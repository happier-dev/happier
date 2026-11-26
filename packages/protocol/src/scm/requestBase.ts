import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ScmGitIdentitySchema } from './gitIdentity.js';
import { ScmBackendPreferenceSchema } from './backendIdentity.js';

export const ScmRequestBaseSchema = lazyZodSchema(() => z.object({
  cwd: z.optional(z.string()),
  gitIdentity: z.optional(ScmGitIdentitySchema),
  backendPreference: z.optional(ScmBackendPreferenceSchema),
  outcomeVersion: z.optional(z.literal(1)),
}));
export type ScmRequestBase = z.infer<typeof ScmRequestBaseSchema>;
