import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { ServerRetentionPolicyV2Schema } from '@happier-dev/protocol/retention/serverRetentionPolicyV2';

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

const cache = new AsyncTtlCache<ServerRetentionPolicyView>({
    successTtlMs: 10 * 60 * 1000,
    errorTtlMs: 5 * 1000,
});

/**
 * One read of a Home's retention policy. `failed` means the policy could not be read (the Home did
 * not answer, answered with an error, or sent a policy this client cannot parse): a reader shows
 * that it could not read it, never a verdict from the features snapshot.
 */
export type ServerRetentionPolicyRead =
    | Readonly<{ status: 'ready'; policy: ServerRetentionPolicyView }>
    | Readonly<{ status: 'failed' }>;

function joinBaseAndPath(baseUrl: string, path: string): string {
    return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

/**
 * Reads the complete `/v2/retention-policy`. How long it may wait is the transport owners' budget
 * (`serverFetch`, or the reachability runtime for another saved Home), not a cutoff of its own. An
 * older Home without the endpoint (404) answers with its features snapshot, which is explicitly
 * incomplete (`legacy_partial`).
 */
export async function getServerRetentionPolicy(params?: {
    serverId?: string;
    force?: boolean;
}): Promise<ServerRetentionPolicyRead> {
    const active = getActiveServerSnapshot();
    const requested = String(params?.serverId ?? '').trim();
    const explicit = requested.length > 0 && !areServerProfileIdentifiersEquivalent(requested, active.serverId);
    const cacheKey = explicit ? resolveServerProfileScopeIdForIdentifier(requested) : active.serverId;

    const cached = cache.get(cacheKey);
    if (!params?.force && cached && cache.isFresh(cached)) {
        return cached.kind === 'success' ? { status: 'ready', policy: cached.value } : { status: 'failed' };
    }

    return await cache.runDedupe(cacheKey, async (): Promise<ServerRetentionPolicyRead> => {
        const succeed = (policy: ServerRetentionPolicyView): ServerRetentionPolicyRead => {
            cache.setSuccess(cacheKey, policy);
            return { status: 'ready', policy };
        };
        const fail = (): ServerRetentionPolicyRead => {
            cache.setError(cacheKey);
            return { status: 'failed' };
        };
        const explicitProfile = explicit ? getServerProfileById(cacheKey) : null;
        const explicitUrl = explicit ? normalizeBaseUrl(explicitProfile?.serverUrl ?? '') : null;
        if (explicit && !explicitUrl) return fail();

        try {
            const response = explicit
                ? await runtimeFetchWithServerReachability({
                    serverUrl: explicitUrl!,
                    ...(explicitProfile?.serverIdentityId ? { homeIdentityId: explicitProfile.serverIdentityId } : {}),
                    token: null,
                    url: joinBaseAndPath(explicitUrl!, '/v2/retention-policy'),
                    init: { method: 'GET' },
                })
                : await serverFetch(
                    '/v2/retention-policy',
                    { method: 'GET' },
                    { includeAuth: false, retry: 'none' },
                );
            if (response.status === 404) {
                const features = await getServerFeaturesSnapshot({ serverId: requested || undefined });
                const legacy = features.status === 'ready' ? readServerRetentionPolicy(features.features) : null;
                return legacy ? succeed(legacy) : fail();
            }
            if (!response.ok) return fail();
            const parsed = ServerRetentionPolicyV2Schema.safeParse(await response.json());
            return parsed.success ? succeed(normalizeServerRetentionPolicyV2(parsed.data)) : fail();
        } catch {
            return fail();
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
