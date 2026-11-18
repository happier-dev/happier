import * as React from 'react';

import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { TeamActionOutcome } from '@/sync/ops/teams/teamActionClient';
import { readTeamSharedMachines, type TeamSharedMachineListItem } from '@/sync/ops/teams/teamSharedMachines';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { teamSharedMachineObservations } from '@/sync/store/teams/teamsSnapshots';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamSharedMachinesProjection = TeamPagedList<TeamSharedMachineListItem> & Readonly<{ isCurrent: boolean }>;
const NO_ROWS: readonly never[] = Object.freeze([]);
const machineKey = (row: TeamSharedMachineListItem) => row.machineId;
const affectsMachines = (event: HomeAccountChangeEvent) => event.machineResourcesAffect !== false;

type TeamMachineListTarget = Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>;

/** Native Team filters own membership independently of the Account inventory. */
export function useTeamSharedMachines(input: TeamMachineListTarget): TeamSharedMachinesProjection {
    return useTeamSharedMachineList(input, teamSharedMachineObservations, machineKey, readTeamSharedMachines);
}

/** Machines and Pools both return a complete Team-filtered list. */
export function useTeamSharedMachineList<Row>(
    input: TeamMachineListTarget,
    observations: Readonly<{
        get(scope: ServerAccountScope, address: TeamAddress): readonly Row[] | undefined;
        apply(address: TeamAddress, lifetime: ServerAccountScopeLifetime, rows: readonly Row[] | null): void;
    }>,
    getRowKey: (row: Row) => string,
    read: (input: Readonly<{ scope: ServerAccountScope; address: TeamAddress; signal: AbortSignal }>) =>
        Promise<TeamActionOutcome<Readonly<{ items: readonly Row[] }>>>,
): TeamPagedList<Row> & Readonly<{ isCurrent: boolean }> {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const teamId = address?.teamId ?? '';
    const { binding, resolution } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const requested = input.enabled && scope !== null && address !== null && serverId === address.serverId;
    const enabled = requested
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const retained = requested && (enabled || resolution.kind === 'resolving') ? observations.get(scope, address) : undefined;
    const page = useTeamPagedList<Row>({
        key: JSON.stringify([serverId, accountId, teamId, binding?.credentialKey]), enabled, getRowKey,
        initialRows: enabled ? retained : undefined,
        onStateChange: state => {
            if (!enabled || !binding || !address) return;
            if (state.status === 'ready') observations.apply(address, binding, state.rows);
            if (state.error && isAuthoritativeScopedSnapshotRefusalKind(state.error.kind)) observations.apply(address, binding, null);
        },
        accountChange: { serverId, affects: affectsMachines },
        loadPage: async (_cursor, signal) => {
            if (!scope || !address) return null;
            const result = await read({ scope, address, signal });
            return result.kind === 'failed' ? result
                : { kind: 'succeeded', value: { items: result.value.items, nextCursor: null } };
        },
    });
    return React.useMemo(() => ({
        ...page,
        rows: enabled ? page.rows : retained ?? NO_ROWS,
        status: !enabled && retained !== undefined ? 'refreshing' : page.status,
        hasMore: false,
        isCurrent: enabled && page.status === 'ready',
    }), [page, enabled, retained]);
}
