import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import { computeWorkspaceSyncPolicyDigest, type HandoffWorkspaceActionV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  // Dependencies represent host transport/effect boundaries; internal admission stays real.
  return createActionExecutor({ isActionApprovalRequired: () => false, ...overrides } as ActionExecutorDeps);
}

describe('hands-off Action admission', () => {
  it('refuses handoff copy and new relationship effects while preserving no-transfer and linked handoffs', async () => {
    const issued: Array<Readonly<{ phase: 'preflight' | 'handoff'; workspaceAction?: HandoffWorkspaceActionV1 }>> = [];
    const executor = createExecutor({
      // These are the host's network/effect boundaries, not mocked admission logic.
      sessionHandoffTargetReplacementApprovalPreflight: async input => {
        issued.push({ phase: 'preflight', workspaceAction: input.workspaceAction });
        return { type: 'not_required' };
      },
      sessionHandoffStart: async input => {
        issued.push({ phase: 'handoff', workspaceAction: input.workspaceAction });
        return { ok: false, errorCode: 'handoff_transport_unavailable', error: 'handoff_transport_unavailable' };
      },
    });
    const context = { surface: 'rpc' as const, workspaceWrites: 'deny' as const,
      authority: 'account_automation' as const, actionRequestId: 'handoff-write-ceiling', serverId: 'home' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const writes: HandoffWorkspaceActionV1[] = [
      { kind: 'copy_once', contentPolicy },
      { kind: 'create_relationship', mode: 'keep_synced', contentPolicy, flushBeforeCommit: true },
    ];
    for (const workspaceAction of writes) {
      const input = { sessionId: 'source', targetMachineId: 'target', targetPath: '/target', workspaceAction };
      await expect(executor.prepare('session.handoff', input, context)).resolves.toMatchObject({
        kind: 'settled', result: { ok: false, errorCode: 'workspace_write_denied' },
      });
      await expect(executor.execute('session.handoff', input, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'workspace_write_denied' });
    }
    expect(issued).toEqual([]);
    for (const workspaceAction of [{ kind: 'none' }, { kind: 'linked_workspace' }] as const) {
      await expect(executor.execute('session.handoff', {
        sessionId: 'source', targetMachineId: 'target', targetPath: '/target', workspaceAction,
      }, context)).resolves.toMatchObject({ ok: false, errorCode: 'handoff_transport_unavailable' });
    }
    expect(issued).toEqual([
      { phase: 'handoff', workspaceAction: { kind: 'none' } },
      { phase: 'handoff', workspaceAction: { kind: 'linked_workspace' } },
    ]);
  });

  it('admits session role edits only for the agent own or server-proved led sessions', async () => {
    const roleActionExecute = vi.fn(async () => ({ updated: true }));
    let accessible = true;
    const executor = createExecutor({ roleActionExecute,
      sessionList: async () => markSessionListQueryResultV1({
        sessions: accessible ? [{ id: 'report', active: false, presence: 'offline', updatedAt: 10 }] : [],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }),
    });
    const context = { surface: 'agent' as const, defaultSessionId: 'self', workspaceWrites: 'allow' as const,
      agentStartContext: { caller: { kind: 'session' as const, sessionId: 'self', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-1', directory: '/repo' }, ledSubtreeSessionIds: ['report'],
        workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' as const } };
    await expect(executor.execute('session.notes.set', { sessionId: 'unrelated', notes: 'task' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(roleActionExecute).not.toHaveBeenCalled();
    await expect(executor.execute('session.notes.set', { sessionId: 'report', notes: 'task' }, context))
      .resolves.toMatchObject({ ok: true });
    const prepared = await executor.prepare('session.notes.set', { sessionId: 'report', notes: 'stale task' }, context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted led Session notes');
    accessible = false;
    roleActionExecute.mockClear();
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(roleActionExecute).not.toHaveBeenCalled();
    await expect(executor.execute('session.notes.set', { sessionId: 'self', notes: 'own task' }, context))
      .resolves.toMatchObject({ ok: true });
  });
  it('rechecks the live workspace ceiling when a prepared invocation finally dispatches', async () => {
    let workspaceWrites: 'allow' | 'deny' = 'allow';
    const scmActionExecute = vi.fn(async () => ({ success: true, alreadyInitialized: false }));
    const executor = createExecutor({ scmActionExecute, getCurrentWorkspaceWrites: () => workspaceWrites });
    const prepared = await executor.prepare('scm.repository.init', { cwd: '/repo' }, { surface: 'rpc', workspaceWrites: 'allow', bypassApprovals: true });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected an admitted invocation');
    workspaceWrites = 'deny';
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'workspace_write_denied' });
    expect(scmActionExecute).not.toHaveBeenCalled();
  });
  it('refuses a workspace-writing Action before approval and preserves read Actions', async () => {
    const scmActionExecute = vi.fn(async () => ({ success: true, alreadyInitialized: false }));
    const executor = createExecutor({ scmActionExecute, machinesList: async () => ({ items: [] }) });
    await expect(executor.execute('scm.repository.init', { cwd: '/repo' }, {
      surface: 'rpc', workspaceWrites: 'deny', bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_write_denied' });
    expect(scmActionExecute).not.toHaveBeenCalled();
    await expect(executor.execute('machines.list', {}, {
      surface: 'cli', workspaceWrites: 'deny',
    })).resolves.toMatchObject({ ok: true, result: { items: [] } });
  });

  it('an agent cannot relax hands-off on its own session, even with approval bypass', async () => {
    const executor = createExecutor();
    await expect(executor.execute(ActionIdSchema.parse('session.roles.override.set'), {
      sessionId: 'self', roleId: 'orchestrator', workspaceWrites: 'allow',
    }, {
      surface: 'agent', defaultSessionId: 'self', workspaceWrites: 'deny', bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_write_escalation_denied' });
  });

  it('allows an agent to tighten and a present user to relax through the role owner', async () => {
    const roleActionExecute = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ roleActionExecute });
    await expect(executor.execute('session.roles.override.set', {
      sessionId: 'self', roleId: 'builder', workspaceWrites: 'deny',
    }, {
      surface: 'agent', defaultSessionId: 'self', workspaceWrites: 'allow',
      agentStartContext: { caller: { kind: 'session', sessionId: 'self', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-1', directory: '/repo' }, ledSubtreeSessionIds: [],
        workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' },
    })).resolves.toMatchObject({ ok: true, result: { updated: true } });
    await expect(executor.execute('session.roles.override.set', {
      sessionId: 'self', roleId: 'builder', workspaceWrites: 'allow',
    }, {
      surface: 'ui', defaultSessionId: 'self', workspaceWrites: 'deny',
    })).resolves.toMatchObject({ ok: true, result: { updated: true } });
  });

  it('refuses workspace effects at prepare admission before creating an approval', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval' }));
    const scmActionExecute = vi.fn();
    const executor = createExecutor({ approvalsCreate, scmActionExecute, isActionApprovalRequired: () => true });
    await expect(executor.prepare('scm.repository.init', { cwd: '/repo' }, {
      surface: 'rpc', workspaceWrites: 'deny',
    })).resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'workspace_write_denied' } });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(scmActionExecute).not.toHaveBeenCalled();
  });
});
