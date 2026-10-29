import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';
import { ScmCommitPublicationSchema } from './commitPublication.js';
import { ScmRepositoryProvisioningFailureResponseSchema } from './repositoryProvisioning.js';

import {
  ProviderRefreshPolicySchema,
  VcsRemoteStateFreshnessSchema,
} from './freshness.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';
import { ScmBackendPreferenceSchema } from './backendIdentity.js';
import { ScmDefaultBranchPushPolicySchema } from './defaultBranchPushPolicy.js';
import {
  ScmBranchSourceRefSchema,
  ScmOptionalBranchSourceRefSchema,
  normalizeScmBranchSourceRef as normalizeScmPullRequestBranchSourceRef,
} from './remoteNormalization.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { RepositoryCheckpointCommitEvidenceSchema } from '../sessions/changes/schemas.js';
import { ScmBranchWorkIdentitySchema } from './branches.js';
import { defineProtocolLiteral, defineProtocolUnion } from '../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

export {
  ScmDefaultBranchPushPolicySchema,
  type ScmDefaultBranchPushPolicy,
} from './defaultBranchPushPolicy.js';

/** One hosting-kind grammar for native readers and public feature protocols. */
export const ScmHostingProviderKindProtocolSchema = defineProtocolUnion([
  defineProtocolLiteral('github'),
  defineProtocolLiteral('gitlab'),
  defineProtocolLiteral('bitbucket'),
  defineProtocolLiteral('azure-devops'),
  defineProtocolLiteral('custom'),
  defineProtocolLiteral('unknown'),
]);
export const ScmHostingProviderKindSchema = asProtocolZod(ScmHostingProviderKindProtocolSchema);
export type ScmHostingProviderKind = z.infer<typeof ScmHostingProviderKindSchema>;

const ScmHostingProviderPullRequestCapabilitiesSchema = lazyZodSchema(() => z._default(z.strictObject({
  list: z._default(z.boolean(), false),
  get: z._default(z.boolean(), false),
  create: z._default(z.boolean(), false),
  checkout: z._default(z.boolean(), false),
  prepareWorktree: z._default(z.boolean(), false),
  runStacked: z._default(z.boolean(), false),
}), {
  list: false,
  get: false,
  create: false,
  checkout: false,
  prepareWorktree: false,
  runStacked: false,
}));

const ScmHostingProviderRepositoryProvisioningCapabilitiesSchema = lazyZodSchema(() => z._default(z.strictObject({
  describeTargets: z._default(z.boolean(), false),
  createRepository: z._default(z.boolean(), false),
  publish: z._default(z.boolean(), false),
}), {
  describeTargets: false,
  createRepository: false,
  publish: false,
}));

const ScmHostingProviderReviewThreadCapabilitiesSchema = lazyZodSchema(() => z._default(z.strictObject({
  read: z._default(z.boolean(), false),
  write: z._default(z.boolean(), false),
}), {
  read: false,
  write: false,
}));

export const ScmHostingProviderCapabilitiesSchema = lazyZodSchema(() => z._default(z.strictObject({
  capabilityScope: z._default(z.literal('remote-hosting-provider'), 'remote-hosting-provider'),
  compareUrl: z._default(z.boolean(), false),
  openUrl: z._default(z.boolean(), false),
  pullRequests: ScmHostingProviderPullRequestCapabilitiesSchema,
  repositoryProvisioning: ScmHostingProviderRepositoryProvisioningCapabilitiesSchema,
  reviewThreads: ScmHostingProviderReviewThreadCapabilitiesSchema,
}), {
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
}));
export type ScmHostingProviderCapabilities =
  z.infer<typeof ScmHostingProviderCapabilitiesSchema>;

export const ScmHostingProviderUrlSafetySchema = lazyZodSchema(() => z.looseObject({
    allowedSchemes: z._default(z.array(z.string().check(z.minLength(2))), ['https:']),
  }));
export type ScmHostingProviderUrlSafety = z.infer<typeof ScmHostingProviderUrlSafetySchema>;

