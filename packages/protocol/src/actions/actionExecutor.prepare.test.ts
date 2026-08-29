import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    sessionList: vi.fn(async () => ({ sessions: [] })),
    ...overrides,
  } as unknown as ActionExecutorDeps);
}

describe('ActionExecutor prepared invocation', () => {
  it('settles admission failures without exposing a runnable mutation', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList });

    await expect(executor.prepare('session.list', { limit: 'invalid' }, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      kind: 'settled',
      result: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
    });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('defers dispatch and memoizes the exact run promise', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1' }] }));
    const executor = createExecutor({ sessionList });

    const prepared = await executor.prepare('session.list', { limit: 1 }, {
      surface: 'api',
      authority: 'account_automation',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    const concurrentRun = prepared.invocation.run();
    expect(concurrentRun).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1' }] },
    });
    expect(prepared.invocation.run()).toBe(firstRun);
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('completes interception and semantic binding before returning ready, then observes settlement', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const interceptActionExecution = vi.fn(async () => ({
      status: 'continue' as const,
      input: { limit: 2 },
    }));
    const observeActionExecution = vi.fn(async () => {});
    const executor = createExecutor({
      sessionList,
      interceptActionExecution,
      observeActionExecution,
    });

    const prepared = await executor.prepare('session.list', { limit: 1 }, {
      surface: 'api',
      authority: 'account_automation',
    });

    expect(prepared.kind).toBe('ready');
    expect(interceptActionExecution).toHaveBeenCalledTimes(1);
    expect(sessionList).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    await prepared.invocation.run();
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.list',
      input: { limit: 2 },
      result: { ok: true, result: { sessions: [] } },
    }));
  });

  it('finishes directory preflight before ready and does not repeat it during run', async () => {
    const input = {
      creationKey: 'prepare-spawn-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: '/workspace/project',
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn(async () => ({
      type: 'not_required' as const,
    }));
    const sessionSpawnNew = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));
    const executor = createExecutor({
      sessionSpawnNewDirectoryApprovalPreflight,
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    });

    const prepared = await executor.prepare('session.spawn_new', input, {
      // The canonical spawn input carries executionTarget; the public api
      // projection treats placement as transport metadata and omits it.
      surface: 'cli',
      authority: 'present_user',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    await prepared.invocation.run();
    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNew).toHaveBeenCalledTimes(1);
  });

  it('retains the canonical fork cutoff, strategy, replay budget, and request identity through run', async () => {
    const sessionFork = vi.fn(async () => ({ ok: true as const, childSessionId: 'child-1' }));
    const executor = createExecutor({
      sessionFork,
      isActionApprovalRequired: () => false,
    });

    const prepared = await executor.prepare('session.fork', {
      sessionId: 'parent-1',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
    }, {
      surface: 'rpc',
      authority: 'present_user',
      serverId: 'server-1',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionFork).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    await prepared.invocation.run();

    expect(sessionFork).toHaveBeenCalledWith({
      sessionId: 'parent-1',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
      serverId: 'server-1',
    });
  });

  it('completes blocking approval admission before ready and dispatches only from run', async () => {
    let storedRequest: ApprovalRequestV1 | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { artifactId: 'approval-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => ({
      decision: 'approve' as const,
      request: {
        ...request,
        status: 'approved' as const,
        decision: { kind: 'approve' as const, decidedAtMs: 2 },
      },
    }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1' }] }));
    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    });

    const prepared = await executor.prepare('session.list', {}, { surface: 'mcp' });

    expect(prepared.kind).toBe('ready');
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1' }] },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
    expect(storedRequest).toMatchObject({
      status: 'executed',
      execution: { ok: true, result: { sessions: [{ id: 'session-1' }] } },
    });
  });

  it('keeps blocking waiter ownership when approval is decided concurrently', async () => {
    let storedRequest: ApprovalRequestV1 | null = null;
    let resolveWaiter: ((request: ApprovalRequestV1) => void) | null = null;
    let markWaiterReady: (() => void) | null = null;
    const waiterReady = new Promise<void>((resolve) => {
      markWaiterReady = resolve;
    });
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { artifactId: 'approval-concurrent-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      if (request.status === 'approved') resolveWaiter?.(request);
      return { ok: true as const };
    });
    const approvalsResolveBlockingDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      resolveWaiter?.(request);
      return { resolved: true };
    });
    const approvalsWaitForDecision = vi.fn(async () => {
      markWaiterReady?.();
      const request = await new Promise<ApprovalRequestV1>((resolveDecision) => {
        resolveWaiter = resolveDecision;
      });
      return { decision: 'approve' as const, request };
    });
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1' }] }));
    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    });

    const preparedPromise = executor.prepare('session.list', {}, { surface: 'mcp' });
    await waiterReady;
    const decideResult = await executor.execute('approval.request.decide', {
      artifactId: 'approval-concurrent-1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });
    const prepared = await preparedPromise;

    expect(decideResult).toEqual({ ok: true, result: { ok: true, status: 'approved' } });
    expect(prepared.kind).toBe('ready');
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1' }] },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('keeps execute as the terminal prepare-then-run convenience contract', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1' }] }));
    const executor = createExecutor({ sessionList });

    await expect(executor.execute('session.list', {}, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1' }] },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });
});
