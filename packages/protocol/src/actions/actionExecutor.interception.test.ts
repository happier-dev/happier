import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor execution interception', () => {
  const runStartInput = {
    sessionId: 'session-1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    instructions: 'do it',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
  } as const;

  it('revalidates transformed input and executes once before observational after', async () => {
    const sequence: string[] = [];
    const sessionTitleSet = vi.fn(async (args: unknown) => {
      sequence.push('execute');
      return { updated: args };
    });
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => {
      sequence.push('before');
      return {
        status: 'continue' as const,
        input: { ...(request.input as object), title: 'transformed' },
      };
    });
    const observeActionExecution = vi.fn(async () => {
      sequence.push('after');
      throw new Error('observer failure must not replace the action result');
    });
    const executor = createExecutor({
      sessionTitleSet,
      interceptActionExecution,
      observeActionExecution,
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'caller.plugin' },
      },
    );

    expect(result.ok).toBe(true);
    expect(sequence).toEqual(['before', 'execute', 'after']);
    expect(sessionTitleSet).toHaveBeenCalledOnce();
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'transformed' });
    expect(interceptActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'original' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
    }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'transformed' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
      result: expect.objectContaining({ ok: true }),
    }));
  });

  it('distinguishes explicit rejection from a hook failure and never executes', async () => {
    const sessionTitleSet = vi.fn(async () => ({}));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createExecutor({
      sessionTitleSet,
      observeActionExecution,
      interceptActionExecution: async () => ({
        status: 'rejected',
        code: 'policy_denied',
        message: 'Denied by policy',
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_interception_rejected',
      details: { code: 'policy_denied' },
    });
    expect(sessionTitleSet).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('rejects malformed transformed input before rights, approval, or action effects', async () => {
    const sessionTitleSet = vi.fn(async () => ({}));
    const isActionApprovalRequired = vi.fn(() => true);
    const executor = createExecutor({
      sessionTitleSet,
      isActionApprovalRequired,
      interceptActionExecution: async () => ({
        status: 'continue',
        input: { sessionId: 'session-1', title: 42 },
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(isActionApprovalRequired).not.toHaveBeenCalled();
    expect(sessionTitleSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'invalid initial input',
      input: {},
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: runStartInput })),
      expectedErrorCode: 'invalid_parameters',
    },
    {
      name: 'throwing hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => {
        throw new Error('hook failed');
      }),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'rejected hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'rejected' as const, code: 'policy_denied' })),
      expectedErrorCode: 'action_interception_rejected',
    },
    {
      name: 'failed hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'failed' as const, code: 'plugin_hook_handler_failed' })),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'invalid transformed input',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: {} })),
      expectedErrorCode: 'invalid_parameters',
    },
  ])('classifies $name as owner-proven pre-dispatch failure for execution.run.start', async ({
    input,
    interceptActionExecution,
    expectedErrorCode,
  }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    const result = await executor.execute(
      'execution.run.start' as any,
      input,
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: expectedErrorCode,
    });
    expect(result).toHaveProperty('details', {
      executionRunStart: { v: 1, runCreation: 'noRunCreated' },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('classifies an invalid Plugin caller before interception as noRunCreated for execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const interceptActionExecution = vi.fn(async () => ({ status: 'continue' as const, input: runStartInput }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    await expect(executor.execute(
      'execution.run.start' as any,
      runStartInput,
      { surface: 'plugin', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('disables interception for one explicitly nested execution', async () => {
    const interceptActionExecution = vi.fn(async () => ({ status: 'rejected' as const }));
    const observeActionExecution = vi.fn(async () => undefined);
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ interceptActionExecution, observeActionExecution, sessionTitleSet });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'nested' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'hook.plugin' },
        bypassActionInterception: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(sessionTitleSet).toHaveBeenCalledOnce();
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('publishes the target after event only when a deferred approved action actually executes', async () => {
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => ({
      status: 'continue' as const,
      input: request.input,
    }));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createExecutor({
      sessionTitleSet,
      interceptActionExecution,
      observeActionExecution,
      isActionApprovalRequired: (actionId) => actionId === 'session.title.set',
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'approval-1' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
    });

    const deferred = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'deferred' },
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'caller.plugin', contributionLocalId: 'title-hook' },
      },
    );
    expect(deferred).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set')).toHaveLength(0);

    await executor.execute(
      'approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(sessionTitleSet).toHaveBeenCalledOnce();
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set'))
      .toEqual([[expect.objectContaining({
        input: { sessionId: 'session-1', title: 'deferred' },
        caller: { kind: 'plugin', pluginId: 'caller.plugin', contributionLocalId: 'title-hook' },
        result: expect.objectContaining({ ok: true }),
      })]]);
  });
});
