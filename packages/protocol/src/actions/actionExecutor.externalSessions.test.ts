import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, listActionSpecsForSurface } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import type {
  HostExternalSessionActionId,
  PluginExternalSessionActionId,
} from './executor/types.js';

function createDeps(
  externalSessionAction: NonNullable<ActionExecutorDeps['externalSessionAction']>,
): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
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
    // External-session routing has dedicated authority tests below; approval is orthogonal.
    isActionApprovalRequired: () => false,
  };
}

describe('createActionExecutor (public External Session actions)', () => {
  it('offers every agent-facing external operation through CLI without exposing viewer leases', () => {
    for (const spec of listActionSpecsForSurface('agent').filter(spec => spec.id.startsWith('sessions.external.'))) {
      expect(spec.surfaces.cli, spec.id).toBe(true);
    }
    expect(listActionSpecsForSurface('cli').some(spec => spec.id === 'sessions.external.follow')).toBe(false);
    expect(listActionSpecsForSurface('cli').some(spec => spec.id === 'sessions.external.unfollow')).toBe(false);
  });
  it('offers semantic history reads and takeover to agents, MCP and CLI with ordinary Ask defaults', async () => {
    const takeover = { request: { v: 1, idempotencyKey: 'takeover-1', sessionId: 'session-1',
      plan: 'takeover', targetStorageMode: 'persisted', targetDirectory: '/workspace', targetRuntimeMode: 'terminal' } };
    const readAfter = { machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' }, cursor: 'native-cursor' };
    const unavailable = { ok: false, errorCode: 'agent_unavailable', error: 'agent_unavailable' };
    const operation = { ok: false, error: { code: 'source_unavailable', message: 'Source is unavailable' } };
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      const catalog = listActionSpecsForSurface(surface);
      for (const actionId of ['sessions.external.status.get', 'sessions.external.transcript.readAfter', 'sessions.external.takeover.start'] as const) {
        expect(catalog.some(spec => spec.id === actionId), `${surface}:${actionId}`).toBe(true);
        const spec = getActionSpec(actionId);
        expect(resolveActionApprovalRouting({ actionId, spec, context: { surface } }).required)
          .toBe(actionId === 'sessions.external.takeover.start');
      }
      const plugin = vi.fn();
      const executor = createActionExecutor({ ...createDeps(plugin), hostExternalSessionAction: async ({ actionId }) =>
        ({ ok: true, result: actionId === 'sessions.external.takeover.start' ? operation : unavailable }) });
      for (const [actionId, input, result] of [
        ['sessions.external.status.get', { sessionId: 'session-1' }, unavailable],
        ['sessions.external.transcript.readAfter', readAfter, unavailable],
        ['sessions.external.takeover.start', takeover, operation],
      ] as const) {
        await expect(executor.execute(actionId, input, { surface, authority: 'account_automation',
          ...(surface === 'agent' ? { defaultSessionId: 'session-1' } : {}) }))
          .resolves.toEqual({ ok: true, result });
      }
      expect(plugin).not.toHaveBeenCalled();
    }
    expect(getActionSpec('sessions.external.follow').surfaces.agent).toBe(false);
    expect(getActionSpec('sessions.external.unfollow').surfaces.mcp).toBe(false);
    expect(getActionSpec('sessions.external.takeover').surfaces.agent).toBe(false);
  });
  it.each(['ui', 'agent', 'mcp', 'cli'] as const)('routes %s background-follow intent through the host owner without plugin provenance', async (surface) => {
    const externalSessionAction = vi.fn();
    const response = { ok: true as const, enabled: true, leaseActive: true, updatedAtMs: 42 };
    const executor = createActionExecutor({ ...createDeps(externalSessionAction),
      hostExternalSessionAction: async () => ({ ok: true, result: response }) });
    await expect(executor.execute('sessions.external.backgroundFollow.set', {
      sessionId: 'session-1', enabled: true,
    }, { surface, authority: 'account_automation',
      ...(surface === 'agent' ? { defaultSessionId: 'session-1' } : {}) })).resolves.toEqual({ ok: true, result: response });
    expect(externalSessionAction).not.toHaveBeenCalled();
  });
  it.each(['ui', 'agent', 'mcp'] as const)('routes %s import through the existing host operation without plugin identity', async (surface) => {
    const externalSessionAction = vi.fn();
    const result = { ok: false as const, error: { code: 'upgrade_required', message: 'Newer daemon required' } };
    const executor = createActionExecutor({ ...createDeps(externalSessionAction), hostExternalSessionAction: async () => ({ ok: true, result }) });
    await expect(executor.execute('sessions.external.materialize.start', {
      request: { v: 1, idempotencyKey: 'materialize-1', sessionId: 'session-1', plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null },
    }, { surface, authority: 'account_automation' })).resolves.toEqual({ ok: true, result });
    expect(externalSessionAction).not.toHaveBeenCalled();
  });
  it.each(['ui', 'agent', 'mcp'] as const)('routes %s Browse discovery through the host owner without inventing plugin provenance', async (surface) => {
    const externalSessionAction = vi.fn();
    const hostExternalSessionAction = vi.fn(async () => ({ ok: true as const, result: { ok: true, candidates: [] } }));
    const executor = createActionExecutor({ ...createDeps(externalSessionAction), hostExternalSessionAction });
    const result = await executor.execute('sessions.external.candidates.list', {
      machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
    }, { surface, authority: 'account_automation' });
    expect(result).toEqual({ ok: true, result: { ok: true, candidates: [] } });
    expect(externalSessionAction).not.toHaveBeenCalled();
  });
  // Registration contract: the plugin-provenance External Session union must
  // never re-expose the low-level ephemeral lease ids excluded by the
  // canonical plugin-surface projection owner
  // (PLUGIN_SURFACE_EXCLUSION_REASONS), while the host union retains their
  // released RPC/API route.
  it('keeps the excluded ephemeral lease ids off the plugin registration union', () => {
    expectTypeOf<PluginExternalSessionActionId>()
      .extract<'sessions.external.follow' | 'sessions.external.unfollow'>()
      .toBeNever();
    expectTypeOf<HostExternalSessionActionId>()
      .extract<'sessions.external.follow' | 'sessions.external.unfollow'>()
      .toEqualTypeOf<'sessions.external.follow' | 'sessions.external.unfollow'>();
  });

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

  // follow/unfollow are admitted only on the host api surface: follow leases
  // are host-owned, so the api path routes through the host external-session
  // owner instead of manufacturing plugin identity from transport data.
  it.each([
    ['sessions.external.follow', { sessionId: 'session-1' }],
    ['sessions.external.unfollow', { sessionId: 'session-1', leaseId: 'lease-1' }],
  ] as const)('routes the host-api semantic mapping %s', async (actionId, input) => {
    const hostExternalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: false, error: { code: 'fixture', message: 'fixture' } },
    }));
    const executor = createActionExecutor({
      ...createDeps(vi.fn()),
      hostExternalSessionAction,
    });

    await executor.execute(actionId, input, {
      surface: 'api',
      actionCaller: { kind: 'host' },
    });

    expect(hostExternalSessionAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId,
      input,
    }));
  });

  // The plugin projection excludes the low-level ephemeral lease Actions, so
  // the plugin surface fails closed before the execution registration and the
  // plugin-provenance executor is never reached; authors use the contextual
  // SessionsService.external.followTranscript subscription instead. If the
  // projection or the registration ever re-exposes these ids, this test fails.
  it.each([
    ['sessions.external.follow', { sessionId: 'session-1' }],
    ['sessions.external.unfollow', { sessionId: 'session-1', leaseId: 'lease-1' }],
  ] as const)('fails closed on the excluded plugin-surface seam %s', async (actionId, input) => {
    const externalSessionAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: false, error: { code: 'fixture', message: 'fixture' } },
    }));
    const executor = createActionExecutor(createDeps(externalSessionAction));

    await expect(executor.execute(actionId, input, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'author.example' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      details: { reason: 'unsupported_surface', surface: 'plugin' },
    });
    expect(externalSessionAction).not.toHaveBeenCalled();
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
