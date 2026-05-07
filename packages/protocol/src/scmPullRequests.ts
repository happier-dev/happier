import { z } from 'zod';

import { ScmOperationErrorCodeSchema } from './scmErrorCodes.js';
import { ScmRequestBaseSchema } from './scmRequestBase.js';

export const ScmHostingProviderKindSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'unknown',
]);
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

export const ScmHostingProviderSchema = z.object({
  kind: ScmHostingProviderKindSchema,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  nameWithOwner: z.string().min(1).nullable(),
  remoteName: z.string().min(1).nullable().optional(),
});
export type ScmHostingProvider = z.infer<typeof ScmHostingProviderSchema>;

export const ScmPullRequestStateSchema = z.enum([
  'open',
  'closed',
  'merged',
  'unknown',
]);
export type ScmPullRequestState = z.infer<typeof ScmPullRequestStateSchema>;

const ScmPullRequestListStateSchema = z.literal('open');

export const ScmPullRequestSummarySchema = z.object({
  provider: ScmHostingProviderSchema,
  number: z.number().int().positive().nullable(),
  title: z.string().min(1),
  url: z.string().url(),
  baseBranch: z.string().min(1),
  headBranch: z.string().min(1),
  state: ScmPullRequestStateSchema,
});
export type ScmPullRequestSummary = z.infer<typeof ScmPullRequestSummarySchema>;

export const ScmDefaultBranchPushPolicySchema = z.enum([
  'allow',
  'requires-feature-branch',
  'deny',
]);
export type ScmDefaultBranchPushPolicy = z.infer<typeof ScmDefaultBranchPushPolicySchema>;

const ScmPullRequestRequestBaseSchema = ScmRequestBaseSchema;

export const ScmPullRequestReferenceSchema = z.union([
  z.object({ number: z.number().int().positive() }),
  z.object({ url: z.string().url() }),
  z.object({ headBranch: z.string().min(1) }),
]);
export type ScmPullRequestReference = z.infer<typeof ScmPullRequestReferenceSchema>;

const ScmPullRequestErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});

export const ScmPullRequestListRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  base: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  state: ScmPullRequestListStateSchema.optional(),
});
export type ScmPullRequestListRequest = z.infer<typeof ScmPullRequestListRequestSchema>;

export const ScmPullRequestListResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    pullRequests: z.array(ScmPullRequestSummarySchema),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestListResponse = z.infer<typeof ScmPullRequestListResponseSchema>;

export const ScmPullRequestGetRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  prReference: ScmPullRequestReferenceSchema,
});
export type ScmPullRequestGetRequest = z.infer<typeof ScmPullRequestGetRequestSchema>;

export const ScmPullRequestGetResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    pullRequest: ScmPullRequestSummarySchema.nullable(),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestGetResponse = z.infer<typeof ScmPullRequestGetResponseSchema>;

export const ScmPullRequestOpenComposeRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  base: z.string().min(1),
  head: z.string().min(1),
});
export type ScmPullRequestOpenComposeRequest = z.infer<typeof ScmPullRequestOpenComposeRequestSchema>;

export const ScmPullRequestOpenComposeResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    url: z.string().url(),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestOpenComposeResponse = z.infer<typeof ScmPullRequestOpenComposeResponseSchema>;

export const ScmPullRequestOpenOrReuseRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  base: z.string().min(1),
  head: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string(),
});
export type ScmPullRequestOpenOrReuseRequest = z.infer<typeof ScmPullRequestOpenOrReuseRequestSchema>;

export const ScmPullRequestOpenOrReuseResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    kind: z.literal('opened'),
    pullRequest: ScmPullRequestSummarySchema,
    reused: z.boolean(),
  }),
  z.object({
    success: z.literal(true),
    kind: z.literal('no-auth'),
    composeUrl: z.string().url(),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestOpenOrReuseResponse = z.infer<typeof ScmPullRequestOpenOrReuseResponseSchema>;

export const ScmPullRequestCheckoutRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  prReference: ScmPullRequestReferenceSchema,
});
export type ScmPullRequestCheckoutRequest = z.infer<typeof ScmPullRequestCheckoutRequestSchema>;

export const ScmPullRequestCheckoutResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    branch: z.string().min(1),
    headSha: z.string().min(1).nullable(),
    baseSha: z.string().min(1).nullable(),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestCheckoutResponse = z.infer<typeof ScmPullRequestCheckoutResponseSchema>;

export const ScmPullRequestPrepareWorktreeRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  sourcePath: z.string().min(1),
  prReference: ScmPullRequestReferenceSchema,
  mode: z.enum(['local', 'worktree']),
});
export type ScmPullRequestPrepareWorktreeRequest = z.infer<typeof ScmPullRequestPrepareWorktreeRequestSchema>;

export const ScmPullRequestPrepareWorktreeResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    targetPath: z.string().min(1),
    branch: z.string().min(1),
    head: z.string().min(1).nullable(),
  }),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestPrepareWorktreeResponse = z.infer<typeof ScmPullRequestPrepareWorktreeResponseSchema>;

export const ScmPullRequestStackedActionSchema = z.enum([
  'commit',
  'push',
  'createPr',
  'commitPush',
  'commitPushPr',
]);
export type ScmPullRequestStackedAction = z.infer<typeof ScmPullRequestStackedActionSchema>;

export const ScmPullRequestStackedPhaseSchema = z.enum([
  'branch',
  'commit',
  'push',
  'pr',
]);
export type ScmPullRequestStackedPhase = z.infer<typeof ScmPullRequestStackedPhaseSchema>;

export const ScmPullRequestRunStackedRequestSchema = ScmPullRequestRequestBaseSchema.extend({
  action: ScmPullRequestStackedActionSchema,
  commitMessage: z.string().min(1).optional(),
  featureBranch: z.string().min(1).optional(),
  filePaths: z.array(z.string().min(1)).optional(),
  base: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
});
export type ScmPullRequestRunStackedRequest = z.infer<typeof ScmPullRequestRunStackedRequestSchema>;

export const ScmPullRequestRunStackedProgressEventSchema = z.object({
  kind: z.enum([
    'action_started',
    'phase_started',
    'hook_started',
    'hook_output',
    'hook_finished',
    'action_finished',
    'action_failed',
  ]),
  phase: ScmPullRequestStackedPhaseSchema.optional(),
  message: z.string().min(1).optional(),
  output: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type ScmPullRequestRunStackedProgressEvent =
  z.infer<typeof ScmPullRequestRunStackedProgressEventSchema>;

export const ScmPullRequestRunStackedNextActionSchema = z.union([
  z.object({
    kind: z.literal('openPullRequest'),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('openCompose'),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('none'),
  }),
]);
export type ScmPullRequestRunStackedNextAction =
  z.infer<typeof ScmPullRequestRunStackedNextActionSchema>;

export const ScmPullRequestRunStackedResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    pullRequest: ScmPullRequestSummarySchema.nullable().optional(),
    composeUrl: z.string().url().optional(),
    branch: z.string().min(1).nullable().optional(),
    commitSha: z.string().min(1).nullable().optional(),
    nextAction: ScmPullRequestRunStackedNextActionSchema.optional(),
    events: z.array(ScmPullRequestRunStackedProgressEventSchema).default([]),
  }),
  ScmPullRequestErrorResponseSchema.extend({
    events: z.array(ScmPullRequestRunStackedProgressEventSchema).default([]),
  }),
]);
export type ScmPullRequestRunStackedResponse = z.infer<typeof ScmPullRequestRunStackedResponseSchema>;
