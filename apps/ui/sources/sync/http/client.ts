import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { Platform } from 'react-native';
import { log } from '@/log';
import { readServerReadInactivityTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol/crypto/publicShareCapabilityUrl';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { classifyEndpointResponse } from '@/sync/runtime/connectivity/classifyEndpointResponse';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import {
    peekServerReachabilityScope,
    reportServerReachabilityProbeResult,
    invalidateServerReachabilitySupervisor,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { notifyAuthCredentialsInvalidated } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    AccountStoredContentCompatibilityUnavailableError,
    readAccountStoredContentCompatibilityRequestDeclaration,
    resolveAccountStoredContentCompatibilityHeaders,
    stripAccountStoredContentCompatibilityHeader,
} from './accountStoredContentCompatibility';
import { resolveActiveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { getActiveServerHomeCarrier } from '@/sync/domains/server/serverRuntime';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { normalizeRequestBodyHeaders } from './requestBodyHeaders';
import { bindAccountEncryptionObservation, captureAccountEncryptionObservationForHome, matchesAccountEncryptionObservationCredentials, type AccountEncryptionObservationBinding } from './accountEncryptionObservationBinding';

export { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

export class StaleServerGenerationError extends Error {
    public readonly retryable = false;

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

export class ServerFetchWriteTimeoutError extends Error {
    public readonly retryable = true;

    constructor() {
        super('Timed out waiting for the server to respond to a write');
        this.name = 'ServerFetchWriteTimeoutError';
    }
}

export type ExpectedActiveServerFetchBasis = Readonly<{
    serverId: string;
    generation: number;
}>;

export type ServerFetchOptions = Readonly<{
    /** Read-only POSTs opt in. Unpaged native reads remain cancellable without a total deadline. */
    recoveryRead?: 'paged' | 'unbounded' | false;
    includeAuth?: boolean;
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
    /**
     * When `none`, skip reachability gating and endpoint supervision. The canonical
     * idempotent-read credential recovery still applies; no transport retry loop is added.
     * Higher-level sync loops retain their own orchestration/backoff.
     */
    retry?: 'default' | 'none';
    /** Opt into a request bound. Requests are unbounded when omitted; zero also disables it. */
    timeoutMs?: number;
    /** Called once after pre-dispatch guards pass and before bytes enter the transport. */
    onIssued?: () => void;
}>;

/**
 * The request function shared by focused-Home compatibility callers and explicit Home/Account
 * Service callers.  The third argument intentionally stays optional so existing call sites keep
 * their established retry/auth options while target callers can use the same lifecycle owner.
 */
export type ServerFetch = (
    path: string,
    init?: RequestInit,
    options?: ServerFetchOptions,
) => Promise<Response>;

/** Consume a response while the request still owns cancellation and its captured Home. */
export type ServerResponseRequest<TOptions = ServerFetchOptions> = {
    (path: string, init?: RequestInit, options?: TOptions): Promise<Response>;
    <T>(path: string, init: RequestInit | undefined, options: TOptions | undefined,
        consumeResponse: (response: Response) => Promise<T>): Promise<T>;
};

/** These POST routes only read selected resources; no mutation may inherit read recovery. */
export function isIdempotentServerRead(method: string, path: string): boolean {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return true;
    if (normalizedMethod !== 'POST') return false;
    const route = path.split(/[?#]/, 1)[0];
    return route === '/v2/sessions/read-batch'
        || route === '/v1/machines/read-batch'
        || route === '/v1/artifacts/read';
}

type EndpointRequestContext = Readonly<{
    /** Stable logical URL used for identity, reachability, compatibility, and storage scope. */
    endpointUrl: string;
    /**
     * Actual request origin. For a native Iroh lease this may be an ephemeral
     * loopback origin. A semantic carrier has no origin, so it stays the
     * canonical endpoint URL and {@link EndpointRequestContext.homeCarrier}
     * moves the bytes.
     */
    runtimeOrigin: string;
    /**
     * A Home carrier that owns its own bytes (browser Iroh). Everything above
     * the transport — compatibility headers, auth, credential invalidation,
     * generation checks, reachability, timeouts, and error classification —
     * stays here; the carrier only receives the final request and returns the
     * response.
     */
    homeCarrier?: HomeCarrier;
    serverId: string;
    generation?: number;
    /** Active requests retain switch currentness/abort semantics; explicit requests do not. */
    active: boolean;
    /**
     * A concrete incumbent binding may retain readiness and endpoint-supervisor
     * policy without consulting the staged active-Home selector.
     */
    superviseReachability?: boolean;
    /** `true` means credentials are resolved from the target's scoped storage. */
    useStoredCredentials: boolean;
    /**
     * The initial bearer is an explicit binding, but an authenticated 401 may
     * retire that exact target-scoped credential and retry one idempotent read
     * with its replacement. This never selects the staged Home.
     */
    recoverStoredCredentials?: boolean;
    /** Currentness belongs to a captured caller binding when this is not the staged active request. */
    isCurrent?: () => boolean;
    /** Lets the caller adopt a recovered target credential before the retry completes. */
    onRecoveredCredentials?: (credentials: AuthCredentials) => boolean;
    /** Observes this write's successful conditional removal of its rejected stored token. */
    onRejectedStoredCredentials?: (rejectedToken: string) => void;
    credentials?: AuthCredentials | null;
    signal?: AbortSignal;
}>;

function assertRequestContextCurrent(context: EndpointRequestContext): void {
    if (context.active) {
        const current = getActiveServerSnapshot();
        if (
            current.serverId !== context.serverId
            || current.generation !== context.generation
        ) {
            throw new StaleServerGenerationError();
        }
    }
    if (context.isCurrent && !context.isCurrent()) {
        throw new StaleServerGenerationError();
    }
}

function resolveRequestTimeoutMs(optionTimeoutMs: number | undefined): number {
    if (typeof optionTimeoutMs === 'number' && Number.isFinite(optionTimeoutMs)) {
        return Math.max(0, Math.trunc(optionTimeoutMs));
    }
    return 0;
}

type InFlightFetch = { active: boolean; readOnly: boolean; reason?: unknown };
const inFlightControllers = new Map<AbortController, InFlightFetch>();
let abortSequence = 0;

// A marked first-key migration keeps the rejected credential bytes as recovery
// custody. Fence only the exact rejected bearer in memory so later HTTP calls
// cannot silently reuse it as ordinary auth. Canonical credential replacement
// or removal clears the fence when the next request observes current storage.
const rejectedFirstKeyBearerByServer = new Map<string, string>();
const classifiedAllowedBearerByServer = new Map<string, string>();

function resolveRejectedFirstKeyBearerKey(params: Readonly<{
    serverId: string;
    serverUrl: string;
}>): string {
    return JSON.stringify([
        params.serverId,
        params.serverUrl,
    ]);
}

const debugLogThrottleMs = 5_000;
const lastDebugLogMsByKey = new Map<string, number>();
let didLogActiveServerSnapshot = false;

export function abortServerFetches(reason: string = 'server-switch', scope?: Readonly<{ readOnly: true }>): void {
    if (!scope?.readOnly) abortSequence += 1;
    for (const [controller, request] of inFlightControllers) {
        if (scope?.readOnly ? !request.readOnly : !request.active) continue;
        request.reason = reason;
        controller.abort(reason);
    }
}

export class ServerFetchReadTimeoutError extends Error {
    readonly retryable = true;
    constructor() {
        super('Server recovery read made no progress within the peer-liveness window');
        this.name = 'ServerFetchReadTimeoutError';
    }
}

export class ServerFetchReadSupersededError extends Error {
    readonly retryable = false;
    constructor() {
        super('Server recovery read superseded by manual retry');
        this.name = 'ServerFetchReadSupersededError';
    }
}

/** One complete read lifetime for active, captured Home/Account and legacy scoped adapters. */
export async function withServerReadLifetime<T = Response>(
    init: RequestInit | undefined,
    request: (init: RequestInit, consume: (response: Response) => Promise<Response | T>) => Promise<Response | T>,
    consumeResponse?: (response: Response) => Promise<T>,
    options: Readonly<{ active?: boolean; responseSizeBounded?: boolean }> = {},
): Promise<Response | T> {
    const controller = new AbortController();
    // React Native's abort-controller discards abort(reason). Preserve the cause
    // at the existing cancellation owner, independently of signal.reason.
    const cancellation: InFlightFetch = { active: options.active === true, readOnly: true };
    inFlightControllers.set(controller, cancellation);
    const upstream = init?.signal;
    const abortFromUpstream = () => {
        cancellation.reason = upstream?.reason;
        controller.abort(upstream?.reason);
    };
    const timeoutMs = readServerReadInactivityTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Native fetch resolves after the whole XHR body: a large unpaged response
    // must not acquire a total deadline until native exposes body progress.
    let canObserveInactivity = Platform.OS === 'web' || options.responseSizeBounded === true;
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
            const reason = cancellation.reason ?? controller.signal.reason;
            const error = reason instanceof ServerFetchReadTimeoutError ? reason
                : reason === 'manual-retry' ? new ServerFetchReadSupersededError()
                : reason === 'server-switch' ? new ServerFetchAbortedForServerSwitchError()
                : reason instanceof Error ? reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' });
            reject(error);
            void reader?.cancel(error).catch(() => {});
        }, { once: true });
    });
    if (upstream?.aborted) abortFromUpstream();
    else upstream?.addEventListener('abort', abortFromUpstream, { once: true });
    resetInactivity();
    try {
        if (controller.signal.aborted) return await cancelled;
        return await Promise.race([cancelled, request({ ...init, signal: controller.signal }, async response => {
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
                        } catch (error) { body.error(error); }
                    },
                    cancel: reason => bodyReader.cancel(reason),
                }), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            // A raw Response borrower receives complete bytes before cancellation
            // and carrier custody end. Later json()/clone() cannot strand a read.
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

function requestAtEndpoint(context: EndpointRequestContext, path: string, init?: RequestInit, options?: ServerFetchOptions): Promise<Response>;
function requestAtEndpoint<T>(context: EndpointRequestContext, path: string, init: RequestInit | undefined,
    options: ServerFetchOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
async function requestAtEndpoint<T>(
    context: EndpointRequestContext,
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
    consumeResponse?: (response: Response) => Promise<T>,
): Promise<Response | T> {
    // A retired binding is a typed stale outcome even when its retirement also aborted the context signal.
    assertRequestContextCurrent(context);
    throwIfAborted(context.signal);
    throwIfAborted(init?.signal ?? undefined);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const readPolicy = options.recoveryRead ?? (isIdempotentServerRead(method, path) ? 'unbounded' : false);
    if (readPolicy) {
        const cancellation = mergeAbortSignals([context.signal, init?.signal ?? undefined]);
        try {
            return await withServerReadLifetime<T>({ ...init, signal: cancellation.signal },
                (ownedInit, consume) => requestAtEndpoint(context, path, ownedInit, { ...options, recoveryRead: false }, consume),
                consumeResponse, { active: context.active, responseSizeBounded: readPolicy === 'paged' });
        } catch (error) {
            assertRequestContextCurrent(context);
            throw error;
        } finally { cancellation.dispose(); }
    }
    const localAbortSequence = context.active ? abortSequence : null;
    const usesReachabilitySupervision = context.active || context.superviseReachability === true;
    const recoversStoredCredentials = context.active || context.recoverStoredCredentials === true;
    if (!context.active) {
        const targetOrigin = tryParseUrl(context.runtimeOrigin);
        if (
            !targetOrigin
            || (targetOrigin.protocol !== 'http:' && targetOrigin.protocol !== 'https:')
        ) {
            throw new Error('Invalid explicit endpoint URL');
        }
    }
    if (
        context.active
        && options.expectedActiveServer
        && (
            context.serverId !== options.expectedActiveServer.serverId
            || context.generation !== options.expectedActiveServer.generation
        )
    ) {
        throw new StaleServerGenerationError();
    }
    const normalizedPath = normalizePath(path);
    const transportOrigin = context.runtimeOrigin;
    const requestUrl = normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
        ? normalizedPath
        : `${transportOrigin}${normalizedPath}`;

    if (context.active && isDebugEnabled() && !didLogActiveServerSnapshot) {
        didLogActiveServerSnapshot = true;
        const logSafeServerUrl = redactUrlForLogs(context.endpointUrl);
        // eslint-disable-next-line no-console
        console.log(
            `[serverFetch] active server snapshot: serverId=${context.serverId}, serverUrl=${logSafeServerUrl}, generation=${context.generation ?? 0}`,
        );
    }

    const absoluteRequestUrl = tryParseUrl(requestUrl);
    const activeServerUrl = tryParseUrl(transportOrigin);
    const isCrossOrigin =
        !!absoluteRequestUrl
        && !!activeServerUrl
        && absoluteRequestUrl.origin !== activeServerUrl.origin;

    const requestedCompatibilityDeclaration =
        readAccountStoredContentCompatibilityRequestDeclaration(init);
    const compatibility = normalizedPath === '/v1/features'
        ? null
        : resolveAccountStoredContentCompatibilityHeaders(
            init?.headers,
            {
                serverUrl: context.endpointUrl,
                ...(requestedCompatibilityDeclaration
                    ? { declaration: requestedCompatibilityDeclaration }
                    : {}),
            },
        );
    if (
        requestedCompatibilityDeclaration
        && compatibility?.status === 'unavailable'
    ) {
        throw new AccountStoredContentCompatibilityUnavailableError(
            compatibility.reason,
        );
    }
    const headers = compatibility?.status === 'available'
        ? compatibility.headers
        : stripAccountStoredContentCompatibilityHeader(init?.headers);
    normalizeRequestBodyHeaders(headers, init?.body);
    const rejectedFirstKeyBearerKey =
        resolveRejectedFirstKeyBearerKey({
            serverId: context.serverId,
            serverUrl: context.endpointUrl,
        });
    let rejectedFirstKeyBearer =
        rejectedFirstKeyBearerByServer.get(
            rejectedFirstKeyBearerKey,
        ) ?? null;
    let usedToken: string | null = null;
    if (options.includeAuth !== false) {
        const credentials = context.credentials !== undefined
            ? context.credentials
            : context.useStoredCredentials
                // The request context captures its Home before any await. Resolve the
                // credential against that same identity/URL even for the active wrapper:
                // a web tab selection can change independently of a stale device-scoped
                // runtime snapshot, and the targetless accessor would then attach the new
                // Home's bearer to the old Home's origin.
                ? await TokenStorage.getCredentialsForServerUrl(
                    context.endpointUrl,
                    context.serverId ? { serverId: context.serverId } : {},
                )
                : null;
        if (!credentials?.token) {
            rejectedFirstKeyBearerByServer.delete(
                rejectedFirstKeyBearerKey,
            );
            classifiedAllowedBearerByServer.delete(
                rejectedFirstKeyBearerKey,
            );
            rejectedFirstKeyBearer = null;
        }
        if (
            rejectedFirstKeyBearer
            && credentials?.token
            !== rejectedFirstKeyBearer
        ) {
            rejectedFirstKeyBearerByServer.delete(
                rejectedFirstKeyBearerKey,
            );
            classifiedAllowedBearerByServer.delete(
                rejectedFirstKeyBearerKey,
            );
            rejectedFirstKeyBearer = null;
        }
        if (
            recoversStoredCredentials
            && credentials?.token
            && (
                rejectedFirstKeyBearer
                === credentials.token
                || classifiedAllowedBearerByServer
                    .get(
                        rejectedFirstKeyBearerKey,
                    )
                    !== credentials.token
            )
        ) {
            const classification =
                await TokenStorage
                    .classifyPendingExternalAuthFirstKeyRejectedCredential({
                        serverId:
                            context.serverId,
                        serverUrl:
                            context.endpointUrl,
                        token:
                            credentials.token,
                    });
            if (
                classification.kind
                === 'rejected'
            ) {
                rejectedFirstKeyBearer =
                    credentials.token;
                rejectedFirstKeyBearerByServer.set(
                    rejectedFirstKeyBearerKey,
                    credentials.token,
                );
                classifiedAllowedBearerByServer.delete(
                    rejectedFirstKeyBearerKey,
                );
                fireAndForget(
                    invalidateServerReachabilitySupervisor({
                        serverUrl:
                            context.endpointUrl,
                        token: null,
                    }),
                    {
                        tag:
                            'serverFetch.persistedFirstKeyRejectedBearerReachability',
                    },
                );
            } else {
                rejectedFirstKeyBearerByServer.delete(
                    rejectedFirstKeyBearerKey,
                );
                rejectedFirstKeyBearer = null;
                classifiedAllowedBearerByServer.set(
                    rejectedFirstKeyBearerKey,
                    credentials.token,
                );
            }
        }
        if (
            credentials?.token
            && credentials.token
            !== rejectedFirstKeyBearer
        ) {
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
    if (
        usedToken
        && usedToken === rejectedFirstKeyBearer
    ) {
        headers.delete('Authorization');
        usedToken = null;
    }
    const hasAuthorization = explicitAuthHeader.trim().length > 0;
    if (hasAuthorization) {
        const logSafeRequestUrl = redactUrlForLogs(requestUrl);
        const logSafeActiveServerUrl = redactUrlForLogs(context.endpointUrl);
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

    const requestController = new AbortController();
    if (context.active) inFlightControllers.set(requestController, { active: true, readOnly: false });
    if (context.active && localAbortSequence !== null && abortSequence !== localAbortSequence) {
        requestController.abort('server-switch');
    }

    const upstreamSignals = [context.signal, init?.signal].filter(
        (signal): signal is AbortSignal => Boolean(signal),
    );
    const removeUpstreamListeners: Array<() => void> = [];
    for (const upstreamSignal of upstreamSignals) {
        if (upstreamSignal.aborted) {
            requestController.abort((upstreamSignal as AbortSignal & { reason?: unknown }).reason);
            continue;
        }
        const onAbort = () => requestController.abort(
            (upstreamSignal as AbortSignal & { reason?: unknown }).reason,
        );
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
        removeUpstreamListeners.push(() => upstreamSignal.removeEventListener('abort', onAbort));
    }

    const idempotentRead = isIdempotentServerRead(method, normalizedPath);
    const effectiveTimeoutMs = resolveRequestTimeoutMs(options.timeoutMs);
    let didWriteTimeout = false;
    let writeTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeoutMs > 0) {
        writeTimeoutHandle = setTimeout(() => {
            didWriteTimeout = true;
            requestController.abort('write-timeout');
        }, effectiveTimeoutMs);
    }
    const retryMode: 'default' | 'none' = options.retry ?? 'default';
    const isActiveOrigin =
        context.active
        && !isCrossOrigin
        && !!absoluteRequestUrl
        && !!activeServerUrl;
    const isSupervisedOrigin =
        usesReachabilitySupervision
        && !isCrossOrigin
        && !!absoluteRequestUrl
        && !!activeServerUrl;
    // A Home carrier is bound to exactly one Home. An absolute cross-origin URL
    // is by definition not that Home, so it keeps the platform transport — which
    // also means a Home bearer can never reach the carrier for another origin
    // (the fail-closed same-origin check above already refuses to attach one).
    const homeCarrier = context.homeCarrier && !isCrossOrigin ? context.homeCarrier : null;

    let response: Response | null = null;
    let issued = false;
    const markIssued = () => {
        if (issued) return;
        issued = true;
        options.onIssued?.();
    };
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                if (isSupervisedOrigin && retryMode !== 'none') {
                    const tokenForReachability =
                        usedToken
                        ?? null;
                    try {
                        const homeIdentityId = resolvePortableServerIdentityForRoutingId(context.serverId);
                        await waitForServerReachable({
                            serverUrl: context.endpointUrl,
                            token: tokenForReachability,
                            ...(homeIdentityId ? { homeIdentityId } : {}),
                            signal: requestController.signal,
                            acceptAuthFailed: true,
                            runtimeOrigin: context.runtimeOrigin,
                            homeCarrier,
                        });
                    } catch (error) {
                        const aborted =
                            requestController.signal.aborted || (error instanceof Error && error.name === 'AbortError');
                        if (aborted) {
                            const reason = (requestController.signal as unknown as { reason?: unknown }).reason;
                            const serverSwitchAbort = context.active
                                && (reason === 'server-switch' || abortSequence !== localAbortSequence);
                            if (serverSwitchAbort) {
                                assertRequestContextCurrent(context);
                                throw new ServerFetchAbortedForServerSwitchError();
                            }
                            if (didWriteTimeout) {
                                throw new ServerFetchWriteTimeoutError();
                            }
                            throw error;
                        }
                        throw error;
                    }
                }

                // Request admission and evidence use the actual bearer, not the
                // settings facade's potentially newer credential binding.
                const probeReportScope = isSupervisedOrigin
                    ? peekServerReachabilityScope(context.endpointUrl, usedToken)
                    : null;
                markIssued();
                const request = { ...init, headers, signal: requestController.signal };
                try {
                    response = homeCarrier
                        ? await homeCarrier.request(requestUrl, request)
                        : await runtimeFetch(requestUrl, request);
                } catch (error) {
                    if (probeReportScope && !requestController.signal.aborted
                        && !(error instanceof Error && error.name === 'AbortError')) {
                        const errorMessage = sanitizeEndpointErrorMessage(error) ?? 'Network request failed';
                        reportServerReachabilityProbeResult(context.endpointUrl, {
                            status: 'server_unreachable', errorMessage,
                        }, probeReportScope, usedToken);
                    }
                    throw error;
                }
                if (probeReportScope && retryMode !== 'none') {
                    const probe = classifyEndpointResponse(response, Boolean(usedToken));
                    if (probe) reportServerReachabilityProbeResult(context.endpointUrl, probe, probeReportScope, usedToken);
                }
            } catch (error) {
                maybeLogRuntimeFetchFailure({
                    method,
                    requestUrl,
                    activeServerUrl: context.endpointUrl,
                    activeServerId: context.serverId,
                    error,
                });
                const aborted =
                    requestController.signal.aborted || (error instanceof Error && error.name === 'AbortError');
                if (aborted) {
                    const reason = (requestController.signal as unknown as { reason?: unknown }).reason;
                    const serverSwitchAbort = context.active
                        && (reason === 'server-switch' || abortSequence !== localAbortSequence);
                    if (serverSwitchAbort) {
                        assertRequestContextCurrent(context);
                        throw new ServerFetchAbortedForServerSwitchError();
                    }
                    if (didWriteTimeout) {
                        throw new ServerFetchWriteTimeoutError();
                    }
                    // Caller aborts should not poison reachability state.
                    throw error;
                }
                throw error;
            }

            assertRequestContextCurrent(context);

            if (!usedToken || response.status !== 401 || !recoversStoredCredentials || isCrossOrigin) {
                break;
            }

            // Classify the rejected active token before deleting it. Marked
            // first-key recovery custody must remain exact; otherwise removal
            // prevents a persistent 401 loop and permits a refreshed token.
            let invalidatedStoredCredentials = false;
            try {
                if (recoversStoredCredentials) {
                    // Load the first-key owner lazily: it uses serverFetch for recovery
                    // requests, so a static import here would create a module cycle.
                    const {
                        guardAccountEncryptionFirstKeyCredentialMutation,
                        markAccountEncryptionFirstKeyRejectedCredential,
                    } = await import(
                        '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth'
                    );
                    const guard =
                        await guardAccountEncryptionFirstKeyCredentialMutation({
                            serverId: context.serverId,
                            serverUrl: context.endpointUrl,
                        });
                    assertRequestContextCurrent(context);
                    if (guard.kind !== 'allowed') {
                        const marked =
                            await markAccountEncryptionFirstKeyRejectedCredential({
                                recovery:
                                    guard.recovery,
                                token: usedToken,
                            });
                        assertRequestContextCurrent(context);
                        if (
                            marked.kind
                            !== 'recorded'
                        ) {
                            break;
                        }
                        const alreadyFenced =
                            rejectedFirstKeyBearerByServer
                                .get(
                                    rejectedFirstKeyBearerKey,
                                )
                            === usedToken;
                        rejectedFirstKeyBearerByServer.set(
                            rejectedFirstKeyBearerKey,
                            usedToken,
                        );
                        classifiedAllowedBearerByServer.delete(
                            rejectedFirstKeyBearerKey,
                        );
                        fireAndForget(
                            invalidateServerReachabilitySupervisor({
                                serverUrl:
                                    context.endpointUrl,
                                token: null,
                            }),
                            {
                                tag:
                                    'serverFetch.firstKeyRejectedBearerReachability',
                            },
                        );
                        if (!alreadyFenced) {
                            notifyAuthCredentialsInvalidated({
                                kind:
                                    'first_key_recovery_required',
                                serverId:
                                    context.serverId,
                                serverUrl:
                                    context.endpointUrl,
                                ...(context.generation === undefined
                                    ? {}
                                    : { generation: context.generation }),
                                recovery:
                                    marked.recovery,
                            });
                        }
                        // The rejected bearer is retained only as exact first-key
                        // recovery custody. It must not be retried as normal auth.
                        break;
                    }
                }
                if (recoversStoredCredentials) {
                    invalidatedStoredCredentials =
                        await TokenStorage.invalidateCredentialsTokenForServerUrl(
                            context.endpointUrl,
                            usedToken,
                            { serverId: context.serverId },
                        );
                }
            } catch {
                // ignore
            }
            if (invalidatedStoredCredentials) {
                try {
                    if (!idempotentRead) {
                        context.onRejectedStoredCredentials?.(usedToken);
                    }
                } finally {
                    notifyAuthCredentialsInvalidated({
                        kind: 'credentials_removed',
                        serverId: context.serverId,
                        serverUrl: context.endpointUrl,
                        ...(context.generation === undefined
                            ? {}
                            : { generation: context.generation }),
                    });
                }
            }

            // Only retry idempotent requests to avoid surprising duplication.
            if (attempt !== 0 || !idempotentRead) {
                break;
            }

            // Re-read target-scoped credentials and retry once if we found a
            // different token. Explicit caller credentials are immutable for the
            // request and must not be replaced from storage.
            if (!recoversStoredCredentials) break;
            try {
                const fresh = await TokenStorage.getCredentialsForServerUrl(
                    context.endpointUrl,
                    context.serverId ? { serverId: context.serverId } : {},
                );
                const freshToken = fresh?.token ?? null;
                if (fresh && freshToken && freshToken !== usedToken) {
                    assertRequestContextCurrent(context);
                    if (context.onRecoveredCredentials && !context.onRecoveredCredentials(fresh)) {
                        throw new StaleServerGenerationError();
                    }
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
        // Domain parsing is outside the transport/auth retry catch. A body read
        // failure must never dispatch a mutating request a second time.
        const result = await consumeResponse(response);
        throwIfAborted(requestController.signal);
        assertRequestContextCurrent(context);
        return result;
    } finally {
        if (writeTimeoutHandle) {
            clearTimeout(writeTimeoutHandle);
        }
        for (const removeUpstreamListener of removeUpstreamListeners) {
            removeUpstreamListener();
        }
        if (context.active) inFlightControllers.delete(requestController);
    }

}

function normalizeEndpointBase(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    try {
        const parsed = new URL(value);
        // Endpoint identity is an origin/base, never a caller-supplied query or fragment. This
        // also prevents credentials from being accidentally attached to an inherited URL query.
        parsed.search = '';
        parsed.hash = '';
        parsed.username = '';
        parsed.password = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return value.replace(/\/+$/, '');
    }
}

function resolveEndpointRuntimeOrigin(endpointUrl: string, runtimeOrigin?: string): string {
    const candidate = String(runtimeOrigin ?? '').trim();
    if (candidate) {
        try {
            const parsed = new URL(candidate);
            if (
                (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && !parsed.username
                && !parsed.password
                && !parsed.search
                && !parsed.hash
            ) {
                return parsed.toString().replace(/\/+$/, '');
            }
        } catch {
            // Invalid runtime origins fail closed to the stable endpoint below.
        }
    }
    return endpointUrl;
}

/**
 * Build a request function for a specific Home/Account Service endpoint. The target is captured
 * once and never resolved through the active-server selector, so changing focus cannot retarget
 * an in-flight or subsequent request made by this function.
 */
export function createServerFetchAtEndpoint(
    params: Readonly<{
        endpointUrl: string;
        runtimeOrigin?: string;
        homeCarrier?: HomeCarrier;
        credentials?: AuthCredentials | null;
        accountEncryptionObservation?: AccountEncryptionObservationBinding;
        serverId?: string;
        signal?: AbortSignal;
        /** Preserve readiness/supervisor policy for a captured incumbent binding. */
        superviseReachability?: boolean;
        /** Preserve target-scoped 401 invalidation/retry for a captured incumbent binding. */
        recoverStoredCredentials?: boolean;
        /** Reject recovery if the caller's captured binding was retired. */
        isCurrent?: () => boolean;
        /** Allows a caller to adopt the replacement target credential before retrying. */
        onRecoveredCredentials?: (credentials: AuthCredentials) => boolean;
        /** Observes this write's successful conditional removal of its rejected stored token. */
        onRejectedStoredCredentials?: (rejectedToken: string) => void;
    }>,
): ServerResponseRequest {
    const endpointUrl = normalizeEndpointBase(params.endpointUrl);
    const runtimeOrigin = resolveEndpointRuntimeOrigin(endpointUrl, params.runtimeOrigin);
    const serverId = String(params.serverId ?? '').trim();
    const context: EndpointRequestContext = {
        endpointUrl,
        runtimeOrigin,
        serverId,
        active: false,
        ...(params.superviseReachability === true ? { superviseReachability: true } : {}),
        ...(params.recoverStoredCredentials === true ? { recoverStoredCredentials: true } : {}),
        ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
        ...(params.onRecoveredCredentials ? { onRecoveredCredentials: params.onRecoveredCredentials } : {}),
        ...(params.onRejectedStoredCredentials ? { onRejectedStoredCredentials: params.onRejectedStoredCredentials } : {}),
        useStoredCredentials: params.credentials === undefined,
        ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
        ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    };

    function request(path: string, init?: RequestInit, options?: ServerFetchOptions): Promise<Response>;
    function request<T>(path: string, init: RequestInit | undefined, options: ServerFetchOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
    async function request<T>(path: string, init?: RequestInit, options?: ServerFetchOptions, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
        return consumeResponse ? await requestAtEndpoint(context, path, init, options, consumeResponse)
            : await requestAtEndpoint(context, path, init, options);
    }
    const observation = params.accountEncryptionObservation;
    const matchesObservation = observation && params.credentials && matchesAccountEncryptionObservationCredentials(observation, params.credentials)
        && observation.serverId === serverId && normalizeEndpointBase(observation.endpointUrl) === endpointUrl
        && normalizeEndpointBase(observation.runtimeOrigin) === normalizeEndpointBase(runtimeOrigin)
        && observation.homeCarrierEndpointId === (params.homeCarrier?.endpointId ?? null);
    if (!matchesObservation) return request;
    const isCurrent = () => observation.isCurrent() && !params.signal?.aborted && params.isCurrent?.() !== false;
    const assertCurrent = () => {
        throwIfAborted(params.signal);
        if (!isCurrent()) throw new StaleServerGenerationError();
    };
    return bindAccountEncryptionObservation(request, {
        ...observation,
        isCurrent,
        read: async signal => {
            assertCurrent();
            const cancellation = mergeAbortSignals([params.signal, signal]);
            try {
                const identity = await observation.read(cancellation.signal);
                assertCurrent();
                return identity;
            } finally { cancellation.dispose(); }
        },
        peek: () => isCurrent() ? observation.peek() : null,
    });
}

/**
 * Capture the focused Home once for a containing operation. Retries and compatibility
 * fallbacks retain that admitted basis; request options cannot retarget it.
 */
export function createServerFetchForActiveServer(
    expectedActiveServer?: ExpectedActiveServerFetchBasis,
    account?: Readonly<{ credentials: AuthCredentials; signal?: AbortSignal; isCurrent?: () => boolean }>,
): ServerResponseRequest {
    const snapshot = getActiveServerSnapshot();
    const basis = expectedActiveServer ?? snapshot;
    const captured = { serverId: basis.serverId, generation: basis.generation };
    const isCurrent = () => {
        const current = getActiveServerSnapshot();
        return current.serverId === captured.serverId && current.generation === captured.generation
            && account?.isCurrent?.() !== false;
    };
    function request(path: string, init?: RequestInit, options?: ServerFetchOptions): Promise<Response>;
    function request<T>(path: string, init: RequestInit | undefined, options: ServerFetchOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
    async function request<T>(path: string, init?: RequestInit, options?: ServerFetchOptions, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
        throwIfAborted(account?.signal);
        if (account && !isCurrent()) throw new StaleServerGenerationError();
        const scopedOptions = { ...options, expectedActiveServer: captured };
        const cancellation = account?.signal ? mergeAbortSignals([account.signal, init?.signal ?? undefined]) : undefined;
        try {
            const scopedInit = cancellation ? { ...init, signal: cancellation.signal } : init;
            return consumeResponse ? await serverFetch(path, scopedInit, scopedOptions, consumeResponse) : await serverFetch(path, scopedInit, scopedOptions);
        } finally { cancellation?.dispose(); }
    }
    if (!account || !isCurrent()) return request;
    const runtimeOrigin = resolveActiveServerRuntimeOrigin(snapshot);
    const homeCarrier = getActiveServerHomeCarrier();
    const observation = captureAccountEncryptionObservationForHome({
        serverId: captured.serverId, endpointUrl: snapshot.serverUrl, credentials: account.credentials,
        isCurrent, signals: [account.signal],
    });
    // Lend only the socket admitted on this exact active publication. Keep the
    // focused request's existing generation/abort owner, not an explicit endpoint path.
    if (!observation || normalizeEndpointBase(observation.runtimeOrigin) !== normalizeEndpointBase(runtimeOrigin)
        || observation.homeCarrierEndpointId !== (homeCarrier?.endpointId ?? null)) return request;
    return bindAccountEncryptionObservation(request, observation);
}

/** Focused-Home compatibility wrapper. All request policy remains in `requestAtEndpoint`. */
export function serverFetch(path: string, init?: RequestInit, options?: ServerFetchOptions): Promise<Response>;
export function serverFetch<T>(path: string, init: RequestInit | undefined, options: ServerFetchOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
export async function serverFetch<T>(
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
    consumeResponse?: (response: Response) => Promise<T>,
): Promise<Response | T> {
    const snapshot = getActiveServerSnapshot();
    // Read from the same publication the snapshot was built from, so a carrier
    // and an origin can never describe different transport generations.
    const homeCarrier = getActiveServerHomeCarrier();
    const context: EndpointRequestContext = {
        endpointUrl: snapshot.serverUrl,
        runtimeOrigin: resolveActiveServerRuntimeOrigin(snapshot),
        ...(homeCarrier ? { homeCarrier } : {}),
        serverId: snapshot.serverId,
        generation: snapshot.generation,
        active: true,
        useStoredCredentials: true,
    };
    return consumeResponse ? await requestAtEndpoint(context, path, init, options, consumeResponse)
        : await requestAtEndpoint(context, path, init, options);
}
