import { z } from 'zod';

import {
  ScmDefaultBranchPushPolicySchema,
  ScmBranchSourceRefSchema,
  ScmOperationErrorCodeSchema,
  ScmOptionalBranchSourceRefSchema,
  ScmRequestBaseSchema,
} from './scm.js';

export {
  ScmDefaultBranchPushPolicySchema,
  type ScmDefaultBranchPushPolicy,
} from './scm.js';

export const ScmHostingProviderKindSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'custom',
  'unknown',
]);
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

export const ScmHostingProviderUrlSafetySchema = z
  .object({
    allowedSchemes: z.array(z.string().min(2)).default(['https:']),
  })
  .passthrough();
export type ScmHostingProviderUrlSafety = z.infer<typeof ScmHostingProviderUrlSafetySchema>;

export const ScmHostingProviderRefSchema = z
  .object({
    id: z.string().min(1),
    kind: ScmHostingProviderKindSchema,
    displayName: z.string().min(1),
    baseUrl: z.string().url(),
    nameWithOwner: z.string().min(1).optional(),
    remoteName: z.string().min(1).optional(),
    urlSafety: ScmHostingProviderUrlSafetySchema.default({ allowedSchemes: ['https:'] }),
  })
  .passthrough();
export type ScmHostingProviderRef = z.infer<typeof ScmHostingProviderRefSchema>;

export const ScmPullRequestStateSchema = z.enum([
  'open',
  'closed',
  'merged',
  'draft',
  'unknown',
]);
export type ScmPullRequestState = z.infer<typeof ScmPullRequestStateSchema>;

