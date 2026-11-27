import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const ManagedMachinePresetIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  homeId: z.string().check(z.trim(), z.minLength(1)),
}));
