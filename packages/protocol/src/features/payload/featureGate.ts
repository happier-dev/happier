import { z } from 'zod';

export const FeatureGateSchema = z.object({
  enabled: z.boolean(),
});

export type FeatureGate = z.infer<typeof FeatureGateSchema>;

