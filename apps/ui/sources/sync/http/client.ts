import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { createEndpointSupervisedRequest } from '@/sync/runtime/connectivity/createEndpointSupervisedRequest';
import { getEndpointSupervisorForServer } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import {
    peekServerReachabilityToken,
    reportServerUnreachable,
    ServerReachabilityWaitTimeoutError,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { readServerReachabilityWaitTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';

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

export class ServerFetchConnectivityTimeoutError extends Error {
    public readonly retryable = false;

    constructor() {
        super('Timed out waiting for server reachability');
        this.name = 'ServerFetchConnectivityTimeoutError';
    }
}

type ServerFetchOptions = Readonly<{
    includeAuth?: boolean;
    /**
     * When `none`, perform a single direct `runtimeFetch` attempt and skip reachability gating and
     * endpoint supervision. This is used by higher-level sync loops that implement their own
     * orchestration/backoff and must not get stuck behind nested connectivity supervisors.
     */
    retry?: 'default' | 'none';
}>;

const inFlightControllers = new Set<AbortController>();
let abortSequence = 0;

const debugLogThrottleMs = 5_000;
const lastDebugLogMsByKey = new Map<string, number>();
let didLogActiveServerSnapshot = false;

export function abortServerFetches(reason: string = 'server-switch'): void {
    abortSequence += 1;
    for (const controller of inFlightControllers) {
        controller.abort(reason);
    }
    inFlightControllers.clear();
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

function isLoopbackHostname(rawHost: string): boolean {
    const host = String(rawHost ?? '').trim().toLowerCase();
    return (
        host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host === '[::1]'
        || host.endsWith('.localhost')
    );
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
    const errorMessage = params.error instanceof Error ? params.error.message : String(params.error ?? '');
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

export async function serverFetch(
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
): Promise<Response> {
    const localAbortSequence = abortSequence;
    const snapshot = getActiveServerSnapshot();
    const normalizedPath = normalizePath(path);
    const requestUrl = normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
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

    const requestController = new AbortController();
    inFlightControllers.add(requestController);
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

    const method = String(init?.method ?? 'GET').toUpperCase();
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
                        ?? (peekServerReachabilityToken(snapshot.serverUrl) ?? null)
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
                        const aborted =
                            requestController.signal.aborted || (error instanceof Error && error.name === 'AbortError');
                        if (aborted) {
                            const reason = (requestController.signal as unknown as { reason?: unknown }).reason;
                            const serverSwitchAbort = reason === 'server-switch' || abortSequence !== localAbortSequence;
                            if (serverSwitchAbort) {
                                throw new ServerFetchAbortedForServerSwitchError();
                            }
                            throw error;
                        }
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
                const aborted =
                    requestController.signal.aborted || (error instanceof Error && error.name === 'AbortError');
                if (aborted) {
                    const reason = (requestController.signal as unknown as { reason?: unknown }).reason;
                    const serverSwitchAbort = reason === 'server-switch' || abortSequence !== localAbortSequence;
                    if (serverSwitchAbort) {
                        throw new ServerFetchAbortedForServerSwitchError();
                    }
                    // Caller aborts should not poison reachability state.
                    throw error;
                }
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

            if (!usedToken || response.status !== 401 || !isActiveOrigin) {
                break;
            }

            // If the active token is rejected, clear it to prevent the UI from getting stuck in a persistent 401 loop.
            // The follow-up request (if any) will re-read credentials and may pick up a refreshed token, or allow the
            // UI to present a clean sign-in state for that server scope.
            try {
                await TokenStorage.invalidateCredentialsTokenForServerUrl(snapshot.serverUrl, usedToken);
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
    } finally {
        removeUpstreamListener();
        inFlightControllers.delete(requestController);
    }

    if (!response) {
        // Defensive: loop always runs at least once, but keep return type strict.
        throw new Error('serverFetch did not attempt the request');
    }
    return response;
}
