import * as React from 'react';
import type { TeamMembersListFilterV1, TeamMembershipV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { loadMoreTeamMembers, observeTeamMembers, refreshTeamMembers } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamMembersSnapshot, subscribeTeamsSnapshots, teamMembersQueryKey } from '@/sync/store/teams/teamsSnapshots';

import type { TeamPagedList } from './useTeamPagedList';

export type TeamMembersRoster = TeamPagedList<TeamMembershipV1>;

/**
 * One Team's roster for one exact Home and Account.
 *
 * The shared Teams snapshot owner holds the pages and its scoped loader owns
 * observation, revalidation and paging. Changing the filter or lookup changes the sequence
 * identity, because a cursor names a position inside the sequence that produced
 * it. The lookup is the Home's, not a narrowing of the pages already read: a
 * member on an unread page is found exactly like one on the first.
 */
export function useTeamMembersRoster(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    filter: TeamMembersListFilterV1;
    query?: string;
    enabled: boolean;
}>): TeamMembersRoster {
    const serverId = params.scope?.serverId ?? '';
    const accountId = params.scope?.accountId ?? '';
    const addressServerId = params.address?.serverId ?? '';
    const teamId = params.address?.teamId ?? '';
    const { filter } = params;
    const query = params.query?.trim() ?? '';
    const { scope, address } = params;
    const active = params.enabled && serverId !== '' && accountId !== '' && teamId !== '' && serverId === addressServerId;
    const queryKey = teamMembersQueryKey(filter, query);
    React.useEffect(() => {
        if (active) return observeTeamMembers({ serverId, accountId }, { serverId: addressServerId, teamId }, filter, query);
    }, [active, serverId, accountId, addressServerId, teamId, filter, query]);
    const subscribe = React.useCallback((listener: () => void) =>
        subscribeTeamsSnapshots(listener, { scopes: scope ? [scope] : [], slices: ['members'] }), [scope]);
    const snapshot = React.useSyncExternalStore(subscribe,
        () => active ? getTeamMembersSnapshot(scope, address, queryKey) : null, () => null);
    const loadMore = React.useCallback(async () => {
        if (active) await loadMoreTeamMembers({ serverId, accountId }, { serverId: addressServerId, teamId }, filter, query);
    }, [active, serverId, accountId, addressServerId, teamId, filter, query]);
    const reload = React.useCallback(async () => {
        if (active) await refreshTeamMembers({ serverId, accountId }, { serverId: addressServerId, teamId }, filter, query);
    }, [active, serverId, accountId, addressServerId, teamId, filter, query]);
    return React.useMemo(() => ({
        rows: snapshot?.data ?? NO_MEMBERS,
        status: snapshot?.status ?? 'loading' as const,
        error: snapshot?.error ?? null,
        hasMore: snapshot === null || (snapshot.data === null && snapshot.status === 'loading') || snapshot.nextCursor !== null,
        loadMore, reload,
    }), [snapshot, loadMore, reload]);
}

const NO_MEMBERS: readonly TeamMembershipV1[] = Object.freeze([]);
