import * as React from 'react';
import { teamSharedResourceSummaryRowKeyV1, type TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { readTeamSharedResourcesSummary } from '@/sync/ops/teams/teamSharedResources';
import {
    applyTeamSharedResourcesSummary,
    applyTeamSharedResourcesSummaryFailure,
    getTeamSharedResourcesSummarySnapshot,
} from '@/sync/store/teams/teamsSnapshots';
import { useTeamPagedList } from './useTeamPagedList';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import type { TeamPagedListStatus } from './useTeamPagedList';

export type TeamSharedResourcesSummaryProjection = Readonly<{
    kinds: readonly TeamSharedResourceSummaryRowV1[]; status: TeamPagedListStatus; error: HomeDomainFailure | null;
    reload: () => Promise<void>; isCurrent: boolean;
}>;
const NO_KINDS: readonly TeamSharedResourceSummaryRowV1[] = Object.freeze([]);

/** One visible summary demand, refreshed by the existing Home wake and on reopening. */
export function useTeamSharedResourcesSummary(input: Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>): TeamSharedResourcesSummaryProjection {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const teamId = address?.teamId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const retained = getTeamSharedResourcesSummarySnapshot(scope, address);
    const page = useTeamPagedList<TeamSharedResourceSummaryRowV1>({
        key: JSON.stringify([serverId, accountId, teamId, binding?.credentialKey]), enabled, getRowKey: teamSharedResourceSummaryRowKeyV1,
        initialRows: enabled ? retained?.data ?? undefined : undefined,
        onStateChange: next => {
            if (!scope || !address) return;
            if (next.status === 'ready') applyTeamSharedResourcesSummary(scope, address, next.rows);
            else if (next.status === 'error' && next.error) applyTeamSharedResourcesSummaryFailure(scope, address, next.error);
        },
        accountChange: { serverId, affects: event => event.teamSharedResourcesAffect !== false },
        loadPage: async (_cursor, signal) => {
            if (!scope || !address) return null;
            const outcome = await readTeamSharedResourcesSummary({ scope, address, signal });
            return outcome.kind === 'failed' ? outcome
                : { kind: 'succeeded', value: { items: outcome.value.kinds, nextCursor: null } };
        },
    });
    const reload = page.reload;
    return React.useMemo(() => ({ kinds: enabled ? page.rows : NO_KINDS, status: page.status, error: page.error, reload,
        isCurrent: enabled && page.status === 'ready' }), [page.rows, page.status, page.error, reload, enabled]);
}
