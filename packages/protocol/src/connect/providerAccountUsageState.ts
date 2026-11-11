import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ProviderAccountUsageStateV1Schema = lazyZodSchema(() => z.enum([
  'not_loaded',
  'loaded_empty',
  'loaded_data',
  'stale_data',
  'error_last_known_good',
]));
export type ProviderAccountUsageStateV1 = z.infer<typeof ProviderAccountUsageStateV1Schema>;
