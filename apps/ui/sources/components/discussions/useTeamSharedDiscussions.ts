import * as React from 'react';
import { DiscussionListResultV1Schema, type DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { useTeamPagedList, type TeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

const NO_DISCUSSIONS: readonly DiscussionOpenedSummaryV1[] = Object.freeze([]);
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
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const page = useTeamPagedList<DiscussionOpenedSummaryV1>({
        key: JSON.stringify([serverId, scope?.accountId, address?.teamId, binding?.credentialKey]),
        enabled, getRowKey: discussionKey,
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
    return React.useMemo(() => ({ ...page, rows: enabled ? page.rows : NO_DISCUSSIONS }), [page, enabled]);
}
