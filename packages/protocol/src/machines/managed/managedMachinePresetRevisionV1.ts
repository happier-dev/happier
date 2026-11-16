import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Public preset identity and original revision; independent of private content. */
export const ManagedMachinePresetRevisionInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)),
  id: z.string().check(z.trim(), z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
}));
export const ManagedMachinePresetPrepareInputV1Schema = lazyZodSchema(() => z.extend(
  ManagedMachinePresetRevisionInputV1Schema,
  { machineId: z.string().check(z.trim(), z.minLength(1)) },
));
export type ManagedMachinePresetPrepareInputV1 = z.infer<typeof ManagedMachinePresetPrepareInputV1Schema>;
