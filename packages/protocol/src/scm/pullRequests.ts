import { z } from 'zod';

import {
  ProviderRefreshPolicySchema,
  VcsRemoteStateFreshnessSchema,
} from './freshness.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';
import { ScmBackendPreferenceSchema } from './backendIdentity.js';

const SCM_PULL_REQUEST_OPERATION_ERROR_CODES = {
  NOT_REPOSITORY: 'NOT_REPOSITORY',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_REQUEST: 'INVALID_REQUEST',
  COMMAND_FAILED: 'COMMAND_FAILED',
  CHANGE_APPLY_FAILED: 'CHANGE_APPLY_FAILED',
  COMMIT_REQUIRED: 'COMMIT_REQUIRED',
  CONFLICTING_WORKTREE: 'CONFLICTING_WORKTREE',
  REMOTE_AUTH_REQUIRED: 'REMOTE_AUTH_REQUIRED',
  REMOTE_UPSTREAM_REQUIRED: 'REMOTE_UPSTREAM_REQUIRED',
  REMOTE_NON_FAST_FORWARD: 'REMOTE_NON_FAST_FORWARD',
  REMOTE_FF_ONLY_REQUIRED: 'REMOTE_FF_ONLY_REQUIRED',
  REMOTE_REJECTED: 'REMOTE_REJECTED',
  REMOTE_NOT_FOUND: 'REMOTE_NOT_FOUND',
  REMOTE_ALREADY_EXISTS: 'REMOTE_ALREADY_EXISTS',
  BRANCH_OPERATION_IN_PROGRESS: 'BRANCH_OPERATION_IN_PROGRESS',
  BRANCH_OPERATION_NOT_IN_PROGRESS: 'BRANCH_OPERATION_NOT_IN_PROGRESS',
  FEATURE_UNSUPPORTED: 'FEATURE_UNSUPPORTED',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
} as const;

const ScmOperationErrorCodeSchema = z.enum([
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.NOT_REPOSITORY,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.INVALID_PATH,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.INVALID_REQUEST,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.COMMAND_FAILED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_REJECTED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
  SCM_PULL_REQUEST_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
]);

const ScmRequestBaseSchema = z.object({
  cwd: z.string().optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(),
});

export const ScmDefaultBranchPushPolicySchema = z.enum([
  'allow',
  'requires-feature-branch',
  'deny',
]);
export type ScmDefaultBranchPushPolicy = z.infer<typeof ScmDefaultBranchPushPolicySchema>;

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

function hasUnsupportedBranchRefSyntax(value: string): boolean {
  if (CONTROL_CHAR_REGEX.test(value)) return true;
  if (value.includes('\\')) return true;
  if (value.includes('//')) return true;
  if (value.startsWith('/') || value.endsWith('/')) return true;
  if (value.includes('@{') || value.includes('..')) return true;
  return (
    value.startsWith('+') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes(':') ||
    value.includes('^') ||
    value.includes('~') ||
    value.includes('?') ||
    value.includes('*') ||
    value.includes('[')
  );
}

function normalizeScmPullRequestBranchSourceRef(value: string | undefined): { ok: true; sourceRef: string } | { ok: false; error: string } {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return { ok: false, error: 'Source ref is required' };
  }
  if (normalized.startsWith('-')) {
    return { ok: false, error: 'Source ref cannot start with "-"' };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: 'Source ref must not contain whitespace' };
  }
  if (hasUnsupportedBranchRefSyntax(normalized)) {
    return { ok: false, error: 'Source ref contains unsupported syntax' };
  }
  return { ok: true, sourceRef: normalized };
}

const ScmBranchSourceRefSchema = z.string().transform((value, ctx) => {
  const result = normalizeScmPullRequestBranchSourceRef(value);
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.error,
    });
    return z.NEVER;
  }
  return result.sourceRef;
});

const ScmOptionalBranchSourceRefSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() ? value : undefined;
}, ScmBranchSourceRefSchema.optional());

export const ScmHostingProviderKindSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'custom',
  'unknown',
]);
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

