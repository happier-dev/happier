import { z } from 'zod';

export const ScmDefaultBranchPushPolicySchema = z.enum([
  'allow',
  'requires-feature-branch',
  'deny',
]);
export type ScmDefaultBranchPushPolicy = z.infer<typeof ScmDefaultBranchPushPolicySchema>;
