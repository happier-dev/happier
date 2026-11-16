import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const port = z.number().check(z.int(), z.minimum(1), z.maximum(65535));

/** Only the selected admitted execution root's assignment crosses the host boundary. */
export const WorktreePortAssignmentV1Schema = lazyZodSchema(() => z.strictObject({
    ports: z.array(port),
    listenerPorts: z.record(z.string(), port),
}));
export type WorktreePortAssignmentV1 = z.infer<typeof WorktreePortAssignmentV1Schema>;

export const WorktreePortsUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
        kind: z.literal('unavailable'),
        code: z.enum(['project_worktree_ports_unavailable', 'project_worktree_ports_active', 'cancelled']),
        reason: z.enum(['state_corrupt', 'state_read_failed', 'state_write_failed', 'root_unavailable',
            'port_selection_failed', 'activity_unavailable', 'active', 'cancelled']),
        causeCode: z.optional(z.string().check(z.minLength(1))),
    }));

export const WorktreePortsResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ready'), assignment: WorktreePortAssignmentV1Schema }),
    WorktreePortsUnavailableV1Schema,
]));
export type WorktreePortsResultV1 = z.infer<typeof WorktreePortsResultV1Schema>;
