import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const FeatureGateSchema = lazySchema(() => z.object({
  enabled: z.boolean(),
}));

export type FeatureGate = z.infer<typeof FeatureGateSchema>;

