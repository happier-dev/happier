import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

/** Dynamic status of the one server-light Personal Home transcript index. */
export const HomeSearchCapabilitiesSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  reason: z.optional(z.enum(['index_unavailable', 'indexing'])),
}));

export type HomeSearchCapabilities = z.infer<typeof HomeSearchCapabilitiesSchema>;
