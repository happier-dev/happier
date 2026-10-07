import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TeamGroupV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { listTeamMemberGroups } from '@/sync/ops/teams/teamMemberOperations';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamMemberGroups = TeamPagedList<TeamGroupV1>;

/**
 * The Groups one membership lifetime is effectively in.
 *
 * Paging lifetime belongs to {@link useTeamPagedList}; this hook owns only what
 * the page *is*. It stays a paged read rather than a shared snapshot because
 * only the open member-detail surface asks for it, so promoting it would add
 * retained state with no second consumer.
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
        (cursor: string | null) => listTeamMemberGroups({
            scope: { serverId, accountId },
            address: { serverId, teamId },
            membershipId,
            cursor,
        }),
        [serverId, accountId, teamId, membershipId],
    );

    return useTeamPagedList<TeamGroupV1>({
        key: params.scope && params.address
            ? serverAccountScopedTeamResourceKey(params.scope, params.address, 'member-groups', membershipId)
            : '',
        enabled: params.enabled
            && serverId !== '' && accountId !== '' && teamId !== '' && membershipId !== '',
        loadPage,
        accountChange: { serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
}
