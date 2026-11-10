import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ArtifactRevisionV1Schema = lazyZodSchema(() => z.strictObject({
  headerVersion: z.number().check(z.int(), z.positive()), bodyVersion: z.number().check(z.int(), z.positive()),
}));
export type ArtifactRevisionV1 = z.infer<typeof ArtifactRevisionV1Schema>;
