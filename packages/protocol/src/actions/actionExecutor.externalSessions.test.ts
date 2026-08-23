import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(
  externalSessionAction: NonNullable<ActionExecutorDeps['externalSessionAction']>,
): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    externalSessionAction,
  };
}

describe('createActionExecutor (public External Session actions)', () => {
  it('routes validated semantic input through the canonical daemon owner', async () => {
    const externalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true,
        machineOnline: true,
        runnerActive: false,
        activity: 'idle',
        canTakeOverDirect: false,
        canTakeOverPersist: true,
        canForceStop: false,
      },
    }));
    const signal = new AbortController().signal;
    const executor = createActionExecutor(createDeps(externalSessionAction));

    const result = await executor.execute(
      'sessions.external.status.get',
      { sessionId: 'session-1' },
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'author.example' },
        signal,
      },
    );

    expect(result.ok).toBe(true);
    expect(externalSessionAction).toHaveBeenCalledWith({
      actionId: 'sessions.external.status.get',
      input: { sessionId: 'session-1' },
      pluginId: 'author.example',
      signal,
    });
  });

  it.each([
    ['sessions.external.status.get', { sessionId: 'session-1' }],
    ['sessions.external.follow', { sessionId: 'session-1' }],
    ['sessions.external.unfollow', { sessionId: 'session-1', leaseId: 'lease-1' }],
    ['sessions.external.backgroundFollow.set', { sessionId: 'session-1', enabled: true }],
    ['sessions.external.materialize.start', {
      request: {
        v: 1,
        idempotencyKey: 'materialize-1',
        sessionId: 'session-1',
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    }],
    ['sessions.external.operation.status.get', { sessionId: 'session-1', operationId: 'operation-1', revision: 1 }],
    ['sessions.external.operation.cancel', { sessionId: 'session-1', operationId: 'operation-1', revision: 1 }],
    ['sessions.external.operation.resume', { sessionId: 'session-1', operationId: 'operation-1', revision: 1 }],
    ['sessions.external.operation.retry', { sessionId: 'session-1', operationId: 'operation-1', revision: 1 }],
    ['sessions.external.operation.discard', { sessionId: 'session-1', operationId: 'operation-1', revision: 1 }],
  ] as const)('routes the selected semantic mapping %s', async (actionId, input) => {
    const externalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: false, error: { code: 'fixture', message: 'fixture' } },
    }));
    const executor = createActionExecutor(createDeps(externalSessionAction));

    await executor.execute(actionId, input, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'author.example' },
    });

    expect(externalSessionAction).toHaveBeenCalledWith({
      actionId,
      input,
      pluginId: 'author.example',
    });
  });

  it('fails closed before dispatch when the plugin principal is missing', async () => {
    const externalSessionAction = vi.fn();
    const executor = createActionExecutor(createDeps(externalSessionAction));

    await expect(executor.execute(
      'sessions.external.status.get',
      { sessionId: 'session-1' },
      { surface: 'plugin' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(externalSessionAction).not.toHaveBeenCalled();
  });

  it('returns typed missing provenance for an API call rather than treating API as a plugin surface', async () => {
    const externalSessionAction = vi.fn();
    const executor = createActionExecutor(createDeps(externalSessionAction));

    await expect(executor.execute(
      'sessions.external.status.get',
      { sessionId: 'session-1' },
      { surface: 'api', authority: 'account_automation' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(externalSessionAction).not.toHaveBeenCalled();
  });

  it('routes a host-stamped API call through the existing host external-session owner', async () => {
    const pluginExternalSessionAction = vi.fn();
    const hostExternalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true,
        machineOnline: true,
        runnerActive: false,
        activity: 'idle',
        canTakeOverDirect: false,
        canTakeOverPersist: true,
        canForceStop: false,
      },
    }));
    const executor = createActionExecutor({
      ...createDeps(pluginExternalSessionAction),
      hostExternalSessionAction,
    } as ActionExecutorDeps & Readonly<{
      hostExternalSessionAction: typeof hostExternalSessionAction;
    }>);
    const signal = new AbortController().signal;

    await expect(executor.execute(
      'sessions.external.status.get',
      { sessionId: 'session-1' },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        signal,
      },
    )).resolves.toMatchObject({ ok: true });

    expect(hostExternalSessionAction).toHaveBeenCalledWith({
      actionId: 'sessions.external.status.get',
      input: { sessionId: 'session-1' },
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        signal,
      },
      signal,
    });
    expect(pluginExternalSessionAction).not.toHaveBeenCalled();
  });

  it('routes host API external-session discovery through the fenced host owner without plugin provenance', async () => {
    const pluginExternalSessionAction = vi.fn();
    const hostExternalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, candidates: [] },
    }));
    const executor = createActionExecutor({
      ...createDeps(pluginExternalSessionAction),
      hostExternalSessionAction,
    } as ActionExecutorDeps & Readonly<{
      hostExternalSessionAction: typeof hostExternalSessionAction;
    }>);

    await expect(executor.execute(
      'sessions.external.candidates.list',
      {
        machineId: 'machine-1',
        providerId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
      },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
    )).resolves.toEqual({ ok: true, result: { ok: true, candidates: [] } });

    expect(hostExternalSessionAction).toHaveBeenCalledWith({
      actionId: 'sessions.external.candidates.list',
      input: {
        machineId: 'machine-1',
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
      },
      context: {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      },
    });
    expect(pluginExternalSessionAction).not.toHaveBeenCalled();
  });
});
