import { z } from 'zod';

export const ScmBackendIdSchema = z.enum(['git', 'sapling']);
export type ScmBackendId = z.infer<typeof ScmBackendIdSchema>;

export const ScmBackendPreferenceSchema = z.object({
  kind: z.literal('prefer'),
  backendId: ScmBackendIdSchema,
});
export type ScmBackendPreference = z.infer<typeof ScmBackendPreferenceSchema>;

export const ScmRequestBaseSchema = z.object({
  cwd: z.string().optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(),
});
export type ScmRequestBase = z.infer<typeof ScmRequestBaseSchema>;