const LEGACY_SCM_HOSTING_PROVIDER_IDS = Object.freeze({
  github: 'happier.scm.forge.github/github',
  gitlab: 'happier.scm.forge.gitlab/gitlab',
  bitbucket: 'happier.scm.forge.bitbucket/bitbucket',
  unknown: 'legacy.scm.hosting.unknown/unknown',
} as const);

/** Known pre-qualification identities; custom registry ids remain exact. */
export function resolveLegacyScmHostingProviderId(id: string): string | undefined {
  return Object.hasOwn(LEGACY_SCM_HOSTING_PROVIDER_IDS, id)
    ? LEGACY_SCM_HOSTING_PROVIDER_IDS[id as keyof typeof LEGACY_SCM_HOSTING_PROVIDER_IDS]
    : undefined;
}

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
    const id = resolveLegacyScmHostingProviderId(kind)
      ?? LEGACY_SCM_HOSTING_PROVIDER_IDS.unknown;
    return { ...record, id, displayName };
  } catch {
    return value;
  }
}

const ScmHostingProviderRefValueSchema = lazyZodSchema(() => z.looseObject({
    id: z.string().check(z.minLength(1)),
    kind: ScmHostingProviderKindSchema,
    displayName: z.string().check(z.minLength(1)),
    baseUrl: z.string().check(z.url()),
    nameWithOwner: z.optional(z.string().check(z.minLength(1))),
    repositoryWebUrl: z.optional(z.string().check(z.url())),
    remoteName: z.optional(z.string().check(z.minLength(1))),
    urlSafety: z._default(ScmHostingProviderUrlSafetySchema, { allowedSchemes: ['https:'] }),
  }));
export const ScmHostingProviderRefSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyScmHostingProviderRef), ScmHostingProviderRefValueSchema));
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

export const ScmPullRequestStateSchema = lazyZodSchema(() => z.enum([
  'open',
  'closed',
  'merged',
  'draft',
  'unknown',
]));
export type ScmPullRequestState = z.infer<typeof ScmPullRequestStateSchema>;

export const ScmPullRequestAuthorSchema = lazyZodSchema(() => z.looseObject({
    login: z.optional(z.string().check(z.minLength(1))),
    displayName: z.optional(z.string().check(z.minLength(1))),
    url: z.optional(z.string().check(z.url())),
  }));
export type ScmPullRequestAuthor = z.infer<typeof ScmPullRequestAuthorSchema>;

export const ScmPullRequestChecksStateSchema = lazyZodSchema(() => z.enum([
  'pending',
  'success',
  'failure',
  'unknown',
]));
export type ScmPullRequestChecksState = z.infer<typeof ScmPullRequestChecksStateSchema>;

export const ScmPullRequestChecksSummarySchema = lazyZodSchema(() => z.looseObject({
    state: ScmPullRequestChecksStateSchema,
    description: z.optional(z.string().check(z.minLength(1))),
  }));
export type ScmPullRequestChecksSummary = z.infer<typeof ScmPullRequestChecksSummarySchema>;

export const ScmPullRequestSummarySchema = lazyZodSchema(() => z.looseObject({
    provider: ScmHostingProviderRefSchema,
    number: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
    providerNativeId: z.optional(z.string().check(z.minLength(1))),
    title: z.string().check(z.minLength(1)),
    url: z.string().check(z.url()),
    baseBranch: z.string().check(z.minLength(1)),
    headBranch: z.string().check(z.minLength(1)),
    headRepositoryNameWithOwner: z.optional(z.string().check(z.minLength(1))),
    isCrossRepository: z.optional(z.boolean()),
    headSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    baseSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    state: ScmPullRequestStateSchema,
    createdAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    closedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    mergedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    isDraft: z.optional(z.boolean()),
    author: z.optional(ScmPullRequestAuthorSchema),
    checks: z.optional(ScmPullRequestChecksSummarySchema),
  }));
export type ScmPullRequestSummary = z.infer<typeof ScmPullRequestSummarySchema>;
/**
 * Current admitted discovery values use the same field grammar without the
 * legacy-provider input preprocessor, which has no portable JSON shape.
 */
export const ScmPullRequestSummaryProtocolSchema = projectZodProtocolSchema(lazyZodSchema(() => z.extend(
  ScmPullRequestSummarySchema, { provider: ScmHostingProviderRefValueSchema },
)));

