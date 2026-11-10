import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const MachineKindSchema = lazyZodSchema(() => z.enum(['persistent', 'ephemeral_session_runner']));
export type MachineKind = z.infer<typeof MachineKindSchema>;

/** Released Machine projections and display caches predate the discriminator. */
export const MachineKindFromLegacyProjectionSchema = lazyZodSchema(() => z._default(MachineKindSchema, 'persistent'));

/**
 * Selection predicate over already-read Machines; runs per Machine on every store
 * notification, so it compares the discriminator instead of parsing it. A kind this
 * reader does not know is not offered as persistent.
 */
export function isPersistentMachine(machine: Readonly<{ kind?: MachineKind }>): boolean {
    return (machine.kind ?? 'persistent') === 'persistent';
}
