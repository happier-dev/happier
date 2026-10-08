import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol/crypto/publicShareCapabilityUrl';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { createEndpointSupervisedRequest } from '@/sync/runtime/connectivity/createEndpointSupervisedRequest';
import { getEndpointSupervisorForServer } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import {
    reportServerUnreachable,
    ServerReachabilityWaitTimeoutError,
    invalidateServerReachabilitySupervisor,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    readServerReachabilityWaitTimeoutMs,
} from '@/sync/runtime/connectivity/serverReachabilityTuning';
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

export class ServerFetchConnectivityTimeoutError extends Error {
    constructor() {
        super('Timed out waiting for server reachability');
        this.name = 'ServerFetchConnectivityTimeoutError';
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
    includeAuth?: boolean;
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
    /**
     * When `none`, perform a single direct `runtimeFetch` attempt and skip reachability gating and
     * endpoint supervision. This is used by higher-level sync loops that implement their own
     * orchestration/backoff and must not get stuck behind nested connectivity supervisors.
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

const inFlightControllers = new Set<AbortController>();
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

async function requestAtEndpoint(
    context: EndpointRequestContext,
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
): Promise<Response> {
    const localAbortSequence = context.active ? abortSequence : null;
    const usesReachabilitySupervision = context.active || context.superviseReachability === true;
    const recoversStoredCredentials = context.active || context.recoverStoredCredentials === true;
    assertRequestContextCurrent(context);
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
    if (context.active) inFlightControllers.add(requestController);
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

    const method = String(init?.method ?? 'GET').toUpperCase();
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
    const endpointSupervisor =
        isSupervisedOrigin
            ? getEndpointSupervisorForServer({ serverId: context.serverId, serverUrl: context.endpointUrl })
            : null;
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
                            timeoutMs: readServerReachabilityWaitTimeoutMs(),
                            acceptAuthFailed: true,
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
                                reportServerUnreachable(context.endpointUrl, error, tokenForReachability);
                                throw new ServerFetchWriteTimeoutError();
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
                        serverId: context.serverId,
                        serverUrl: transportOrigin,
                        token: usedToken,
                        endpointSupervisor,
                        ...(homeCarrier ? { homeCarrier } : {}),
                    });
                    markIssued();
                    response = await supervisedFetch(requestUrl, {
                        ...init,
                        headers,
                        signal: requestController.signal,
                    });
                } else if (homeCarrier) {
                    markIssued();
                    response = await homeCarrier.request(requestUrl, {
                        ...init,
                        headers,
                        signal: requestController.signal,
                    });
                } else {
                    markIssued();
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
                    reportServerUnreachable(context.endpointUrl, error, usedToken);
                        throw new ServerFetchWriteTimeoutError();
                    }
                    // Caller aborts should not poison reachability state.
                    throw error;
                }
                if (error instanceof ServerFetchConnectivityTimeoutError) {
                    // Reachability wait timeouts already represent a "paused/offline" state; do not report an extra
                    // transport failure which can reset backoff scheduling.
                    throw error;
                }
                reportServerUnreachable(context.endpointUrl, error, usedToken);
                throw error;
            }

            assertRequestContextCurrent(context);

            if (!usedToken || response.status !== 401 || !isSupervisedOrigin) {
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
                    if (method !== 'GET' && method !== 'HEAD') {
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
            if (attempt !== 0 || (method !== 'GET' && method !== 'HEAD')) {
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
    } finally {
        if (writeTimeoutHandle) {
            clearTimeout(writeTimeoutHandle);
        }
        for (const removeUpstreamListener of removeUpstreamListeners) {
            removeUpstreamListener();
        }
        if (context.active) inFlightControllers.delete(requestController);
    }

    if (!response) {
        // Defensive: loop always runs at least once, but keep return type strict.
        throw new Error('serverFetch did not attempt the request');
    }
    return response;
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
): ServerFetch {
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

    return async (path, init, options) => await requestAtEndpoint(context, path, init, options);
}

/**
 * Capture the focused Home once for a containing operation. Retries and compatibility
 * fallbacks retain that admitted basis; request options cannot retarget it.
 */
export function createServerFetchForActiveServer(
    expectedActiveServer?: ExpectedActiveServerFetchBasis,
): ServerFetch {
    const basis = expectedActiveServer ?? getActiveServerSnapshot();
    const captured = { serverId: basis.serverId, generation: basis.generation };
    return async (path, init, options) => await serverFetch(path, init, {
        ...options,
        expectedActiveServer: captured,
    });
}

/** Focused-Home compatibility wrapper. All request policy remains in `requestAtEndpoint`. */
export async function serverFetch(
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
): Promise<Response> {
    const snapshot = getActiveServerSnapshot();
    // Read from the same publication the snapshot was built from, so a carrier
    // and an origin can never describe different transport generations.
    const homeCarrier = getActiveServerHomeCarrier();
    return await requestAtEndpoint(
        {
            endpointUrl: snapshot.serverUrl,
            runtimeOrigin: resolveActiveServerRuntimeOrigin(snapshot),
            ...(homeCarrier ? { homeCarrier } : {}),
            serverId: snapshot.serverId,
            generation: snapshot.generation,
            active: true,
            useStoredCredentials: true,
        },
        path,
        init,
        options,
    );
}
