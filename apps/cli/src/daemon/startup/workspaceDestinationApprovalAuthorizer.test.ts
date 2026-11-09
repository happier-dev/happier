import { describe, expect, it } from 'vitest';

import {
  computeWorkspaceSyncPolicyDigest,
  type HandoffTargetReplacementApprovalV1,
} from '@happier-dev/protocol';

import { createWorkspaceDestinationApprovalAuthorizer, createWorkspaceCommittedCopyRemovalAuthorizer } from './createProductionDaemonWorkspaceSyncRuntime';

const contentPolicy = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [] as const,
  extraIncludePatterns: [] as const,
  policyDigest: computeWorkspaceSyncPolicyDigest({
    v: 1,
    selection: 'all_files',
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  }),
};

const approval: HandoffTargetReplacementApprovalV1 = {
  v: 1,
  consequences: ['delete_target_only_files_during_exact_mirror'],
  serverId: 'server-1',
  machineId: 'machine-b',
  canonicalRoot: '/work/beta',
  rootFingerprint: 'a'.repeat(64),
  operationId: 'link-action-1',
};

const linkActionInput = {
  v: 1 as const,
  sourceWorkspaceRefId: 'workspace-alpha',
  targetMachineId: 'machine-b',
  targetPath: '/work/beta',
  mode: 'mirror_exactly' as const,
  contentPolicy,
  destinationIntent: 'use_existing' as const,
};

describe('createWorkspaceDestinationApprovalAuthorizer', () => {
  it('admits a Project linking input without a persisted approval', async () => {
    const authorize = createWorkspaceDestinationApprovalAuthorizer();

    await expect(authorize('allow-request-1', linkActionInput, approval)).resolves.toBeUndefined();
    await expect(authorize('allow-request-1', { ...linkActionInput, replaceRelationshipId: 'old-link' }, approval))
      .resolves.toBeUndefined();
    await expect(authorize('allow-request-1', { ...linkActionInput, replaceRelationshipId: 'old-link',
      destinationIntent: 'materialize_from_source_workspace' }, approval)).rejects.toMatchObject({ code: 'approval_stale' });
  });

  it('refuses an input that belongs to no destination-choosing Action family', async () => {
    const authorize = createWorkspaceDestinationApprovalAuthorizer();
    const unrelatedInput = { sessionId: 'session-1', scopes: ['code'], candidate: { source: 'auto' } };

    await expect(authorize('allow-request-1', unrelatedInput, approval))
      .rejects.toMatchObject({ code: 'approval_stale' });
  });

  it('admits a Session handoff input without a persisted approval', async () => {
    const authorize = createWorkspaceDestinationApprovalAuthorizer();
    const handoffInput = {
      sessionId: 'session-1',
      targetMachineId: 'machine-b',
      targetPath: '/work/beta',
      workspaceAction: { kind: 'copy_once' as const, contentPolicy },
    };

    await expect(authorize('allow-request-1', handoffInput, approval)).resolves.toBeUndefined();
  });
});

describe('createWorkspaceCommittedCopyRemovalAuthorizer', () => {
  const actionInput = {
    workspace: { serverId: 'server-1', refId: 'workspace-alpha' },
    machineId: 'machine-a',
    expectedRelationship: {
      v: 1 as const, relationshipId: 'rel-1', controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
      mode: 'mirror_exactly' as const, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    },
    removeTargetCopy: { workspaceRefId: 'workspace-beta', rootFingerprint: 'a'.repeat(64) },
  };

  it('admits committed-copy removal in the receiving Home without a persisted approval', async () => {
    const authorize = createWorkspaceCommittedCopyRemovalAuthorizer({ serverId: 'server-1' });

    await expect(authorize('allow-request-1', actionInput)).resolves.toBeUndefined();
  });

  it('refuses retirement without a requested copy removal', async () => {
    const authorize = createWorkspaceCommittedCopyRemovalAuthorizer({ serverId: 'server-1' });
    const { removeTargetCopy: _removal, ...definitionOnly } = actionInput;

    await expect(authorize('allow-request-1', definitionOnly)).rejects.toMatchObject({ code: 'approval_stale' });
  });

  it('refuses committed-copy removal belonging to another Home', async () => {
    const authorize = createWorkspaceCommittedCopyRemovalAuthorizer({ serverId: 'server-1' });

    await expect(authorize('allow-request-1', {
      ...actionInput,
      workspace: { ...actionInput.workspace, serverId: 'other-server' },
    })).rejects.toMatchObject({ code: 'approval_stale' });
  });
});
