import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import * as serverHttp from '@/sync/http/client';
import type { ServerFetch } from '@/sync/http/client';
import {
    ServerFetchAbortedForServerSwitchError,
    StaleServerGenerationError,
} from '@/sync/http/client';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
    reconcileServerProfileHomeConnectionDescriptor,
    setServerProfileIdentityForUrl,
} from '@/sync/domains/server/serverProfiles';
import { decodeServerFeaturesResponse } from './serverFeaturesParse';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { normalizeBaseUrl } from './probeAuthenticatedServerAuthPingEndpoint';
import { isServerFeaturesProbeRetryable } from './serverFeaturesProbeRetryability';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { ResolvedServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';

export { isServerFeaturesProbeRetryable } from './serverFeaturesProbeRetryability';

const TTL_READY_MS = 10 * 60 * 1000;
const TTL_UNSUPPORTED_ENDPOINT_MISSING_MS = 60 * 60 * 1000;
const TTL_UNSUPPORTED_INVALID_PAYLOAD_MS = 10 * 60 * 1000;
const TTL_ERROR_NETWORK_MS = 5 * 1000;
const TTL_ERROR_TIMEOUT_MS = 5 * 1000;
const TTL_ERROR_RESPONSE_STATUS_MS = 30 * 1000;
// A successfully parsed Home descriptor can still describe an active indexing
// transition. Reuse the existing short retry window for transient feature
// observations; this protects readiness freshness without a Search-owned poller.
const TTL_TRANSITIONAL_FEATURE_MS = TTL_ERROR_NETWORK_MS;

export type ServerFeaturesSnapshot =
    | Readonly<{ status: 'ready'; features: ServerFeatures; serverIdentityId?: string | null }>
    | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
    | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status' | 'identity_conflict'; httpStatus?: number }>;

const cache = new AsyncTtlCache<ServerFeaturesSnapshot>({
    successTtlMs: TTL_READY_MS,
    errorTtlMs: TTL_ERROR_NETWORK_MS,
});
// Full descriptors are an authenticated projection, not a replacement for
// public capability discovery. Keep their cache and in-flight work separate so
// pre-auth consumers never inherit a credential requirement.
const authenticatedCache = new AsyncTtlCache<ServerFeaturesSnapshot>({
    successTtlMs: TTL_READY_MS,
    errorTtlMs: TTL_ERROR_NETWORK_MS,
});
// Explicit endpoint probes are diagnostic inputs for their caller, not active
// Home state. Keep their cache and in-flight map separate so a probe cannot
// notify active feature subscribers or collide with an id-scoped entry.
const endpointCache = new AsyncTtlCache<ServerFeaturesSnapshot>({
    successTtlMs: TTL_READY_MS,
    errorTtlMs: TTL_ERROR_NETWORK_MS,
});
const snapshotListeners = new Set<() => void>();
const transientRetryAtByProjectionKey = new Map<string, number>();

function notifyServerFeaturesSnapshotChanged(): void {
    for (const listener of snapshotListeners) {
        listener();
    }
}

function writeServerFeaturesSnapshot(
    cacheKey: string,
    snapshot: ServerFeaturesSnapshot,
    ttlMs: number,
): void {
    transientRetryAtByProjectionKey.delete(`public\u0000${cacheKey}`);
    cache.setSuccess(cacheKey, snapshot, { ttlMs });
    notifyServerFeaturesSnapshotChanged();
}

type ActiveFeatureProjection = 'public' | 'authenticated';

function getActiveProjectionCache(projection: ActiveFeatureProjection): AsyncTtlCache<ServerFeaturesSnapshot> {
    return projection === 'authenticated' ? authenticatedCache : cache;
}

function writeActiveProjectionSnapshot(
    projection: ActiveFeatureProjection,
    cacheKey: string,
    snapshot: ServerFeaturesSnapshot,
    ttlMs: number,
): ServerFeaturesSnapshot {
    const projectionCache = getActiveProjectionCache(projection);
    const retryKey = `${projection}\u0000${cacheKey}`;
    if (isServerFeaturesProbeRetryable(snapshot)) {
        const previous = projectionCache.get(cacheKey);
        if (previous?.kind === 'success' && previous.value.status === 'ready') {
            projectionCache.setSuccess(cacheKey, previous.value, { ttlMs });
            transientRetryAtByProjectionKey.set(retryKey, Date.now() + ttlMs);
            if (projection === 'public') notifyServerFeaturesSnapshotChanged();
            return previous.value;
        }
    }
    transientRetryAtByProjectionKey.delete(retryKey);
    if (projection === 'public') {
        writeServerFeaturesSnapshot(cacheKey, snapshot, ttlMs);
        return snapshot;
    }
    authenticatedCache.setSuccess(cacheKey, snapshot, { ttlMs });
    return snapshot;
}

function writeEndpointServerFeaturesSnapshot(
    cacheKey: string,
    snapshot: ServerFeaturesSnapshot,
    ttlMs: number,
): void {
    endpointCache.setSuccess(cacheKey, snapshot, { ttlMs });
}

export function subscribeServerFeaturesSnapshot(
    listener: () => void,
): () => void {
    snapshotListeners.add(listener);
    return () => {
        snapshotListeners.delete(listener);
    };
}

function isEndpointMissing(status: number): boolean {
    return status === 404 || status === 405 || status === 501;
}

function getCacheTtlMs(snapshot: ServerFeaturesSnapshot): number {
    if (snapshot.status === 'ready') {
        return snapshot.features.capabilities.homeSearch?.reason === 'indexing'
            ? TTL_TRANSITIONAL_FEATURE_MS
            : TTL_READY_MS;
    }
    if (snapshot.status === 'unsupported') {
        return snapshot.reason === 'endpoint_missing'
            ? TTL_UNSUPPORTED_ENDPOINT_MISSING_MS
            : TTL_UNSUPPORTED_INVALID_PAYLOAD_MS;
    }

    // error
    switch (snapshot.reason) {
        case 'timeout':
            return TTL_ERROR_TIMEOUT_MS;
        case 'network':
            return TTL_ERROR_NETWORK_MS;
        case 'response_status':
        case 'identity_conflict':
            return TTL_ERROR_RESPONSE_STATUS_MS;
        default:
            return TTL_ERROR_NETWORK_MS;
    }
}

function getCacheKey(serverId?: string): string {
    const snapshot = getActiveServerSnapshot();
    const requested = String(serverId ?? '').trim();
    if (!requested || areServerProfileIdentifiersEquivalent(requested, snapshot.serverId)) return snapshot.serverId;
    return resolveServerProfileScopeIdForIdentifier(requested);
}

function joinBaseAndPath(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}

/**
 * Explicit endpoint probes are keyed by their stable URL and effective request
 * origin rather than the focused server id. Keep the namespace separate from
 * id-scoped entries in the legacy active-server cache; a URL is allowed to be
 * unknown to the local profile store.
 */
function getEndpointCacheKey(
    endpointUrl: string,
    runtimeOrigin: string,
    homeCarrier?: HomeCarrier,
    expectedServerIdentityId?: string,
): string {
    return `endpoint:${endpointUrl}\u0000identity:${expectedServerIdentityId ?? 'unknown'}\u0000runtime:${runtimeOrigin}\u0000carrier:${homeCarrier?.endpointId ?? 'url'}`;
}

function normalizeExplicitEndpointUrl(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    try {
        const parsed = new URL(value);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function resolveEffectiveProbeRuntimeOrigin(
    endpointUrl: string,
    runtimeOrigin: unknown,
): string {
    const candidate = String(runtimeOrigin ?? '').trim();
    if (!candidate) return endpointUrl;
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
        // Invalid runtime origins use the same stable-endpoint fallback as the
        // explicit request adapter.
    }
    return endpointUrl;
}

function isAbortErrorLike(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

async function resolveExplicitServerFeatureTransport(params: Readonly<{
    serverId: string;
    profile: NonNullable<ReturnType<typeof getServerProfileById>>;
    credentials?: AuthCredentials;
}>): Promise<ResolvedServerScopedTransport | null> {
    // Profiles remain stable identity/routing input only. Runtime transport is
    // acquired from the existing server-scoped authority for the duration of
    // this request and is never written back to the profile.
    if (!params.profile.serverIdentityId || !params.profile.homeConnectionDescriptor) return null;

    const credentials = params.credentials ?? await import('@/auth/storage/tokenStorage')
        .then(async ({ TokenStorage }) => await TokenStorage.getCredentialsForServerUrl(
            params.profile.serverUrl,
            { serverId: params.serverId },
        ));
    if (!credentials) return null;

    // Keep this import lazy: the native Iroh verification probe itself uses
    // this feature client at its explicit endpoint seam. Loading the scoped
    // transport owner only after this module is initialized avoids turning
    // that valid runtime composition into an eager module cycle.
    const { resolveServerScopedTransport } = await import(
        '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport'
    );
    return await resolveServerScopedTransport({
        profile: params.profile,
        credentials,
    });
}

async function drainExplicitServerFeatureTransportReleaseCustody(): Promise<void> {
    const { drainRetainedHomeCarrierReleases } = await import(
        '@/sync/runtime/homeCarrierPolicy'
    );
    await drainRetainedHomeCarrierReleases();
}

async function getServerFeaturesSnapshotWithRetry(
    params: {
        timeoutMs?: number;
        force?: boolean;
        serverId?: string;
        projection?: ActiveFeatureProjection;
        credentials?: AuthCredentials;
        scopedTransport?: ResolvedServerScopedTransport;
        signal?: AbortSignal;
    } | undefined,
): Promise<ServerFeaturesSnapshot> {
    const force = params?.force ?? false;
    const projection = params?.projection ?? 'public';
    const projectionCache = getActiveProjectionCache(projection);
    const cacheKey = getCacheKey(params?.serverId);
    const requestedServerId = String(params?.serverId ?? '').trim();
    let activeSnapshot = getActiveServerSnapshot();
    // Read at request time, not once: the focused Home's transport publication
    // can be replaced between retries, exactly like `activeSnapshot` itself.
    const readActiveHomeCarrier = () => {
        const homeCarrier = getActiveServerHomeCarrier();
        return homeCarrier ? { homeCarrier } : null;
    };
    const isExplicitServerRequest = requestedServerId.length > 0
        && !areServerProfileIdentifiersEquivalent(requestedServerId, activeSnapshot.serverId);
    const explicitServerId = isExplicitServerRequest ? resolveServerProfileScopeIdForIdentifier(requestedServerId) : '';
    const explicitServerProfile = isExplicitServerRequest
        ? getServerProfileById(explicitServerId)
        : null;
    const explicitServerUrl = isExplicitServerRequest
        ? normalizeBaseUrl(explicitServerProfile?.serverUrl ?? '')
        : null;

    // A previous explicit probe can finish its feature response before its
    // request-scoped transport release rejects. Retry that retained cleanup at
    // the next explicit Iroh operation boundary, before a cached feature result
    // can bypass transport ownership entirely. A repeated cleanup failure stays
    // retained and does not invalidate an otherwise valid cached observation.
    if (isExplicitServerRequest && explicitServerProfile?.homeConnectionDescriptor?.endpoints.some((endpoint) => endpoint.kind === 'iroh')) {
        await drainExplicitServerFeatureTransportReleaseCustody();
    }

    const cachedEntry = projectionCache.get(cacheKey);
    const cached = cachedEntry?.kind === 'success' ? cachedEntry.value : null;
    if (!force && cached && cachedEntry && projectionCache.isFresh(cachedEntry)) return cached;

    return await projectionCache.runDedupe(cacheKey, async ({ signal, isCurrent }): Promise<ServerFeaturesSnapshot> => {
        const publishSnapshot = (value: ServerFeaturesSnapshot, key = cacheKey): ServerFeaturesSnapshot => {
            return isCurrent()
                ? writeActiveProjectionSnapshot(projection, key, value, getCacheTtlMs(value))
                : value;
        };
        const cachedEntry2 = projectionCache.get(cacheKey);
        const cached2 = cachedEntry2?.kind === 'success' ? cachedEntry2.value : null;
        if (!force && cached2 && cachedEntry2 && projectionCache.isFresh(cachedEntry2)) return cached2;

        if (isExplicitServerRequest && !explicitServerUrl) {
            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
            return publishSnapshot(value);
        }

        // Public current-Home observations survive transport-owner retirement. Authenticated
        // observations retain their captured Account/Home; ordinary network failures still settle.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            throwIfAborted(signal);
            let releaseExplicitTransport: (() => Promise<void>) | null = null;

            try {
                let response: Response;
                let descriptorObservation: 'exact' | 'public' = 'public';
                try {
                    const probedServerUrl = isExplicitServerRequest
                        ? explicitServerUrl!
                        : activeSnapshot.serverUrl;
                    recordAccountStoredContentServerRequirements({
                        serverUrl: probedServerUrl,
                        requirements: undefined,
                    });
                    if (isExplicitServerRequest) {
                        const transport = params?.scopedTransport ?? (explicitServerProfile
                            ? await resolveExplicitServerFeatureTransport({
                                serverId: explicitServerId,
                                profile: explicitServerProfile,
                                credentials: params?.credentials,
                            })
                            : null);
                        if (transport) {
                            // A caller-supplied scoped transport belongs to that
                            // secondary runtime. Only request-local acquisitions
                            // are released by the feature client.
                            if (!params?.scopedTransport) {
                                releaseExplicitTransport = transport.release;
                            }
                            const request = serverHttp.createServerFetchAtEndpoint({
                                endpointUrl: transport.canonicalServerUrl,
                                runtimeOrigin: transport.runtimeOrigin,
                                ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                                serverId: explicitServerId,
                                ...(projection === 'public'
                                    ? { credentials: null }
                                    : params?.credentials
                                        ? { credentials: params.credentials }
                                        : {}),
                            });
                            response = await request(
                                projection === 'authenticated' ? '/v1/features/authenticated' : '/v1/features',
                                {
                                    method: 'GET',
                                    signal,
                                },
                                { includeAuth: projection === 'authenticated', retry: 'none' },
                            );
                            if (projection === 'authenticated') {
                                if (isEndpointMissing(response.status)) {
                                    response = await request(
                                        '/v1/features',
                                        {
                                            method: 'GET',
                                            signal,
                                        },
                                        { includeAuth: false, retry: 'none' },
                                    );
                                } else if (response.ok) {
                                    descriptorObservation = 'exact';
                                }
                            }
                        } else {
                            response = await runtimeFetchWithServerReachability({
                                serverUrl: explicitServerUrl!,
                                ...(explicitServerProfile?.serverIdentityId
                                    ? { homeIdentityId: explicitServerProfile.serverIdentityId }
                                    : {}),
                                token: null,
                                url: joinBaseAndPath(
                                    explicitServerUrl!,
                                    projection === 'authenticated' ? '/v1/features/authenticated' : '/v1/features',
                                ),
                                init: {
                                    method: 'GET',
                                    signal,
                                    ...(projection === 'authenticated' && params?.credentials?.token
                                        ? { headers: { Authorization: `Bearer ${params.credentials.token}` } }
                                        : {}),
                                },
                            });
                            if (projection === 'authenticated') {
                                if (isEndpointMissing(response.status)) {
                                    response = await runtimeFetchWithServerReachability({
                                        serverUrl: explicitServerUrl!,
                                        ...(explicitServerProfile?.serverIdentityId
                                            ? { homeIdentityId: explicitServerProfile.serverIdentityId }
                                            : {}),
                                        token: null,
                                        url: joinBaseAndPath(explicitServerUrl!, '/v1/features'),
                                        init: {
                                            method: 'GET',
                                            signal,
                                        },
                                    });
                                } else if (response.ok) {
                                    descriptorObservation = 'exact';
                                }
                            }
                        }
                    } else {
                        response = projection === 'authenticated'
                            ? await serverHttp.createServerFetchAtEndpoint({
                                endpointUrl: params?.scopedTransport?.canonicalServerUrl
                                    ?? activeSnapshot.serverUrl,
                                runtimeOrigin: params?.scopedTransport?.runtimeOrigin
                                    ?? activeSnapshot.runtimeOrigin,
                                // An ingress-less Home has no URL a platform fetch
                                // can reach; discovery uses the same carrier the
                                // requests do, while the canonical URL stays the
                                // cache and profile key.
                                ...(params?.scopedTransport?.homeCarrier
                                    ? { homeCarrier: params.scopedTransport.homeCarrier }
                                    : (readActiveHomeCarrier() ?? {})),
                                serverId: activeSnapshot.serverId,
                                credentials: params?.credentials,
                            })(
                                '/v1/features/authenticated',
                                {
                                    method: 'GET',
                                    signal,
                                },
                                { includeAuth: true, retry: 'none' },
                            )
                            : await serverHttp.serverFetch(
                                '/v1/features',
                                {
                                    method: 'GET',
                                    signal,
                                },
                                // Public discovery must remain usable before a Home credential exists.
                                { includeAuth: false, retry: 'none' },
                            );
                    }
                    if (!isExplicitServerRequest && projection === 'authenticated') {
                        if (isEndpointMissing(response.status)) {
                            response = await serverHttp.createServerFetchAtEndpoint({
                                endpointUrl: params?.scopedTransport?.canonicalServerUrl
                                    ?? activeSnapshot.serverUrl,
                                runtimeOrigin: params?.scopedTransport?.runtimeOrigin
                                    ?? activeSnapshot.runtimeOrigin,
                                ...(params?.scopedTransport?.homeCarrier
                                    ? { homeCarrier: params.scopedTransport.homeCarrier }
                                    : (readActiveHomeCarrier() ?? {})),
                                serverId: activeSnapshot.serverId,
                                credentials: params?.credentials,
                            })(
                                '/v1/features',
                                {
                                    method: 'GET',
                                    signal,
                                },
                                { includeAuth: false, retry: 'none' },
                            );
                        } else if (response.ok) {
                            descriptorObservation = 'exact';
                        }
                    }
                } catch (error) {
                    throwIfAborted(signal);
                    const aborted = isAbortErrorLike(error);
                    const serverSwitchFailure =
                        error instanceof ServerFetchAbortedForServerSwitchError
                        || error instanceof StaleServerGenerationError;

                    const current = getActiveServerSnapshot();
                    const activeChanged = current.serverId !== activeSnapshot.serverId
                        || current.generation !== activeSnapshot.generation;
                    // A Home-scoped reader must not adopt its successor or write the successor's
                    // capabilities under the retired Home's key. An unscoped reader follows focus.
                    if (!isExplicitServerRequest && projection === 'public' && requestedServerId
                        && (serverSwitchFailure || (aborted && activeChanged))
                        && !areServerProfileIdentifiersEquivalent(requestedServerId, current.serverId)) {
                        return { status: 'error', reason: 'network' };
                    }
                    if (!isExplicitServerRequest && projection === 'public' && serverSwitchFailure) {
                        // A different cache key must enter its own dedupe owner. A generation-only
                        // change keeps this entry; re-entering it would await the current probe.
                        if (activeChanged) {
                            if (getCacheKey(params?.serverId) !== cacheKey) {
                                return await getServerFeaturesSnapshotWithRetry({ ...params, signal });
                            }
                            activeSnapshot = current;
                            continue;
                        }
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        continue;
                    }

                    if (aborted) {
                        if (!isExplicitServerRequest && projection === 'public' && activeChanged) {
                            if (getCacheKey(params?.serverId) !== cacheKey) {
                                return await getServerFeaturesSnapshotWithRetry({ ...params, signal });
                            }
                            activeSnapshot = current;
                            continue;
                        }
                        // Likely cancelled upstream (e.g. unmount). Do not cache.
                        return { status: 'error', reason: 'network' };
                    }

                    const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
                    return publishSnapshot(value);
                }

                throwIfAborted(signal);
                if (!response.ok) {
                    const value: ServerFeaturesSnapshot = isEndpointMissing(response.status)
                        ? { status: 'unsupported', reason: 'endpoint_missing' }
                        : { status: 'error', reason: 'response_status', httpStatus: response.status };
                    return publishSnapshot(value);
                }

                const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
                if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
                    const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                    return publishSnapshot(value);
                }

                const parsed = await decodeServerFeaturesResponse(response);
                throwIfAborted(signal);
                if (!parsed) {
                    const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                    return publishSnapshot(value);
                }

                const serverIdentityId = parsed.capabilities.serverIdentity.serverIdentityId;
                if (serverIdentityId) {
                    const observedServerUrl = isExplicitServerRequest ? explicitServerUrl! : activeSnapshot.serverUrl;
                    const learnedProfile = await setServerProfileIdentityForUrl(
                        observedServerUrl,
                        serverIdentityId,
                    );
                    throwIfAborted(signal);
                    if (!learnedProfile) {
                        const value: ServerFeaturesSnapshot = { status: 'error', reason: 'identity_conflict' };
                        return publishSnapshot(value);
                    }
                    if (
                        learnedProfile.serverIdentityId === serverIdentityId
                        && parsed.homeConnectionDescriptor
                    ) {
                        const reconciliation = await reconcileServerProfileHomeConnectionDescriptor({
                            serverUrl: observedServerUrl,
                            observedServerIdentityId: serverIdentityId,
                            descriptor: parsed.homeConnectionDescriptor,
                            observation: descriptorObservation,
                        });
                        throwIfAborted(signal);
                        if (reconciliation.kind === 'conflict') {
                            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'identity_conflict' };
                            return publishSnapshot(value);
                        }
                    }
                }

                const value: ServerFeaturesSnapshot = {
                    status: 'ready',
                    features: parsed,
                    serverIdentityId,
                };
                recordAccountStoredContentServerRequirements({
                    serverUrl: isExplicitServerRequest
                        ? explicitServerUrl!
                        : activeSnapshot.serverUrl,
                    requirements:
                        parsed.capabilities.accountStoredContentCompatibility,
                });
                publishSnapshot(value);
                // Learning a stable server identity can synchronously change
                // the active/profile scope key. Publish the same observed
                // snapshot under that canonical key before returning so an
                // immediate identity-scoped consumer cannot miss the ready
                // result and fail closed on a transient null cache entry.
                // Keep the captured key until its TTL expires: deleting it
                // here would also remove this still-running dedupe entry.
                const canonicalCacheKey = getCacheKey(params?.serverId);
                if (canonicalCacheKey !== cacheKey) {
                    publishSnapshot(value, canonicalCacheKey);
                }
                return value;
            } finally {
                if (releaseExplicitTransport) await releaseExplicitTransport();
            }
        }
    }, { signal: params?.signal });
}