/** Private authorized SCM read projection, never accounting event metadata. */
export const ScmPullRequestWorkEvidenceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RepositoryCheckpointCommitEvidenceSchema, {
  pullRequest: ScmPullRequestSummarySchema,
  /** Local refs with exactly this admitted hosting head, never matched by name. */
  branches: z.optional(z.array(ScmBranchWorkIdentitySchema)),
  /** The local branch reader's opaque Git-directory identity; hosted repositoryKey stays unchanged. */
  branchRepositoryKey: z.optional(z.string().check(z.minLength(1))),
})));
export type ScmPullRequestWorkEvidence = z.infer<typeof ScmPullRequestWorkEvidenceSchema>;
const ScmPullRequestWorkEvidenceRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
}));
const ScmPullRequestWorkEvidenceStatusSchema = lazyZodSchema(() => z.enum(['available', 'partial', 'unavailable']));

const ScmPullRequestReferenceBaseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ number: z.number().check(z.int(), z.positive()) }),
  z.looseObject({ url: z.string().check(z.url()) }),
  z.looseObject({ headBranch: ScmBranchSourceRefSchema }),
]));
export const ScmPullRequestReferenceSchema = lazyZodSchema(() => ScmPullRequestReferenceBaseSchema.check(z.superRefine((value, ctx) => {
  const headBranch = (value as { headBranch?: unknown }).headBranch;
  if (headBranch === undefined) return;
  const result = normalizeScmPullRequestBranchSourceRef(typeof headBranch === 'string' ? headBranch : undefined);
  if (!result.ok || result.sourceRef !== headBranch) {
    ctx.addIssue({
      code: "custom",
      path: ['headBranch'],
      message: result.ok ? 'Source ref contains unsupported syntax' : result.error,
    });
  }
})));
export type ScmPullRequestReference = z.infer<typeof ScmPullRequestReferenceSchema>;

export const ScmPullRequestAuthStateSchema = lazyZodSchema(() => z.enum([
  'authenticated',
  'authentication_required',
  'unsupported',
  'unknown',
]));
export type ScmPullRequestAuthState = z.infer<typeof ScmPullRequestAuthStateSchema>;

export const ScmPullRequestStatusProjectionSchema = lazyZodSchema(() => z.looseObject({
    provider: z.nullable(ScmHostingProviderRefSchema),
    headBranch: z.nullable(z.string().check(z.minLength(1))),
    baseBranch: z.nullable(z.string().check(z.minLength(1))),
    openPullRequest: z.nullable(ScmPullRequestSummarySchema),
    composeUrl: z.optional(z.nullable(z.string().check(z.url()))),
    authState: z.optional(ScmPullRequestAuthStateSchema),
    checkedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    cacheTtlMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    freshness: z.optional(VcsRemoteStateFreshnessSchema),
    refreshPolicy: z.optional(ProviderRefreshPolicySchema),
  }));
export type ScmPullRequestStatusProjection = z.infer<typeof ScmPullRequestStatusProjectionSchema>;

export const ScmFollowupActionSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      kind: z.literal('openUrl'),
      purpose: z.enum(['pullRequest', 'compose']),
      url: z.string().check(z.url()),
      allowedBaseUrl: z.string().check(z.url()),
      urlSafety: z._default(ScmHostingProviderUrlSafetySchema, { allowedSchemes: ['https:'] }),
    }),
  z.looseObject({ kind: z.literal('none') }),
]));
export type ScmFollowupAction = z.infer<typeof ScmFollowupActionSchema>;

const ScmPullRequestErrorResponseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRepositoryProvisioningFailureResponseSchema, {
    result: z.optional(z.literal('opened_compose')),
    composeUrl: z.optional(z.string().check(z.url())),
  })));
export type ScmPullRequestErrorResponse = z.infer<typeof ScmPullRequestErrorResponseSchema>;

export const ScmPullRequestListRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  providerId: z.optional(z.string().check(z.minLength(1))),
  base: ScmOptionalBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  state: z.optional(ScmPullRequestStateSchema),
  workEvidence: z.optional(ScmPullRequestWorkEvidenceRequestSchema),
})));
export type ScmPullRequestListRequest = z.infer<typeof ScmPullRequestListRequestSchema>;

