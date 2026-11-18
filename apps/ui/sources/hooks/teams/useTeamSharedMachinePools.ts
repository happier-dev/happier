import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { readTeamSharedMachinePools } from '@/sync/ops/teams/teamSharedMachinePools';
import { teamSharedMachinePoolObservations } from '@/sync/store/teams/teamsSnapshots';

import type { TeamPagedList } from './useTeamPagedList';
import { useTeamSharedMachineList } from './useTeamSharedMachines';

export type TeamSharedMachinePoolsProjection = TeamPagedList<MachinePoolViewV1> & Readonly<{ isCurrent: boolean }>;
const poolKey = (view: MachinePoolViewV1) => view.pool.id;

async function readPools(input: Parameters<typeof readTeamSharedMachinePools>[0]) {
    const outcome = await readTeamSharedMachinePools(input);
    return outcome.kind === 'failed' ? outcome
        : { kind: 'succeeded' as const, value: { items: outcome.value.pools } };
}

/** The existing Pool list is a complete relation; its owner has no continuation cursor. */
export function useTeamSharedMachinePools(input: Readonly<{
    scope: ServerAccountScope | null; address: TeamAddress | null; enabled: boolean;
}>): TeamSharedMachinePoolsProjection {
    return useTeamSharedMachineList(input, teamSharedMachinePoolObservations, poolKey, readPools);
}
