import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { ScmPullRequestSummarySchema } from './pullRequests.js';

/** The SCM writer's acknowledged effects, retained for explicit continuation. */
export const ScmRepositoryFilesPullRequestPartialV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('partial'),
  stage: z.enum(['worktree', 'write', 'commit', 'pullRequest', 'cleanup']),
  errorCode: z.string().check(z.minLength(1)),
  worktree: z.optional(z.strictObject({ path: z.string().check(z.minLength(1)), branchName: z.string().check(z.minLength(1)) })),
  headCommit: z.optional(ScmCommitOidSchema),
  writtenPaths: z.optional(z.array(z.string().check(z.minLength(1)))),
  pullRequest: z.optional(ScmPullRequestSummarySchema),
}));
export type ScmRepositoryFilesPullRequestPartialV1 = z.infer<typeof ScmRepositoryFilesPullRequestPartialV1Schema>;
