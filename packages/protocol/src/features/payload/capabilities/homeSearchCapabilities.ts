import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

/** Dynamic status of the one server-light Personal Home transcript index. */
export const HomeSearchCapabilitiesSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  reason: z.enum(['index_unavailable', 'indexing']).optional(),
}).strict());

export type HomeSearchCapabilities = z.infer<typeof HomeSearchCapabilitiesSchema>;