export const ScmPullRequestListResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      pullRequests: z.array(ScmPullRequestSummarySchema),
      workEvidence: z.optional(z.array(ScmPullRequestWorkEvidenceSchema)),
      workEvidenceStatus: z.optional(ScmPullRequestWorkEvidenceStatusSchema),
      freshness: z.optional(VcsRemoteStateFreshnessSchema),
      refreshPolicy: z.optional(ProviderRefreshPolicySchema),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestListResponse = z.infer<typeof ScmPullRequestListResponseSchema>;

export const ScmPullRequestGetRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  prReference: ScmPullRequestReferenceSchema,
  workEvidence: z.optional(ScmPullRequestWorkEvidenceRequestSchema),
})));
export type ScmPullRequestGetRequest = z.infer<typeof ScmPullRequestGetRequestSchema>;

export const ScmPullRequestGetResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      pullRequest: z.nullable(ScmPullRequestSummarySchema),
      workEvidence: z.optional(z.array(ScmPullRequestWorkEvidenceSchema)),
      workEvidenceStatus: z.optional(ScmPullRequestWorkEvidenceStatusSchema),
      freshness: z.optional(VcsRemoteStateFreshnessSchema),
      refreshPolicy: z.optional(ProviderRefreshPolicySchema),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestGetResponse = z.infer<typeof ScmPullRequestGetResponseSchema>;

export const ScmPullRequestOpenComposeRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  providerId: z.optional(z.string().check(z.minLength(1))),
  base: ScmBranchSourceRefSchema,
  head: ScmBranchSourceRefSchema,
  includeTemplate: z.optional(z.boolean()),
})));
export type ScmPullRequestOpenComposeRequest = z.infer<typeof ScmPullRequestOpenComposeRequestSchema>;

export const ScmPullRequestOpenComposeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      nextAction: ScmFollowupActionSchema,
      composeUrl: z.optional(z.string().check(z.url())),
      template: z.optional(z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('ready'), body: z.optional(z.string()) }),
        z.strictObject({ kind: z.literal('needs_input'), error: z.string().check(z.minLength(1)) }),
      ])),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestOpenComposeResponse = z.infer<typeof ScmPullRequestOpenComposeResponseSchema>;

export const ScmPullRequestOpenOrReuseRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  providerId: z.optional(z.string().check(z.minLength(1))),
  base: ScmBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  headRepositoryNameWithOwner: z.optional(z.string().check(z.trim(), z.minLength(1))),
  title: z.optional(z.string().check(z.minLength(1))),
  body: z.optional(z.string()),
  draft: z.optional(z.boolean()),
  defaultBranchPushPolicy: z.optional(ScmDefaultBranchPushPolicySchema),
})));
export type ScmPullRequestOpenOrReuseRequest = z.infer<typeof ScmPullRequestOpenOrReuseRequestSchema>;

export const ScmPullRequestOpenOrReuseResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      pullRequest: z.optional(z.nullable(ScmPullRequestSummarySchema)),
      reused: z.optional(z.boolean()),
      result: z.optional(z.enum(['created', 'reused', 'opened_compose'])),
      outcome: z.optional(ScmOperationOutcomeSchema),
      composeUrl: z.optional(z.string().check(z.url())),
      nextAction: ScmFollowupActionSchema,
      authState: z.optional(ScmPullRequestAuthStateSchema),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestOpenOrReuseResponse = z.infer<typeof ScmPullRequestOpenOrReuseResponseSchema>;

export const ScmPullRequestCheckoutRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  prReference: ScmPullRequestReferenceSchema,
})));
export type ScmPullRequestCheckoutRequest = z.infer<typeof ScmPullRequestCheckoutRequestSchema>;

export const ScmPullRequestCheckoutResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      outcome: z.optional(ScmOperationOutcomeSchema),
      pullRequest: z.optional(z.nullable(ScmPullRequestSummarySchema)),
      branch: z.optional(z.string().check(z.minLength(1))),
      headSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
      baseSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestCheckoutResponse = z.infer<typeof ScmPullRequestCheckoutResponseSchema>;