export const ScmPullRequestAuthorSchema = z
  .object({
    login: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .passthrough();
export type ScmPullRequestAuthor = z.infer<typeof ScmPullRequestAuthorSchema>;

export const ScmPullRequestChecksStateSchema = z.enum([
  'pending',
  'success',
  'failure',
  'unknown',
]);
export type ScmPullRequestChecksState = z.infer<typeof ScmPullRequestChecksStateSchema>;

export const ScmPullRequestChecksSummarySchema = z
  .object({
    state: ScmPullRequestChecksStateSchema,
    description: z.string().min(1).optional(),
  })
  .passthrough();
export type ScmPullRequestChecksSummary = z.infer<typeof ScmPullRequestChecksSummarySchema>;

export const ScmPullRequestSummarySchema = z
  .object({
    provider: ScmHostingProviderRefSchema,
    number: z.number().int().positive().nullable().optional(),
    providerNativeId: z.string().min(1).optional(),
    title: z.string().min(1),
    url: z.string().url(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
    headSha: z.string().min(1).nullable().optional(),
    baseSha: z.string().min(1).nullable().optional(),
    state: ScmPullRequestStateSchema,
    isDraft: z.boolean().optional(),
    author: ScmPullRequestAuthorSchema.optional(),
    checks: ScmPullRequestChecksSummarySchema.optional(),
  })
  .passthrough();
export type ScmPullRequestSummary = z.infer<typeof ScmPullRequestSummarySchema>;

export const ScmPullRequestReferenceSchema = z.union([
  z.object({ number: z.number().int().positive() }).passthrough(),
  z.object({ url: z.string().url() }).passthrough(),
  z.object({ headBranch: z.string().min(1) }).passthrough(),
]);
export type ScmPullRequestReference = z.infer<typeof ScmPullRequestReferenceSchema>;

export const ScmPullRequestAuthStateSchema = z.enum([
  'authenticated',
  'authentication_required',
  'unsupported',
  'unknown',
]);
export type ScmPullRequestAuthState = z.infer<typeof ScmPullRequestAuthStateSchema>;

export const ScmPullRequestStatusProjectionSchema = z
  .object({
    provider: ScmHostingProviderRefSchema.nullable(),
    headBranch: z.string().min(1).nullable(),
    baseBranch: z.string().min(1).nullable(),
    openPullRequest: ScmPullRequestSummarySchema.nullable(),
    composeUrl: z.string().url().nullable().optional(),
    authState: ScmPullRequestAuthStateSchema.optional(),
    checkedAt: z.number().int().nonnegative().optional(),
    cacheTtlMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ScmPullRequestStatusProjection = z.infer<typeof ScmPullRequestStatusProjectionSchema>;

export const ScmFollowupActionSchema = z.union([
  z
    .object({
      kind: z.literal('openUrl'),
      purpose: z.enum(['pullRequest', 'compose']),
      url: z.string().url(),
      allowedBaseUrl: z.string().url(),
    })
    .passthrough(),
  z.object({ kind: z.literal('none') }).passthrough(),
]);
export type ScmFollowupAction = z.infer<typeof ScmFollowupActionSchema>;

const ScmPullRequestErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: ScmOperationErrorCodeSchema.optional(),
  })
  .passthrough();
export type ScmPullRequestErrorResponse = z.infer<typeof ScmPullRequestErrorResponseSchema>;

export const ScmPullRequestListRequestSchema = ScmRequestBaseSchema.extend({
  providerId: z.string().min(1).optional(),
  base: ScmOptionalBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  state: ScmPullRequestStateSchema.optional(),
}).passthrough();
export type ScmPullRequestListRequest = z.infer<typeof ScmPullRequestListRequestSchema>;

export const ScmPullRequestListResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      pullRequests: z.array(ScmPullRequestSummarySchema),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestListResponse = z.infer<typeof ScmPullRequestListResponseSchema>;

export const ScmPullRequestGetRequestSchema = ScmRequestBaseSchema.extend({
  prReference: ScmPullRequestReferenceSchema,
}).passthrough();
export type ScmPullRequestGetRequest = z.infer<typeof ScmPullRequestGetRequestSchema>;

export const ScmPullRequestGetResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      pullRequest: ScmPullRequestSummarySchema.nullable(),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestGetResponse = z.infer<typeof ScmPullRequestGetResponseSchema>;

export const ScmPullRequestOpenComposeRequestSchema = ScmRequestBaseSchema.extend({
  providerId: z.string().min(1).optional(),
  base: ScmBranchSourceRefSchema,
  head: ScmBranchSourceRefSchema,
}).passthrough();
export type ScmPullRequestOpenComposeRequest = z.infer<typeof ScmPullRequestOpenComposeRequestSchema>;

export const ScmPullRequestOpenComposeResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      nextAction: ScmFollowupActionSchema,
      composeUrl: z.string().url().optional(),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestOpenComposeResponse = z.infer<typeof ScmPullRequestOpenComposeResponseSchema>;

export const ScmPullRequestOpenOrReuseRequestSchema = ScmRequestBaseSchema.extend({
  providerId: z.string().min(1).optional(),
  base: ScmBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
}).passthrough();
export type ScmPullRequestOpenOrReuseRequest = z.infer<typeof ScmPullRequestOpenOrReuseRequestSchema>;

export const ScmPullRequestOpenOrReuseResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      pullRequest: ScmPullRequestSummarySchema.nullable().optional(),
      reused: z.boolean().optional(),
      composeUrl: z.string().url().optional(),
      nextAction: ScmFollowupActionSchema,
      authState: ScmPullRequestAuthStateSchema.optional(),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestOpenOrReuseResponse = z.infer<typeof ScmPullRequestOpenOrReuseResponseSchema>;

export const ScmPullRequestCheckoutRequestSchema = ScmRequestBaseSchema.extend({
  prReference: ScmPullRequestReferenceSchema,
}).passthrough();
export type ScmPullRequestCheckoutRequest = z.infer<typeof ScmPullRequestCheckoutRequestSchema>;

export const ScmPullRequestCheckoutResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      pullRequest: ScmPullRequestSummarySchema.nullable().optional(),
      branch: z.string().min(1).optional(),
      headSha: z.string().min(1).nullable().optional(),
      baseSha: z.string().min(1).nullable().optional(),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestCheckoutResponse = z.infer<typeof ScmPullRequestCheckoutResponseSchema>;

export const ScmPullRequestPrepareWorktreeModeSchema = z.enum([
  'local',
  'worktree',
]);
export type ScmPullRequestPrepareWorktreeMode =
  z.infer<typeof ScmPullRequestPrepareWorktreeModeSchema>;

export const ScmPullRequestPrepareWorktreeRequestSchema = ScmRequestBaseSchema.extend({
  sourcePath: z.string().min(1),
  prReference: ScmPullRequestReferenceSchema,
  mode: ScmPullRequestPrepareWorktreeModeSchema.optional(),
}).passthrough();
export type ScmPullRequestPrepareWorktreeRequest =
  z.infer<typeof ScmPullRequestPrepareWorktreeRequestSchema>;

export const ScmPullRequestPrepareWorktreeResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      targetPath: z.string().min(1),
      branch: z.string().min(1).optional(),
      pullRequest: ScmPullRequestSummarySchema.nullable().optional(),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema,
]);
export type ScmPullRequestPrepareWorktreeResponse =
  z.infer<typeof ScmPullRequestPrepareWorktreeResponseSchema>;

export const ScmPullRequestStackedActionSchema = z.enum([
  'commit',
  'push',
  'openOrReuse',
  'commitAndPush',
  'pushAndOpenOrReuse',
  'commitPushAndOpenOrReuse',
]);
export type ScmPullRequestStackedAction = z.infer<typeof ScmPullRequestStackedActionSchema>;

export const ScmPullRequestRunStackedPhaseSchema = z.enum([
  'branch',
  'commit',
  'push',
  'pr',
]);
export type ScmPullRequestRunStackedPhase = z.infer<typeof ScmPullRequestRunStackedPhaseSchema>;

export const ScmPullRequestRunStackedProgressEventSchema = z
  .object({
    kind: z.enum([
      'action_started',
      'phase_started',
      'phase_finished',
      'action_finished',
      'action_failed',
      'output',
    ]),
    phase: ScmPullRequestRunStackedPhaseSchema.optional(),
    message: z.string().min(1).optional(),
    output: z.string().optional(),
    timestamp: z.number().int().nonnegative(),
  })
  .passthrough();
export type ScmPullRequestRunStackedProgressEvent =
  z.infer<typeof ScmPullRequestRunStackedProgressEventSchema>;

export const ScmPullRequestRunStackedRequestSchema = ScmRequestBaseSchema.extend({
  action: ScmPullRequestStackedActionSchema,
  commitMessage: z.string().min(1).optional(),
  featureBranch: z.string().min(1).optional(),
  filePaths: z.array(z.string().min(1)).optional(),
  base: ScmOptionalBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  defaultBranchPushPolicy: ScmDefaultBranchPushPolicySchema.optional(),
}).passthrough();
export type ScmPullRequestRunStackedRequest =
  z.infer<typeof ScmPullRequestRunStackedRequestSchema>;

export const ScmPullRequestRunStackedResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      pullRequest: ScmPullRequestSummarySchema.nullable().optional(),
      composeUrl: z.string().url().optional(),
      branch: z.string().min(1).nullable().optional(),
      commitSha: z.string().min(1).nullable().optional(),
      nextAction: ScmFollowupActionSchema,
      events: z.array(ScmPullRequestRunStackedProgressEventSchema).default([]),
    })
    .passthrough(),
  ScmPullRequestErrorResponseSchema.extend({
    events: z.array(ScmPullRequestRunStackedProgressEventSchema).default([]),
  }).passthrough(),
]);
export type ScmPullRequestRunStackedResponse =
  z.infer<typeof ScmPullRequestRunStackedResponseSchema>;
