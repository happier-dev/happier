import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ScmBackendIdSchema } from './backendIdentity.js';
import { ScmDefaultBranchPushPolicySchema } from './defaultBranchPushPolicy.js';
import { ScmOperationStateSchema } from './operationState.js';
export * from './operationState.js';
import {
  ProviderRefreshPolicySchema,
  VcsLocalStateFreshnessSchema,
} from './freshness.js';
import {
  ScmHostingProviderRefSchema,
  ScmPullRequestStatusProjectionSchema,
} from './pullRequests.js';

export const ScmRepoModeSchema = lazyZodSchema(() => z.enum(['.git', '.sl']));
export type ScmRepoMode = z.infer<typeof ScmRepoModeSchema>;

export const ScmDiffAreaSchema = lazyZodSchema(() => z.enum(['included', 'pending', 'both']));
export type ScmDiffArea = z.infer<typeof ScmDiffAreaSchema>;

export const ScmChangeSetModelSchema = lazyZodSchema(() => z.enum(['index', 'working-copy']));
export type ScmChangeSetModel = z.infer<typeof ScmChangeSetModelSchema>;

export {
  ScmDefaultBranchPushPolicySchema,
  type ScmDefaultBranchPushPolicy,
} from './defaultBranchPushPolicy.js';

const ScmCapabilitiesSchemaCore = lazyZodSchema(() => z.object({
  capabilityScope: z._default(z.literal('local-backend'), 'local-backend'),
  readStatus: z.boolean(),
  readDiffFile: z.boolean(),
  readBlame: z.optional(z.boolean()),
  readDiffCommit: z.boolean(),
  readLog: z.boolean(),
  readHistoryEntries: z.optional(z.boolean()),
  readBranches: z.optional(z.boolean()),
  readStash: z.optional(z.boolean()),
  writeInclude: z.boolean(),
  writeExclude: z.boolean(),
  writeDiscard: z.optional(z.boolean()),
  writeCommit: z.boolean(),
  writeCommitUndoLast: z.optional(z.boolean()),
  writeCommitAmend: z.optional(z.boolean()),
  writeCommitSignOff: z.optional(z.boolean()),
  writeCommitExpectedBase: z.optional(z.boolean()),
  writeCommitSafePlan: z.optional(z.boolean()),
  readCommitResolveOutcome: z.optional(z.boolean()),
  writeCommitPathSelection: z.boolean(),
  writeCommitLineSelection: z.boolean(),
  writeBackout: z.boolean(),
  writeBranchCreate: z.optional(z.boolean()),
  writeBranchCheckout: z.optional(z.boolean()),
  writeBranchMerge: z.optional(z.boolean()),
  writeBranchRebase: z.optional(z.boolean()),
  writeBranchOperationControl: z.optional(z.boolean()),
  writeBranchOperationSkip: z.optional(z.boolean()),
  writeConflictResolution: z.optional(z.boolean()),
  writeRemoteAdd: z.optional(z.boolean()),
  writeRemoteSetUrl: z.optional(z.boolean()),
  writeRemoteRemove: z.optional(z.boolean()),
  writeRemoteFetch: z.boolean(),
  writeRemotePull: z.boolean(),
  writeRemotePush: z.boolean(),
  writeRemotePublish: z.optional(z.boolean()),
  writeRemotePolicies: z.optional(z.boolean()),
  writeRemoteForceWithLease: z.optional(z.boolean()),
  readHostingProvider: z.optional(z.boolean()),
  readPullRequestStatus: z.optional(z.boolean()),
  writePullRequestCreate: z.optional(z.boolean()),
  writePullRequestDraftCreate: z.optional(z.boolean()),
  writePullRequestCheckout: z.optional(z.boolean()),
  writePullRequestPrepareWorktree: z.optional(z.boolean()),
  writePullRequestRunStacked: z.optional(z.boolean()),
  defaultBranchPushPolicy: z.optional(ScmDefaultBranchPushPolicySchema),
  writeRepositoryInit: z.optional(z.boolean()),
  readHostingRepositoryPublishTargets: z.optional(z.boolean()),
  writeHostingRepositoryPublish: z.optional(z.boolean()),
  writeRepositoryRemoveIndexLock: z.optional(z.boolean()),
  writeStash: z.optional(z.boolean()),
  writeStashCreate: z.optional(z.boolean()),
  worktreeCreate: z.boolean(),
  worktreeRetention: z.optional(z.boolean()),
  changeSetModel: ScmChangeSetModelSchema,
  supportedDiffAreas: z.array(ScmDiffAreaSchema).check(z.minLength(1)),
  operationLabels: z.optional(z
    .object({
      commit: z.optional(z.string()),
      include: z.optional(z.string()),
      exclude: z.optional(z.string()),
      backout: z.optional(z.string()),
      fetch: z.optional(z.string()),
      pull: z.optional(z.string()),
      push: z.optional(z.string()),
    })),
}));
export const ScmCapabilitiesSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.worktreeCreate !== undefined || record.workspaceWorktreeCreate === undefined) {
    return value;
  }
  return {
    ...record,
    worktreeCreate: record.workspaceWorktreeCreate,
  };
}), ScmCapabilitiesSchemaCore));
export type ScmCapabilities = z.infer<typeof ScmCapabilitiesSchema>;

