import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export { resolveScmBackendCapabilities } from './resolveScmBackendCapabilities.js';
export { scmPathMatchesScopePath } from './pathScope.js';
export { buildWorktreeRelativePath, hasForbiddenGitRefName, normalizeWorktreeDisplayName } from './worktreeName.js';
import {
  ProviderRefreshPolicySchema,
  VcsLocalStateFreshnessSchema,
} from './freshness.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';
import {
  ScmBackendIdSchema,
  ScmBackendPreferenceSchema,
} from './backendIdentity.js';
import {
  SCM_OPERATION_ERROR_CODES,
  ScmOperationErrorCodeSchema,
  type ScmOperationErrorCode,
} from './operationError.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';
import { ScmComparisonSourceSchema, ScmRevisionRangeV1Schema } from './comparison.js';
import { FilesystemPreparedExportSchema } from '../actions/filesystemActionFamily.js';
import { ScmCommitOidSchema, ScmCommitExpectedRefSchema, ScmCommitPublicationSchema, ScmCommitHookContentChangesSchema } from './commitPublication.js';
import { ScmRepositoryOperationKindSchema } from './operationState.js';
import { ScmRemotePolicyFields, validateScmRemoteLeaseAuthority } from './remotePolicy.js';
export { admitScmRemotePolicy, type ScmRemotePolicy } from './remotePolicy.js';
export * from './operationOutcome.js';
export * from './entriesHistoryV1.js';
export * from './fileAtRevision.js';
export * from './commitPublication.js';
export * from './branches.js';
export * from './stash.js';
export * from './pullRequests.js';
export * from './diffSummary.js';
export * from './comparisonOccurrences.js';
export * from './comparisonDiscard.js';
export * from './diffSummaryResult.js';
export { executeScmDiffSummaryClear } from './clearSavedResults.js';
export * from './diffSummaryCommitPlan.js';
export * from './repositoryProvisioning.js';
export * from './repositoryClone.js';
export * from './worktrees.js';
export * from './fileChangesScope.js';
import {
  ScmBranchSourceRefSchema,
  ScmRemoteManagementNameSchema,
  ScmRemoteUrlSchema,
} from './remoteNormalization.js';
import { ScmRemoteResponseSchema } from './remoteResponse.js';
import {
  ScmBranchIntegrationOperationSchema,
  ScmCapabilitiesSchema,
  ScmChangeSetModelSchema,
  ScmDefaultBranchPushPolicySchema,
  ScmDiffAreaSchema,
  ScmEntryKindSchema,
  ScmOperationStateSchema,
  ScmRepoModeSchema,
  ScmRemoteInfoSchema,
  ScmWorkingEntrySchema,
  ScmWorkingSnapshotSchema,
  type ScmWorkingSnapshot,
  type ScmWorkingSnapshotInput,
} from './workingSnapshot.js';

