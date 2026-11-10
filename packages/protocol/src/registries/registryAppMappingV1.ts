import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Reviewed inert source replacements; the selected format adapter still owns normalization. */
export const RegistryAppMappingV1Schema = lazyZodSchema(() => z.strictObject({
  document: z.string().check(z.minLength(1)), template: z.optional(z.string()),
}));
export type RegistryAppMappingV1 = z.infer<typeof RegistryAppMappingV1Schema>;
