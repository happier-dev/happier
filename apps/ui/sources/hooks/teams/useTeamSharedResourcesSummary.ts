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
    const { binding, resolution } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const requested = input.enabled && scope !== null && address !== null && serverId === address.serverId;
    const enabled = requested && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    // The existing snapshot follows the credential lifetime, so the first frame
    // can show it while this observer binds. Reads still wait for the binding.
    const retained = requested && (enabled || resolution.kind === 'resolving')
        ? getTeamSharedResourcesSummarySnapshot(scope, address)?.data ?? undefined : undefined;
    const page = useTeamPagedList<TeamSharedResourceSummaryRowV1>({
        key: JSON.stringify([serverId, accountId, teamId, binding?.credentialKey]), enabled, getRowKey: teamSharedResourceSummaryRowKeyV1,
        initialPage: enabled && retained !== undefined ? { items: retained, nextCursor: null } : undefined,
        onStateChange: next => {
            if (!enabled || !scope || !address || !binding?.isCurrent()) return;
            if (next.status === 'ready') applyTeamSharedResourcesSummary(scope, address, next.rows, binding);
            else if (next.status === 'error' && next.error) applyTeamSharedResourcesSummaryFailure(scope, address, next.error, binding);
        },
        accountChange: { serverId, affects: event => event.teamSharedResourcesAffect !== false },
        loadPage: async (_cursor, signal) => {
            if (!scope || !address) return null;
            const outcome = await readTeamSharedResourcesSummary({ scope, address, signal });
            return outcome.kind === 'failed' ? outcome
                : { kind: 'succeeded', value: { items: outcome.value.kinds, nextCursor: null } };
        },
    });
    const { reload } = page;
    const kinds = enabled ? page.rows : retained ?? NO_KINDS;
    const status = enabled ? page.status : retained === undefined ? 'loading' : 'refreshing';
    const error = enabled ? page.error : null;
    return React.useMemo(() => ({ kinds, status, error, reload, isCurrent: enabled && status === 'ready' }),
        [kinds, status, error, reload, enabled]);
}