export {
  ScmSelectedMutationPathSchema,
  type ScmSelectedMutationPath,
} from './selectedMutationPath.js';
export {
  ScmBackendIdSchema,
  ScmBackendPreferenceSchema,
  ScmBuiltInBackendIdSchema,
  type ScmBackendId,
  type ScmBackendPreference,
  type ScmBuiltInBackendId,
  getFirstPartyScmBackendQualifiedId, getFirstPartyScmBackendLegacyLocalId, isFirstPartyGitScmBackendId,
  SCM_GIT_REPO_BACKEND_OPTIONS, SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH,
  normalizeScmGitRepoPreferredBackend, normalizeScmBackendQualifiedId,
  resolveScmGitRepoPreferredBackendId, buildScmGitRepoBackendPreferenceSettingsDelta,
  type ScmGitRepoPreferredBackend, type ScmGitRepoBackendPreferenceSettingsDelta,
} from './backendIdentity.js';
export {
  ProviderRefreshPolicySchema,
  type ProviderRefreshPolicy,
} from './freshness.js';
export {
  SourceControlCloneProtocolSchema,
  type SourceControlCloneProtocol,
} from './cloneProtocol.js';
export {
  SCM_OPERATION_ERROR_CODES,
  ScmOperationErrorCodeSchema,
  type ScmOperationErrorCode,
} from './operationError.js';
export {
  ScmRequestBaseSchema,
  type ScmRequestBase,
} from './requestBase.js';
export {
  ScmBranchSourceRefSchema,
  ScmOptionalBranchSourceRefSchema,
  ScmOptionalRemoteManagementNameSchema,
  ScmOptionalRemoteNameSchema,
  ScmRemoteNameSchema,
  ScmRemoteUrlSchema,
  normalizeScmBranchSourceRef,
  normalizeScmRemoteName,
  normalizeScmRemoteRequest,
  normalizeScmRemoteUrl,
  type ScmBranchSourceRef,
  type ScmBranchSourceRefNormalizationResult,
  type ScmOptionalBranchSourceRef,
  type ScmOptionalRemoteName,
  type ScmRemoteName,
  type ScmRemoteNameNormalizationResult,
  type ScmRemoteRequestNormalizationResult,
  type ScmRemoteUrl,
  type ScmRemoteUrlNormalizationResult,
} from './remoteNormalization.js';
export {
  ScmRemoteResponseSchema,
  type ScmRemoteResponse,
} from './remoteResponse.js';
export * from './workingSnapshot.js';
export {
  admitScmCommitPolicy,
  admitScmCommitUndoLast,
  createScmCapabilities,
  createScmCapabilitiesFromBackendCapabilities,
} from './capabilities.js';
export {
  ScmBackendCapabilitiesSchema,
  supportedCapability,
  unsupportedCapability,
  type ScmBackendCapabilities,
  type ScmBackendCapabilityLeaf,
  type ScmBackendCapabilityUnavailableReason,
} from './backendCapabilities.js';
export { resolveScmScopedChangedPaths } from './pathScope.js';
export {
  ScmHostingProviderKindProtocolSchema,
  ScmHostingProviderKindSchema,
  resolveScmHostingProviderFollowupAllowedBaseUrl,
  type ScmHostingProviderKind,
  type ScmHostingProviderRef,
} from './pullRequests.js';
export { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from './worktrees.js';
export {
  ScmReviewWorkspaceCurrentnessSchema,
  ScmReviewWorkspaceMaterializePreparedRequestSchema,
  ScmReviewWorkspaceMaterializePreparedResponseSchema,
  ScmReviewWorkspaceSourceTipSchema,
  type ScmReviewWorkspaceCurrentness,
  type ScmReviewWorkspaceMaterializePreparedRequest,
  type ScmReviewWorkspaceMaterializePreparedResponse,
  type ScmReviewWorkspaceSourceTip,
} from './reviewWorkspace.js';
export {
  ScmBackendContributionSchema,
  type ScmBackendContribution,
} from '../plugins/contributions/scmBackends.js';

export const SCM_COMMIT_MESSAGE_MAX_LENGTH = 4096;
export const SCM_COMMIT_PATCH_MAX_COUNT = 256;
export const SCM_COMMIT_PATCH_MAX_LENGTH = 200_000;
/**
 * Bounded length for the `scm.log.list` commit-search query. Queries are user-typed search
 * terms; the bound protects the SCM command line and result transport, not a UX limit.
 */
export const SCM_LOG_QUERY_MAX_LENGTH = 512;

export const ScmBackendDescribeRequestSchema = ScmRequestBaseSchema;
export type ScmBackendDescribeRequest = z.infer<typeof ScmBackendDescribeRequestSchema>;

export const ScmBackendDescribeResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  backendId: z.optional(ScmBackendIdSchema),
  repoMode: z.optional(ScmRepoModeSchema),
  isRepo: z.optional(z.boolean()),
  capabilities: z.optional(ScmCapabilitiesSchema),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmBackendDescribeResponse = z.infer<typeof ScmBackendDescribeResponseSchema>;

export const ScmStatusSnapshotRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  includeWorktreeStatus: z.optional(z.boolean()),
  operationStateVersion: z.optional(z.literal(1)),
}));
export type ScmStatusSnapshotRequest = z.infer<typeof ScmStatusSnapshotRequestSchema>;

export const SCM_WORKTREES_ENRICHMENT_MAX_PATHS = 64;

export const ScmWorktreesEnrichmentRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  worktreePaths: z
    .array(z.string().check(z.minLength(1))).check(z.minLength(0), z.maxLength(SCM_WORKTREES_ENRICHMENT_MAX_PATHS)),
}));
export type ScmWorktreesEnrichmentRequest = z.infer<typeof ScmWorktreesEnrichmentRequestSchema>;

export const ScmWorktreeEnrichmentEntrySchema = lazyZodSchema(() => z.object({
  path: z.string(),
  changeCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  lastActivityAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  ahead: z.optional(z.number().check(z.int(), z.nonnegative())),
  upstream: z.optional(z.nullable(z.string())),
  upstreamGone: z.optional(z.boolean()),
  mergedIntoDefault: z.optional(z.boolean()),
  isLocked: z.optional(z.boolean()),
  lockReason: z.optional(z.string()),
  headOid: z.optional(z.string()),
  hasSubmodules: z.optional(z.boolean()),
  // SCM-owned proof and loss facts consumed by Storage's existing review/Trash lifecycle.
  retention: z.optional(z.strictObject({
    kind: z.enum(['main', 'orphan']), commonDirPath: z.string().check(z.minLength(1)), fingerprint: z.string().check(z.minLength(1)),
    losses: z.optional(z.strictObject({
      unpushedBranches: z.array(z.strictObject({ name: z.string(), ahead: z.number().check(z.int(), z.nonnegative()) })),
      stashes: z.array(z.strictObject({ name: z.string(), oid: z.string() })),
      changes: z.array(z.strictObject({ path: z.string(), untracked: z.boolean(), worktreePath: z.string() })),
      dependentWorktrees: z.array(z.string()),
    })),
  })),
}));
export type ScmWorktreeEnrichmentEntry = z.infer<typeof ScmWorktreeEnrichmentEntrySchema>;

export const ScmWorktreesEnrichmentResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  worktrees: z.optional(z.array(ScmWorktreeEnrichmentEntrySchema)),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmWorktreesEnrichmentResponse = z.infer<typeof ScmWorktreesEnrichmentResponseSchema>;

export const ScmStatusSnapshotResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  snapshot: z.optional(ScmWorkingSnapshotSchema),
  freshness: z.optional(VcsLocalStateFreshnessSchema),
  refreshPolicy: z.optional(ProviderRefreshPolicySchema),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStatusSnapshotResponse = z.infer<typeof ScmStatusSnapshotResponseSchema>;