const ScmHostingProviderPullRequestCapabilitiesSchema = z.object({
  list: z.boolean().default(false),
  get: z.boolean().default(false),
  create: z.boolean().default(false),
  checkout: z.boolean().default(false),
  prepareWorktree: z.boolean().default(false),
  runStacked: z.boolean().default(false),
}).strict().default({
  list: false,
  get: false,
  create: false,
  checkout: false,
  prepareWorktree: false,
  runStacked: false,
});

const ScmHostingProviderRepositoryProvisioningCapabilitiesSchema = z.object({
  describeTargets: z.boolean().default(false),
  createRepository: z.boolean().default(false),
  publish: z.boolean().default(false),
}).strict().default({
  describeTargets: false,
  createRepository: false,
  publish: false,
});

const ScmHostingProviderReviewThreadCapabilitiesSchema = z.object({
  read: z.boolean().default(false),
  write: z.boolean().default(false),
}).strict().default({
  read: false,
  write: false,
});

export const ScmHostingProviderCapabilitiesSchema = z.object({
  capabilityScope: z.literal('remote-hosting-provider').default('remote-hosting-provider'),
  compareUrl: z.boolean().default(false),
  openUrl: z.boolean().default(false),
  pullRequests: ScmHostingProviderPullRequestCapabilitiesSchema,
  repositoryProvisioning: ScmHostingProviderRepositoryProvisioningCapabilitiesSchema,
  reviewThreads: ScmHostingProviderReviewThreadCapabilitiesSchema,
}).strict().default({
  capabilityScope: 'remote-hosting-provider',
  compareUrl: false,
  openUrl: false,
  pullRequests: {
    list: false,
    get: false,
    create: false,
    checkout: false,
    prepareWorktree: false,
    runStacked: false,
  },
  repositoryProvisioning: {
    describeTargets: false,
    createRepository: false,
    publish: false,
  },
  reviewThreads: {
    read: false,
    write: false,
  },
});
export type ScmHostingProviderCapabilities =
  z.infer<typeof ScmHostingProviderCapabilitiesSchema>;

export const ScmHostingProviderUrlSafetySchema = z
  .object({
    allowedSchemes: z.array(z.string().min(2)).default(['https:']),
  })
  .passthrough();
export type ScmHostingProviderUrlSafety = z.infer<typeof ScmHostingProviderUrlSafetySchema>;

const LEGACY_SCM_HOSTING_PROVIDER_IDS = Object.freeze({
  github: 'happier.scm.hosting.github/github',
  gitlab: 'happier.scm.hosting.gitlab/gitlab',
  bitbucket: 'happier.scm.hosting.bitbucket/bitbucket',
  unknown: 'legacy.scm.hosting.unknown/unknown',
} as const);

function normalizeLegacyScmHostingProviderRef(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  try {
    const record = value as Record<string, unknown>;
    if (record.kind === 'unknown' && record.providerKind === 'custom') {
      return { ...record, kind: 'custom' };
    }
    if (typeof record.id === 'string' || typeof record.displayName === 'string') return value;
    const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
    const displayName = typeof record.name === 'string' ? record.name : null;
    if (!displayName) return value;
    const id = LEGACY_SCM_HOSTING_PROVIDER_IDS[kind as keyof typeof LEGACY_SCM_HOSTING_PROVIDER_IDS]
      ?? LEGACY_SCM_HOSTING_PROVIDER_IDS.unknown;
    return { ...record, id, displayName };
  } catch {
    return value;
  }
}

export const ScmHostingProviderRefSchema = z.preprocess(
  normalizeLegacyScmHostingProviderRef,
  z.object({
    id: z.string().min(1),
    kind: ScmHostingProviderKindSchema,
    displayName: z.string().min(1),
    baseUrl: z.string().url(),
    nameWithOwner: z.string().min(1).optional(),
    repositoryWebUrl: z.string().url().optional(),
    remoteName: z.string().min(1).optional(),
    urlSafety: ScmHostingProviderUrlSafetySchema.default({ allowedSchemes: ['https:'] }),
  })
  .passthrough(),
);
export type ScmHostingProviderRef = z.infer<typeof ScmHostingProviderRefSchema>;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isAllowedBaseWithinProviderBase(input: Readonly<{
  provider: ScmHostingProviderRef;
  allowedBase: URL;
}>): boolean {
  let providerBase: URL;
  try {
    providerBase = new URL(input.provider.baseUrl);
  } catch {
    return false;
  }
  if (input.allowedBase.origin !== providerBase.origin) return false;

  const providerPath = stripTrailingSlashes(providerBase.pathname);
  const allowedPath = stripTrailingSlashes(input.allowedBase.pathname);
  if (!providerPath || providerPath === '/') return true;
  return allowedPath === providerPath || allowedPath.startsWith(`${providerPath}/`);
}

