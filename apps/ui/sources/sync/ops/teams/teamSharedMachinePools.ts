import { MachinePoolOpenedListOutputV1Schema, type MachinePoolOpenedListOutputV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction, type TeamActionOutcome } from './teamActionClient';

/** A selected Team read never replaces the Home's complete Pool inventory. */
export function readTeamSharedMachinePools(input: Readonly<{
    scope: ServerAccountScope; address: TeamAddress; signal?: AbortSignal;
}>): Promise<TeamActionOutcome<MachinePoolOpenedListOutputV1>> {
    return runTeamAction({ scope: input.scope, actionId: 'machines.pools.list',
        input: { sharedWithTeamId: input.address.teamId }, signal: input.signal,
        parse: value => MachinePoolOpenedListOutputV1Schema.parse(value) });
}