export type ScmStatusSnapshotTransportResponse = Omit<z.input<typeof ScmStatusSnapshotResponseSchema>, 'snapshot'> & {
  snapshot?: ScmWorkingSnapshotInput;
};

export const ScmDiffFileRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  path: z.string(),
  area: z.optional(ScmDiffAreaSchema),
}));
export type ScmDiffFileRequest = z.infer<typeof ScmDiffFileRequestSchema>;

export const ScmDiffFileResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  diff: z.optional(z.string()),
  reviewUnits: z.optional(z.array(z.strictObject({
    key: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    hunkIndex: z.number().check(z.int(), z.nonnegative()),
    runIndex: z.number().check(z.int(), z.nonnegative()),
    oldStart: z.number().check(z.int(), z.nonnegative()),
    oldLines: z.number().check(z.int(), z.nonnegative()),
    newStart: z.number().check(z.int(), z.nonnegative()),
    newLines: z.number().check(z.int(), z.nonnegative()),
  }))),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmDiffFileResponse = z.infer<typeof ScmDiffFileResponseSchema>;

/** A separate operation prevents an older reader from silently ignoring the alignment guard. */
export const ScmBlameFileRequestSchema = lazyZodSchema(() => z.strictObject({
  ...ScmRequestBaseSchema.shape,
  path: z.string().check(z.minLength(1)),
  expectedHash: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
}));
export type ScmBlameFileRequest = z.infer<typeof ScmBlameFileRequestSchema>;

export const ScmBlameRangeSchema = lazyZodSchema(() => z.strictObject({
  startLine: z.number().check(z.int(), z.positive()),
  lineCount: z.number().check(z.int(), z.positive()),
  commitIndex: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));
export type ScmBlameRange = z.infer<typeof ScmBlameRangeSchema>;

export const ScmBlameCommitSchema = lazyZodSchema(() => z.strictObject({
  sha: z.string().check(z.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  shortSha: z.string().check(z.minLength(1)),
  authorName: z.string(),
  authorEmail: z.optional(z.string()),
  authoredAtMs: z.number().check(z.int()),
  summary: z.string(),
}));
export type ScmBlameCommit = z.infer<typeof ScmBlameCommitSchema>;

export const ScmBlameFileResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), ranges: z.array(ScmBlameRangeSchema), commits: z.array(ScmBlameCommitSchema) }),
  z.strictObject({
    success: z.literal(false),
    error: z.optional(z.string()),
    errorCode: z.optional(z.union([ScmOperationErrorCodeSchema, z.enum(['stale_file', 'untracked', 'unsupported_path'])])),
  }),
]).check(z.superRefine((response, context) => {
  if (!response.success) return;
  let nextLine = 1;
  for (const [index, range] of response.ranges.entries()) {
    if (range.startLine !== nextLine || (range.commitIndex !== null && range.commitIndex >= response.commits.length)) {
      context.addIssue({ code: 'custom', path: ['ranges', index], message: 'Blame ranges must cover consecutive file lines and reference a known commit' });
    }
    nextLine = range.startLine + range.lineCount;
  }
})));
export type ScmBlameFileResponse = z.infer<typeof ScmBlameFileResponseSchema>;

export const ScmDiffCommitRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  commit: z.string(),
  /** Explicit immutable tree comparison; commit is the recorded after tree in this mode. */
  beforeTreeOid: z.optional(ScmCommitOidSchema),
})).check(z.superRefine((request, context) => {
  if (request.beforeTreeOid !== undefined && !ScmCommitOidSchema.safeParse(request.commit).success) {
    context.addIssue({ code: "custom", path: ['commit'], message: 'Tree comparison requires an immutable after tree OID' });
  }
})));
export type ScmDiffCommitRequest = z.infer<typeof ScmDiffCommitRequestSchema>;

export const ScmDiffCommitResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  diff: z.optional(z.string()),
  /** The read owner verified these tree objects; missing witnesses never attest an exact hook delta. */
  beforeTreeOid: z.optional(ScmCommitOidSchema),
  afterTreeOid: z.optional(ScmCommitOidSchema),
  /** Literal Git inventory identities paired with the corresponding immutable patch sections. */
  files: z.optional(z.array(z.strictObject({
    path: z.string().check(z.minLength(1)),
    previousPath: z.optional(z.string().check(z.minLength(1))),
    changeKind: z.string().check(z.minLength(1)),
    unifiedDiff: z.string(),
  }))),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmDiffCommitResponse = z.infer<typeof ScmDiffCommitResponseSchema>;

export const ScmChangeApplyRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  paths: z.optional(z.array(ScmSelectedMutationPathSchema)),
  patch: z.optional(z.string()),
}));
export type ScmChangeApplyRequest = z.infer<typeof ScmChangeApplyRequestSchema>;

export const ScmChangeApplyResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmChangeApplyResponse = z.infer<typeof ScmChangeApplyResponseSchema>;

const discardHash = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const discardSelection = z.array(z.string().check(z.minLength(1))).check(z.minLength(1),
  z.refine(values => new Set(values).size === values.length, 'Selections must be unique'));
export const ScmChangeDiscardEntrySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ path: ScmSelectedMutationPathSchema, kind: ScmEntryKindSchema }),
  z.strictObject({
    path: ScmSelectedMutationPathSchema, kind: z.literal('comparison'),
    against: z.strictObject({ source: ScmComparisonSourceSchema,
      comparisonId: z.optional(discardHash), sessionId: z.optional(z.string().check(z.minLength(1))) }),
    changeKeys: z.optional(discardSelection), changeRefs: z.optional(discardSelection),
    expectedHash: z.optional(discardHash), includeUndo: z.optional(z.boolean()),
  }).check(z.refine(entry => !(entry.changeKeys && entry.changeRefs), 'Select keys or occurrence refs, never both'),
    z.refine(entry => entry.against.source.kind === 'workingTree' || !!entry.against.comparisonId,
      'Captured sources require their comparison identity'),
    z.refine(entry => !entry.changeRefs || !!entry.against.comparisonId, 'Occurrence refs require a captured comparison')),
]));
export type ScmChangeDiscardEntry = z.infer<typeof ScmChangeDiscardEntrySchema>;
export type ScmComparisonDiscardEntry = Extract<ScmChangeDiscardEntry, { kind: 'comparison' }>;

export const ScmChangeDiscardResultEntrySchema = lazyZodSchema(() => z.strictObject({
  path: ScmSelectedMutationPathSchema,
  status: z.enum(['discarded', 'reverted', 'restored', 'deleted', 'recreated', 'kept_edited', 'refused']),
  errorCode: z.optional(ScmOperationErrorCodeSchema), error: z.optional(z.string()),
  hashBefore: z.nullable(discardHash), hashAfter: z.nullable(discardHash),
  inverseEdits: z.optional(z.array(z.strictObject({ startUtf16: z.number().check(z.int(), z.minimum(0)),
    deleteLength: z.number().check(z.int(), z.minimum(0)), insertText: z.string(), originalText: z.string() }))),
  previous: z.optional(z.union([z.strictObject({ inlineBase64: z.string() }),
    z.strictObject({ export: FilesystemPreparedExportSchema })])),
}));
export type ScmChangeDiscardResultEntry = z.infer<typeof ScmChangeDiscardResultEntrySchema>;

export const ScmChangeDiscardRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  entries: z.array(ScmChangeDiscardEntrySchema).check(z.minLength(1)),
}));
export type ScmChangeDiscardRequest = z.infer<typeof ScmChangeDiscardRequestSchema>;

export const ScmChangeDiscardResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  entries: z.optional(z.array(ScmChangeDiscardResultEntrySchema)),
  noteDelivery: z.optional(z.strictObject({ status: z.enum(['queued', 'failed']) })),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmChangeDiscardResponse = z.infer<typeof ScmChangeDiscardResponseSchema>;

export const ScmCommitPatchSchema = lazyZodSchema(() => z.strictObject({
  path: ScmSelectedMutationPathSchema,
  patch: z.string().check(z.minLength(1), z.maxLength(SCM_COMMIT_PATCH_MAX_LENGTH)),
}));
export type ScmCommitPatch = z.infer<typeof ScmCommitPatchSchema>;

const scmOrdinaryCommitMessageSchema = lazyZodSchema(() => z.string().check(z.maxLength(SCM_COMMIT_MESSAGE_MAX_LENGTH)));

export const ScmCommitCreateRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  message: z.string(),
  mode: z.optional(z.enum(['commit', 'amend'])),
  signOff: z.optional(z.boolean()),
  allowPublishedAmend: z.optional(z.boolean()),
  expectedHeadOid: z.optional(z.nullable(ScmCommitOidSchema)),
  expectedRef: z.optional(ScmCommitExpectedRefSchema),
  expectedCandidateTreeOid: z.optional(ScmCommitOidSchema),
  preparedTreeOid: z.optional(ScmCommitOidSchema),
  expectedIndexTreeOid: z.optional(ScmCommitOidSchema),
  acceptedHookTreeOid: z.optional(ScmCommitOidSchema),
  scope: z.optional(z
    .union([
      z.strictObject({
        kind: z.literal('all-pending'),
      }),
      z.strictObject({
        kind: z.literal('paths'),
        include: z.array(ScmSelectedMutationPathSchema).check(z.minLength(1)),
        exclude: z.optional(z.array(ScmSelectedMutationPathSchema)),
      }),
    ])),
  patches: z.optional(z.array(ScmCommitPatchSchema).check(z.minLength(1), z.maxLength(SCM_COMMIT_PATCH_MAX_COUNT))),
})).check(z.superRefine((request, context) => {
  if (request.preparedTreeOid !== undefined) {
    if (!request.message.trim()) {
      context.addIssue({ code: "custom", path: ['message'], message: 'A prepared-plan commit requires a nonblank message' });
    }
  } else {
    const message = scmOrdinaryCommitMessageSchema.safeParse(request.message);
    if (!message.success) {
      for (const issue of message.error.issues) context.addIssue({ ...issue, path: ['message', ...issue.path] });
    }
  }
  if (request.expectedIndexTreeOid !== undefined && request.preparedTreeOid === undefined) {
    context.addIssue({ code: "custom", path: ['expectedIndexTreeOid'], message: 'Expected index authority requires a host-prepared safe-plan tree' });
  }
  if (request.preparedTreeOid !== undefined && (request.preparedTreeOid !== request.expectedCandidateTreeOid || request.scope !== undefined || request.patches !== undefined)) {
    context.addIssue({ code: "custom", path: ['preparedTreeOid'], message: 'A host-prepared tree requires the exact expected tree and cannot be combined with scope or patches' });
  }
  if (request.expectedCandidateTreeOid !== undefined && (request.expectedHeadOid === undefined || request.expectedRef === undefined || request.mode === 'amend')) {
    context.addIssue({ code: "custom", path: ['expectedCandidateTreeOid'], message: 'Safe-plan commits require an explicit parent and ref and cannot amend' });
  }
  if (request.acceptedHookTreeOid !== undefined && request.expectedCandidateTreeOid === undefined) {
    context.addIssue({ code: "custom", path: ['acceptedHookTreeOid'], message: 'Hook inclusion requires the exact original candidate tree' });
  }
  if (request.allowPublishedAmend === true && request.mode !== 'amend') {
    context.addIssue({ code: "custom", path: ['allowPublishedAmend'], message: 'Published-head acknowledgment requires explicit amend mode' });
  }
})));
export type ScmCommitCreateRequest = z.infer<typeof ScmCommitCreateRequestSchema>;

