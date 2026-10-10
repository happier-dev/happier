import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ArtifactRevisionV1Schema = lazyZodSchema(() => z.object({
  headerVersion: z.number().int().positive(), bodyVersion: z.number().int().positive(),
}).strict());
export type ArtifactRevisionV1 = z.infer<typeof ArtifactRevisionV1Schema>;
