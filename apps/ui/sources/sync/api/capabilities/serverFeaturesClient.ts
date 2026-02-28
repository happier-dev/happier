import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import { AsyncTtlCache } from '@happier-dev/protocol';

import { ServerFetchAbortedForServerSwitchError, serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { parseServerFeatures } from './serverFeaturesParse';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

const TTL_READY_MS = 10 * 60 * 1000;
const TTL_UNSUPPORTED_ENDPOINT_MISSING_MS = 60 * 60 * 1000;
const TTL_UNSUPPORTED_INVALID_PAYLOAD_MS = 10 * 60 * 1000;
const TTL_ERROR_NETWORK_MS = 5 * 1000;
const TTL_ERROR_TIMEOUT_MS = 5 * 1000;
const TTL_ERROR_RESPONSE_STATUS_MS = 30 * 1000;

const FORCE_COOLDOWN_ENDPOINT_MISSING_MS = 60 * 1000;

export type ServerFeaturesSnapshot =
    | Readonly<{ status: 'ready'; features: ServerFeatures }>
    | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
    | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status' }>;

const cache = new AsyncTtlCache<ServerFeaturesSnapshot>({
    successTtlMs: TTL_READY_MS,
    errorTtlMs: TTL_ERROR_NETWORK_MS,
});

function isEndpointMissing(status: number): boolean {
    return status === 404 || status === 405 || status === 501;
}

function getCacheTtlMs(snapshot: ServerFeaturesSnapshot): number {
    if (snapshot.status === 'ready') return TTL_READY_MS;
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
            return TTL_ERROR_RESPONSE_STATUS_MS;
        default:
            return TTL_ERROR_NETWORK_MS;
    }
}

function getForceCooldownMs(snapshot: ServerFeaturesSnapshot): number {
    if (snapshot.status === 'unsupported' && snapshot.reason === 'endpoint_missing') {
        return FORCE_COOLDOWN_ENDPOINT_MISSING_MS;
    }
    return 0;
}

function getCacheKey(serverId?: string): string {
    const snapshot = getActiveServerSnapshot();
    const requested = String(serverId ?? '').trim();
    if (!requested) return snapshot.serverId;
    return requested;
}

function normalizeBaseUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return value.replace(/\/+$/, '');
    }
}

function joinBaseAndPath(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}

