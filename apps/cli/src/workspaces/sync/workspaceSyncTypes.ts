import { createHash } from 'node:crypto';

export const workspaceSyncModes = ['copy_once', 'keep_synced', 'mirror_exactly', 'keep_both_in_sync'] as const;
export type WorkspaceSyncModeV1 = (typeof workspaceSyncModes)[number];
export type WorkspaceSyncPersistentModeV1 = Exclude<WorkspaceSyncModeV1, 'copy_once'>;

export type WorkspaceContentPolicyV1 = Readonly<{
  v: 1;
  selection: 'git_worktree' | 'all_files';
  extraIgnorePatterns: readonly string[];
  extraIncludePatterns: readonly string[];
  includeGitDirectory: boolean;
  policyDigest: string;
}>;

export type WorkspaceSyncRelationshipV1 = Readonly<{
  v: 1;
  relationshipId: string;
  controllerMachineId: string;
  alphaWorkspaceRefId: string;
  betaWorkspaceRefId: string;
  mode: WorkspaceSyncPersistentModeV1;
  contentPolicy: WorkspaceContentPolicyV1;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type WorkspaceSyncCopyOnceV1 = Readonly<{
  v: 1;
  operationId: string;
  controllerMachineId: string;
  alphaWorkspaceRefId: string;
  betaWorkspaceRefId: string;
  contentPolicy: WorkspaceContentPolicyV1;
}>;

export type WorkspaceSyncStatusV1 = Readonly<{
  relationshipId: string;
  controllerMachineId: string;
  state: 'starting' | 'watching' | 'flushing' | 'paused' | 'disconnected' | 'conflicted' | 'controller_unavailable' | 'error' | 'stopped';
  alphaPath: string;
  betaPath: string;
  mode: WorkspaceSyncModeV1;
  changedFiles: number;
  conflictCount: number;
  lastSuccessfulSyncAtMs: number | null;
  errorCode?: string;
}>;

export type WorkspaceSyncConflictV1 = Readonly<{
  relationshipId: string;
  path: string;
  alpha: Readonly<{ kind: 'missing' | 'file' | 'directory' | 'symlink'; digest?: string; size?: number }>;
  beta: Readonly<{ kind: 'missing' | 'file' | 'directory' | 'symlink'; digest?: string; size?: number }>;
}>;
export type WorkspaceSyncConflictListV1 = Readonly<{ relationshipId: string; totalCount: number; shownCount: number; truncatedCount: number; conflicts: readonly WorkspaceSyncConflictV1[] }>;
export type DeleteWorkspaceSyncConflictLoserV1 = Readonly<{ relationshipId: string; path: string; keep: 'alpha' | 'beta'; expectedDigest?: string; expectedKind: 'missing' | 'file' | 'directory' | 'symlink' }>;

export function computeWorkspaceSyncPolicyDigest(policy: Omit<WorkspaceContentPolicyV1, 'policyDigest'>): string {
  const canonical = JSON.stringify({ v: 1, selection: policy.selection, extraIgnorePatterns: [...policy.extraIgnorePatterns].sort(), extraIncludePatterns: [...policy.extraIncludePatterns].sort(), includeGitDirectory: policy.includeGitDirectory });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ManagedWorkspaceSync {
  get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  subscribe(relationshipId: string, signal: AbortSignal): AsyncIterable<WorkspaceSyncStatusV1>;
  ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncConflictListV1>;
  deleteConflictLoser(request: DeleteWorkspaceSyncConflictLoserV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
}
