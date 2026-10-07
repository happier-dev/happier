import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TeamMembersListFilterV1, TeamMembershipV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { listTeamMembers } from '@/sync/ops/teams/teamMemberOperations';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamMembersRoster = TeamPagedList<TeamMembershipV1>;

/**
 * One Team's roster for one exact Home and Account.
 *
 * Paging lifetime belongs to {@link useTeamPagedList}; this hook owns only what
 * a member page *is*. Changing the filter or the lookup changes the sequence
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
    const teamId = params.address?.teamId ?? '';
    const { filter } = params;
    const query = params.query?.trim() ?? '';

    const loadPage = React.useCallback(
        (cursor: string | null) => listTeamMembers({
            scope: { serverId, accountId },
            address: { serverId, teamId },
            filter,
            ...(query === '' ? {} : { query }),
            cursor,
        }),
        [serverId, accountId, teamId, filter, query],
    );

    return useTeamPagedList<TeamMembershipV1>({
        key: params.scope && params.address
            ? serverAccountScopedTeamResourceKey(params.scope, params.address, 'members', filter, query)
            : '',
        enabled: params.enabled && serverId !== '' && accountId !== '' && teamId !== '',
        loadPage,
        accountChange: { serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
}
