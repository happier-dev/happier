import { z } from 'zod';

export const ScmBuiltInBackendIdSchema = z.enum(['git', 'sapling']);
export type ScmBuiltInBackendId = z.infer<typeof ScmBuiltInBackendIdSchema>;

export const ScmBackendIdSchema = z.string().trim().min(1);
export type ScmBackendId = z.infer<typeof ScmBackendIdSchema>;

export const ScmBackendPreferenceSchema = z.object({
  kind: z.literal('prefer'),
  backendId: ScmBackendIdSchema,
});
export type ScmBackendPreference = z.infer<typeof ScmBackendPreferenceSchema>;
