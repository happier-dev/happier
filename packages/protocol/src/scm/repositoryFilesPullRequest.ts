import { z } from '../zodRuntimePolicy.js';
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

export const ScmRepositoryFilesPullRequestSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pullRequest'),
  pullRequest: ScmPullRequestSummarySchema,
  headCommit: ScmCommitOidSchema,
  branchName: z.string().check(z.minLength(1)),
}));
export type ScmRepositoryFilesPullRequestSuccessV1 = z.infer<typeof ScmRepositoryFilesPullRequestSuccessV1Schema>;
export const ScmRepositoryFilesPullRequestResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ScmRepositoryFilesPullRequestPartialV1Schema, ScmRepositoryFilesPullRequestSuccessV1Schema,
]));
export type ScmRepositoryFilesPullRequestResultV1 = z.infer<typeof ScmRepositoryFilesPullRequestResultV1Schema>;
