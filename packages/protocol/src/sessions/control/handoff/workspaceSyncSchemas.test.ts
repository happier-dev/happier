import { describe, expect, it } from 'vitest';

import {
  HandoffWorkspaceActionV1Schema,
  WorkspaceContentPolicyV1Schema,
  WorkspaceSyncConflictListV1Schema,
  WorkspaceSyncRelationshipV1Schema,
  WorkspaceSyncStatusV1Schema,
} from './workspaceSyncSchemas.js';
import {
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStartRequestSchema,
} from './handoffSchemas.js';

const contentPolicy = {
  v: 1 as const,
  selection: 'git_worktree' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
  includeGitDirectory: false,
  policyDigest: 'sha256:policy',
};

describe('workspace sync protocol schemas', () => {
  it('accepts the four product modes and rejects copy_once relationships', () => {
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'copy_once', contentPolicy })).toMatchObject({ kind: 'copy_once' });
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'relationship', relationshipId: 'rel-1', flushBeforeCommit: true })).toMatchObject({ kind: 'relationship' });

    expect(WorkspaceSyncRelationshipV1Schema.safeParse({
      v: 1,
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a',
      betaWorkspaceRefId: 'workspace-b',
      mode: 'keep_synced',
      contentPolicy,
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 11,
    }).success).toBe(true);
    expect(WorkspaceSyncRelationshipV1Schema.safeParse({
      v: 1,
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a',
      betaWorkspaceRefId: 'workspace-a',
      mode: 'copy_once',
      contentPolicy,
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 11,
    }).success).toBe(false);
  });

  it('keeps status and conflict projections strict and internally bounded', () => {
    expect(WorkspaceSyncStatusV1Schema.parse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_both_in_sync',
      changedFiles: 2,
      conflictCount: 1,
      lastSuccessfulSyncAtMs: null,
    })).toMatchObject({ state: 'watching' });

    expect(WorkspaceSyncConflictListV1Schema.safeParse({
      relationshipId: 'rel-1',
      totalCount: 1,
      shownCount: 1,
      truncatedCount: 0,
      conflicts: [{
        relationshipId: 'rel-1',
        path: 'src/index.ts',
        alpha: { kind: 'file', digest: 'a', size: 10 },
        beta: { kind: 'file', digest: 'b', size: 12 },
      }],
    }).success).toBe(true);
    expect(WorkspaceSyncStatusV1Schema.safeParse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_synced',
      changedFiles: 0,
      conflictCount: 0,
      lastSuccessfulSyncAtMs: null,
      unexpected: true,
    }).success).toBe(false);
  });

  it('rejects non-versioned or malformed content policies', () => {
    expect(WorkspaceContentPolicyV1Schema.safeParse({ ...contentPolicy, v: 2 }).success).toBe(false);
    expect(WorkspaceContentPolicyV1Schema.safeParse({
      ...contentPolicy,
      extraIgnorePatterns: [''],
    }).success).toBe(false);
  });

  it('fails closed on the retired workspaceTransfer request field', () => {
    expect(SessionHandoffStartRequestSchema.safeParse({
      sessionId: 'session-1',
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      workspaceTransfer: { enabled: true },
    }).success).toBe(false);
    expect(SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ok: false,
      errorCode: 'workspace_sync_update_required',
      error: 'client must update before using workspace sync',
    }).success).toBe(true);
  });
});
