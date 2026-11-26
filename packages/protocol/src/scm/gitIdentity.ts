import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Non-secret commit attribution chosen deliberately by a person. */
export const ScmGitIdentitySchema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.trim(), z.minLength(1), z.regex(/^[^<>\r\n\0]+$/)),
  email: z.string().check(z.trim(), z.minLength(1), z.regex(/^[^<>\r\n\0]+$/)),
}));
export type ScmGitIdentity = z.infer<typeof ScmGitIdentitySchema>;

/** Presentation of the Machine resolver's decision; environment overlays stay on the Machine. */
export const ScmGitIdentityResolutionSchema = lazyZodSchema(() => z.strictObject({
  source: z.enum(['repository', 'person', 'native', 'none']),
  identity: z.nullable(ScmGitIdentitySchema),
}));
export type ScmGitIdentityResolution = z.infer<typeof ScmGitIdentityResolutionSchema>;
