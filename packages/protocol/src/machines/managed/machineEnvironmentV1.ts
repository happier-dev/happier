import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';

/** Setup is revisioned with a preset. Only the exact Saved Secret owner resolves values. */
export const MachineEnvironmentV1Schema = lazyZodSchema(() => z.object({
  toolchain: z.object({ adapterId: z.string().trim().min(1), config: z.string() }).strict().optional(),
  setupScript: z.string().optional(),
  secretRefs: SecretReferenceOverlayV1Schema.optional(),
}).strict());
export const MachineEnvironmentV1ReadSchema = createStoredReadSchema(MachineEnvironmentV1Schema);
export type MachineEnvironmentV1 = Readonly<z.infer<typeof MachineEnvironmentV1Schema>>;