function isUrlWithinBase(input: Readonly<{
  url: URL;
  base: URL;
}>): boolean {
  if (input.url.origin !== input.base.origin) return false;
  const basePath = stripTrailingSlashes(input.base.pathname);
  const urlPath = stripTrailingSlashes(input.url.pathname);
  if (!basePath || basePath === '/') return true;
  return urlPath === basePath || urlPath.startsWith(`${basePath}/`);
}

export function resolveScmHostingProviderFollowupAllowedBaseUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  allowedBaseUrl: string;
}>): string | null {
  let base: URL;
  try {
    base = new URL(input.allowedBaseUrl);
  } catch {
    return null;
  }
  if (base.username || base.password || base.search || base.hash) {
    return null;
  }
  if (!isAllowedBaseWithinProviderBase({ provider: input.provider, allowedBase: base })) {
    return null;
  }

  const repositoryWebUrl = input.provider.repositoryWebUrl?.trim();
  if (!repositoryWebUrl) {
    return null;
  }

  let repositoryBase: URL;
  try {
    repositoryBase = new URL(repositoryWebUrl);
  } catch {
    return null;
  }
  if (
    repositoryBase.username
    || repositoryBase.password
    || repositoryBase.search
    || repositoryBase.hash
    || !isUrlWithinBase({ url: repositoryBase, base })
  ) return null;
  return stripTrailingSlashes(repositoryBase.toString());
}

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
    headRepositoryNameWithOwner: z.string().min(1).optional(),
    isCrossRepository: z.boolean().optional(),
    headSha: z.string().min(1).nullable().optional(),
    baseSha: z.string().min(1).nullable().optional(),
    state: ScmPullRequestStateSchema,
    isDraft: z.boolean().optional(),
    author: ScmPullRequestAuthorSchema.optional(),
    checks: ScmPullRequestChecksSummarySchema.optional(),
  })
  .passthrough();
export type ScmPullRequestSummary = z.infer<typeof ScmPullRequestSummarySchema>;

const ScmPullRequestReferenceBaseSchema = z.union([
  z.object({ number: z.number().int().positive() }).passthrough(),
  z.object({ url: z.string().url() }).passthrough(),
  z.object({ headBranch: ScmBranchSourceRefSchema }).passthrough(),
]);
export const ScmPullRequestReferenceSchema = ScmPullRequestReferenceBaseSchema.superRefine((value, ctx) => {
  const headBranch = (value as { headBranch?: unknown }).headBranch;
  if (headBranch === undefined) return;
  const result = normalizeScmPullRequestBranchSourceRef(typeof headBranch === 'string' ? headBranch : undefined);
  if (!result.ok || result.sourceRef !== headBranch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headBranch'],
      message: result.ok ? 'Source ref contains unsupported syntax' : result.error,
    });
  }
});
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
    freshness: VcsRemoteStateFreshnessSchema.optional(),
    refreshPolicy: ProviderRefreshPolicySchema.optional(),
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
      urlSafety: ScmHostingProviderUrlSafetySchema.default({ allowedSchemes: ['https:'] }),
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
      freshness: VcsRemoteStateFreshnessSchema.optional(),
      refreshPolicy: ProviderRefreshPolicySchema.optional(),
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
      freshness: VcsRemoteStateFreshnessSchema.optional(),
      refreshPolicy: ProviderRefreshPolicySchema.optional(),
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
  headRepositoryNameWithOwner: z.string().trim().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  defaultBranchPushPolicy: ScmDefaultBranchPushPolicySchema.optional(),
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
  featureBranch: ScmOptionalBranchSourceRefSchema,
  filePaths: z.array(ScmSelectedMutationPathSchema).optional(),
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
