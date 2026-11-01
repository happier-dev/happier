import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Platform } from 'react-native';
import { log } from '@/log';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { redactPublicShareCapabilityUrl, withConnectedServiceReaderSupport } from '@happier-dev/protocol';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { SupersededOperationError } from '@/utils/timing/time';
import { createEndpointSupervisedRequest } from '@/sync/runtime/connectivity/createEndpointSupervisedRequest';
import { getEndpointSupervisorForServer } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import {
    peekServerReachabilityToken,
    reportServerUnreachable,
    ServerReachabilityWaitTimeoutError,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    readServerReachabilityWaitTimeoutMs,
    readServerReadInactivityTimeoutMs,
} from '@/sync/runtime/connectivity/serverReachabilityTuning';
import { observeUiClientUpgradeRequiredResponse } from '@/sync/runtime/clientCompatibility/uiClientUpgradeRequired';
import { isLoopbackHostname } from '@/sync/domains/server/url/serverUrlClassification';

export { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

export class StaleServerGenerationError extends Error {
    constructor() {
        super('Ignored response from a stale server generation');
        this.name = 'StaleServerGenerationError';
    }
}

export class ServerFetchAbortedForServerSwitchError extends Error {
    constructor() {
        super('Aborted request due to an active server switch');
        this.name = 'ServerFetchAbortedForServerSwitchError';
    }
}

export class ServerFetchConnectivityTimeoutError extends ServerReachabilityWaitTimeoutError {
    public readonly retryable = false;

    constructor() {
        super();
        this.name = 'ServerFetchConnectivityTimeoutError';
    }
}

/**
 * A mutating request exceeded its write timeout (the server accepted the connection but never
 * responded). Retryable: the pending outbox re-POSTs with the same localId (server dedupes), so a
 * timeout that fires after the server actually committed is idempotent.
 */
export class ServerFetchWriteTimeoutError extends Error {
    public readonly retryable = true;

    constructor() {
        super('Timed out waiting for the server to respond to a write');
        this.name = 'ServerFetchWriteTimeoutError';
    }
}

type ServerFetchOptions = Readonly<{
    /** GET/HEAD are cancellable by default; only paged reads get a native deadline.
     * POST-based reads must opt in; mutations must not.
     */
    recoveryRead?: 'paged' | 'unbounded' | false;
    includeAuth?: boolean;
    /**
     * When `none`, perform a single direct `runtimeFetch` attempt and skip reachability gating and
     * endpoint supervision. This is used by higher-level sync loops that implement their own
     * orchestration/backoff and must not get stuck behind nested connectivity supervisors.
     */
    retry?: 'default' | 'none';
    /**
     * Per-request upper bound (ms) after which the request is aborted with a retryable
     * `ServerFetchWriteTimeoutError`. Requests are unbounded when omitted; the operation
     * owner must opt in only when it can safely classify and recover an ambiguous timeout.
     * Pass `0` to explicitly disable the bound for a single request.
     */
    timeoutMs?: number;
}>;

export type ServerReadRequestInit = RequestInit & Readonly<{
    /** The read owner verified a server-enforced page/response bound; permits a native deadline. */
    responseSizeBounded?: boolean;
}>;

function resolveRequestTimeoutMs(optionTimeoutMs: number | undefined): number {
    if (typeof optionTimeoutMs === 'number' && Number.isFinite(optionTimeoutMs)) {
        return Math.max(0, Math.trunc(optionTimeoutMs));
    }
    return 0;
}

type InFlightFetch = { readOnly: boolean; reason?: unknown };
const inFlightControllers = new Map<AbortController, InFlightFetch>();
let abortSequence = 0;

export class ServerFetchReadTimeoutError extends Error {
    readonly retryable = true;

    constructor() {
        super('Server recovery read made no progress within the peer-liveness window');
        this.name = 'ServerFetchReadTimeoutError';
    }
}

export class ServerFetchReadSupersededError extends SupersededOperationError {
    constructor() {
        super('Server recovery read superseded by manual retry');
        this.name = 'ServerFetchReadSupersededError';
    }
}

const debugLogThrottleMs = 5_000;
const lastDebugLogMsByKey = new Map<string, number>();
let didLogActiveServerSnapshot = false;

export function abortServerFetches(reason: string = 'server-switch', scope?: Readonly<{ readOnly: true }>): void {
    if (!scope?.readOnly) abortSequence += 1;
    for (const [controller, request] of inFlightControllers) {
        if (scope?.readOnly && !request.readOnly) continue;
        request.reason = reason;
        controller.abort(reason);
    }
}

/** Shared by active and scoped adapters. The transport retains its own cancellation through
 * the supplied consumer, so abort still reaches the network after headers have arrived.
 */
export async function withServerReadLifetime<T = Response>(
    init: ServerReadRequestInit | undefined,
    request: (init: RequestInit, consume: (response: Response) => Promise<Response | T>) => Promise<Response | T>,
    consumeResponse?: (response: Response) => Promise<T>,
): Promise<Response | T> {
    const controller = new AbortController();
    // RN's abort-controller polyfill discards abort(reason); keep the cause with the existing
    // cancellation owner so timeout and supersession classification also survives on native.
    const cancellation: InFlightFetch = { readOnly: true };
    inFlightControllers.set(controller, cancellation);
    const upstream = init?.signal;
    const abortFromUpstream = () => {
        cancellation.reason = upstream?.reason;
        controller.abort(upstream?.reason);
    };
    const timeoutMs = readServerReadInactivityTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Native XHR fetch cannot expose progress before resolution. Large unpaged responses must
    // remain cancellable without a total deadline until native fetch exposes streaming progress.
    let canObserveInactivity = Platform.OS === 'web' || init?.responseSizeBounded === true;
    const resetInactivity = () => {
        clearTimeout(timer);
        if (!canObserveInactivity) return;
        timer = setTimeout(() => {
            log.log(`[serverFetch] recovery read inactivity timeout (${timeoutMs}ms)`);
            cancellation.reason = new ServerFetchReadTimeoutError();
            controller.abort(cancellation.reason);
        }, timeoutMs);
    };
    const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
            const reason: unknown = cancellation.reason ?? controller.signal.reason;
            const error = reason instanceof ServerFetchReadTimeoutError ? reason
                : reason === 'manual-retry' ? new ServerFetchReadSupersededError()
                : reason === 'server-switch' ? new ServerFetchAbortedForServerSwitchError()
                : Object.assign(new Error('Aborted'), { name: 'AbortError' });
            reject(error);
            // Some synthetic/platform streams do not observe fetch's signal themselves.
            void reader?.cancel(error).catch(() => {});
        }, { once: true });
    });
    if (upstream?.aborted) abortFromUpstream();
    else upstream?.addEventListener('abort', abortFromUpstream, { once: true });
    resetInactivity();
    try {
        if (controller.signal.aborted) return await cancelled;
        const requestInit = { ...init, signal: controller.signal };
        delete requestInit.responseSizeBounded;
        return await Promise.race([cancelled, request(requestInit, async response => {
            if (controller.signal.aborted) return await cancelled;
            resetInactivity();
            let ownedResponse = response;
            if (typeof response.body?.getReader === 'function') {
                canObserveInactivity = true;
                resetInactivity();
                reader = response.body.getReader();
                const bodyReader = reader;
                ownedResponse = new Response(new ReadableStream<Uint8Array>({
                    async pull(body) {
                        try {
                            const chunk = await bodyReader.read();
                            if (chunk.done) body.close();
                            else {
                                if (chunk.value.byteLength > 0) resetInactivity();
                                body.enqueue(chunk.value);
                            }
                        } catch (error) {
                            body.error(error);
                        }
                    },
                    cancel: reason => bodyReader.cancel(reason),
                }), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            // Response-returning adapters must finish the body here too. Their callers receive a
            // buffered response, so subsequent json()/clone() cannot outlive cancellation ownership.
            const result = consumeResponse ? await consumeResponse(ownedResponse)
                : reader ? new Response(await ownedResponse.blob(), {
                    status: response.status, statusText: response.statusText, headers: response.headers,
                }) : response;
            if (controller.signal.aborted) return await cancelled;
            return result;
        })]);
    } finally {
        clearTimeout(timer);
        upstream?.removeEventListener('abort', abortFromUpstream);
        // A callback may finish on status alone. Release an unread body as well as its timer.
        void reader?.cancel().catch(() => {});
        inFlightControllers.delete(controller);
    }
}

function normalizePath(path: string): string {
    const value = String(path ?? '').trim();
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    return value.startsWith('/') ? value : `/${value}`;
}

function tryParseUrl(raw: string): URL | null {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function isDebugEnabled(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_DEBUG ?? '').trim();
    return raw === '1' || raw.toLowerCase() === 'true';
}

function describeUrlForHint(rawUrl: string): { hostname: string; port: string } | null {
    const parsed = tryParseUrl(rawUrl);
    if (!parsed) return null;
    return { hostname: parsed.hostname, port: parsed.port };
}

function redactUrlForLogs(raw: string): string {
    return toServerUrlDisplay(raw) || '<invalid-url>';
}

function maybeLogRuntimeFetchFailure(params: {
    method: string;
    requestUrl: string;
    activeServerUrl: string;
    activeServerId: string;
    error: unknown;
}): void {
    if (!isDebugEnabled()) return;

    const errorName = params.error instanceof Error ? params.error.name : '';
    const errorMessage = redactPublicShareCapabilityUrl(
        params.error instanceof Error ? params.error.message : String(params.error ?? ''),
    );
    const activeServerUrl = redactUrlForLogs(params.activeServerUrl);
    const requestUrl = redactUrlForLogs(params.requestUrl);
    const key = `${params.activeServerId}|${activeServerUrl}|${requestUrl}|${errorName}|${errorMessage}`;
    const now = Date.now();
    const last = lastDebugLogMsByKey.get(key) ?? 0;
    if (now - last < debugLogThrottleMs) return;
    lastDebugLogMsByKey.set(key, now);

    const msg =
        `[serverFetch] runtimeFetch failed: ${params.method} ${requestUrl} ` +
        `(activeServer=${activeServerUrl}, serverId=${params.activeServerId}) ` +
        `${errorName ? `${errorName}: ` : ''}${errorMessage}`.trim();
    // eslint-disable-next-line no-console
    console.log(msg);

    const hintUrl = describeUrlForHint(activeServerUrl);
    if (hintUrl && isLoopbackHostname(hintUrl.hostname)) {
        // eslint-disable-next-line no-console
        console.log(
            `[serverFetch] hint: active server URL is loopback (${hintUrl.hostname}${hintUrl.port ? `:${hintUrl.port}` : ''}); ` +
            `a physical device cannot reach your computer via localhost. Use a LAN/Tailscale URL.`,
        );
    }
}

export function serverFetch(path: string, init?: ServerReadRequestInit, options?: ServerFetchOptions): Promise<Response>;
/** Await response consumption before releasing caller, Home-switch, and opted-in timeout cancellation. */
export function serverFetch<T>(
    path: string,
    init: ServerReadRequestInit | undefined,
    options: ServerFetchOptions,
    consumeResponse: (response: Response) => Promise<T>,
): Promise<T>;
export async function serverFetch<T>(
    path: string,
    init?: ServerReadRequestInit,
    options: ServerFetchOptions = {},
    consumeResponse?: (response: Response) => Promise<T>,
): Promise<Response | T> {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const readPolicy = options.recoveryRead ?? (method === 'GET' || method === 'HEAD' ? 'unbounded' : false);
    if (readPolicy) {
        const readInit = { ...init, responseSizeBounded: readPolicy === 'paged' || init?.responseSizeBounded === true };
        return await withServerReadLifetime<T>(readInit,
            (ownedInit, consume) => serverFetch(path, ownedInit, { ...options, recoveryRead: false }, consume),
            consumeResponse);
    }
    const localAbortSequence = abortSequence;
    const snapshot = getActiveServerSnapshot();
    const normalizedPath = normalizePath(path);
    let requestUrl = normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
        ? normalizedPath
        : `${snapshot.serverUrl}${normalizedPath}`;

    if (isDebugEnabled() && !didLogActiveServerSnapshot) {
        didLogActiveServerSnapshot = true;
        const logSafeServerUrl = redactUrlForLogs(snapshot.serverUrl);
        // eslint-disable-next-line no-console
        console.log(
            `[serverFetch] active server snapshot: serverId=${snapshot.serverId}, serverUrl=${logSafeServerUrl}, generation=${snapshot.generation}`,
        );
    }

    const absoluteRequestUrl = tryParseUrl(requestUrl);
    const activeServerUrl = tryParseUrl(snapshot.serverUrl);
    const isCrossOrigin =
        !!absoluteRequestUrl
        && !!activeServerUrl
        && absoluteRequestUrl.origin !== activeServerUrl.origin;

    const headers = new Headers(init?.headers ?? {});
    let usedToken: string | null = null;
    if (options.includeAuth !== false) {
        const credentials = await TokenStorage.getCredentials();
        if (credentials?.token) {
            usedToken = credentials.token;
            headers.set('Authorization', `Bearer ${credentials.token}`);
        }
    }
    // Also capture an explicit Authorization header, even when includeAuth=false (many ops pass
    // credentials explicitly to avoid repeated TokenStorage reads).
    const explicitAuthHeader = headers.get('Authorization') ?? '';
    if (!usedToken && explicitAuthHeader.startsWith('Bearer ')) {
        usedToken = explicitAuthHeader.slice(7).trim() || null;
    }
    const hasAuthorization = explicitAuthHeader.trim().length > 0;
    if (hasAuthorization) {
        const logSafeRequestUrl = redactUrlForLogs(requestUrl);
        const logSafeActiveServerUrl = redactUrlForLogs(snapshot.serverUrl);
        // Fail-closed: if we have any Authorization header, we must be able to validate same-origin
        // to avoid accidentally sending credentials to an unexpected host (or the current web origin).
        if (!absoluteRequestUrl || !activeServerUrl) {
            throw new Error(
                `Refused authenticated request because request/active server URL is not a valid absolute URL ` +
                `(requestUrl=${logSafeRequestUrl}, activeServerUrl=${logSafeActiveServerUrl})`,
            );
        }
        if ((absoluteRequestUrl.protocol !== 'http:' && absoluteRequestUrl.protocol !== 'https:') || (activeServerUrl.protocol !== 'http:' && activeServerUrl.protocol !== 'https:')) {
            throw new Error(
                `Refused authenticated request because request/active server URL is not http(s) ` +
                `(requestUrl=${logSafeRequestUrl}, activeServerUrl=${logSafeActiveServerUrl})`,
            );
        }
        if (absoluteRequestUrl.origin !== activeServerUrl.origin) {
            throw new Error(
                `Refused authenticated request to ${absoluteRequestUrl.origin}; active server is ${activeServerUrl.origin}`,
            );
        }
    }

    if (hasAuthorization) requestUrl = withConnectedServiceReaderSupport(requestUrl);

    const requestController = new AbortController();
    inFlightControllers.set(requestController, { readOnly: false });
    if (abortSequence !== localAbortSequence) {
        requestController.abort('server-switch');
    }

    const upstreamSignal = init?.signal;
    let removeUpstreamListener = () => {};
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            requestController.abort();
        } else {
            const onAbort = () => requestController.abort();
            upstreamSignal.addEventListener('abort', onAbort, { once: true });
            removeUpstreamListener = () => upstreamSignal.removeEventListener('abort', onAbort);
        }
    }

    // A request owner may opt into a bound when it can recover safely from an
    // ambiguous write timeout. Read liveness is owned by withServerReadLifetime above.
    const effectiveTimeoutMs = resolveRequestTimeoutMs(options.timeoutMs);
    let didWriteTimeout = false;
    let writeTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeoutMs > 0) {
        writeTimeoutHandle = setTimeout(() => {
            didWriteTimeout = true;
            requestController.abort('write-timeout');
        }, effectiveTimeoutMs);
    }

    const throwIfRequestAborted = (error: unknown, reportTimeout: boolean): void => {
        if (!requestController.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) return;
        const reason = (requestController.signal as unknown as { reason?: unknown }).reason;
        if (reason === 'server-switch' || abortSequence !== localAbortSequence) {
            throw new ServerFetchAbortedForServerSwitchError();
        }
        if (didWriteTimeout) {
            if (reportTimeout) reportServerUnreachable(snapshot.serverUrl, error);
            throw new ServerFetchWriteTimeoutError();
        }
        // Caller cancellation does not establish a server reachability failure.
        throw error;
    };

    const retryMode: 'default' | 'none' = options.retry ?? 'default';
    const isActiveOrigin =
        !isCrossOrigin
        && !!absoluteRequestUrl
        && !!activeServerUrl;
    const endpointSupervisor =
        isActiveOrigin
            ? getEndpointSupervisorForServer({ serverId: snapshot.serverId, serverUrl: snapshot.serverUrl })
            : null;

    let response: Response | null = null;
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                if (isActiveOrigin && retryMode !== 'none') {
                    const tokenForReachability =
                        usedToken
                        ?? peekServerReachabilityToken(snapshot.serverUrl)
                        ?? null;
                    try {
                        await waitForServerReachable({
                            serverUrl: snapshot.serverUrl,
                            token: tokenForReachability,
                            signal: requestController.signal,
                            timeoutMs: readServerReachabilityWaitTimeoutMs(),
                            acceptAuthFailed: true,
                        });
                    } catch (error) {
                        // The surrounding transport catch owns timeout reachability reporting.
                        throwIfRequestAborted(error, false);
                        if (error instanceof ServerReachabilityWaitTimeoutError) {
                            throw new ServerFetchConnectivityTimeoutError();
                        }
                        throw error;
                    }
                }

                if (endpointSupervisor && retryMode !== 'none') {
                    const supervisedFetch = createEndpointSupervisedRequest({
                        serverId: snapshot.serverId,
                        serverUrl: snapshot.serverUrl,
                        token: usedToken,
                        endpointSupervisor,
                    });
                    response = await supervisedFetch(requestUrl, {
                        ...init,
                        headers,
                        signal: requestController.signal,
                    });
                } else {
                    response = await runtimeFetch(requestUrl, {
                        ...init,
                        headers,
                        signal: requestController.signal,
                    });
                }
            } catch (error) {
                maybeLogRuntimeFetchFailure({
                    method,
                    requestUrl,
                    activeServerUrl: snapshot.serverUrl,
                    activeServerId: snapshot.serverId,
                    error,
                });
                throwIfRequestAborted(error, true);
                if (error instanceof ServerFetchConnectivityTimeoutError) {
                    // Reachability wait timeouts already represent a "paused/offline" state; do not report an extra
                    // transport failure which can reset backoff scheduling.
                    throw error;
                }
                reportServerUnreachable(snapshot.serverUrl, error);
                throw error;
            }

            const current = getActiveServerSnapshot();
            if (current.generation !== snapshot.generation || current.serverId !== snapshot.serverId) {
                throw new StaleServerGenerationError();
            }

            await observeUiClientUpgradeRequiredResponse(response);

            if (!usedToken || response.status !== 401 || !isActiveOrigin) {
                break;
            }

            // If the active token is rejected, clear it to prevent the UI from getting stuck in a persistent 401 loop.
            // The follow-up request (if any) will re-read credentials and may pick up a refreshed token, or allow the
            // UI to present a clean sign-in state for that server scope.
            try {
                await TokenStorage.invalidateCredentialsTokenForServerUrl(snapshot.serverUrl, usedToken, {
                    serverId: snapshot.serverId,
                });
            } catch {
                // ignore
            }

            // Only retry idempotent requests to avoid surprising duplication.
            if (attempt !== 0 || (method !== 'GET' && method !== 'HEAD')) {
                break;
            }

            // Re-read credentials and retry once if we found a different token.
            try {
                const fresh = await TokenStorage.getCredentials();
                const freshToken = fresh?.token ?? null;
                if (freshToken && freshToken !== usedToken) {
                    usedToken = freshToken;
                    headers.set('Authorization', `Bearer ${freshToken}`);
                    continue;
                }
            } catch {
                // ignore
            }

            break;
        }
        if (!response) throw new Error('serverFetch did not attempt the request');
        if (!consumeResponse) return response;

        // A body-consuming owner keeps cancellation attached until its read settles. Parsing
        // failures stay outside the transport retry/classification path and never replay a write.
        try {
            const result = await consumeResponse(response);
            if (requestController.signal.aborted) {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                throw error;
            }
            return result;
        } catch (error) {
            throwIfRequestAborted(error, false);
            throw error;
        }
    } finally {
        if (writeTimeoutHandle) {
            clearTimeout(writeTimeoutHandle);
        }
        removeUpstreamListener();
        inFlightControllers.delete(requestController);
    }
}
