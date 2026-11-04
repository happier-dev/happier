import * as React from 'react';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import type { AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type { SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getUserProfiles } from '@/sync/api/social/apiFriends';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

/** Safe display facts alongside the admitted roster, never another people inventory or grant owner. */
export function useDiscussionParticipantProfiles(input: Readonly<{
    scope: ServerAccountScope;
    roster: DiscussionParticipantsListResponseV1 | null;
    /** Complete scoped profiles already admitted by the Discussion summary owner. */
    participantAccounts?: readonly SessionMessageAccountActorV1[];
    /** Before a roster exists (a New Discussion's chosen people), the same profile read by id. */
    accountIds?: readonly string[];
    enabled: boolean;
    accountLifetime: ServerAccountScopeLifetime | null;
}>): Readonly<{ owner: TranscriptAccountActor | null; accounts: ReadonlyMap<string, TranscriptAccountActor>;
    status: 'loading' | 'ready' | 'unavailable' }> {
    const { scope, roster, enabled, accountLifetime } = input;
    const subscribe = React.useCallback((notify: () => void) => {
        const retirement = accountLifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const isCurrent = React.useSyncExternalStore(subscribe,
        () => accountLifetime?.isCurrent() === true && areServerAccountScopesEqual(accountLifetime.scope, scope),
        () => false);
    const viewerProfile = useShareViewerProfile(scope);
    const accountIds = roster ? [...new Set([roster.ownerAccountId, ...roster.grants.flatMap(grant =>
        grant.principal.kind === 'account' ? [grant.principal.accountId] : [])])].sort() : [...new Set(input.accountIds ?? [])].sort();
    const accountIdsKey = JSON.stringify(accountIds);
    const admittedAccounts = React.useMemo(() => new Map<string, SessionMessageAccountActorV1>(input.participantAccounts?.map(actor => [actor.accountId, actor]) ?? []), [input.participantAccounts]);
    const missingIdsKey = JSON.stringify(accountIds.filter(id => !admittedAccounts.has(id)));
    const key = serverAccountScopedResourceKey(scope, roster?.discussionId ?? '', accountIdsKey);
    const [resolved, setResolved] = React.useState<Readonly<{
        key: string; missingIdsKey: string; status: 'ready' | 'unavailable'; lifetime: ServerAccountScopeLifetime; profiles: ReadonlyMap<string, AccountDisplayProfileV1 | null>;
    }> | null>(null);

    React.useEffect(() => {
        if (!enabled || !isCurrent || !accountLifetime || missingIdsKey === '[]') return;
        const abort = new AbortController();
        const retirement = accountLifetime.onRetire(() => abort.abort());
        const ids: string[] = JSON.parse(missingIdsKey);
        void runWithServerRequestAuthorityForServerAccountScope({ scope,
            activeRequest: async () => { throw new Error('Discussion profiles require captured Home credentials'); },
        }, async authority => {
            if (abort.signal.aborted || !accountLifetime.isCurrent()) return;
            // New drafts and genuinely absent projections still need the People
            // owner, under the same captured Account even when another Home is focused.
            const users = await getUserProfiles({ token: authority.context.token }, ids, { retry: 'none',
                request: (path, init, options) => authority.request(path, { ...init, signal: abort.signal }, { retry: options?.retry }),
            });
            if (abort.signal.aborted || !accountLifetime.isCurrent()) return;
            const usersById = new Map(users.map(user => [user.id, user]));
            setResolved({ key, missingIdsKey, status: 'ready', lifetime: accountLifetime, profiles: new Map(ids.map(id => {
                const user = usersById.get(id);
                return [id, user ? { name: user.name ?? null, firstName: user.firstName,
                    lastName: user.lastName, username: user.username, avatarUrl: user.avatar?.url ?? null } : null];
            })) });
        }).catch(() => {
            // Failure settles presentation without inventing former members or erasing admitted names.
            if (!abort.signal.aborted && accountLifetime.isCurrent()) setResolved({ key, missingIdsKey, lifetime: accountLifetime, profiles: new Map(), status: 'unavailable' });
        });
        return () => { retirement.dispose(); abort.abort(); };
    }, [missingIdsKey, enabled, key, scope.serverId, scope.accountId, accountLifetime, isCurrent]);

    return React.useMemo(() => {
        const accounts = new Map<string, TranscriptAccountActor>();
        if (!isCurrent) return { owner: null, accounts, status: 'unavailable' as const };
        for (const grant of roster?.grants ?? []) {
            if (grant.principal.kind !== 'account') continue;
            accounts.set(grant.principal.accountId, { v: 1, serverId: scope.serverId, accountId: grant.principal.accountId,
                profile: { name: grant.display.name, username: grant.display.username ?? null,
                    firstName: null, lastName: null, avatarUrl: null } });
        }
        if (resolved?.key === key && resolved.lifetime === accountLifetime) for (const [accountId, profile] of resolved.profiles) {
            accounts.set(accountId, { v: 1, serverId: scope.serverId, accountId, profile });
        }
        // Canonical current observations beat earlier fallback reads, including
        // explicit null profiles that withdraw a previously displayed face/name.
        for (const actor of admittedAccounts.values()) accounts.set(actor.accountId, { ...actor, serverId: scope.serverId });
        // A default/unnamed loading profile must not erase an acknowledged Home name.
        if (roster && viewerProfile && formatAccountDisplayName(viewerProfile)
            && (roster.ownerAccountId === scope.accountId || accounts.has(scope.accountId))) {
            accounts.set(scope.accountId, { v: 1, serverId: scope.serverId, accountId: scope.accountId, profile: viewerProfile });
        }
        const status = missingIdsKey === '[]' ? 'ready'
            : resolved?.key === key && resolved.missingIdsKey === missingIdsKey && resolved.lifetime === accountLifetime ? resolved.status : 'loading';
        return { owner: roster ? accounts.get(roster.ownerAccountId) ?? null : null, accounts, status };
    }, [admittedAccounts, key, resolved, roster, scope.serverId, scope.accountId, viewerProfile, accountLifetime, isCurrent, missingIdsKey]);
}
