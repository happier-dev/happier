import * as React from 'react';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { readTeamSharedMachines, type TeamSharedMachineListItem } from '@/sync/ops/teams/teamSharedMachines';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamSharedMachinesProjection = TeamPagedList<TeamSharedMachineListItem> & Readonly<{ isCurrent: boolean }>;
const NO_MACHINES: readonly TeamSharedMachineListItem[] = Object.freeze([]);
const machineKey = (row: TeamSharedMachineListItem) => row.machineId;
const affectsMachines = (event: HomeAccountChangeEvent) => event.machineResourcesAffect !== false;

/** The native Team list owns membership; the mounted pager never rewrites the Account inventory. */
export function useTeamSharedMachines(input: Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>): TeamSharedMachinesProjection {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const teamId = address?.teamId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const page = useTeamPagedList<TeamSharedMachineListItem>({
        key: JSON.stringify([serverId, accountId, teamId, binding?.credentialKey]), enabled, getRowKey: machineKey,
        accountChange: { serverId, affects: affectsMachines },
        loadPage: async (_cursor, signal) => {
            if (!scope || !address) return null;
            const result = await readTeamSharedMachines({ scope, address, signal });
            return result.kind === 'failed' ? result
                : { kind: 'succeeded', value: { items: result.value.items, nextCursor: null } };
        },
    });
    return React.useMemo(() => ({ ...page, rows: enabled ? page.rows : NO_MACHINES,
        isCurrent: enabled && page.status === 'ready' }), [page, enabled]);
}
