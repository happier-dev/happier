import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const id = () => z.string().check(z.minLength(1));
export const MachineScheduledJobV1Schema = lazyZodSchema(() => z.strictObject({
  id: id(), name: id(), schedule: id(), nextRun: z.optional(z.string()), lastRun: z.optional(z.string()), enabled: z.optional(z.boolean()),
}));
export const MachineScheduledSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ source: id(), kind: z.literal('available'), jobs: z.array(MachineScheduledJobV1Schema),
    totalJobs: z.number().check(z.int(), z.minimum(0)),
    observation: z.optional(z.strictObject({ kind: z.literal('unavailable'), reason: id() })) }),
  z.strictObject({ source: id(), kind: z.literal('unavailable'), reason: id() }),
]));
export const MachineScheduledInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id(), machineId: id(),
  // The consuming page chooses its visible row demand; there is no competing daemon ceiling.
  pageSize: z.number().check(z.int(), z.minimum(1)), offset: z.optional(z.number().check(z.int(), z.minimum(0))),
  sinceRevision: z.optional(z.number().check(z.int(), z.minimum(0))), refresh: z.optional(z.boolean()),
}));
export const MachineScheduledResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), revision: z.number().check(z.int(), z.minimum(0)),
    sources: z.array(MachineScheduledSourceV1Schema), nextOffset: z.nullable(z.number().check(z.int(), z.minimum(0))) }),
  z.strictObject({ kind: z.literal('unchanged') }),
]));
export type MachineScheduledInputV1 = z.infer<typeof MachineScheduledInputV1Schema>;
export type MachineScheduledResultV1 = z.infer<typeof MachineScheduledResultV1Schema>;
export type MachineScheduledSourceV1 = z.infer<typeof MachineScheduledSourceV1Schema>;
