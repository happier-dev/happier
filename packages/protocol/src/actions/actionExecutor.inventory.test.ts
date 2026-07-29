import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { SPAWN_SESSION_ERROR_CODES } from '../sessions/spawnSession.js';

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
    agentsConfigOptionsList: vi.fn(async () => ({ items: [] })),
    agentsSessionModesList: vi.fn(async () => ({ items: [] })),
    spawnProfilesList: vi.fn(async () => ({ items: [] })),
    spawnConnectedServicesList: vi.fn(async () => ({ items: [] })),
    spawnMcpServersPreview: vi.fn(async () => ({ items: [] })),

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
  it('rejects agent subagents.delegate.start default workspace_write above a default caller', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
    }, { surface: 'agent', defaultSessionId: 'session_1' });

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
    }));
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  });

  it('rejects agent execution.run.start above the caller permission ordinal', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.start', {
      sessionId: 'session_1',
      intent: 'delegate',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Run this task.',
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'agent', defaultSessionId: 'session_1' });

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
    }));
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  });

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

  it('threads per-target connectedServices selections through delegate fanout starts', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const codexSelection = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
      },
    };

    const res = await executor.execute('subagents.delegate.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex', 'agent:claude'],
      instructions: 'Delegate this task.',
      connectedServicesByBackendTargetKey: {
        'agent:codex': codexSelection,
      },
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: expect.objectContaining({
          bindingsByServiceId: expect.objectContaining({
            'openai-codex': expect.objectContaining({ profileId: 'profile_1' }),
          }),
        }),
      }),
      undefined,
    );
    const claudeCall = (deps.executionRunStart as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => (call[1] as { backendTarget?: { agentId?: string } }).backendTarget?.agentId === 'claude');
    expect(claudeCall?.[1]).not.toHaveProperty('connectedServices');
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

  it('executes subagent starts with V2 backend target keys returned by backend inventory', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({
      ok: true,
      data: {
        runId: 'run_1',
      },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.plan.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['backend:codex', 'backend:review-bot:configured:review-bot'],
      instructions: 'Plan this task.',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenNthCalledWith(
      1,
      'session_1',
      expect.objectContaining({
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        intentInput: expect.objectContaining({
          backendTargetKey: 'backend:codex',
        }),
      }),
      undefined,
    );
    expect(deps.executionRunStart).toHaveBeenNthCalledWith(
      2,
      'session_1',
      expect.objectContaining({
        intent: 'plan',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        intentInput: expect.objectContaining({
          backendTargetKey: 'backend:review-bot:configured:review-bot',
        }),
      }),
      undefined,
    );
  });

  it('preserves failed execution-run service envelope codes and messages in fanout results', async () => {
    const deps = createDeps();
    deps.reviewEnginesList = vi.fn(async () => ({
      items: [{ value: 'coderabbit', label: 'CodeRabbit' }],
    }));
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

  it('forwards rich dev spawn fields to session.spawn_new', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'codex',
      agent: {
        agentExtra: {
          owner: 'happier',
          schemaId: 'codex-runtime',
          v: 1,
        },
        backendMode: 'appServer',
      },
    } as const;
    const mcpSelection = {
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } as const;
    const sessionConfigOptionOverrides = {
      v: 1,
      updatedAt: 1710000000000,
      overrides: {
        reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
      },
    } as const;
    const configOptions = { ultracode: true } as const;

    const res = await executor.execute('session.spawn_new', {
      directory: '/repo/project',
      backendTargetKey: 'backend:codex',
      initialPrompt: 'Inspect this workspace.',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      sessionConfigOptionOverrides,
      configOptions,
      profileId: 'codex-profile',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      mcpSelection,
      transcriptStorage: 'persisted',
      runtimeDescriptorV1,
      terminal: { mode: 'tmux' },
      windowsTerminalWindowName: 'Happier Test',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo/project',
      backendTargetKey: 'backend:codex',
      initialMessage: 'Inspect this workspace.',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      sessionConfigOptionOverrides,
      configOptions,
      profileId: 'codex-profile',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        ...mcpSelection,
      },
      transcriptStorage: 'persisted',
      runtimeDescriptorV1,
      terminal: { mode: 'tmux' },
      windowsTerminalWindowName: 'Happier Test',
    }));
  });

  it('preserves protocol-owned spawn error codes thrown by action dependencies', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => {
      const error = new Error('Provider preflight failed before spawning.');
      (error as Error & { code: string }).code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
      throw error;
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      backendTargetKey: 'agent:ohMyPi',
      path: '/repo/project',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Provider preflight failed before spawning.',
    });
  });

  it('prefers protocol-owned errorCode over generic thrown code fields', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => {
      const error = new Error('Provider preflight failed before spawning.');
      (error as Error & { code: string; errorCode: string }).code = 'ERR_BAD_RESPONSE';
      (error as Error & { code: string; errorCode: string }).errorCode = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
      throw error;
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      backendTargetKey: 'agent:ohMyPi',
      path: '/repo/project',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Provider preflight failed before spawning.',
    });
  });

  it('treats returned spawn-result errors as failed action results', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'OhMyPi has no chat-capable models.',
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      backendTargetKey: 'agent:ohMyPi',
      path: '/repo/project',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'OhMyPi has no chat-capable models.',
    });
  });

  it('treats returned spawn-shaped local validation errors as failed action results', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: 'host_not_found',
      errorMessage: 'host_not_found',
      host: 'other-host',
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      host: 'other-host',
      initialMessage: 'Hello',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'host_not_found',
      error: 'host_not_found',
    });
  });

  it('requires an explicit runtime carrier when spawning a canonical plugin backend session', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      backendTargetKey: 'backend:plugin-review-bot',
      path: '/repo/project',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();
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

    const res = await executor.execute('agents.backends.list', { includeDisabled: false, limit: 2, machineId: 'm1' });
    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false, limit: 2, machineId: 'm1' });
  });

  it('routes agents.models.list to deps.agentsModelsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', { agentId: 'claude', machineId: 'm1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({ agentId: 'claude', machineId: 'm1', limit: 3 });
  });

  it('routes agents.config_options.list to deps.agentsConfigOptionsList', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsConfigOptionsList: ReturnType<typeof vi.fn>;
    };
    deps.agentsConfigOptionsList.mockResolvedValueOnce({
      items: [{ id: 'reasoning_effort', label: 'Thinking', type: 'select' }],
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.config_options.list' as any, {
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      modelId: 'claude-opus-4-8',
      limit: 5,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsConfigOptionsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      modelId: 'claude-opus-4-8',
      limit: 5,
    });
    expect((res as any).result.items).toEqual([
      { id: 'reasoning_effort', label: 'Thinking', type: 'select' },
    ]);
  });

  it('routes agents.session_modes.list to deps.agentsSessionModesList', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsSessionModesList: ReturnType<typeof vi.fn>;
    };
    deps.agentsSessionModesList.mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.session_modes.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 5,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsSessionModesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 5,
    });
    expect((res as any).result.items).toEqual([{ id: 'plan', label: 'Plan' }]);
  });

  it('routes spawn option inventory actions through their matching deps', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      spawnProfilesList: ReturnType<typeof vi.fn>;
      spawnConnectedServicesList: ReturnType<typeof vi.fn>;
      spawnMcpServersPreview: ReturnType<typeof vi.fn>;
    };
    deps.spawnProfilesList.mockResolvedValueOnce({
      items: [{ id: 'default', label: 'Default', builtIn: true }],
    });
    deps.spawnConnectedServicesList.mockResolvedValueOnce({
      items: [{ serviceId: 'openai', label: 'OpenAI', profiles: [] }],
    });
    deps.spawnMcpServersPreview.mockResolvedValueOnce({
      items: [{ id: 'managed:repo', label: 'Repo MCP', selected: true }],
    });
    const executor = createActionExecutor(deps);

    await expect(executor.execute('sessions.spawn.profiles.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      limit: 10,
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnProfilesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      limit: 10,
    });

    await expect(executor.execute('sessions.spawn.connected_services.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      includeUnavailable: true,
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnConnectedServicesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      includeUnavailable: true,
    });

    await expect(executor.execute('sessions.spawn.mcp_servers.preview' as any, {
      agentId: 'codex',
      machineId: 'm1',
      directory: '/repo',
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnMcpServersPreview).toHaveBeenCalledWith({
      agentId: 'codex',
      machineId: 'm1',
      directory: '/repo',
    });
  });

  it('preserves canonical built-in backendTargetKey values through agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 2,
    });
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
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('does not forward legacy configured ACP agentId carriers when backendTargetKey is configured', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'acp:review-bot',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('routes configured ACP backendTargetKey through session.spawn_new without synthesizing customAcp', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', {
      backendTargetKey: 'acpBackend:review-bot',
      path: '/repo/project',
      tag: 'review',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({
      backendTargetKey: 'acpBackend:review-bot',
      path: '/repo/project',
      tag: 'review',
    });
  });

  it('routes canonical plugin backendTargetKey plus runtime carrier through agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
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

  it('rejects agent:customAcp as a concrete backend target for agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'agent:customAcp',
      machineId: 'm1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('routes session.spawn_picker to deps.sessionSpawnPicker', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_picker', {
      tag: 'x',
      initialMessage: 'hello',
      backendTargetKey: 'acpBackend:review-bot',
    });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnPicker).toHaveBeenCalledWith({
      tag: 'x',
      initialMessage: 'hello',
      backendTargetKey: 'acpBackend:review-bot',
    });
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

  it('passes the resolved server scope when opening a session', async () => {
    const deps = createDeps();
    deps.resolveServerIdForSessionId = vi.fn(() => 'server-b');
    const executor = createActionExecutor(deps);

    const res = await executor.execute(
      'session.open',
      { sessionId: 's2' },
      { serverId: 'server-a' },
    );

    expect(res.ok).toBe(true);
    expect(deps.resolveServerIdForSessionId).not.toHaveBeenCalled();
    expect(deps.sessionOpen).toHaveBeenCalledWith({ sessionId: 's2', serverId: 'server-a' });
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
      answers: [{
        question: 'Where should this run?',
        values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
      }],
    });
    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_1',
      answers: [{
        question: 'Where should this run?',
        values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
      }],
    });
  });

  it('normalizes the released scalar session.user_action.answer shape at the ActionSpec boundary', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_legacy',
      answers: [{ question: 'What next?', answer: 'Proceed' }],
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_legacy',
      answers: [{ question: 'What next?', values: ['Proceed'] }],
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

    const res = await executor.execute('action.spec.search', { query: '', limit: 50 }, { surface: 'voice' });
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
        { targetKey: 'backend:codex', title: 'Codex' },
        { targetKey: 'backend:review-bot:configured:review-bot', title: 'Review Bot' },
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
        { value: 'backend:codex', label: 'Codex' },
        { value: 'backend:review-bot:configured:review-bot', label: 'Review Bot' },
      ],
    });
  });

  it('resolves spawn dynamic option sources through the same deps as their list actions', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsConfigOptionsList: ReturnType<typeof vi.fn>;
      agentsSessionModesList: ReturnType<typeof vi.fn>;
      spawnProfilesList: ReturnType<typeof vi.fn>;
      spawnConnectedServicesList: ReturnType<typeof vi.fn>;
      spawnMcpServersPreview: ReturnType<typeof vi.fn>;
    };
    deps.agentsModelsList.mockResolvedValueOnce({
      items: [{ id: 'claude-opus-4-8', label: 'Claude Opus' }],
    });
    deps.agentsSessionModesList.mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });
    deps.agentsConfigOptionsList.mockResolvedValueOnce({
      items: [{ id: 'reasoning_effort', label: 'Thinking' }],
    });
    deps.pathsListRecent.mockResolvedValueOnce({
      items: [{ path: '/repo', label: 'Repo' }],
    });
    deps.machinesList.mockResolvedValueOnce({
      items: [{ id: 'm1', label: 'Laptop' }],
    });
    deps.serversList.mockResolvedValueOnce({
      items: [{ id: 'local', label: 'Local' }],
    });
    deps.spawnProfilesList.mockResolvedValueOnce({
      items: [{ id: 'profile-default', label: 'Default profile' }],
    });
    deps.spawnConnectedServicesList.mockResolvedValueOnce({
      items: [{ id: 'openai:work', label: 'OpenAI work' }],
    });
    deps.spawnMcpServersPreview.mockResolvedValueOnce({
      items: [{ id: 'managed:repo', label: 'Repo MCP' }],
    });
    const executor = createActionExecutor(deps);

    const cases = [
      ['agents.models.available', 'modelId', [{ value: 'claude-opus-4-8', label: 'Claude Opus' }]],
      ['agents.session_modes.available', 'agentModeId', [{ value: 'plan', label: 'Plan' }]],
      ['agents.config_options.available', 'sessionConfigOptionOverrides', [{ value: 'reasoning_effort', label: 'Thinking' }]],
      ['sessions.spawn.paths.recent', 'path', [{ value: '/repo', label: 'Repo' }]],
      ['sessions.spawn.machines.available', 'machineId', [{ value: 'm1', label: 'Laptop' }]],
      ['sessions.spawn.servers.available', 'serverId', [{ value: 'local', label: 'Local' }]],
      ['sessions.spawn.profiles.available', 'profileId', [{ value: 'profile-default', label: 'Default profile' }]],
      ['sessions.spawn.connected_services.available', 'connectedServices', [{ value: 'openai:work', label: 'OpenAI work' }]],
      ['sessions.spawn.mcp_servers.preview', 'mcpSelection', [{ value: 'managed:repo', label: 'Repo MCP' }]],
    ] as const;

    for (const [optionsSourceId, fieldPath, options] of cases) {
      const res = await executor.execute('action.options.resolve', {
        actionId: 'session.spawn_new',
        fieldPath,
        optionsSourceId,
        agentId: 'claude',
        backendTargetKey: 'backend:claude',
        machineId: 'm1',
        directory: '/repo',
        limit: 10,
      });
      expect(res).toEqual({
        ok: true,
        result: {
          actionId: 'session.spawn_new',
          fieldPath,
          optionsSourceId,
          options,
        },
      });
    }
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
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'mcp',
        reason: 'unsupported_surface',
      }),
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
      details: expect.objectContaining({
        actionId: 'action.spec.search',
        surface: 'cli',
        reason: 'unsupported_surface',
      }),
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
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'mcp',
        reason: 'unsupported_surface',
      }),
    });
  });

  it('rejects executing actions disabled by settings with structured settings details', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute(
      'session.message.send',
      { sessionId: 's1', message: 'Hello' },
      {
        surface: 'agent',
        actionsSettings: {
          v: 1,
          actions: {
            'session.message.send': {
              disabledSurfaces: ['agent'],
            },
          },
        },
      } as any,
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'session.message.send',
        surface: 'agent',
        reason: 'disabled_by_settings',
        settingsState: 'disabled',
      }),
    });
    expect(deps.sessionSendMessage).not.toHaveBeenCalled();
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
