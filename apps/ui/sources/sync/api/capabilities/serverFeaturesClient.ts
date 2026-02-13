import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { parseServerFeatures } from './serverFeaturesParse';

const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry = Readonly<{ value: ServerFeaturesSnapshot; at: number }>;

export type ServerFeaturesSnapshot =
    | Readonly<{ status: 'ready'; features: ServerFeatures }>
    | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
    | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status' }>;

const cachedByServerId = new Map<string, CacheEntry>();
const inFlightByServerId = new Map<string, Promise<ServerFeaturesSnapshot>>();

function isEndpointMissing(status: number): boolean {
    return status === 404 || status === 405 || status === 501;
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

export async function getServerFeaturesSnapshot(params?: {
    timeoutMs?: number;
    force?: boolean;
    serverId?: string;
}): Promise<ServerFeaturesSnapshot> {
    const force = params?.force ?? false;
    const timeoutMs = params?.timeoutMs ?? 800;
    const cacheKey = getCacheKey(params?.serverId);
    const requestedServerId = String(params?.serverId ?? '').trim();
    const activeSnapshot = getActiveServerSnapshot();
    const isExplicitServerRequest = requestedServerId.length > 0 && requestedServerId !== activeSnapshot.serverId;
    const explicitServerUrl = isExplicitServerRequest
        ? normalizeBaseUrl(getServerProfileById(requestedServerId)?.serverUrl ?? '')
        : null;

    if (!force) {
        const cached = cachedByServerId.get(cacheKey) ?? null;
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return cached.value;
        }
    }

    const inFlight = inFlightByServerId.get(cacheKey);
    if (inFlight) {
        return await inFlight;
    }

    const request = (async (): Promise<ServerFeaturesSnapshot> => {
        if (isExplicitServerRequest && !explicitServerUrl) {
            const value: ServerFeaturesSnapshot = { status: 'error', reason: 'network' };
            cachedByServerId.set(cacheKey, { value, at: Date.now() });
            return value;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = isExplicitServerRequest
                ? await fetch(joinBaseAndPath(explicitServerUrl!, '/v1/features'), {
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

            if (!response.ok) {
                const value: ServerFeaturesSnapshot = isEndpointMissing(response.status)
                    ? { status: 'unsupported', reason: 'endpoint_missing' }
                    : { status: 'error', reason: 'response_status' };
                cachedByServerId.set(cacheKey, { value, at: Date.now() });
                return value;
            }

            const payload = await response.json();
            const parsed = parseServerFeatures(payload);
            if (!parsed) {
                const value: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'invalid_payload' };
                cachedByServerId.set(cacheKey, { value, at: Date.now() });
                return value;
            }

            const value: ServerFeaturesSnapshot = { status: 'ready', features: parsed };
            cachedByServerId.set(cacheKey, { value, at: Date.now() });
            return value;
        } catch (error) {
            const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
            const value: ServerFeaturesSnapshot = { status: 'error', reason: aborted ? 'timeout' : 'network' };
            cachedByServerId.set(cacheKey, { value, at: Date.now() });
            return value;
        } finally {
            clearTimeout(timer);
            inFlightByServerId.delete(cacheKey);
        }
    })();

    inFlightByServerId.set(cacheKey, request);
    return await request;
}

export function getCachedServerFeaturesSnapshot(params?: { serverId?: string }): ServerFeaturesSnapshot | null {
    const cacheKey = getCacheKey(params?.serverId);
    const cached = cachedByServerId.get(cacheKey) ?? null;
    return cached?.value ?? null;
}

export function resetServerFeaturesClientForTests(): void {
    cachedByServerId.clear();
    inFlightByServerId.clear();
}