export const ScmPullRequestPrepareWorktreeModeSchema = lazyZodSchema(() => z.enum([
  'local',
  'worktree',
]));
export type ScmPullRequestPrepareWorktreeMode =
  z.infer<typeof ScmPullRequestPrepareWorktreeModeSchema>;

export const ScmPullRequestPrepareWorktreeRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  sourcePath: z.string().check(z.minLength(1)),
  prReference: ScmPullRequestReferenceSchema,
  mode: z.optional(ScmPullRequestPrepareWorktreeModeSchema),
})));
export type ScmPullRequestPrepareWorktreeRequest =
  z.infer<typeof ScmPullRequestPrepareWorktreeRequestSchema>;

export const ScmPullRequestPrepareWorktreeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      outcome: z.optional(ScmOperationOutcomeSchema),
      targetPath: z.string().check(z.minLength(1)),
      branch: z.optional(z.string().check(z.minLength(1))),
      pullRequest: z.optional(z.nullable(ScmPullRequestSummarySchema)),
    }),
  ScmPullRequestErrorResponseSchema,
]));
export type ScmPullRequestPrepareWorktreeResponse =
  z.infer<typeof ScmPullRequestPrepareWorktreeResponseSchema>;

export const ScmPullRequestStackedActionSchema = lazyZodSchema(() => z.enum([
  'commit',
  'push',
  'openOrReuse',
  'commitAndPush',
  'pushAndOpenOrReuse',
  'commitPushAndOpenOrReuse',
]));
export type ScmPullRequestStackedAction = z.infer<typeof ScmPullRequestStackedActionSchema>;

export const ScmPullRequestRunStackedPhaseSchema = lazyZodSchema(() => z.enum([
  'branch',
  'commit',
  'push',
  'pr',
]));
export type ScmPullRequestRunStackedPhase = z.infer<typeof ScmPullRequestRunStackedPhaseSchema>;

export const ScmPullRequestRunStackedProgressEventSchema = lazyZodSchema(() => z.looseObject({
    kind: z.enum([
      'action_started',
      'phase_started',
      'phase_finished',
      'action_finished',
      'action_failed',
      'output',
    ]),
    phase: z.optional(ScmPullRequestRunStackedPhaseSchema),
    message: z.optional(z.string().check(z.minLength(1))),
    output: z.optional(z.string()),
    timestamp: z.number().check(z.int(), z.nonnegative()),
  }));
export type ScmPullRequestRunStackedProgressEvent =
  z.infer<typeof ScmPullRequestRunStackedProgressEventSchema>;

export const ScmPullRequestRunStackedRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmRequestBaseSchema, {
  action: ScmPullRequestStackedActionSchema,
  commitMessage: z.optional(z.string().check(z.minLength(1))),
  featureBranch: ScmOptionalBranchSourceRefSchema,
  filePaths: z.optional(z.array(ScmSelectedMutationPathSchema)),
  base: ScmOptionalBranchSourceRefSchema,
  head: ScmOptionalBranchSourceRefSchema,
  title: z.optional(z.string().check(z.minLength(1))),
  body: z.optional(z.string()),
  defaultBranchPushPolicy: z.optional(ScmDefaultBranchPushPolicySchema),
})));
export type ScmPullRequestRunStackedRequest =
  z.infer<typeof ScmPullRequestRunStackedRequestSchema>;

export const ScmPullRequestRunStackedResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      outcome: z.optional(ScmOperationOutcomeSchema),
      pullRequest: z.optional(z.nullable(ScmPullRequestSummarySchema)),
      composeUrl: z.optional(z.string().check(z.url())),
      branch: z.optional(z.nullable(z.string().check(z.minLength(1)))),
      commitSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
      commitPublication: z.optional(ScmCommitPublicationSchema),
      nextAction: ScmFollowupActionSchema,
      events: z._default(z.array(ScmPullRequestRunStackedProgressEventSchema), []),
    }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ScmPullRequestErrorResponseSchema, {
    commitSha: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    commitPublication: z.optional(ScmCommitPublicationSchema),
    events: z._default(z.array(ScmPullRequestRunStackedProgressEventSchema), []),
  })),
]));
export type ScmPullRequestRunStackedResponse =
  z.infer<typeof ScmPullRequestRunStackedResponseSchema>;
