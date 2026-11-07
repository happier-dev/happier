import type { AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { getUserProfiles } from '@/sync/api/social/apiFriends';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createScopedBatchResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

type Profile = AccountDisplayProfileV1 | null;
const profiles = createScopedBatchResolutionSingleFlight<Profile>();

/** Pending People reads share the existing batch owner, cancellation and exact Account lifetime. */
export function readAccountProfiles(lifetime: ServerAccountScopeLifetime, ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, Profile>> {
    return profiles.run('people', ids, async (ids, signal) =>
        await runWithServerRequestAuthorityForServerAccountScope({ scope: lifetime.scope,
            activeRequest: async () => { throw new Error('People profiles require captured Home credentials'); },
        }, async authority => {
            const users = await getUserProfiles({ token: authority.context.token }, [...ids], { retry: 'none',
                request: (path, init, options) => authority.request(path, { ...init, signal }, { retry: options?.retry }),
            });
            const byId = new Map(users.map(user => [user.id, user]));
            return new Map(ids.map(id => {
                const user = byId.get(id);
                return [id, user ? { name: user.name ?? null, firstName: user.firstName,
                    lastName: user.lastName, username: user.username, avatarUrl: user.avatar?.url ?? null } : null] as const;
            }));
        }), { scope: lifetime, signal });
}