export const ScmEntryKindSchema = lazyZodSchema(() => z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
]));
export type ScmEntryKind = z.infer<typeof ScmEntryKindSchema>;

export const ScmPathStatsSchema = lazyZodSchema(() => z.object({
  includedAdded: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  includedRemoved: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  pendingAdded: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  pendingRemoved: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  isBinary: z._default(z.boolean(), false),
  // False means bounded enrichment could not measure all line counts.
  isComplete: z.optional(z.boolean()),
}));
export type ScmPathStats = z.infer<typeof ScmPathStatsSchema>;

export const ScmWorkingEntrySchema = lazyZodSchema(() => z.object({
  path: z.string(),
  previousPath: z._default(z.nullable(z.string()), null),
  kind: ScmEntryKindSchema,
  includeStatus: z.string(),
  pendingStatus: z.string(),
  hasIncludedDelta: z._default(z.boolean(), false),
  hasPendingDelta: z._default(z.boolean(), false),
  stats: z.prefault(ScmPathStatsSchema, {}),
}));
export type ScmWorkingEntry = z.infer<typeof ScmWorkingEntrySchema>;

export const ScmWorktreeSchema = lazyZodSchema(() => z.object({
  id: z.optional(z.string().check(z.minLength(1))),
  path: z.string(),
  branch: z.nullable(z.string()),
  isCurrent: z.boolean(),
  isMain: z.optional(z.boolean()),
  isPrunable: z.optional(z.boolean()),
  changeCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  lastActivityAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type ScmWorktree = z.infer<typeof ScmWorktreeSchema>;

export const ScmRemoteInfoSchema = lazyZodSchema(() => z.object({
  name: z.string().check(z.minLength(1)),
  fetchUrl: z.optional(z.string()),
  pushUrl: z.optional(z.string()),
}));
export type ScmRemoteInfo = z.infer<typeof ScmRemoteInfoSchema>;

export const ScmSnapshotDetailSchema = lazyZodSchema(() => z.enum(['summary', 'facts']));
export type ScmSnapshotDetail = z.infer<typeof ScmSnapshotDetailSchema>;

export const ScmWorkingSnapshotSchema = lazyZodSchema(() => z.object({
  projectKey: z.string(),
  fetchedAt: z.number().check(z.int()),
  freshness: z.optional(VcsLocalStateFreshnessSchema),
  refreshPolicy: z.optional(ProviderRefreshPolicySchema),
  repo: z.object({
    isRepo: z.boolean(),
    rootPath: z.nullable(z.string()),
    backendId: z.nullable(ScmBackendIdSchema),
    mode: z.nullable(ScmRepoModeSchema),
    defaultBranch: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    worktrees: z._default(z.array(ScmWorktreeSchema), []),
    remotes: z._default(z.array(ScmRemoteInfoSchema), []),
  }),
  capabilities: ScmCapabilitiesSchema,
  branch: z.object({
    head: z.nullable(z.string()),
    headOid: z.optional(z.string()),
    upstream: z.nullable(z.string()),
    upstreamOid: z.optional(z.string()),
    ahead: z.number().check(z.int(), z.nonnegative()),
    behind: z.number().check(z.int(), z.nonnegative()),
    detached: z.boolean(),
  }),
  stashCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  operationState: z.optional(z.nullable(ScmOperationStateSchema)),
  operationStateVersion: z.optional(z.literal(1)),
  hostingProvider: z.optional(z.nullable(ScmHostingProviderRefSchema)),
  pullRequestStatus: z.optional(z.nullable(ScmPullRequestStatusProjectionSchema)),
  hasConflicts: z.boolean(),
  entries: z.array(ScmWorkingEntrySchema),
  // Present only on a reply to a `detail` read: `entries` is empty because it was not sent, never
  // because the working copy is clean. 'summary' carries `summary`; 'facts' measured no working
  // copy, so its `totals`, `hasConflicts` and `entries` say nothing and must not be read.
  detail: z.optional(ScmSnapshotDetailSchema),
  summary: z.optional(z.object({
    changedFiles: z.number().check(z.int(), z.nonnegative()),
    includedAdded: z.number().check(z.int()),
    includedRemoved: z.number().check(z.int()),
    pendingAdded: z.number().check(z.int()),
    pendingRemoved: z.number().check(z.int()),
  })),
  totals: z.object({
    includedFiles: z.number().check(z.int(), z.nonnegative()),
    pendingFiles: z.number().check(z.int(), z.nonnegative()),
    untrackedFiles: z.number().check(z.int(), z.nonnegative()),
    includedAdded: z.number().check(z.int(), z.nonnegative()),
    includedRemoved: z.number().check(z.int(), z.nonnegative()),
    pendingAdded: z.number().check(z.int(), z.nonnegative()),
    pendingRemoved: z.number().check(z.int(), z.nonnegative()),
    isComplete: z.optional(z.boolean()),
  }),
}));
export type ScmWorkingSnapshot = z.infer<typeof ScmWorkingSnapshotSchema>;
/** RPC input may omit neutral facts; parsed/domain snapshots remain fully populated. */
export type ScmWorkingSnapshotInput = Omit<z.input<typeof ScmWorkingSnapshotSchema>, 'capabilities'> & {
  // The producer supplies canonical capabilities; the schema's preprocess input is unknown.
  capabilities: ScmCapabilities;
};
