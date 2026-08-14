import { z } from 'zod';

import { ScmBackendPreferenceSchema } from './backendIdentity.js';

export const ScmRequestBaseSchema = z.object({
  cwd: z.string().optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(),
});
export type ScmRequestBase = z.infer<typeof ScmRequestBaseSchema>;
