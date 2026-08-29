import { z } from 'zod';

const MAX_RELATIONSHIP_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_WORKSPACE_REF_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_PATTERN_LENGTH = 1024;
const MAX_PATTERNS = 128;
const MAX_DIGEST_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 256;
const MAX_CONFLICTS = 1_000;

export const WorkspaceSyncModeV1Schema = z.enum([
  'copy_once',
  'keep_synced',
  'mirror_exactly',
  'keep_both_in_sync',
]);
export type WorkspaceSyncModeV1 = z.infer<typeof WorkspaceSyncModeV1Schema>;

export const WorkspaceSyncPersistentModeV1Schema = z.enum([
  'keep_synced',
  'mirror_exactly',
  'keep_both_in_sync',
]);
export type WorkspaceSyncPersistentModeV1 = z.infer<typeof WorkspaceSyncPersistentModeV1Schema>;

export const WorkspaceContentPolicyV1Schema = z.object({
  v: z.literal(1),
  selection: z.enum(['git_worktree', 'all_files']),
  extraIgnorePatterns: z.array(z.string().trim().min(1).max(MAX_PATTERN_LENGTH)).max(MAX_PATTERNS).readonly(),
  extraIncludePatterns: z.array(z.string().trim().min(1).max(MAX_PATTERN_LENGTH)).max(MAX_PATTERNS).readonly(),
  includeGitDirectory: z.boolean(),
  policyDigest: z.string().trim().min(1).max(MAX_DIGEST_LENGTH),
}).strict();
export type WorkspaceContentPolicyV1 = z.infer<typeof WorkspaceContentPolicyV1Schema>;

export const WorkspaceSyncRelationshipV1Schema = z
  .object({
    v: z.literal(1),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
    alphaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    betaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    mode: WorkspaceSyncPersistentModeV1Schema,
    contentPolicy: WorkspaceContentPolicyV1Schema,
    enabled: z.boolean(),
    createdAtMs: z.number().finite().nonnegative(),
    updatedAtMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.alphaWorkspaceRefId === value.betaWorkspaceRefId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['betaWorkspaceRefId'],
        message: 'alphaWorkspaceRefId and betaWorkspaceRefId must be distinct',
      });
    }
  });
export type WorkspaceSyncRelationshipV1 = z.infer<typeof WorkspaceSyncRelationshipV1Schema>;

export const WorkspaceSyncCopyOnceV1Schema = z.object({
  v: z.literal(1),
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  alphaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  betaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  contentPolicy: WorkspaceContentPolicyV1Schema,
}).strict().superRefine((value, context) => {
  if (value.alphaWorkspaceRefId === value.betaWorkspaceRefId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['betaWorkspaceRefId'],
      message: 'alphaWorkspaceRefId and betaWorkspaceRefId must be distinct',
    });
  }
});
export type WorkspaceSyncCopyOnceV1 = z.infer<typeof WorkspaceSyncCopyOnceV1Schema>;

export const WorkspaceSyncEndpointEntryKindV1Schema = z.enum(['missing', 'file', 'directory', 'symlink']);
export type WorkspaceSyncEndpointEntryKindV1 = z.infer<typeof WorkspaceSyncEndpointEntryKindV1Schema>;

const WorkspaceSyncConflictEndpointV1Schema = z.object({
  kind: WorkspaceSyncEndpointEntryKindV1Schema,
  digest: z.string().trim().min(1).max(MAX_DIGEST_LENGTH).optional(),
  size: z.number().int().nonnegative().optional(),
}).strict();

export const WorkspaceSyncConflictV1Schema = z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  alpha: WorkspaceSyncConflictEndpointV1Schema,
  beta: WorkspaceSyncConflictEndpointV1Schema,
}).strict();
export type WorkspaceSyncConflictV1 = z.infer<typeof WorkspaceSyncConflictV1Schema>;

export const WorkspaceSyncConflictListV1Schema = z
  .object({
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    totalCount: z.number().int().nonnegative(),
    shownCount: z.number().int().nonnegative(),
    truncatedCount: z.number().int().nonnegative(),
    conflicts: z.array(WorkspaceSyncConflictV1Schema).max(MAX_CONFLICTS).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.shownCount !== value.conflicts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shownCount'],
        message: 'shownCount must equal conflicts.length',
      });
    }
    if (value.totalCount < value.shownCount || value.truncatedCount !== value.totalCount - value.shownCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truncatedCount'],
        message: 'truncatedCount must equal totalCount minus shownCount',
      });
    }
    for (const [index, conflict] of value.conflicts.entries()) {
      if (conflict.relationshipId !== value.relationshipId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conflicts', index, 'relationshipId'],
          message: 'conflict relationshipId must match the list relationshipId',
        });
      }
    }
  });
export type WorkspaceSyncConflictListV1 = z.infer<typeof WorkspaceSyncConflictListV1Schema>;

export const DeleteWorkspaceSyncConflictLoserV1Schema = z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  keep: z.enum(['alpha', 'beta']),
  expectedDigest: z.string().trim().min(1).max(MAX_DIGEST_LENGTH).optional(),
  expectedKind: WorkspaceSyncEndpointEntryKindV1Schema,
}).strict();
export type DeleteWorkspaceSyncConflictLoserV1 = z.infer<typeof DeleteWorkspaceSyncConflictLoserV1Schema>;

export const WorkspaceSyncStatusV1Schema = z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  state: z.enum([
    'starting',
    'watching',
    'flushing',
    'paused',
    'disconnected',
    'conflicted',
    'controller_unavailable',
    'error',
    'stopped',
  ]),
  alphaPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  betaPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  mode: WorkspaceSyncModeV1Schema,
  changedFiles: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  lastSuccessfulSyncAtMs: z.number().finite().nonnegative().nullable(),
  errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH).optional(),
}).strict();
export type WorkspaceSyncStatusV1 = z.infer<typeof WorkspaceSyncStatusV1Schema>;

export const HandoffWorkspaceActionV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('copy_once'),
    contentPolicy: WorkspaceContentPolicyV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('relationship'),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    flushBeforeCommit: z.boolean(),
  }).strict(),
]);
export type HandoffWorkspaceActionV1 = z.infer<typeof HandoffWorkspaceActionV1Schema>;
