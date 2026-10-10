import { describe, expect, it, vi } from 'vitest';

import {
  computeWorkspaceSyncPolicyDigest,
  type HandoffTargetReplacementApprovalV1,
} from '@happier-dev/protocol';

import { createWorkspaceDestinationApprovalAuthorizer, createWorkspaceCommittedCopyRemovalAuthorizer } from './createProductionDaemonWorkspaceSyncRuntime';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

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

function artifactFor(actionId: string, actionArgs: unknown, overrides: Readonly<Record<string, unknown>> = {}) {
  return ApprovalRequestV2Schema.parse({
    v: 2 as const,
    status: 'executing' as const,
    createdAtMs: 1,
    updatedAtMs: 2,
    createdBy: { surface: 'system' as const },
    executionOriginV1: {
      v: 1 as const,
      authority: 'present_user' as const,
      surface: 'ui' as const,
      caller: { kind: 'host' as const },
      serverId: 'server-1',
      machineId: 'machine-a',
      actionId,
      requestId: 'link-action-1',
    },
    approval: { flow: 'deferred' as const, result: 'required' as const },
    actionId,
    actionArgs,
    summary: 'Approve destination',
    ...(actionId === 'workspace.sync.relationship.create' || actionId === 'session.handoff'
      ? { handoffTargetReplacementApproval: approval } : {}),
    ...(overrides.status === 'open' ? {} : { decision: { kind: 'approve' as const, decidedAtMs: 2 } }),
    ...overrides,
  });
}

function createAuthorizer() {
  const approvalsGet = vi.fn();
  const authorize = createWorkspaceDestinationApprovalAuthorizer({
    approvalsGet: approvalsGet as never,
    serverId: 'server-1',
  });
  return { approvalsGet, authorize };
}

describe('createWorkspaceDestinationApprovalAuthorizer', () => {
  it('admits a direct Project linking receipt for its exact approved input', async () => {
    const { approvalsGet, authorize } = createAuthorizer();
    approvalsGet.mockResolvedValue(artifactFor('workspace.sync.relationship.create', linkActionInput));

    await expect(authorize('receipt-1', linkActionInput, approval)).resolves.toBeUndefined();
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'receipt-1', serverId: 'server-1' });
  });

  it('refuses a linking receipt whose stored input names a different destination', async () => {
    const { approvalsGet, authorize } = createAuthorizer();
    approvalsGet.mockResolvedValue(artifactFor('workspace.sync.relationship.create', linkActionInput));

    await expect(authorize(
      'receipt-1',
      { ...linkActionInput, targetPath: '/work/other' },
      approval,
    )).rejects.toMatchObject({ code: 'approval_stale' });
  });

  it('refuses a linking input replayed against a handoff artifact', async () => {
    // A stored approval from another Action family authorizes nothing here,
    // even when the destination proof itself is intact.
    const { approvalsGet, authorize } = createAuthorizer();
    approvalsGet.mockResolvedValue(artifactFor('session.handoff', linkActionInput));

    await expect(authorize('receipt-1', linkActionInput, approval))
      .rejects.toMatchObject({ code: 'approval_stale' });
  });

  it('refuses an input that belongs to no destination-choosing Action family', async () => {
    const { approvalsGet, authorize } = createAuthorizer();
    const unrelatedInput = { sessionId: 'session-1', scopes: ['code'], candidate: { source: 'auto' } };
    approvalsGet.mockResolvedValue(artifactFor('session.restore', unrelatedInput));

    await expect(authorize('receipt-1', unrelatedInput, approval))
      .rejects.toMatchObject({ code: 'approval_stale' });
    // The decision is made from the input's own shape, so the approvals store is
    // never consulted for an Action that cannot own a destination proof.
    expect(approvalsGet).not.toHaveBeenCalled();
  });

  it('still binds the admitted Session for a handoff receipt', async () => {
    const { approvalsGet, authorize } = createAuthorizer();
    const handoffInput = {
      sessionId: 'session-1',
      targetMachineId: 'machine-b',
      targetPath: '/work/beta',
      workspaceAction: { kind: 'copy_once' as const, contentPolicy },
    };
    const handoffArtifact = artifactFor('session.handoff', handoffInput, {
      executionOriginV1: {
        v: 1 as const,
        authority: 'present_user' as const,
        surface: 'ui' as const,
        caller: { kind: 'host' as const },
        serverId: 'server-1',
        sessionId: 'session-1',
        machineId: 'machine-a',
        actionId: 'session.handoff',
        requestId: 'link-action-1',
      },
    });
    approvalsGet.mockResolvedValueOnce(handoffArtifact);
    await expect(authorize('receipt-1', handoffInput, approval)).resolves.toBeUndefined();

    approvalsGet.mockResolvedValueOnce({
      ...handoffArtifact,
      executionOriginV1: { ...handoffArtifact.executionOriginV1, sessionId: 'other-session' },
    });
    await expect(authorize('receipt-1', handoffInput, approval))
      .rejects.toMatchObject({ code: 'approval_stale' });
  });
});

describe('createWorkspaceCommittedCopyRemovalAuthorizer', () => {
  it('requires the exact executing approved retirement receipt rather than a definition-only or changed removal', async () => {
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
    const approvalsGet = vi.fn(async () => artifactFor('projects.worker.copy.retire', actionInput));
    const authorize = createWorkspaceCommittedCopyRemovalAuthorizer({ approvalsGet: approvalsGet as never, serverId: 'server-1' });
    await expect(authorize('receipt-1', actionInput)).resolves.toBeUndefined();
    await expect(authorize('receipt-1', {
      ...actionInput, removeTargetCopy: { ...actionInput.removeTargetCopy, rootFingerprint: 'b'.repeat(64) },
    })).rejects.toMatchObject({ code: 'approval_stale' });
    approvalsGet.mockResolvedValueOnce(artifactFor('projects.worker.copy.retire', actionInput, { status: 'open' }));
    await expect(authorize('receipt-1', actionInput)).rejects.toMatchObject({ code: 'approval_stale' });
    const { removeTargetCopy: _removal, ...definitionOnly } = actionInput;
    await expect(authorize('receipt-1', definitionOnly)).rejects.toMatchObject({ code: 'approval_stale' });
  });
});
