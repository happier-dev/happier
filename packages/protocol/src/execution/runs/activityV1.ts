import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Content-free invalidation from the currently admitted Machine installation. */
export const ExecutionRunMachineActivityV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: id,
  installationId: id,
  runId: id,
  executionAuthorizationToken: z.optional(z.string().check(z.minLength(1))),
}));
export type ExecutionRunMachineActivityV1 = z.infer<typeof ExecutionRunMachineActivityV1Schema>;

/** The Account reader re-reads only this demanded exact source. */
export const ExecutionRunMachineActivityEphemeralV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('execution-run-updated'),
  machineId: id,
  runId: id,
}));
export type ExecutionRunMachineActivityEphemeralV1 = z.infer<typeof ExecutionRunMachineActivityEphemeralV1Schema>;
