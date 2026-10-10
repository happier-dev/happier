import { describe, expect, it, vi } from 'vitest';

import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

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

const input = {
  v: 1 as const,
  sourceWorkspaceRefId: 'source-ref',
  targetMachineId: 'target-machine',
  targetPath: '/work/existing',
  mode: 'keep_both_in_sync' as const,
  contentPolicy,
  destinationIntent: 'use_existing' as const,
};

const result = {
  v: 1 as const,
  relationshipId: 'relationship-1',
  created: true,
  controllerMachineId: 'source-machine',
  sourceWorkspaceRefId: 'source-ref',
  targetWorkspaceRefId: 'target-ref',
  status: {
    relationshipId: 'relationship-1',
    controllerMachineId: 'source-machine',
    state: 'conflicted' as const,
    alphaPath: '/work/source',
    betaPath: '/work/existing',
    mode: 'keep_both_in_sync' as const,
    endpointStates: { alpha: null, beta: null },
    conflictCount: 1,
    lastCycleObservedAtMs: null,
  },
};

describe('workspace.sync.relationship.create Action', () => {
  it('keeps worker-copy purpose and the chosen folder in the existing destination approval', async () => {
    const exactInput = { ...input, mode: 'keep_synced' as const, destinationIntent: 'materialize_from_source_workspace' as const,
      targetPath: '/chosen-worker', purpose: 'worker_clean_copy' as const };
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'worker-approval' }));
    const create = vi.fn(async () => result);
    const executor = createActionExecutor({
      sessionHandoffTargetReplacementApprovalPreflight: async () => ({ type: 'approval_required' as const, approval: {
        v: 1 as const, consequences: ['replace_nonempty_workspace_target'] as const, serverId: 'server-a', machineId: 'target-machine',
        canonicalRoot: '/chosen-worker', rootFingerprint: 'a'.repeat(64), operationId: 'worker-create',
      } }),
      workspaceSyncRelationshipCreate: create,
      isActionApprovalRequired: () => false,
      approvalsCreate,
    } satisfies ActionExecutorDeps);
    const outcome = await executor.execute('workspace.sync.relationship.create', exactInput, {
      surface: 'ui', authority: 'present_user', machineId: 'source-machine', actionRequestId: 'worker-create', serverId: 'server-a',
    });
    expect(outcome).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'worker-approval' } });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ actionId: 'workspace.sync.relationship.create', actionArgs: exactInput }) }));
    expect(create).not.toHaveBeenCalled();
  });
  it('passes existing-folder intent through target preflight and starts without a Session', async () => {
    const preflight = vi.fn(async () => ({ type: 'not_required' as const }));
    const create = vi.fn(async () => result);
    const executor = createActionExecutor({
      sessionHandoffTargetReplacementApprovalPreflight: preflight,
      workspaceSyncRelationshipCreate: create,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    const response = await executor.execute('workspace.sync.relationship.create', input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1', actionRequestId: 'link-request-1',
    });

    expect(response).toMatchObject({ ok: true, result });
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      targetMachineId: 'target-machine',
      targetPath: '/work/existing',
      destinationIntent: 'use_existing',
      activatesExactMirror: false,
      operationId: 'link-request-1',
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      input,
      operationId: 'link-request-1',
      serverId: 'home-1',
    }));
  });

  it.each([false, true])('requires an exact confirmed target proof for continuing mirror deletion (changed=%s)', async (targetChanged) => {
    const approvals = new Map<string, Record<string, unknown>>();
    const approval = {
      v: 1 as const,
      consequences: ['delete_target_only_files_during_exact_mirror'] as const,
      serverId: 'home-1',
      machineId: 'target-machine',
      canonicalRoot: '/work/empty',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'link-request-2',
    };
    let currentApproval = approval;
    const create = vi.fn(async () => result);
    const executor = createActionExecutor({
      sessionHandoffTargetReplacementApprovalPreflight: async () => ({ type: 'approval_required', approval: currentApproval }),
      workspaceSyncRelationshipCreate: create,
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request }) => {
        approvals.set('approval-1', request as unknown as Record<string, unknown>);
        return { artifactId: 'approval-1' };
      },
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) as never,
      approvalsUpdate: async ({ artifactId, request }) => {
        approvals.set(artifactId, request as unknown as Record<string, unknown>);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);
    const exactInput = { ...input, targetPath: '/work/empty', mode: 'mirror_exactly' as const };

    const requested = await executor.execute('workspace.sync.relationship.create', exactInput, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1', actionRequestId: 'link-request-2',
    });
    expect(requested).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(approvals.get('approval-1')).toMatchObject({
      actionId: 'workspace.sync.relationship.create',
      handoffTargetReplacementApproval: approval,
      executionOriginV1: { authority: 'present_user', requestId: 'link-request-2' },
    });

    if (targetChanged) currentApproval = { ...approval, rootFingerprint: 'b'.repeat(64) };
    const approved = await executor.execute('approval.request.decide', {
      artifactId: 'approval-1', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-1' });
    if (targetChanged) {
      expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: {
        status: 'failed', execution: { ok: false, errorCode: 'approval_stale' },
      } });
      expect(create).not.toHaveBeenCalled();
      return;
    }
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      input: exactInput,
      operationId: 'link-request-2',
      targetReplacementApproval: approval,
      targetReplacementApprovalReceiptId: 'approval-1',
    }));
  });
});