async function waitForServerFeaturesSnapshot(
    request: (signal: AbortSignal) => Promise<ServerFeaturesSnapshot>,
    waitBudgetMs: number | undefined,
    signal?: AbortSignal,
): Promise<ServerFeaturesSnapshot> {
    if (signal?.aborted) return { status: 'error', reason: 'network' };
    return await new Promise<ServerFeaturesSnapshot>((resolve, reject) => {
        const observer = new AbortController();
        let settled = false;
        let cancelTimer: (() => void) | null = null;
        const cleanup = () => {
            cancelTimer?.();
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (snapshot: ServerFeaturesSnapshot) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(snapshot);
        };
        const onAbort = () => {
            finish({ status: 'error', reason: 'network' });
            observer.abort(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (typeof waitBudgetMs === 'number' && Number.isFinite(waitBudgetMs) && waitBudgetMs > 0) {
            cancelTimer = armDeadlineTimer(Date.now() + waitBudgetMs, () => {
                finish({ status: 'error', reason: 'timeout' });
                observer.abort();
            });
        }
        // Cancellation also settles a caller still preparing an explicit transport, before it
        // reaches dedupe. The signal retires its shared demand whenever preparation completes.
        void request(observer.signal).then(finish, (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}

/**
 * Fresh authenticated observation used by enrollment and credential-verification transactions.
 * It deliberately bypasses reusable feature caches while keeping endpoint ownership and decoding
 * inside the canonical feature client.
 */
export async function observeAuthenticatedServerFeaturesFresh(params: Readonly<{
    request: ServerFetch;
    timeoutMs?: number;
}>): Promise<ServerFeaturesSnapshot> {
    try {
        const response = await params.request(
            '/v1/features/authenticated',
            { method: 'GET' },
            { includeAuth: true, retry: 'none', ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) },
        );
        if (!response.ok) {
            return isEndpointMissing(response.status)
                ? { status: 'unsupported', reason: 'endpoint_missing' }
                : { status: 'error', reason: 'response_status', httpStatus: response.status };
        }
        const parsed = await decodeServerFeaturesResponse(response);
        if (!parsed) return { status: 'unsupported', reason: 'invalid_payload' };
        return {
            status: 'ready',
            features: parsed,
            serverIdentityId: parsed.capabilities.serverIdentity.serverIdentityId,
        };
    } catch {
        return { status: 'error', reason: 'network' };
    }
}

export async function getServerFeaturesSnapshot(params?: {
    /** Stop this caller's wait early only when it has its own fallback. Omit to await the shared attempt. */
    timeoutMs?: number;
    force?: boolean;
    serverId?: string;
    /** Cancels this waiter without aborting other consumers' shared request. */
    signal?: AbortSignal;
}): Promise<ServerFeaturesSnapshot> {
    return await waitForServerFeaturesSnapshot(
        (signal) => getServerFeaturesSnapshotWithRetry({ ...params, signal, projection: 'public' }),
        params?.timeoutMs,
        params?.signal,
    );
}

/**
 * Refresh the focused Home's full descriptor after authentication has already
 * succeeded. Older Homes fall back to the public projection; pre-auth feature
 * consumers continue to use `getServerFeaturesSnapshot`.
 */
export async function refreshAuthenticatedServerFeaturesSnapshot(params: {
    credentials: AuthCredentials;
    timeoutMs?: number;
    force?: boolean;
    serverId?: string;
    /** Existing secondary-runtime transport; ownership remains with the caller. */
    scopedTransport?: ResolvedServerScopedTransport;
    signal?: AbortSignal;
}): Promise<ServerFeaturesSnapshot> {
    return await waitForServerFeaturesSnapshot((signal) => getServerFeaturesSnapshotWithRetry({
        ...params, signal, projection: 'authenticated',
    }), params.timeoutMs, params.signal);
}

export function getCachedServerFeaturesSnapshot(params?: { serverId?: string }): ServerFeaturesSnapshot | null {
    const cacheKey = getCacheKey(params?.serverId);
    const cached = cache.get(cacheKey);
    return cached?.kind === 'success' ? cached.value : null;
}

export function getServerFeaturesSnapshotRetryDelayMs(params: {
    serverId?: string;
    snapshot: ServerFeaturesSnapshot;
}): number | null {
    const transientRetryAt = transientRetryAtByProjectionKey.get(`public\u0000${getCacheKey(params.serverId)}`);
    if (transientRetryAt !== undefined) {
        return Math.max(0, transientRetryAt - Date.now());
    }
    const shouldRetry = params.snapshot.status === 'error'
        || (
            params.snapshot.status === 'ready'
            && params.snapshot.features.capabilities.homeSearch?.reason === 'indexing'
        );
    if (!shouldRetry) return null;
    const cached = cache.get(getCacheKey(params.serverId));
    if (cached?.kind !== 'success' || cached.value !== params.snapshot) {
        return getCacheTtlMs(params.snapshot);
    }
    return Math.max(0, cached.expiresAt - Date.now());
}

export function primeServerFeaturesSnapshot(params: {
    serverId?: string;
    snapshot: ServerFeaturesSnapshot;
    ttlMs?: number;
}): void {
    writeServerFeaturesSnapshot(
        getCacheKey(params.serverId),
        params.snapshot,
        params.ttlMs ?? getCacheTtlMs(params.snapshot),
    );
}

export function deleteServerFeaturesSnapshot(params?: { serverId?: string }): void {
    const cacheKey = getCacheKey(params?.serverId);
    cache.delete(cacheKey);
    transientRetryAtByProjectionKey.delete(`public\u0000${cacheKey}`);
    notifyServerFeaturesSnapshotChanged();
}

export type ProbeServerFeaturesAtUrlOptions = Readonly<{
    /**
     * How long this caller waits for the shared request before acting on its own fallback.
     * Omit (or use `0`) to wait for the shared request.
     * A shorter budget is opt-in and requires a real fallback at the caller.
     */
    timeoutMs?: number;
    /** Force a refresh even when a URL-scoped snapshot is still fresh. */
    force?: boolean;
    /** Stable profile/identity hint used only for credential/reachability scoping. */
    serverId?: string;
    /** Request-only transport origin (for example an Iroh loopback origin). */
    runtimeOrigin?: string | null;
    /** Semantic browser Iroh carrier, where a loopback runtime origin cannot exist. */
    homeCarrier?: HomeCarrier;
    /** Cancels this waiter without aborting other consumers' shared request or changing focus. */
    signal?: AbortSignal;
}>;

export type ProbeServerFeaturesAtUrlInput = ProbeServerFeaturesAtUrlOptions & {
    /** Canonical spelling used by the endpoint contracts. */
    endpointUrl?: string;
    /** Compatibility spelling retained by the earlier probe helper contract. */
    serverUrl?: string;
};

function normalizeProbeServerFeaturesArgs(
    endpointOrInput: string | ProbeServerFeaturesAtUrlInput,
    options?: ProbeServerFeaturesAtUrlOptions,
): ProbeServerFeaturesAtUrlInput {
    if (typeof endpointOrInput === 'string') {
        return {
            endpointUrl: endpointOrInput,
            ...(options ?? {}),
        };
    }
    return {
        ...endpointOrInput,
        endpointUrl: endpointOrInput.endpointUrl ?? endpointOrInput.serverUrl ?? '',
    };
}

/**
 * Probe a Home/Account Service at an explicit endpoint. This is intentionally
 * independent from the focused-server snapshot/profile path: the URL is the
 * request's stable audience and the optional runtime origin is transport-only.
 * The result records observed identity, but does not adopt it into profiles or
 * change focus.
 */
export async function probeServerFeaturesAtUrl(
    endpointUrl: string,
    options?: ProbeServerFeaturesAtUrlOptions,
): Promise<ServerFeaturesSnapshot>;
export async function probeServerFeaturesAtUrl(
    input: ProbeServerFeaturesAtUrlInput,
): Promise<ServerFeaturesSnapshot>;
export async function probeServerFeaturesAtUrl(
    endpointOrInput: string | ProbeServerFeaturesAtUrlInput,
    options?: ProbeServerFeaturesAtUrlOptions,
): Promise<ServerFeaturesSnapshot> {
    const input = normalizeProbeServerFeaturesArgs(endpointOrInput, options);
    const endpointUrl = normalizeExplicitEndpointUrl(input.endpointUrl);
    const runtimeOrigin = resolveEffectiveProbeRuntimeOrigin(endpointUrl, input.runtimeOrigin);
    const cacheKey = getEndpointCacheKey(
        endpointUrl,
        runtimeOrigin,
        input.homeCarrier,
        String(input.serverId ?? '').trim() || undefined,
    );
    const force = input.force ?? false;

    const cachedEntry = endpointCache.get(cacheKey);
    const cached = cachedEntry?.kind === 'success' ? cachedEntry.value : null;
    if (!force && cached && cachedEntry && endpointCache.isFresh(cachedEntry)) return cached;

    const observe = (observerSignal: AbortSignal) => endpointCache.runDedupe(cacheKey, async ({ signal, isCurrent }): Promise<ServerFeaturesSnapshot> => {
        const publishSnapshot = (value: ServerFeaturesSnapshot): ServerFeaturesSnapshot => {
            if (isCurrent()) writeEndpointServerFeaturesSnapshot(cacheKey, value, getCacheTtlMs(value));
            return value;
        };
        const cachedEntry2 = endpointCache.get(cacheKey);
        const cached2 = cachedEntry2?.kind === 'success' ? cachedEntry2.value : null;
        if (!force && cached2 && cachedEntry2 && endpointCache.isFresh(cachedEntry2)) return cached2;

        if (!endpointUrl) {
            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
            return publishSnapshot(value);
        }

        recordAccountStoredContentServerRequirements({
            serverUrl: endpointUrl,
            requirements: undefined,
        });
        const request = serverHttp.createServerFetchAtEndpoint({
            endpointUrl,
            runtimeOrigin,
            ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
            serverId: input.serverId,
            // A feature probe is intentionally unauthenticated. Passing null
            // also prevents a scoped credential lookup if a future caller
            // omits includeAuth on the request adapter.
            credentials: null,
        });

        let response: Response;
        try {
            response = await request(
                '/v1/features',
                {
                    method: 'GET',
                    signal,
                },
                { includeAuth: false, retry: 'none' },
            );
        } catch (error) {
            throwIfAborted(signal);
            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
            return publishSnapshot(value);
        }

        throwIfAborted(signal);
        if (!response.ok) {
            const value: ServerFeaturesSnapshot = isEndpointMissing(response.status)
                ? { status: 'unsupported', reason: 'endpoint_missing' }
                : { status: 'error', reason: 'response_status', httpStatus: response.status };
            return publishSnapshot(value);
        }

        const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
        if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
            const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
            return publishSnapshot(value);
        }

        const parsed = await decodeServerFeaturesResponse(response);
        throwIfAborted(signal);
        if (!parsed) {
            const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
            return publishSnapshot(value);
        }

        const serverIdentityId = parsed.capabilities.serverIdentity.serverIdentityId;
        const value: ServerFeaturesSnapshot = {
            status: 'ready',
            features: parsed,
            serverIdentityId,
        };
        recordAccountStoredContentServerRequirements({
            serverUrl: endpointUrl,
            requirements: parsed.capabilities.accountStoredContentCompatibility,
        });
        return publishSnapshot(value);
    }, { signal: observerSignal });
    return await waitForServerFeaturesSnapshot(observe, input.timeoutMs, input.signal);
}

export function resetServerFeaturesClientForTests(): void {
    cache.clear();
    authenticatedCache.clear();
    endpointCache.clear();
    transientRetryAtByProjectionKey.clear();
    notifyServerFeaturesSnapshotChanged();
}
