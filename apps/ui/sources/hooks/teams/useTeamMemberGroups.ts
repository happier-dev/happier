import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TeamGroupV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { listTeamMemberGroups } from '@/sync/ops/teams/teamMemberOperations';
import { teamMemberGroupPages } from '@/sync/store/teams/teamsSnapshots';

import { useTeamObservedPagedList } from './useTeamObservedPagedList';
import type { TeamPagedList } from './useTeamPagedList';

export type TeamMemberGroups = TeamPagedList<TeamGroupV1>;

/**
 * The Groups one membership lifetime is effectively in.
 *
 * The sequence identity is the membership lifetime, not the Account: a rejoined
 * person is a different lifetime and must not continue the previous one's page.
 */
export function useTeamMemberGroups(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    membershipId: string;
    enabled: boolean;
}>): TeamMemberGroups {
    const serverId = params.scope?.serverId ?? '';
    const accountId = params.scope?.accountId ?? '';
    const teamId = params.address?.teamId ?? '';
    const { membershipId } = params;

    const loadPage = React.useCallback(
        (cursor: string | null, signal: AbortSignal) => listTeamMemberGroups({
            scope: { serverId, accountId },
            address: { serverId, teamId },
            membershipId,
            cursor,
            signal,
        }),
        [serverId, accountId, teamId, membershipId],
    );

    return useTeamObservedPagedList<TeamGroupV1>({
        scope: params.scope,
        observations: teamMemberGroupPages,
        key: params.scope && params.address
            ? serverAccountScopedTeamResourceKey(params.scope, params.address, 'member-groups', membershipId)
            : '',
        enabled: params.enabled
            && serverId !== '' && accountId !== '' && teamId !== '' && membershipId !== '',
        loadPage,
        accountChange: { serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
}
