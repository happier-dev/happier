import { z } from 'zod/mini';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ResourceTeamShareScopeV1Schema } from '@happier-dev/protocol/teams/resourceGrantAccessV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction, type TeamActionOutcome } from './teamActionClient';

// The existing Action returns a display projection, never a published content row.
const machineListItemSchema = z.object({
    serverId: z.string(), machineId: z.string(), installationId: z.nullable(z.string()), label: z.string(),
    access: z.optional(AccessibleMachineAccessV1Schema),
    sharedWithTeamScope: z.optional(ResourceTeamShareScopeV1Schema),
});
const machineListSchema = z.object({ items: z.array(machineListItemSchema) });
export type TeamSharedMachineListItem = z.infer<typeof machineListItemSchema>;

/** Admission and privacy stay with machines.list; its native reader owns Team membership. */
export function readTeamSharedMachines(input: Readonly<{
    scope: ServerAccountScope; address: TeamAddress; signal?: AbortSignal;
}>): Promise<TeamActionOutcome<z.infer<typeof machineListSchema>>> {
    return runTeamAction({ scope: input.scope, actionId: 'machines.list',
        input: { serverId: input.scope.serverId, sharedWithTeamId: input.address.teamId, refresh: true },
        signal: input.signal, parse: value => machineListSchema.parse(value) });
}
