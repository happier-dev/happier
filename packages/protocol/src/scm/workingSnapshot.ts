import { z } from 'zod';

import { ScmBackendIdSchema } from './backendIdentity.js';
import { ScmDefaultBranchPushPolicySchema } from './defaultBranchPushPolicy.js';
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

export const ScmBranchIntegrationOperationSchema = z.enum(['merge', 'rebase']);
export type ScmBranchIntegrationOperation = z.infer<typeof ScmBranchIntegrationOperationSchema>;

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
  writeCommitPathSelection: z.boolean(),
  writeCommitLineSelection: z.boolean(),
  writeBackout: z.boolean(),
  writeBranchCreate: z.boolean().optional(),
  writeBranchCheckout: z.boolean().optional(),
  writeBranchMerge: z.boolean().optional(),
  writeBranchRebase: z.boolean().optional(),
  writeBranchOperationControl: z.boolean().optional(),
  writeRemoteAdd: z.boolean().optional(),
  writeRemoteSetUrl: z.boolean().optional(),
  writeRemoteRemove: z.boolean().optional(),
  writeRemoteFetch: z.boolean(),
  writeRemotePull: z.boolean(),
  writeRemotePush: z.boolean(),
  writeRemotePublish: z.boolean().optional(),
  readHostingProvider: z.boolean().optional(),
  readPullRequestStatus: z.boolean().optional(),
  writePullRequestCreate: z.boolean().optional(),
  writePullRequestCheckout: z.boolean().optional(),
  writePullRequestPrepareWorktree: z.boolean().optional(),
  writePullRequestRunStacked: z.boolean().optional(),
  defaultBranchPushPolicy: ScmDefaultBranchPushPolicySchema.optional(),
  writeRepositoryInit: z.boolean().optional(),
  readHostingRepositoryPublishTargets: z.boolean().optional(),
  writeHostingRepositoryPublish: z.boolean().optional(),
  writeRepositoryRemoveIndexLock: z.boolean().optional(),
  writeStash: z.boolean().optional(),
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
  includedAdded: z.number().int().nonnegative(),
  includedRemoved: z.number().int().nonnegative(),
  pendingAdded: z.number().int().nonnegative(),
  pendingRemoved: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});
export type ScmPathStats = z.infer<typeof ScmPathStatsSchema>;

export const ScmWorkingEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  kind: ScmEntryKindSchema,
  includeStatus: z.string(),
  pendingStatus: z.string(),
  hasIncludedDelta: z.boolean(),
  hasPendingDelta: z.boolean(),
  stats: ScmPathStatsSchema,
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

export const ScmOperationStateSchema = z.object({
  kind: ScmBranchIntegrationOperationSchema,
  sourceRef: z.string().nullable().optional(),
  canContinue: z.boolean(),
  canAbort: z.boolean(),
});
export type ScmOperationState = z.infer<typeof ScmOperationStateSchema>;

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
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    detached: z.boolean(),
  }),
  stashCount: z.number().int().nonnegative().optional(),
  operationState: ScmOperationStateSchema.nullable().optional(),
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
  }),
});
export type ScmWorkingSnapshot = z.infer<typeof ScmWorkingSnapshotSchema>;
