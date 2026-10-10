import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const FeatureGateSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
}));

export type FeatureGate = z.infer<typeof FeatureGateSchema>;