export const ScmCommitCreateResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  publication: z.optional(ScmCommitPublicationSchema),
  hookContentChanges: z.optional(ScmCommitHookContentChangesSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  commitSha: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmCommitCreateResponse = z.infer<typeof ScmCommitCreateResponseSchema>;

export const ScmCommitResolveOutcomeRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  candidateOid: ScmCommitOidSchema,
  expectedHeadOid: z.nullable(ScmCommitOidSchema),
  expectedRef: ScmCommitExpectedRefSchema,
})));
export type ScmCommitResolveOutcomeRequest = z.infer<typeof ScmCommitResolveOutcomeRequestSchema>;

/** Read-only object/ref evidence; pending index state does not authorize retry or the next step. */
export const ScmCommitResolveOutcomeResponseSchema = lazyZodSchema(() => z.strictObject({
  success: z.boolean(),
  publication: ScmCommitPublicationSchema,
  candidateTreeOid: z.optional(ScmCommitOidSchema),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmCommitResolveOutcomeResponse = z.infer<typeof ScmCommitResolveOutcomeResponseSchema>;

export const ScmCommitUndoLastRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  expectedHeadOid: z.string().check(z.regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)),
})));
export type ScmCommitUndoLastRequest = z.infer<typeof ScmCommitUndoLastRequestSchema>;

export const ScmCommitUndoLastResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  undoneCommitSha: z.optional(z.string()),
  headOid: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmCommitUndoLastResponse = z.infer<typeof ScmCommitUndoLastResponseSchema>;

function normalizeScmPatchPathToken(raw: string): string | null {
  let value = raw;
  if (!value || value === '/dev/null') return null;

  if (value.startsWith('"')) {
    const decoded = decodeScmQuotedPatchPath(value);
    if (decoded === null) return null;
    value = decoded;
  }

  value = value.replace(/^([ab])\//, '').replace(/^\.\/+/, '');
  if (!value || value === '/dev/null') return null;
  return value;
}

function decodeScmQuotedPatchPath(token: string): string | null {
  if (!token.endsWith('"')) return null;
  const escapes: Readonly<Record<string, string>> = {
    a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\',
  };
  let result = '';
  for (let index = 1; index < token.length - 1; index += 1) {
    const char = token[index]!;
    if (char !== '\\') {
      if (char === '"') return null;
      result += char;
      continue;
    }
    const octets: number[] = [];
    while (token[index] === '\\' && /^[0-7]{3}$/.test(token.slice(index + 1, index + 4))) {
      octets.push(parseInt(token.slice(index + 1, index + 4), 8));
      index += 4;
    }
    if (octets.length > 0) {
      result += new TextDecoder().decode(Uint8Array.from(octets));
      index -= 1;
      continue;
    }
    const escaped = escapes[token[++index] ?? ''];
    if (escaped === undefined) return null;
    result += escaped;
  }
  return result;
}

function tokenizeScmDiffHeader(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (inQuotes && char === '\\') {
      current += char + (value[++index] ?? '');
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseScmGitDiffHeaderPath(line: string): string[] {
  const raw = line.slice('diff --git '.length);
  if (!raw) return [];

  // Git leaves spaces unquoted here. A same-file patch repeats the exact path
  // after the a/ and b/ prefixes, so use that identity to find its separator.
  if (raw.startsWith('a/')) {
    for (let split = raw.indexOf(' b/'); split >= 0; split = raw.indexOf(' b/', split + 1)) {
      const left = normalizeScmPatchPathToken(raw.slice(0, split));
      const right = normalizeScmPatchPathToken(raw.slice(split + 1));
      if (left !== null && left === right) return [left];
    }
  }
  const tokens = tokenizeScmDiffHeader(raw);
  if (tokens.length < 2) return [];

  const left = normalizeScmPatchPathToken(tokens[0] ?? '');
  const right = normalizeScmPatchPathToken(tokens[1] ?? '');
  return [left, right].filter((value): value is string => Boolean(value));
}

export function parseScmPatchPaths(patch: string): string[] {
  const normalized = String(patch ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const seen = new Set<string>();
  for (const line of normalized.split('\n')) {
    if (line.startsWith('diff --git ')) {
      for (const path of parseScmGitDiffHeaderPath(line)) {
        seen.add(path);
      }
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // An unquoted filename ends at the timestamp separator, never at a space.
      const parsed = normalizeScmPatchPathToken(line.slice(4).split('\t')[0] ?? '');
      if (parsed) seen.add(parsed);
    }
  }

  return Array.from(seen);
}

export function isScmPatchBoundToPath(path: string, patch: string): boolean {
  const normalizedPath = path.replace(/^\.\/+/, '');
  if (!normalizedPath) return false;
  const parsedPaths = parseScmPatchPaths(patch);
  if (parsedPaths.length === 0) return false;
  return parsedPaths.every((parsedPath) => parsedPath === normalizedPath);
}

export const ScmLogEntrySchema = lazyZodSchema(() => z.strictObject({
  sha: z.string(),
  shortSha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number().check(z.int()),
  subject: z.string(),
  body: z.string(),
}));
export type ScmLogEntry = z.infer<typeof ScmLogEntrySchema>;

export const ScmLogListRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
  skip: z.optional(z.number().check(z.int(), z.minimum(0))),
  /**
   * Bounded commit search over the repository addressed by `cwd` (the explicit workspace
   * scope), matching SHA prefixes, subject/body text, and author name/email. The current
   * routing envelope is closed; older daemons may ignore this new optional field, which is
   * why the response carries `queryApplied`.
   */
  query: z.optional(z.string().check(z.maxLength(SCM_LOG_QUERY_MAX_LENGTH))),
  range: z.optional(z.literal('incoming')),
  /** Exact pinned range, never HEAD; absent producer evidence means unsupported. */
  revisionRange: z.optional(ScmRevisionRangeV1Schema),
})).check(z.refine(request => !request.revisionRange || (request.range === undefined && request.query === undefined),
  'Exact revision ranges cannot be combined with another log selector')));