function isAbortErrorLike(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

async function getServerFeaturesSnapshotWithRetry(
    params: {
        timeoutMs?: number;
        force?: boolean;
        serverId?: string;
    } | undefined,
    remainingSwitchAbortRetries: number,
): Promise<ServerFeaturesSnapshot> {
    const force = params?.force ?? false;
    const timeoutMs = params?.timeoutMs ?? 800;
    const cacheKey = getCacheKey(params?.serverId);
    const requestedServerId = String(params?.serverId ?? '').trim();
    const activeSnapshot = getActiveServerSnapshot();
    const isExplicitServerRequest = requestedServerId.length > 0 && requestedServerId !== activeSnapshot.serverId;
    const explicitServerUrl = isExplicitServerRequest
        ? normalizeBaseUrl(getServerProfileById(requestedServerId)?.serverUrl ?? '')
        : null;

    const cachedEntry = cache.get(cacheKey);
    const cached = cachedEntry?.kind === 'success' ? cachedEntry.value : null;
    if (cached && cachedEntry) {
        const ageMs = Date.now() - cachedEntry.updatedAt;
        const fresh = cache.isFresh(cachedEntry);
        if (fresh) {
            if (!force) return cached;

            const cooldownMs = getForceCooldownMs(cached);
            if (ageMs < cooldownMs) {
                return cached;
            }
        }
    }

    return await cache.runDedupe(cacheKey, async (): Promise<ServerFeaturesSnapshot> => {
        const cachedEntry2 = cache.get(cacheKey);
        const cached2 = cachedEntry2?.kind === 'success' ? cachedEntry2.value : null;
        if (cached2 && cachedEntry2) {
            const ageMs = Date.now() - cachedEntry2.updatedAt;
            const fresh = cache.isFresh(cachedEntry2);
            if (fresh) {
                if (!force) return cached2;
                const cooldownMs = getForceCooldownMs(cached2);
                if (ageMs < cooldownMs) return cached2;
            }
        }

        if (isExplicitServerRequest && !explicitServerUrl) {
            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
            cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
            return value;
        }

        let remainingRetries = remainingSwitchAbortRetries;
        // If a server switch is in-flight, it can cancel multiple feature probes in a row. Treat those aborts as
        // transient and retry a couple times so the UI doesn't get stuck behind a manual "Retry".
        // This is separate from network timeouts (which should still be cached briefly).
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                let response: Response;
                try {
                    response = isExplicitServerRequest
                        ? await runtimeFetch(joinBaseAndPath(explicitServerUrl!, '/v1/features'), {
                            method: 'GET',
                            signal: controller.signal,
                        })
                        : await serverFetch(
                            '/v1/features',
                            {
                                method: 'GET',
                                signal: controller.signal,
                            },
                            { includeAuth: false },
                        );
                } catch (error) {
                    const timedOut = controller.signal.aborted;
                    const aborted = isAbortErrorLike(error);
                    const serverSwitchAbort = error instanceof ServerFetchAbortedForServerSwitchError;

                    if (!isExplicitServerRequest && serverSwitchAbort && remainingRetries > 0) {
                        const current = getActiveServerSnapshot();
                        const activeChanged =
                            current.serverId !== activeSnapshot.serverId || current.generation !== activeSnapshot.generation;
                        remainingRetries -= 1;
                        // If we switched to a different active server, restart the whole flow so caching/dedupe uses
                        // the new server's key. Otherwise, the abort was likely caused by the switch itself racing
                        // with a follow-up probe against the already-selected server.
                        if (activeChanged) {
                            return await getServerFeaturesSnapshotWithRetry(params, remainingRetries);
                        }
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        continue;
                    }

                    if (!timedOut && aborted) {
                        const current = getActiveServerSnapshot();
                        const activeChanged =
                            current.serverId !== activeSnapshot.serverId || current.generation !== activeSnapshot.generation;
                        if (!isExplicitServerRequest && activeChanged && remainingRetries > 0) {
                            remainingRetries -= 1;
                            return await getServerFeaturesSnapshotWithRetry(params, remainingRetries);
                        }
                        // Likely cancelled upstream (e.g. unmount). Do not cache.
                        return { status: 'error', reason: 'network' };
                    }

                    const value: ServerFeaturesSnapshot = { status: 'error', reason: timedOut ? 'timeout' : 'network' };
                    cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                    return value;
                }

                if (!response.ok) {
                    const value: ServerFeaturesSnapshot = isEndpointMissing(response.status)
                        ? { status: 'unsupported', reason: 'endpoint_missing' }
                        : { status: 'error', reason: 'response_status' };
                    cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                    return value;
                }

                const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
                if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
                    const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                    cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                    return value;
                }

                let payload: unknown;
                try {
                    payload = await response.json();
                } catch {
                    const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                    cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                    return value;
                }

                const parsed = parseServerFeatures(payload);
                if (!parsed) {
                    const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                    cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                    return value;
                }

                const value: ServerFeaturesSnapshot = { status: 'ready', features: parsed };
                cache.setSuccess(cacheKey, value, { ttlMs: getCacheTtlMs(value) });
                return value;
            } finally {
                clearTimeout(timer);
            }
        }
    });
}

export async function getServerFeaturesSnapshot(params?: {
    timeoutMs?: number;
    force?: boolean;
    serverId?: string;
}): Promise<ServerFeaturesSnapshot> {
    return await getServerFeaturesSnapshotWithRetry(params, 2);
}

export function getCachedServerFeaturesSnapshot(params?: { serverId?: string }): ServerFeaturesSnapshot | null {
    const cacheKey = getCacheKey(params?.serverId);
    const cached = cache.get(cacheKey);
    return cached?.kind === 'success' ? cached.value : null;
}

export function resetServerFeaturesClientForTests(): void {
    cache.clear();
}
