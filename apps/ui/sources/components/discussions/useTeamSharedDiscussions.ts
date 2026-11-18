import { DiscussionListResultV1Schema, type DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { useTeamObservedPagedList } from '@/hooks/teams/useTeamObservedPagedList';
import type { TeamPagedList } from '@/hooks/teams/useTeamPagedList';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { teamSharedDiscussionPages } from '@/sync/store/teams/teamsSnapshots';

const discussionKey = (row: DiscussionOpenedSummaryV1) => row.id;
const affectsDiscussions = (event: HomeAccountChangeEvent) => event.discussionAffects !== false;

/** A Team list owns its demanded pages independently of the Account Discussion repository. */
export function useTeamSharedDiscussions(input: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    enabled: boolean;
}>): TeamPagedList<DiscussionOpenedSummaryV1> {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    return useTeamObservedPagedList<DiscussionOpenedSummaryV1>({
        scope,
        observations: teamSharedDiscussionPages,
        key: JSON.stringify([serverId, scope?.accountId, address?.teamId]),
        enabled: input.enabled && address !== null && serverId === address.serverId,
        getRowKey: discussionKey,
        accountChange: { serverId, affects: affectsDiscussions },
        loadPage: async (cursor, signal) => {
            if (!scope || !address) return null;
            const result = await runTeamAction({ scope, actionId: 'discussion.list', signal,
                input: { sharedWithTeamId: address.teamId, ...(cursor === null ? {} : { cursor }) },
                parse: value => DiscussionListResultV1Schema.parse(value) });
            return result.kind === 'failed' ? result : { kind: 'succeeded', value: {
                items: result.value.discussions, nextCursor: result.value.nextCursor,
            } };
        },
    });
}