export type ScmLogListRequest = z.infer<typeof ScmLogListRequestSchema>;

export const ScmLogListResponseSchema = lazyZodSchema(() => z.strictObject({
  success: z.boolean(),
  entries: z.optional(z.array(ScmLogEntrySchema)),
  /**
   * Echoed `true` only by producers that honored a request `query`. Absence means the
   * producer did not apply the query (an older daemon ignored it and returned a recent
   * page), so a consumer must never present that page as query matches.
   */
  queryApplied: z.optional(z.boolean()),
  rangeApplied: z.optional(z.boolean()),
  /** Endpoint attestation and full-history proof are distinct from page exhaustion. */
  revisionRange: z.optional(z.strictObject({
    kind: z.literal('revisionRange'), baseOid: ScmCommitOidSchema, headOid: ScmCommitOidSchema, historyComplete: z.boolean(),
    graphRelation: z.optional(z.enum(['equal', 'forward', 'diverged'])),
    totalCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    nextSkip: z.optional(z.number().check(z.int(), z.minimum(0))),
  })),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmLogListResponse = z.infer<typeof ScmLogListResponseSchema>;

export const ScmCommitBackoutRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  commit: z.string(),
}));
export type ScmCommitBackoutRequest = z.infer<typeof ScmCommitBackoutRequestSchema>;

export const ScmCommitBackoutResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmCommitBackoutResponse = z.infer<typeof ScmCommitBackoutResponseSchema>;

export const ScmRemoteRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  remote: z.optional(z.string()),
  branch: z.optional(z.string()),
  ...ScmRemotePolicyFields,
})).check(z.superRefine((request, ctx) => {
  const error = validateScmRemoteLeaseAuthority(request);
  if (error) ctx.addIssue({ code: "custom", message: error, path: ['pushMode'] });
})));
export type ScmRemoteRequest = z.infer<typeof ScmRemoteRequestSchema>;

export type ScmRemoteTarget = {
  remote: string;
  branch: string | null;
};

export function parseScmUpstreamRef(upstream: string | null | undefined): ScmRemoteTarget | null {
  if (!upstream) return null;
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0 || slashIndex === upstream.length - 1) {
    return null;
  }
  return {
    remote: upstream.slice(0, slashIndex),
    branch: upstream.slice(slashIndex + 1),
  };
}

export function inferScmRemoteTarget(input: {
  upstream: string | null | undefined;
  head: string | null | undefined;
  defaultRemote?: string;
  allowHeadFallback?: boolean;
}): ScmRemoteTarget {
  const parsed = parseScmUpstreamRef(input.upstream);
  if (parsed) return parsed;
  return {
    remote: input.defaultRemote ?? 'origin',
    branch: input.allowHeadFallback ? (input.head ?? null) : null,
  };
}

export type ScmRemoteMutationKind = 'push' | 'pull';

export type ScmRemoteMutationReason =
  | 'operation_in_progress'
  | 'conflicts_present'
  | 'upstream_required'
  | 'detached_head'
  | 'branch_behind_remote'
  | 'clean_worktree_required';

export type ScmRemoteMutationSnapshot = {
  hasConflicts: boolean;
  operationState?: z.infer<typeof ScmOperationStateSchema> | null;
  branch: Pick<ScmWorkingSnapshot['branch'], 'head' | 'upstream' | 'behind' | 'detached'>;
  totals: Pick<ScmWorkingSnapshot['totals'], 'includedFiles' | 'pendingFiles' | 'untrackedFiles'>;
};

