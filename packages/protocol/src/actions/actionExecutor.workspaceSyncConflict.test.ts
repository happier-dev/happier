import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

const input = {
  controllerMachineId: 'machine-a',
  hubWorkspaceRefId: 'workspace-a',
  path: 'src/index.ts',
  source: { workspaceRefId: 'workspace-a', expected: { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 12 } },
  targets: [{ workspaceRefId: 'workspace-b', expected: { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 12 } }],
  relationshipIds: ['relationship-1'],
  strategy: 'use_source' as const,
};

describe('workspace.sync.conflict.resolve Action authority', () => {
  it('honors Ask through canonical deferred approval and replays the approved artifact receipt', async () => {
    const approvals = new Map<string, Record<string, unknown>>();
    const workspaceSyncConflictResolve = vi.fn(async () => ({
      endpoints: [{ workspaceRefId: 'workspace-b', status: 'applied' as const }],
    }));
    const executor = createActionExecutor({
      workspaceSyncConflictResolve,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workspace.sync.conflict.resolve': { approvalRequiredSurfaces: [context.surface] } } }),
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

    await expect(executor.execute('workspace.sync.conflict.resolve', input, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1', actionRequestId: 'conflict-request-1',
      defaultSessionId: 'session-c', defaultSessionMachineId: 'machine-c',
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'workspace.sync.conflict.resolve' },
    });
    expect(workspaceSyncConflictResolve).not.toHaveBeenCalled();

    const decision = await executor.execute('approval.request.decide', {
      artifactId: 'approval-1', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' });
    expect(decision, JSON.stringify(decision)).toMatchObject({
      ok: true,
      result: { ok: true, status: 'executed', execution: { ok: true } },
    });
    expect(approvals.get('approval-1')).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(workspaceSyncConflictResolve).toHaveBeenCalledWith({
      actionReceiptId: 'approval-1', input, context: expect.objectContaining({
        authority: 'account_automation', bypassApprovals: true, serverId: 'server-1',
        defaultSessionId: 'session-c', defaultSessionMachineId: 'machine-c',
      }),
    });
  });

  it('cannot execute through an approval bypass without an Action receipt', async () => {
    const workspaceSyncConflictResolve = vi.fn();
    const executor = createActionExecutor({ workspaceSyncConflictResolve } as unknown as ActionExecutorDeps);
    await expect(executor.execute('workspace.sync.conflict.resolve', input, {
      surface: 'ui', authority: 'present_user', bypassApprovals: true,
    })).resolves.toEqual({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
    expect(workspaceSyncConflictResolve).not.toHaveBeenCalled();
  });

  it('leaves a denied or stale Agent-origin request without a controller effect', async () => {
    const approvals = new Map<string, Record<string, unknown>>();
    const workspaceSyncConflictResolve = vi.fn();
    let nextArtifact = 0;
    let originCurrent = true;
    const executor = createActionExecutor({
      workspaceSyncConflictResolve,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workspace.sync.conflict.resolve': { approvalRequiredSurfaces: [context.surface] } } }),
      approvalsCreate: async ({ request }) => {
        const artifactId = `approval-${++nextArtifact}`;
        approvals.set(artifactId, request as unknown as Record<string, unknown>);
        return { artifactId };
      },
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) as never,
      approvalsUpdate: async ({ artifactId, request }) => {
        approvals.set(artifactId, request as unknown as Record<string, unknown>);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async (args: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]) => {
        if (!originCurrent) args.reportStale?.('credential_changed');
        return originCurrent;
      },
    } as unknown as ActionExecutorDeps);
    const origin = {
      surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: 'server-1', defaultSessionId: 'session-c', defaultSessionMachineId: 'machine-c',
    };

    await expect(executor.execute('workspace.sync.conflict.resolve', input, {
      ...origin, actionRequestId: 'agent-request-denied',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1' } });
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-1', decision: 'reject',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'rejected' } });

    await expect(executor.execute('workspace.sync.conflict.resolve', input, {
      ...origin, actionRequestId: 'agent-request-stale',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-2' } });
    originCurrent = false;
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-2', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(workspaceSyncConflictResolve).not.toHaveBeenCalled();
  });
});
