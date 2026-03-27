import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(): ActionExecutorDeps {
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
    sessionSpawnPicker: vi.fn(async () => ({})),

    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    resetGlobalVoiceAgent: vi.fn(),
    teleportVoiceAgentToSessionRoot: vi.fn(async () => ({ ok: true })),
  };
}

describe('createActionExecutor (inventory/discovery)', () => {
  it('uses workspace_write as the default permission mode for subagents.delegate.start', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'workspace_write',
        intentInput: expect.objectContaining({
          backendTargetKey: 'agent:claude',
        }),
      }),
      undefined,
    );
  });

  it('treats successful execution-run service envelopes as successful fanout results', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({
      ok: true,
      data: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
      },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.plan.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'Plan this task.',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'plan',
        sessionId: 'session_1',
        results: [
          {
            key: 'agent:codex',
            ok: true,
            result: {
              runId: 'run_1',
              callId: 'call_1',
              sidechainId: 'side_1',
            },
          },
        ],
      },
    });
  });

  it('preserves failed execution-run service envelope codes and messages in fanout results', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Unable to resolve a default base branch for CodeRabbit review.',
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('review.start', {
      sessionId: 'session_1',
      engineIds: ['coderabbit'],
      instructions: 'Review this task.',
      changeType: 'committed',
      base: { kind: 'none' },
    });

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 'session_1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            errorCode: 'execution_run_not_allowed',
            error: 'Unable to resolve a default base branch for CodeRabbit review.',
          },
        ],
      },
    });
  });

  it('defaults execution.run.send delivery to steer_if_supported and omits resume when unset', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.send', {
      sessionId: 'session_1',
      runId: 'run_1',
      message: 'Continue and summarize what changed.',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunSend).toHaveBeenCalledWith(
      'session_1',
      {
        runId: 'run_1',
        message: 'Continue and summarize what changed.',
        delivery: 'steer_if_supported',
      },
      undefined,
    );
  });

  it('forwards path and host to session.spawn_new', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      path: '/repo/project',
      host: 'leeroy-mbp',
      tag: 't',
    });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({
      path: '/repo/project',
      host: 'leeroy-mbp',
      tag: 't',
    });
  });

  it('forwards agentId + modelId to session.spawn_new', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', { agentId: 'codex', modelId: 'gpt-5' });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({ agentId: 'codex', modelId: 'gpt-5' });
  });

  it('routes paths.list_recent to deps.pathsListRecent', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('paths.list_recent', { machineId: 'm1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(deps.pathsListRecent).toHaveBeenCalledWith({ machineId: 'm1', limit: 3 });
  });

  it('routes machines.list to deps.machinesList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('machines.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.machinesList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes servers.list to deps.serversList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('servers.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.serversList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes review.engines.list to deps.reviewEnginesList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('review.engines.list', { sessionId: 's1', includeDisabled: true });
    expect(res.ok).toBe(true);
    expect(deps.reviewEnginesList).toHaveBeenCalledWith({ sessionId: 's1', includeDisabled: true });
  });

  it('forwards parsed request fields to execution.run.list deps', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.list', {
      sessionId: 'session_1',
      status: 'running',
      limit: 5,
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunList).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        sessionId: 'session_1',
        status: 'running',
        limit: 5,
      }),
      undefined,
    );
  });

  it('routes voice_agent.start to deps.executionRunStart', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('voice_agent.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'Start the voice agent run.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'streaming',
        intentInput: expect.objectContaining({
          backendTargetKey: 'agent:codex',
        }),
      }),
      undefined,
    );
  });

  it('routes agents.backends.list to deps.agentsBackendsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.backends.list', { includeDisabled: false, limit: 2 });
    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false, limit: 2 });
  });

  it('routes agents.models.list to deps.agentsModelsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', { agentId: 'claude', machineId: 'm1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({ agentId: 'claude', machineId: 'm1', limit: 3 });
  });

  it('routes configured ACP backendTargetKey through agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'customAcp',
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('rejects ambiguous customAcp agentId for agents.models.list without backendTargetKey', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'customAcp',
      machineId: 'm1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('routes session.spawn_picker to deps.sessionSpawnPicker', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_picker', { tag: 'x', initialMessage: 'hello' });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnPicker).toHaveBeenCalledWith({ tag: 'x', initialMessage: 'hello' });
  });

  it('opens a session by exact title when sessionId is omitted', async () => {
    const deps = createDeps();
    deps.sessionList = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ id: 's1', title: 'Wrong title' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        sessions: [{ id: 's2', title: 'Target Session' }],
        nextCursor: null,
      });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Target Session' });

    expect(res.ok).toBe(true);
    expect(deps.sessionOpen).toHaveBeenCalledWith({ sessionId: 's2' });
  });

  it('does not open a session when the requested title is ambiguous', async () => {
    const deps = createDeps();
    deps.sessionList = vi.fn(async () => ({
      sessions: [
        { id: 's1', title: 'Target Session' },
        { id: 's2', title: 'Target Session' },
      ],
      nextCursor: null,
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Target Session' });

    expect(res).toEqual({ ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' });
    expect(deps.sessionOpen).not.toHaveBeenCalled();
  });

  it('sets the primary target by exact title when sessionId is omitted', async () => {
    const deps = createDeps();
    deps.sessionList = vi.fn(async () => ({
      sessions: [{ id: 's2', title: 'Target Session' }],
      nextCursor: null,
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.target.primary.set', { sessionTitle: 'Target Session' });

    expect(res.ok).toBe(true);
    expect(deps.sessionTargetPrimarySet).toHaveBeenCalledWith({ sessionId: 's2' });
  });

  it('does not update the primary target when the requested title is ambiguous', async () => {
    const deps = createDeps();
    deps.sessionList = vi.fn(async () => ({
      sessions: [
        { id: 's1', title: 'Target Session' },
        { id: 's2', title: 'Target Session' },
      ],
      nextCursor: null,
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.target.primary.set', { sessionTitle: 'Target Session' });

    expect(res).toEqual({ ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' });
    expect(deps.sessionTargetPrimarySet).not.toHaveBeenCalled();
  });

  it('routes session.user_action.answer to deps.sessionUserActionAnswer', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_1',
      answers: [{ question: 'What next?', answer: 'Proceed' }],
    });
    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_1',
      answers: [{ question: 'What next?', answer: 'Proceed' }],
    });
  });

  it('routes session.user_action.answer decisions to deps.sessionUserActionAnswer', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_1',
      decision: 'request_changes',
      reason: 'Revise the plan before exiting plan mode.',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_1',
      decision: 'request_changes',
      reason: 'Revise the plan before exiting plan mode.',
      answers: [],
      updatedPermissions: undefined,
    });
  });

  it('searches enabled action specs through action.spec.search', async () => {
    const deps = createDeps();
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: (actionId) => actionId !== 'review.start',
    });

    const res = await executor.execute('action.spec.search', { query: '', limit: 50 }, { surface: 'voice_tool' });
    expect(res.ok).toBe(true);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'subagents.plan.start')).toBe(true);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'review.start')).toBe(false);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'session.mode.set')).toBe(true);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'workspaces.list_recent')).toBe(false);
  });

  it('filters action.spec.search by surfaced availability for the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.spec.search', { query: '', limit: 50 }, { surface: 'mcp' });
    expect(res.ok).toBe(true);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'session.mode.set')).toBe(true);
    expect((res as any).result.actionSpecs.some((spec: any) => spec.id === 'ui.voice_global.reset')).toBe(false);
  });

  it('routes ui.voice_agent.teleport to deps.teleportVoiceAgentToSessionRoot using the default session fallback', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('ui.voice_agent.teleport', {}, { defaultSessionId: 's1' });

    expect(res.ok).toBe(true);
    expect(deps.teleportVoiceAgentToSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('resolves action options for dynamic option sources through action.options.resolve', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.agentsBackendsList as any).mockResolvedValueOnce({
      items: [
        { id: 'codex', title: 'Codex' },
        { id: 'claude', title: 'Claude' },
      ],
    });

    const res = await executor.execute('action.options.resolve', {
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      sessionId: 's1',
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false, limit: undefined });
    expect((res as any).result).toEqual({
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      optionsSourceId: 'execution.backends.enabled',
      options: [
        { value: 'agent:codex', label: 'Codex' },
        { value: 'agent:claude', label: 'Claude' },
      ],
    });
  });

  it('filters resolved dynamic action options by query and limit', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.agentsBackendsList as any).mockResolvedValueOnce({
      items: [
        { id: 'codex', title: 'Codex' },
        { id: 'claude', title: 'Claude' },
        { id: 'cursor', title: 'Cursor' },
      ],
    });

    const res = await executor.execute('action.options.resolve', {
      optionsSourceId: 'execution.backends.enabled',
      query: 'cl',
      limit: 1,
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'execution.backends.enabled',
      options: [{ value: 'agent:claude', label: 'Claude' }],
    });
  });

  it('filters resolved static action options by query and limit', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.options.resolve', {
      actionId: 'session.user_action.answer',
      fieldPath: 'decision',
      query: 'req',
      limit: 1,
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: 'session.user_action.answer',
      fieldPath: 'decision',
      optionsSourceId: null,
      options: [{ value: 'request_changes', label: 'Request changes' }],
    });
  });

  it('uses a direct optionsSourceId fallback when actionId + fieldPath are also provided', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('action.options.resolve', {
      actionId: 'session.mode.set',
      fieldPath: 'modeId',
      optionsSourceId: 'session.modes.available',
      sessionId: 's1',
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: 'session.mode.set',
      fieldPath: 'modeId',
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    });
  });

  it('routes session.mode.set to deps.sessionModeSet', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'plan',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'plan' });
  });

  it('allows session.mode.set when the available modes list is empty', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'plan',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'plan' });
  });

  it('preserves default as a real mode id when the available modes literally include default', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'default',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'default' });
  });

  it('rejects session.mode.set when the requested mode is unavailable', async () => {
    const deps = createDeps();
    const executor = createActionExecutor({
      ...deps,
      sessionModesList: vi.fn(async () => ({
        items: [{ id: 'plan', label: 'Plan' }],
      })),
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'not-a-real-mode',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(deps.sessionModeSet).not.toHaveBeenCalled();
  });

  it('rejects action.spec.get for actions that are not surfaced on the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.spec.get', { id: 'ui.voice_global.reset' }, { surface: 'mcp' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
  });

  it('rejects action.spec.search when it is not surfaced on the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.spec.search', { query: '', limit: 5 }, { surface: 'cli' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
  });

  it('rejects executing actions that are not surfaced on the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('ui.voice_global.reset', {}, { surface: 'mcp' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
  });

  it('preserves allowlisted thrown error codes and messages when deps throw plain objects', async () => {
    const deps = createDeps();
    deps.sessionSendMessage = vi.fn(async () => {
      throw { code: 'session_not_found', message: 'Session was not found.' };
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.message.send', { sessionId: 's1', message: 'Hello' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'session_not_found',
      error: 'Session was not found.',
    });
  });
});
