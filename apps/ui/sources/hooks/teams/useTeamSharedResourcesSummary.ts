import * as React from 'react';
import { type TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { observeTeamSharedResourcesSummary, refreshTeamSharedResourcesSummary } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamSharedResourcesSummarySnapshot, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import type { TeamPagedListStatus } from './useTeamPagedList';

export type TeamSharedResourcesSummaryProjection = Readonly<{
    kinds: readonly TeamSharedResourceSummaryRowV1[]; status: TeamPagedListStatus; error: HomeDomainFailure | null;
    reload: () => Promise<void>; isCurrent: boolean;
}>;
const NO_KINDS: readonly TeamSharedResourceSummaryRowV1[] = Object.freeze([]);

/** One visible summary demand, kept current by the existing Home wake. */
export function useTeamSharedResourcesSummary(input: Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>): TeamSharedResourcesSummaryProjection {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    const { binding, resolution } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const requested = input.enabled && scope !== null && address !== null && serverId === address.serverId;
    const enabled = requested && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const read = React.useCallback(() => requested && (enabled || resolution.kind === 'resolving')
        ? getTeamSharedResourcesSummarySnapshot(scope, address) : null, [requested, enabled, resolution.kind, scope, address]);
    const snapshot = React.useSyncExternalStore(subscribeTeamsSnapshots, read, read);
    React.useEffect(() => {
        if (enabled && scope && address && binding) return observeTeamSharedResourcesSummary({ scope, address, lifetime: binding });
    }, [enabled, scope, address, binding]);
    const reload = React.useCallback(async () => {
        if (enabled && scope && address && binding) await refreshTeamSharedResourcesSummary({ scope, address, lifetime: binding });
    }, [enabled, scope, address, binding]);
    const kinds = snapshot?.data ?? NO_KINDS;
    const status = !enabled || !snapshot || snapshot.status === 'loading'
        ? (snapshot?.data ? 'refreshing' : 'loading')
        : snapshot.status;
    const error = enabled ? snapshot?.error ?? null : null;
    return React.useMemo(() => ({ kinds, status, error, reload, isCurrent: enabled && status === 'ready' }),
        [kinds, status, error, reload, enabled]);
}