export type ScmRemoteMutationPolicy = {
  requireUpstreamWhenNoExplicitTarget: boolean;
  requireActiveHead: boolean;
  blockPushOnConflicts: boolean;
  blockPushWhenBehind: boolean;
  requireCleanPull: boolean;
  blockActiveOperation?: boolean;
  allowDetachedPushWithExplicitSource?: boolean;
};

export type ScmRemoteMutationResult =
  | { ok: true }
  | { ok: false; reason: ScmRemoteMutationReason };

export const ScmRemoteAddRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  name: ScmRemoteManagementNameSchema,
  fetchUrl: ScmRemoteUrlSchema,
  pushUrl: z.optional(ScmRemoteUrlSchema),
}));
export type ScmRemoteAddRequest = z.infer<typeof ScmRemoteAddRequestSchema>;

export const ScmRemoteSetUrlRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  name: ScmRemoteManagementNameSchema,
  fetchUrl: z.optional(ScmRemoteUrlSchema),
  pushUrl: z.optional(z.nullable(ScmRemoteUrlSchema)),
}).check(z.superRefine((value, ctx) => {
  if (value.fetchUrl === undefined && value.pushUrl === undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'At least one remote URL field is required',
      path: ['fetchUrl'],
    });
  }
})));
export type ScmRemoteSetUrlRequest = z.infer<typeof ScmRemoteSetUrlRequestSchema>;

export const ScmRemoteRemoveRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  name: ScmRemoteManagementNameSchema,
}));
export type ScmRemoteRemoveRequest = z.infer<typeof ScmRemoteRemoveRequestSchema>;

export const ScmRemoteManagementResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  remotes: z.optional(z.array(ScmRemoteInfoSchema)),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmRemoteManagementResponse = z.infer<typeof ScmRemoteManagementResponseSchema>;

export const ScmBranchIntegrationRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  sourceRef: ScmBranchSourceRefSchema,
}));
export type ScmBranchIntegrationRequest = z.infer<typeof ScmBranchIntegrationRequestSchema>;

export const ScmBranchOperationControlRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  operation: ScmRepositoryOperationKindSchema,
}));
export type ScmBranchOperationControlRequest = z.infer<typeof ScmBranchOperationControlRequestSchema>;

export const ScmBranchIntegrationResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  operationState: z.optional(z.nullable(ScmOperationStateSchema)),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmBranchIntegrationResponse = z.infer<typeof ScmBranchIntegrationResponseSchema>;

export const ScmConflictAcceptSideRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  path: ScmSelectedMutationPathSchema,
  side: z.enum(['ours', 'theirs']),
}));
export type ScmConflictAcceptSideRequest = z.infer<typeof ScmConflictAcceptSideRequestSchema>;
export const ScmConflictMarkResolvedRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  paths: z.array(ScmSelectedMutationPathSchema).check(z.minLength(1)),
}));
export type ScmConflictMarkResolvedRequest = z.infer<typeof ScmConflictMarkResolvedRequestSchema>;
export const ScmConflictAcceptSideResponseSchema = ScmBranchIntegrationResponseSchema;
export type ScmConflictAcceptSideResponse = ScmBranchIntegrationResponse;
export const ScmConflictMarkResolvedResponseSchema = ScmBranchIntegrationResponseSchema;
export type ScmConflictMarkResolvedResponse = ScmBranchIntegrationResponse;

export function hasAnyPendingScmChanges(snapshot: Pick<ScmRemoteMutationSnapshot, 'totals'>): boolean {
  return (
    snapshot.totals.includedFiles > 0 ||
    snapshot.totals.pendingFiles > 0 ||
    snapshot.totals.untrackedFiles > 0
  );
}

export function evaluateScmRemoteMutationPolicy(input: {
  kind: ScmRemoteMutationKind;
  snapshot: ScmRemoteMutationSnapshot;
  hasExplicitTarget: boolean;
  policy: ScmRemoteMutationPolicy;
}): ScmRemoteMutationResult {
  const { kind, snapshot, hasExplicitTarget, policy } = input;

  if (policy.blockActiveOperation && snapshot.operationState) {
    return { ok: false, reason: 'operation_in_progress' };
  }

  if (kind === 'push' && policy.blockPushOnConflicts && snapshot.hasConflicts) {
    return { ok: false, reason: 'conflicts_present' };
  }

  if (policy.requireUpstreamWhenNoExplicitTarget && !hasExplicitTarget && !snapshot.branch.upstream) {
    return { ok: false, reason: 'upstream_required' };
  }

  const hasExplicitPushSource = kind === 'push' && hasExplicitTarget && policy.allowDetachedPushWithExplicitSource === true;
  if (!hasExplicitPushSource && (snapshot.branch.detached || (policy.requireActiveHead && !snapshot.branch.head))) {
    return { ok: false, reason: 'detached_head' };
  }

  if (kind === 'push' && policy.blockPushWhenBehind && snapshot.branch.behind > 0) {
    return { ok: false, reason: 'branch_behind_remote' };
  }

  if (kind === 'pull' && policy.requireCleanPull && (snapshot.hasConflicts || hasAnyPendingScmChanges(snapshot))) {
    return { ok: false, reason: 'clean_worktree_required' };
  }

  return { ok: true };
}

