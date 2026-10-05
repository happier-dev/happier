import { z } from 'zod';

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

export const ScmRepoModeSchema = z.enum(['.git', '.sl']);
export type ScmRepoMode = z.infer<typeof ScmRepoModeSchema>;

export const ScmDiffAreaSchema = z.enum(['included', 'pending', 'both']);
export type ScmDiffArea = z.infer<typeof ScmDiffAreaSchema>;

export const ScmChangeSetModelSchema = z.enum(['index', 'working-copy']);
export type ScmChangeSetModel = z.infer<typeof ScmChangeSetModelSchema>;

export {
  ScmDefaultBranchPushPolicySchema,
  type ScmDefaultBranchPushPolicy,
} from './defaultBranchPushPolicy.js';

const ScmCapabilitiesSchemaCore = z.object({
  capabilityScope: z.literal('local-backend').default('local-backend'),
  readStatus: z.boolean(),
  readDiffFile: z.boolean(),
  readDiffCommit: z.boolean(),
  readLog: z.boolean(),
  readBranches: z.boolean().optional(),
  readStash: z.boolean().optional(),
  writeInclude: z.boolean(),
  writeExclude: z.boolean(),
  writeDiscard: z.boolean().optional(),
  writeCommit: z.boolean(),
  writeCommitUndoLast: z.boolean().optional(),
  writeCommitAmend: z.boolean().optional(),
  writeCommitSignOff: z.boolean().optional(),
  writeCommitExpectedBase: z.boolean().optional(),
  writeCommitSafePlan: z.boolean().optional(),
  readCommitResolveOutcome: z.boolean().optional(),
  writeCommitPathSelection: z.boolean(),
  writeCommitLineSelection: z.boolean(),
  writeBackout: z.boolean(),
  writeBranchCreate: z.boolean().optional(),
  writeBranchCheckout: z.boolean().optional(),
  writeBranchMerge: z.boolean().optional(),
  writeBranchRebase: z.boolean().optional(),
  writeBranchOperationControl: z.boolean().optional(),
  writeBranchOperationSkip: z.boolean().optional(),
  writeConflictResolution: z.boolean().optional(),
  writeRemoteAdd: z.boolean().optional(),
  writeRemoteSetUrl: z.boolean().optional(),
  writeRemoteRemove: z.boolean().optional(),
  writeRemoteFetch: z.boolean(),
  writeRemotePull: z.boolean(),
  writeRemotePush: z.boolean(),
  writeRemotePublish: z.boolean().optional(),
  writeRemotePolicies: z.boolean().optional(),
  writeRemoteForceWithLease: z.boolean().optional(),
  readHostingProvider: z.boolean().optional(),
  readPullRequestStatus: z.boolean().optional(),
  writePullRequestCreate: z.boolean().optional(),
  writePullRequestDraftCreate: z.boolean().optional(),
  writePullRequestCheckout: z.boolean().optional(),
  writePullRequestPrepareWorktree: z.boolean().optional(),
  writePullRequestRunStacked: z.boolean().optional(),
  defaultBranchPushPolicy: ScmDefaultBranchPushPolicySchema.optional(),
  writeRepositoryInit: z.boolean().optional(),
  readHostingRepositoryPublishTargets: z.boolean().optional(),
  writeHostingRepositoryPublish: z.boolean().optional(),
  writeRepositoryRemoveIndexLock: z.boolean().optional(),
  writeStash: z.boolean().optional(),
  writeStashCreate: z.boolean().optional(),
  worktreeCreate: z.boolean(),
  changeSetModel: ScmChangeSetModelSchema,
  supportedDiffAreas: z.array(ScmDiffAreaSchema).min(1),
  operationLabels: z
    .object({
      commit: z.string().optional(),
      include: z.string().optional(),
      exclude: z.string().optional(),
      backout: z.string().optional(),
      fetch: z.string().optional(),
      pull: z.string().optional(),
      push: z.string().optional(),
    })
    .optional(),
});
export const ScmCapabilitiesSchema = z.preprocess((value) => {
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
}, ScmCapabilitiesSchemaCore);
export type ScmCapabilities = z.infer<typeof ScmCapabilitiesSchema>;

