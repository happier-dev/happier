import { AsyncTtlCache, ServerRetentionPolicyV2Schema } from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';
import { getServerFeaturesSnapshot } from './serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { normalizeBaseUrl } from './probeAuthenticatedServerAuthPingEndpoint';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    normalizeServerRetentionPolicyV2,
    readServerRetentionPolicy,
    type ServerRetentionPolicyView,
} from '@/sync/domains/server/retention/serverRetentionPolicy';

const cache = new AsyncTtlCache<ServerRetentionPolicyView | null>({
    successTtlMs: 10 * 60 * 1000,
    errorTtlMs: 5 * 1000,
});

function joinBaseAndPath(baseUrl: string, path: string): string {
    return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

export async function getServerRetentionPolicy(params?: {
    serverId?: string;
    force?: boolean;
    timeoutMs?: number;
}): Promise<ServerRetentionPolicyView | null> {
    const active = getActiveServerSnapshot();
    const requested = String(params?.serverId ?? '').trim();
    const explicit = requested.length > 0 && !areServerProfileIdentifiersEquivalent(requested, active.serverId);
    const cacheKey = explicit ? resolveServerProfileScopeIdForIdentifier(requested) : active.serverId;

    const cached = cache.get(cacheKey);
    if (!params?.force && cached?.kind === 'success' && cache.isFresh(cached)) return cached.value;

    return await cache.runDedupe(cacheKey, async () => {
        const features = await getServerFeaturesSnapshot({ serverId: requested || undefined });
        const fallback = features.status === 'ready' ? readServerRetentionPolicy(features.features) : null;
        const explicitUrl = explicit
            ? normalizeBaseUrl(getServerProfileById(cacheKey)?.serverUrl ?? '')
            : null;
        if (explicit && !explicitUrl) {
            cache.setSuccess(cacheKey, fallback);
            return fallback;
        }

        const controller = new AbortController();
        const timeoutMs = params?.timeoutMs ?? 1_500;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = explicit
                ? await runtimeFetchWithServerReachability({
                    serverUrl: explicitUrl!,
                    token: null,
                    url: joinBaseAndPath(explicitUrl!, '/v2/retention-policy'),
                    init: { method: 'GET', signal: controller.signal },
                    timeoutMs,
                })
                : await serverFetch(
                    '/v2/retention-policy',
                    { method: 'GET', signal: controller.signal },
                    { includeAuth: false, retry: 'none' },
                );
            if (!response.ok) {
                cache.setSuccess(cacheKey, fallback);
                return fallback;
            }
            const parsed = ServerRetentionPolicyV2Schema.safeParse(await response.json());
            const value = parsed.success ? normalizeServerRetentionPolicyV2(parsed.data) : fallback;
            cache.setSuccess(cacheKey, value);
            return value;
        } catch {
            cache.setSuccess(cacheKey, fallback, { ttlMs: 5_000 });
            return fallback;
        } finally {
            clearTimeout(timer);
        }
    });
}

export function getCachedServerRetentionPolicy(serverId?: string): ServerRetentionPolicyView | null {
    const active = getActiveServerSnapshot();
    const requested = String(serverId ?? '').trim();
    const cacheKey = requested && !areServerProfileIdentifiersEquivalent(requested, active.serverId)
        ? resolveServerProfileScopeIdForIdentifier(requested)
        : active.serverId;
    const cached = cache.get(cacheKey);
    return cached?.kind === 'success' ? cached.value : null;
}

export function resetServerRetentionPolicyClientForTests(): void {
    cache.clear();
}
