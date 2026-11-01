import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

export const ScmBackendIdSchema = lazySchema(() => z.enum(['git', 'sapling']));
export type ScmBackendId = z.infer<typeof ScmBackendIdSchema>;

export const ScmBackendPreferenceSchema = lazySchema(() => z.object({
  kind: z.literal('prefer'),
  backendId: ScmBackendIdSchema,
}));
export type ScmBackendPreference = z.infer<typeof ScmBackendPreferenceSchema>;

export const ScmRequestBaseSchema = lazySchema(() => z.object({
  cwd: z.string().optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(),
}));
export type ScmRequestBase = z.infer<typeof ScmRequestBaseSchema>;