export const ScmEntryKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
]);
export type ScmEntryKind = z.infer<typeof ScmEntryKindSchema>;

export const ScmPathStatsSchema = z.object({
  includedAdded: z.number().int().nonnegative().default(0),
  includedRemoved: z.number().int().nonnegative().default(0),
  pendingAdded: z.number().int().nonnegative().default(0),
  pendingRemoved: z.number().int().nonnegative().default(0),
  isBinary: z.boolean().default(false),
  // False means bounded enrichment could not measure all line counts.
  isComplete: z.boolean().optional(),
});
export type ScmPathStats = z.infer<typeof ScmPathStatsSchema>;

export const ScmWorkingEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable().default(null),
  kind: ScmEntryKindSchema,
  includeStatus: z.string(),
  pendingStatus: z.string(),
  hasIncludedDelta: z.boolean().default(false),
  hasPendingDelta: z.boolean().default(false),
  stats: ScmPathStatsSchema.prefault({}),
});
export type ScmWorkingEntry = z.infer<typeof ScmWorkingEntrySchema>;

export const ScmWorktreeSchema = z.object({
  id: z.string().min(1).optional(),
  path: z.string(),
  branch: z.string().nullable(),
  isCurrent: z.boolean(),
  isMain: z.boolean().optional(),
  isPrunable: z.boolean().optional(),
  changeCount: z.number().int().nonnegative().optional(),
  lastActivityAt: z.number().int().nonnegative().optional(),
});
export type ScmWorktree = z.infer<typeof ScmWorktreeSchema>;

export const ScmRemoteInfoSchema = z.object({
  name: z.string().min(1),
  fetchUrl: z.string().optional(),
  pushUrl: z.string().optional(),
});
export type ScmRemoteInfo = z.infer<typeof ScmRemoteInfoSchema>;

export const ScmWorkingSnapshotSchema = z.object({
  projectKey: z.string(),
  fetchedAt: z.number().int(),
  freshness: VcsLocalStateFreshnessSchema.optional(),
  refreshPolicy: ProviderRefreshPolicySchema.optional(),
  repo: z.object({
    isRepo: z.boolean(),
    rootPath: z.string().nullable(),
    backendId: ScmBackendIdSchema.nullable(),
    mode: ScmRepoModeSchema.nullable(),
    defaultBranch: z.string().min(1).nullable().optional(),
    worktrees: z.array(ScmWorktreeSchema).default([]),
    remotes: z.array(ScmRemoteInfoSchema).default([]),
  }),
  capabilities: ScmCapabilitiesSchema,
  branch: z.object({
    head: z.string().nullable(),
    headOid: z.string().optional(),
    upstream: z.string().nullable(),
    upstreamOid: z.string().optional(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    detached: z.boolean(),
  }),
  stashCount: z.number().int().nonnegative().optional(),
  operationState: ScmOperationStateSchema.nullable().optional(),
  operationStateVersion: z.literal(1).optional(),
  hostingProvider: ScmHostingProviderRefSchema.nullable().optional(),
  pullRequestStatus: ScmPullRequestStatusProjectionSchema.nullable().optional(),
  hasConflicts: z.boolean(),
  entries: z.array(ScmWorkingEntrySchema),
  totals: z.object({
    includedFiles: z.number().int().nonnegative(),
    pendingFiles: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
    includedAdded: z.number().int().nonnegative(),
    includedRemoved: z.number().int().nonnegative(),
    pendingAdded: z.number().int().nonnegative(),
    pendingRemoved: z.number().int().nonnegative(),
    isComplete: z.boolean().optional(),
  }),
});
export type ScmWorkingSnapshot = z.infer<typeof ScmWorkingSnapshotSchema>;
/** RPC input may omit neutral facts; parsed/domain snapshots remain fully populated. */
export type ScmWorkingSnapshotInput = Omit<z.input<typeof ScmWorkingSnapshotSchema>, 'capabilities'> & {
  // The producer supplies canonical capabilities; the schema's preprocess input is unknown.
  capabilities: ScmCapabilities;
};