export type ScmOperationErrorCategory =
  | 'repository'
  | 'path'
  | 'request'
  | 'command'
  | 'change'
  | 'commit'
  | 'worktree'
  | 'remote'
  | 'capability'
  | 'backend'
  | 'unknown';

export function classifyScmOperationErrorCode(
  errorCode: ScmOperationErrorCode | undefined
): ScmOperationErrorCategory {
  switch (errorCode) {
    case SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY:
      return 'repository';
    case SCM_OPERATION_ERROR_CODES.INVALID_PATH:
    case SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND:
      return 'path';
    case SCM_OPERATION_ERROR_CODES.INVALID_REQUEST:
      return 'request';
    case SCM_OPERATION_ERROR_CODES.COMMAND_FAILED:
    case SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED:
    case SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT:
    case SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED:
    case SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN:
    case SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED:
      return 'command';
    case SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED:
      return 'change';
    case SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_FAILED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_HOOK_CONTENT_CHANGED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_HEAD_CHANGED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_STAGING_CONFLICT:
    case SCM_OPERATION_ERROR_CODES.COMMIT_SIGNING_FAILED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_EMPTY:
    case SCM_OPERATION_ERROR_CODES.COMMIT_AMEND_PUBLISHED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_PUBLISHED:
    case SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_MERGE:
    case SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_NO_PARENT:
    case SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_HEAD_CHANGED:
    case SCM_OPERATION_ERROR_CODES.INDEX_RECONCILIATION_FAILED:
      return 'commit';
    case SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE:
    case SCM_OPERATION_ERROR_CODES.INDEX_LOCKED:
    case SCM_OPERATION_ERROR_CODES.STASH_CREATE_FAILED:
    case SCM_OPERATION_ERROR_CODES.STASH_APPLY_FAILED:
    case SCM_OPERATION_ERROR_CODES.STASH_DROP_FAILED:
      return 'worktree';
    case SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD:
    case SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED:
    case SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND:
    case SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS:
      return 'remote';
    case SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS:
    case SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS:
      return 'worktree';
    case SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED:
      return 'capability';
    case SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE:
      return 'backend';
    default:
      return 'unknown';
  }
}

export function mapSaplingScmErrorCode(stderr: string): ScmOperationErrorCode {
  const lower = String(stderr ?? '').toLowerCase();
  if (lower.includes('no repository found') || lower.includes('not inside a repository')) {
    return SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY;
  }
  if (lower.includes('authentication') || lower.includes('permission denied') || lower.includes('authorization')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
  }
  if (lower.includes('bookmark') && lower.includes('not found')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes("use '--to' to specify destination bookmark")) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes('you must specify a destination for the update')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (lower.includes('does not have a name')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
  }
  if (lower.includes('non-fast-forward') || lower.includes('push creates new remote head')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD;
  }
  if (lower.includes('remote rejected')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED;
  }
  return SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}

export function mapGitScmErrorCode(stderr: string): ScmOperationErrorCode {
  const lower = String(stderr ?? '').toLowerCase();
  if (lower.includes('gpg failed to sign') || lower.includes('failed to sign the data') || lower.includes('signing failed')) {
    return SCM_OPERATION_ERROR_CODES.COMMIT_SIGNING_FAILED;
  }
  if (lower.includes('author identity unknown') || lower.includes('committer identity unknown') || lower.includes('unable to auto-detect email address')) {
    return SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED;
  }
  if (lower.includes('index.lock') && (lower.includes('file exists') || lower.includes('unable to create'))) {
    return SCM_OPERATION_ERROR_CODES.INDEX_LOCKED;
  }
  if (
    lower.includes('could not resolve host') ||
    lower.includes('failed to connect to') ||
    lower.includes('connection timed out') ||
    lower.includes('network is unreachable') ||
    lower.includes('remote end hung up unexpectedly') ||
    lower.includes('unexpected disconnect') ||
    lower.includes('connection reset by peer')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED;
  }
  if (lower.includes('would be overwritten by merge') || lower.includes('would be overwritten by checkout')) {
    return SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE;
  }
  if (lower.includes('not a git repository')) {
    return SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY;
  }
  if (lower.includes('no such remote') || lower.includes('does not appear to be a git repository')) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('support for password authentication was removed')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
  }
  if (
    lower.includes('no upstream configured') ||
    lower.includes('has no upstream branch') ||
    lower.includes('no tracking information for the current branch')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
  }
  if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    lower.includes('tip of your current branch is behind') || lower.includes('(stale info)')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD;
  }
  if (lower.includes('not possible to fast-forward') || (lower.includes('ff-only') && lower.includes('aborting'))) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED;
  }
  if (
    lower.includes('remote rejected') ||
    lower.includes('pre-receive hook declined') ||
    lower.includes('protected branch hook declined') ||
    lower.includes('remote: error: gh006') ||
    lower.includes('remote: error: gh013')
  ) {
    return SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED;
  }
  return SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}

export {
  readScmHostingRepositoryIdentity,
  normalizeScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
  type ScmHostingRepositoryIdentityV1,
} from './hostingRepositoryIdentity.js';
