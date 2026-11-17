import * as React from 'react';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { readTeamSharedMachinePools } from '@/sync/ops/teams/teamSharedMachinePools';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamSharedMachinePoolsProjection = TeamPagedList<MachinePoolViewV1> & Readonly<{ isCurrent: boolean }>;
const NO_POOLS: readonly MachinePoolViewV1[] = Object.freeze([]);
const poolKey = (view: MachinePoolViewV1) => view.pool.id;

/** The existing Pool list is a complete relation; its owner has no continuation cursor. */
export function useTeamSharedMachinePools(input: Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>): TeamSharedMachinePoolsProjection {
    const { scope, address } = input;
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const teamId = address?.teamId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const page = useTeamPagedList<MachinePoolViewV1>({
        key: JSON.stringify([serverId, accountId, teamId, binding?.credentialKey]), enabled, getRowKey: poolKey,
        accountChange: { serverId, affects: event => event.machineResourcesAffect !== false },
        loadPage: async (_cursor, signal) => {
            if (!scope || !address) return null;
            const outcome = await readTeamSharedMachinePools({ scope, address, signal });
            return outcome.kind === 'failed' ? outcome
                : { kind: 'succeeded', value: { items: outcome.value.pools, nextCursor: null } };
        },
    });
    return React.useMemo(() => ({ ...page, rows: enabled ? page.rows : NO_POOLS,
        isCurrent: enabled && page.status === 'ready' }), [page, enabled]);
}
