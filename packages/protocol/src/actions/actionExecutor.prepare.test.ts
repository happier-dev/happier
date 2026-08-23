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
    sessionSpawnNew: vi.fn(async () => ({ sessionId: 'created-session' })),
    sessionSpawnPicker: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    agentsConfigOptionsList: vi.fn(async () => ({ items: [] })),
    agentsSessionModesList: vi.fn(async () => ({ items: [] })),
    sessionsSpawnProfilesList: vi.fn(async () => ({ items: [] })),
    sessionsSpawnConnectedServicesList: vi.fn(async () => ({ items: [] })),
    sessionsSpawnMcpServersPreview: vi.fn(async () => ({ ok: true, builtIn: [], managed: [], detected: [] })),
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

describe('ActionExecutor prepared invocation', () => {
  it('keeps approval-required deferred Actions under prepared invocation custody', async () => {
    const deps = createDeps();
    type ApprovalRequest = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'];
    let approve!: (value: { decision: 'approve'; request: ApprovalRequest }) => void;
    const decision = new Promise<{ decision: 'approve'; request: ApprovalRequest }>((resolve) => {
      approve = resolve;
    });
    deps.isActionApprovalRequired = () => true;
    deps.approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
    deps.approvalsGet = vi.fn(async () => null);
    deps.approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    deps.approvalsWaitForDecision = vi.fn(async () => await decision);
    const executor = createActionExecutor(deps);

    const preparing = executor.prepare('session.spawn_new', { agentId: 'codex' }, {
      surface: 'ui_button',
    });
    await vi.waitFor(() => expect(deps.approvalsCreate).toHaveBeenCalledOnce());
    const createdRequest = vi.mocked(deps.approvalsCreate).mock.calls[0]![0].request;
    expect(createdRequest.approval).toEqual({ flow: 'blocking', result: 'optional' });
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();

    approve({
      decision: 'approve',
      request: {
        ...createdRequest,
        status: 'approved',
        updatedAtMs: createdRequest.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: createdRequest.updatedAtMs + 1 },
      },
    });
    const prepared = await preparing;
    expect(prepared.kind).toBe('ready');
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected approval-admitted invocation');

    await expect(prepared.invocation.run()).resolves.toEqual({
      ok: true,
      result: { sessionId: 'created-session' },
    });
    expect(deps.sessionSpawnNew).toHaveBeenCalledOnce();
  });

  it('settles an admission failure without invoking the action dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const prepared = await executor.prepare('session.spawn_new', {
      daemonInternalField: 'must-not-pass-admission',
    });

    expect(prepared).toEqual({
      kind: 'settled',
      result: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
    });
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('does not mutate before run and dispatches a prepared invocation exactly once', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const prepared = await executor.prepare('session.spawn_new', { agentId: 'codex' }, {
      surface: 'ui_button',
      actionRequestId: 'request-1',
    });

    expect(prepared.kind).toBe('ready');
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    const secondRun = prepared.invocation.run();
    expect(secondRun).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessionId: 'created-session' },
    });
    await expect(prepared.invocation.run()).resolves.toEqual({
      ok: true,
      result: { sessionId: 'created-session' },
    });

    expect(deps.sessionSpawnNew).toHaveBeenCalledTimes(1);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      surface: 'ui_button',
      actionRequestId: 'request-1',
    }));
  });

  it('keeps execute as the same terminal convenience contract', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    await expect(executor.execute('session.spawn_new', { agentId: 'codex' }, {
      surface: 'ui_button',
    })).resolves.toEqual({
      ok: true,
      result: { sessionId: 'created-session' },
    });
    expect(deps.sessionSpawnNew).toHaveBeenCalledTimes(1);
  });

  it('preserves the complete ordinary spawn recipe through prepare and dispatches it exactly once', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const spawnInput = {
      machineId: 'machine-1',
      directory: '/repo',
      approvedNewDirectoryCreation: true,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
      profileId: 'profile-1',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      resume: 'vendor-session-1',
      spawnNonce: 'spawn-nonce-1',
      userAttemptId: 'user-attempt-1',
      firstTurnLocalId: 'first-turn-1',
      attachmentMessageLocalId: 'attachment-message-1',
      pendingFirstInput: {
        text: 'Inspect this repository.',
        localId: 'first-turn-1',
        meta: { source: 'new-session' },
      },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 1_000,
      agentModeId: 'plan',
      agentModeUpdatedAt: 1_001,
      modelId: 'gpt-5',
      modelUpdatedAt: 1_002,
      sessionConfigOptionOverrides: {
        v: 1 as const,
        updatedAt: 1_003,
        overrides: { reasoning_effort: { updatedAt: 1_003, value: 'high' } },
      },
      experimentalCodexAcp: false,
      codexBackendMode: 'appServer' as const,
      agentRuntimeDescriptorV1: {
        v: 1 as const,
        providerId: 'codex' as const,
        provider: { backendMode: 'appServer' as const },
      },
      terminal: {
        mode: 'tmux' as const,
        tmux: { sessionName: 'spawn-session', isolated: true, tmpDir: null },
      },
      windowsRemoteSessionLaunchMode: 'hidden' as const,
      windowsRemoteSessionConsole: 'hidden' as const,
      windowsTerminalWindowName: 'Happier',
      connectedServices: {
        v: 1 as const,
        bindingsByServiceId: {
          github: { source: 'connected' as const, selection: 'profile' as const, profileId: 'default' },
        },
      },
      connectedServicesUpdatedAt: 1_004,
      mcpSelection: {
        v: 1 as const,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: [],
      },
      transcriptStorage: 'persisted' as const,
      sourceContext: {
        v: 1 as const,
        kind: 'session_replay' as const,
        sourceSessionId: 'source-session',
        forkPoint: { type: 'seq' as const, upToSeqInclusive: 42 },
      },
    };

    const prepared = await executor.prepare('session.spawn_new', spawnInput, {
      surface: 'ui_button',
      actionRequestId: 'tracked-correlation-1',
    });

    expect(prepared.kind).toBe('ready');
    expect(deps.sessionSpawnNew).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const controller = new AbortController();
    const firstRun = prepared.invocation.run({ signal: controller.signal });
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessionId: 'created-session' },
    });
    expect(deps.sessionSpawnNew).toHaveBeenCalledOnce();
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({
      ...spawnInput,
      surface: 'ui_button',
      actionRequestId: 'tracked-correlation-1',
      signal: controller.signal,
    });
  });

  it('preserves the canonical fork recipe through prepare and dispatches it exactly once', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const forkInput = {
      sessionId: 'parent-session',
      forkPoint: { type: 'seq' as const, upToSeqInclusive: 42 },
      strategy: 'replay' as const,
      replaySummaryRunner: {
        v: 1 as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools' as const,
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
    };

    const prepared = await executor.prepare('session.fork', forkInput, {
      serverId: 'server-1',
      actionRequestId: 'context-request-must-not-override-explicit',
    });

    expect(prepared.kind).toBe('ready');
    expect(deps.sessionFork).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const controller = new AbortController();
    const firstRun = prepared.invocation.run({ signal: controller.signal });
    const secondRun = prepared.invocation.run();
    expect(secondRun).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({ ok: true, result: {} });

    expect(deps.sessionFork).toHaveBeenCalledTimes(1);
    expect(deps.sessionFork).toHaveBeenCalledWith({
      ...forkInput,
      serverId: 'server-1',
      signal: controller.signal,
    });
  });

  it('keeps the legacy fork execute input compatible', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    await expect(executor.execute('session.fork', { sessionId: 'parent-session' })).resolves.toEqual({
      ok: true,
      result: {},
    });
    expect(deps.sessionFork).toHaveBeenCalledOnce();
    expect(deps.sessionFork).toHaveBeenCalledWith({ sessionId: 'parent-session' });
  });

  it('preserves acknowledged AbortError cancellation through the prepared owner boundary', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async ({ signal }) => await new Promise((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error('cancelled by operation owner');
        error.name = 'AbortError';
        reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
    const executor = createActionExecutor(deps);
    const prepared = await executor.prepare('session.spawn_new', { agentId: 'codex' });
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    const controller = new AbortController();

    const running = prepared.invocation.run({ signal: controller.signal });
    await vi.waitFor(() => expect(deps.sessionSpawnNew).toHaveBeenCalledOnce());
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the normalized action request identity when fork input has no explicit request id', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const prepared = await executor.prepare('session.fork', {
      sessionId: 'parent-session',
      forkPoint: { type: 'latest' },
    }, {
      actionRequestId: ' tracked-fork-request-1\n',
    });

    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    await expect(prepared.invocation.run()).resolves.toEqual({ ok: true, result: {} });
    expect(deps.sessionFork).toHaveBeenCalledOnce();
    expect(deps.sessionFork).toHaveBeenCalledWith({
      sessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      requestId: 'tracked-fork-request-1',
    });
  });
});
