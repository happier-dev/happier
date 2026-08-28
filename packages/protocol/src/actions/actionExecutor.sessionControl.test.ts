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

const canonicalSessionSpawnInput = {
  creationKey: 'session-control-spawn',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/repo',
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('createActionExecutor (session control)', () => {
  it('executes session.message.send via deps.sessionSendMessage (including optional overrides)', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });
    const cancellation = new AbortController();

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        message: 'Hello',
        permissionModeOverride: 'read_only',
        modelOverride: 'gpt-4o',
        providerConnectionId: 'pc_work',
        requestedAction: { v: 1, kind: 'send_now' },
        localId: 'caller-retained-1',
        wait: true,
        timeoutSeconds: 42,
      },
      { surface: 'cli', defaultSessionId: null, signal: cancellation.signal },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'Hello',
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
      providerConnectionId: 'pc_work',
      requestedAction: { v: 1, kind: 'send_now' },
      localId: 'caller-retained-1',
      wait: true,
      timeoutSeconds: 42,
      signal: cancellation.signal,
    }));
  });

  it('defaults generic session.message.send to settings-aware steering intent', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Continue' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
  });

  it('turns plugin subagent-launch intent into the canonical structured send and stamps immediate delivery', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'plugin-input-v1:launch' }));
    const executor = createExecutor({ sessionSendMessage });
    const actionCaller = {
      kind: 'plugin' as const,
      pluginId: 'acme.agent',
      contributionLocalId: 'launch-teammate',
    };

    const result = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        kind: 'sessionSubagentLaunch',
        launch: {
          kind: 'agent_team_create',
          teamId: 'reviewers',
          description: 'Review the current change.',
        },
        idempotencyKey: 'launch-reviewers',
      },
      { surface: 'plugin', actionCaller },
    );

    expect(result).toEqual({
      ok: true,
      result: { status: 'accepted', localId: 'plugin-input-v1:launch' },
    });

    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'Create team reviewers',
      displayText: 'Create team reviewers',
      messageMeta: {
        happier: {
          kind: 'subagent_launch.v1',
          payload: {
            kind: 'agent_team_create',
            teamId: 'reviewers',
            description: 'Review the current change.',
          },
        },
      },
      requestedAction: { v: 1, kind: 'send_now' },
      actionCaller,
    }));
  });

  it('forwards host-stamped plugin caller and bounded source intent without accepting caller identity fields', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'plugin-input-v1:test' }));
    const executor = createExecutor({ sessionSendMessage });
    const actionCaller = {
      kind: 'plugin' as const,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
    };

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        message: 'Hello',
        idempotencyKey: 'message-42',
        source: {
          sourceRef: 'channel-7',
          sourceRevisionOrEpoch: 'message-42',
          remoteApprovalMaxScope: 'request',
          requestedPermissionCeiling: 'read-only',
          externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
          contentProvenance: 'forwarded',
        },
      },
      { surface: 'plugin', actionCaller },
    );

    expect(res).toEqual({
      ok: true,
      result: { status: 'accepted', localId: 'plugin-input-v1:test' },
    });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      actionCaller,
      callerSurface: 'plugin',
      idempotencyKey: 'message-42',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
        externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded',
      },
    }));
  });

  it('forwards declared attachment drafts only for a plugin caller', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'plugin-input-v1:test' }));
    const executor = createExecutor({ sessionSendMessage });
    const actionCaller = {
      kind: 'plugin' as const,
      pluginId: 'happier.triage',
      contributionLocalId: 'entries',
    };
    const attachments = [{
      attachmentLocalId: 'entry',
      value: {
        key: 'github:pull:42',
        value: { sourceId: 'github', entryId: '42' },
        presentation: { label: 'PR #42' },
      },
    }];

    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Fix it', idempotencyKey: 'message-42', attachments },
      { surface: 'plugin', actionCaller },
    );
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      actionCaller,
      attachments,
    }));

    // Only a plugin caller has a declared attachment the host can qualify. A
    // generic caller supplying the field is refused rather than silently
    // dropped, so a mis-routed send never sends its text with no context.
    sessionSendMessage.mockClear();
    await expect(executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Fix it', attachments },
      { surface: 'cli', defaultSessionId: null },
    )).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('never lets a plugin caller retain its own durable input identity', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'plugin-input-v1:test' }));
    const executor = createExecutor({ sessionSendMessage });
    const actionCaller = {
      kind: 'plugin' as const,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
    };

    // The strict plugin surface binding refuses the field outright.
    await expect(executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', idempotencyKey: 'message-42', localId: 'forged-1' },
      { surface: 'plugin', actionCaller },
    )).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(sessionSendMessage).not.toHaveBeenCalled();

    // A plugin caller reaching the generic input schema through another surface
    // still gets a host-derived identity: its localId is dropped, not forwarded.
    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', idempotencyKey: 'message-42', localId: 'forged-1' },
      { surface: 'agent', actionCaller },
    );
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    expect(sessionSendMessage.mock.calls[0]?.[0]).not.toHaveProperty('localId');
  });

  it('refuses a Provider connection selection that carries no model instead of discarding it', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'local-1' }));
    const executor = createExecutor({ sessionSendMessage });

    // `null` is the explicit Agent-native source. A connection is only ever
    // applied together with the model it sources, so without a model id the
    // send path has nothing to apply it to and would drop it silently.
    await expect(executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', providerConnectionId: null },
      { surface: 'cli', defaultSessionId: null },
    )).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(sessionSendMessage).not.toHaveBeenCalled();

    // The same native source with a model id — concrete or the reset sentinel
    // — is still accepted and still reaches the send path.
    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', providerConnectionId: null, modelOverride: 'sonnet' },
      { surface: 'cli', defaultSessionId: null },
    );
    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', providerConnectionId: null, modelOverride: null },
      { surface: 'cli', defaultSessionId: null },
    );
    expect(sessionSendMessage).toHaveBeenCalledTimes(2);
    expect(sessionSendMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      providerConnectionId: null,
      modelOverride: 'sonnet',
    }));
    expect(sessionSendMessage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      providerConnectionId: null,
      modelOverride: null,
    }));
  });

  it('rejects plugin Session permission overrides before admission can persist them', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'unexpected' }));
    const executor = createExecutor({ sessionSendMessage });

    await expect(executor.execute(
      'session.message.send',
      {
        sessionId: 's1',
        message: 'Forward this',
        idempotencyKey: 'message-42',
        permissionModeOverride: 'yolo',
      },
      {
        surface: 'plugin',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
        },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('projects a thrown plugin Session admission dispatch into a strict outcome-unknown result', async () => {
    const sessionSendMessage = vi.fn(async () => {
      throw new Error('Session admission response channel closed after dispatch');
    });
    const executor = createExecutor({ sessionSendMessage });

    await expect(executor.execute(
      'session.message.send',
      {
        sessionId: 's1',
        message: 'Hello',
        idempotencyKey: 'message-42',
      },
      {
        surface: 'plugin',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
        },
      },
    )).resolves.toEqual({
      ok: true,
      result: {
        status: 'outcomeUnknown',
        localId: 'plugin-input-v1:39j_qcTWrVcq__rGFFM0w0Qlbv2PLRf6Iq32ot1bYcY',
        code: 'session_input_action_execution_failed',
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledOnce();
  });

  it('keeps a plugin Session message failure before dispatch generic and does not fabricate admission identity', async () => {
    const approvalsCreate = vi.fn(async () => {
      throw new Error('Approval store unavailable');
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'unexpected' }));
    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId) => actionId === 'session.message.send',
    });

    const result = await executor.execute(
      'session.message.send',
      {
        sessionId: 's1',
        message: 'Hello',
        idempotencyKey: 'message-42',
      },
      {
        surface: 'plugin',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
        },
      },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'action_failed' });
    expect(result).not.toHaveProperty('result');
    expect(approvalsCreate).toHaveBeenCalledOnce();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('rejects plugin message sends without attributable contribution idempotency', async () => {
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted', localId: 'unexpected' }));
    const executor = createExecutor({ sessionSendMessage });

    await expect(executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello' },
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.channels' },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('clamps an agent message without an explicit override to the caller permission', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 'higher-privilege-session',
        message: 'Continue',
      },
      { surface: 'agent', defaultSessionId: 'caller', callerPermissionMode: 'read-only' } as any,
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      permissionModeOverride: 'read-only',
      callerSurface: 'agent',
      callerPermissionMode: 'read-only',
    }));
  });

  it('rejects provider identity without a concrete model override', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        message: 'Hello',
        providerConnectionId: 'pc_work',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('preserves message from session.message.send failure envelopes', async () => {
    const sessionSendMessage = vi.fn(async () => ({
      ok: false,
      errorCode: 'session_inactive',
      error: 'session_inactive',
      message: 'Session is inactive. Resume it before sending a message.',
    }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'session_inactive',
      error: 'Session is inactive. Resume it before sending a message.',
    });
  });

  it('executes session.title.set via deps.sessionTitleSet', async () => {
    const sessionTitleSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTitleSet });

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 's1', title: 'New title' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 's1', title: 'New title' });
  });

  it('executes session.stop via deps.sessionStop', async () => {
    const sessionStop = vi.fn(async () => ({ ok: true, stopped: true }));
    const executor = createExecutor({
      sessionStop,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true, stopped: true } });
    expect(sessionStop).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
  });

  it('preserves structured session.stop outcomes as top-level action success', async () => {
    const dependencyResult = {
      ok: true as const,
      sessionId: 's1',
      stopped: false as const,
      stopOutcome: {
        status: 'stopped_cleanup_incomplete' as const,
        reason: 'terminal_attachment_descriptor_retirement_failed' as const,
      },
    };
    const sessionStop = vi.fn(async () => dependencyResult);
    const executor = createExecutor({ sessionStop });

    const result = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({ ok: true, result: dependencyResult });
  });

  it('executes session.terminalComposer.clear via deps.sessionTerminalComposerClear', async () => {
    const sessionTerminalComposerClear = vi.fn(async () => ({
      ok: true,
      status: 'cleared',
      sessionId: 's1',
    }));
    const executor = createExecutor({
      sessionTerminalComposerClear,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as Partial<ActionExecutorDeps>);

    const res = await executor.execute(
      'session.terminalComposer.clear' as any,
      { sessionId: 's1', expectedStateAtMs: 42 },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'cleared',
        sessionId: 's1',
      },
    });
    expect(sessionTerminalComposerClear).toHaveBeenCalledWith({
      sessionId: 's1',
      expectedStateAtMs: 42,
      serverId: 'server-a',
    });
  });

  it('fails closed when session.terminalComposer.clear is unsupported by the executor deps', async () => {
    const executor = createExecutor();

    await expect(executor.execute(
      'session.terminalComposer.clear' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.terminalComposer.clear',
    });
  });

  it('executes session.permission_mode.set via deps.sessionPermissionModeSet', async () => {
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionPermissionModeSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.permission_mode.set' as any,
      { sessionId: 's1', permissionMode: 'read_only' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionPermissionModeSet).toHaveBeenCalledWith({
      sessionId: 's1',
      permissionMode: 'read_only',
      serverId: 'server-a',
    });
  });

  it('executes session.model.set via deps.sessionModelSet', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionModelSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: 'default' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({ sessionId: 's1', modelId: 'default', serverId: 'server-a' });
  });

  it('preserves provider connection identity through session.model.set', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionModelSet });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: 'model-a', providerConnectionId: 'pc_work' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({
      sessionId: 's1',
      modelId: 'model-a',
      providerConnectionId: 'pc_work',
    });
  });

  it('preserves a literal provider model id named default', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionModelSet });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: 'default', providerConnectionId: 'pc_work' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({
      sessionId: 's1',
      modelId: 'default',
      providerConnectionId: 'pc_work',
    });
  });

  it('executes session.archive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionArchiveSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.archive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: true, serverId: 'server-a' });
  });

  it('executes session.unarchive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionArchiveSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.unarchive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: false, serverId: 'server-a' });
  });

  it('executes session.status.get via deps.sessionStatusGet', async () => {
    const sessionStatusGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionStatusGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.status.get' as any,
      { sessionId: 's1', live: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionStatusGet).toHaveBeenCalledWith({ sessionId: 's1', live: true, serverId: 'server-a' });
  });

  it('routes deprecated session.history.get to deps.sessionEventsGet', async () => {
    const sessionEventsGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionEventsGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.history.get' as any,
      { sessionId: 's1', limit: 25, format: 'compact', includeMeta: false, includeStructuredPayload: false },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionEventsGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      format: 'compact',
      includeMeta: false,
      includeStructuredPayload: false,
      serverId: 'server-a',
    });
  });

  it('executes session.transcript.get via deps.sessionTranscriptGet', async () => {
    const transcriptResult = {
      ok: true,
      sessionId: 's1',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: {
        rawRowsScanned: 0,
        pagesFetched: 0,
        scanLimitReached: false,
        payloadTruncations: 0,
      },
    } as const;
    const sessionTranscriptGet = vi.fn(async () => transcriptResult);
    const executor = createExecutor({
      sessionTranscriptGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as any);

    const res = await executor.execute(
      'session.transcript.get' as any,
      { sessionId: 's1', limit: 25, roles: ['user', 'assistant'], includeTools: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: transcriptResult });
    expect(sessionTranscriptGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      roles: ['user', 'assistant'],
      includeTools: true,
      serverId: 'server-a',
    });
  });

  it('forwards cancellation to session.transcript.get before the dependency begins its read', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTranscriptGet } as any);
    const cancellation = new AbortController();

    await executor.execute(
      'session.transcript.get' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null, signal: cancellation.signal },
    );

    expect(sessionTranscriptGet).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      signal: cancellation.signal,
    }));
  });

  it('host-stamps the plugin caller for the external shareable transcript projection', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTranscriptGet } as any);

    await executor.execute(
      'session.transcript.get' as any,
      { sessionId: 's1', projection: 'externalShareableV1', cursor: '7' },
      {
        surface: 'plugin',
        defaultSessionId: null,
        actionCaller: { kind: 'plugin', pluginId: 'com.example.channel' },
      },
    );

    expect(sessionTranscriptGet).toHaveBeenCalledWith({
      sessionId: 's1',
      projection: 'externalShareableV1',
      cursor: '7',
      callerPluginId: 'com.example.channel',
    });
  });

  it('keeps Plugin transcript reads on the external-shareable input contract', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTranscriptGet } as any);
    const pluginContext = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.channels', contributionLocalId: 'inbound' },
    };

    await expect(executor.execute(
      'session.transcript.get',
      { sessionId: 's1', includeRaw: true },
      pluginContext,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionTranscriptGet).not.toHaveBeenCalled();
  });

  it('routes other public Session reads and permission-mode control for plugin callers', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const sessionEventsGet = vi.fn(async () => ({ ok: true }));
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionTranscriptGet,
      sessionEventsGet,
      sessionPermissionModeSet,
    } as any);
    const pluginContext = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.channels', contributionLocalId: 'inbound' },
    };

    for (const [actionId, input] of [
      ['session.history.get', { sessionId: 's1', format: 'raw' }],
      ['session.events.get', { sessionId: 's1', includeRaw: true }],
      ['session.messages.recent.get', { sessionId: 's1', limit: 1 }],
      ['session.permission_mode.set', { sessionId: 's1', permissionMode: 'yolo' }],
    ] as const) {
      await expect(executor.execute(actionId, input, pluginContext)).resolves.toEqual({
        ok: true,
        result: { ok: true },
      });
    }

    expect(sessionTranscriptGet).toHaveBeenCalledTimes(1);
    expect(sessionEventsGet).toHaveBeenCalledTimes(2);
    expect(sessionPermissionModeSet).toHaveBeenCalledTimes(1);
  });

  it('executes session.events.get via deps.sessionEventsGet', async () => {
    const sessionEventsGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionEventsGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as any);

    const res = await executor.execute(
      'session.events.get' as any,
      { sessionId: 's1', limit: 10, format: 'raw', roles: ['event'], includeRaw: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionEventsGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 10,
      format: 'raw',
      roles: ['event'],
      includeRaw: true,
      serverId: 'server-a',
    });
  });

  it('routes deprecated session.messages.recent.get to deps.sessionTranscriptGet', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTranscriptGet });

    const res = await executor.execute(
      'session.messages.recent.get' as any,
      { sessionId: 's1', limit: 3, cursor: 'cursor-1', includeUser: true, includeAssistant: false, maxCharsPerMessage: 80 },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTranscriptGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 3,
      cursor: 'cursor-1',
      roles: ['user'],
      maxCharsPerMessage: 80,
    });
  });

  it('executes session.wait.idle via deps.sessionWaitIdle', async () => {
    const sessionWaitIdle = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionWaitIdle,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.wait.idle' as any,
      { sessionId: 's1', timeoutSeconds: 42 },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionWaitIdle).toHaveBeenCalledWith({ sessionId: 's1', timeoutSeconds: 42, serverId: 'server-a' });
  });

  it('executes session work-state and goal actions through protocol deps', async () => {
    const sessionWorkStateGet = vi.fn(async () => ({ workState: null }));
    const sessionGoalGet = vi.fn(async () => ({ workState: null }));
    const sessionGoalSet = vi.fn(async () => ({ ok: true }));
    const sessionGoalClear = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionWorkStateGet,
      sessionGoalGet,
      sessionGoalSet,
      sessionGoalClear,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    await executor.execute('session.work_state.get' as any, { sessionId: 's1' }, { surface: 'cli' });
    await executor.execute('session.goal.get' as any, { sessionId: 's1' }, { surface: 'cli' });
    await executor.execute(
      'session.goal.set' as any,
      { sessionId: 's1', objective: 'Ship goals', status: 'active', tokenBudget: null },
      { surface: 'cli' },
    );
    await executor.execute('session.goal.clear' as any, { sessionId: 's1' }, { surface: 'cli' });

    expect(sessionWorkStateGet).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
    expect(sessionGoalGet).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 's1',
      objective: 'Ship goals',
      status: 'active',
      tokenBudget: null,
      serverId: 'server-a',
    });
    expect(sessionGoalClear).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
  });

  it('preserves budget-clearing session goal mutations through protocol deps', async () => {
    const sessionGoalSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionGoalSet });

    const res = await executor.execute(
      'session.goal.set' as any,
      { sessionId: 's1', tokenBudget: null },
      { surface: 'cli' },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 's1',
      tokenBudget: null,
    });
  });

  it('executes vendor plugin and skill catalog list actions through protocol deps', async () => {
    const sessionVendorPluginCatalogList = vi.fn(async () => ({ vendorPlugins: [] }));
    const sessionSkillCatalogList = vi.fn(async () => ({ skills: [] }));
    const executor = createExecutor({
      sessionVendorPluginCatalogList,
      sessionSkillCatalogList,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    await executor.execute('session.vendor_plugin_catalog.list' as any, { sessionId: 's1', cwd: '/repo' }, { surface: 'cli' });
    await executor.execute('session.skill_catalog.list' as any, { sessionId: 's1', cwd: '/repo' }, { surface: 'cli' });

    expect(sessionVendorPluginCatalogList).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/repo', serverId: 'server-a' });
    expect(sessionSkillCatalogList).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/repo', serverId: 'server-a' });
  });

  it('executes usage-limit recovery actions through protocol deps', async () => {
    const sessionUsageLimitWaitResumeEnable = vi.fn(async () => ({ ok: true }));
    const sessionUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true }));
    const sessionUsageLimitCheckNow = vi.fn(async () => ({ ok: true }));
    const sessionUsageLimitSwitchAccountNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const executor = createExecutor({
      sessionUsageLimitWaitResumeEnable,
      sessionUsageLimitWaitResumeCancel,
      sessionUsageLimitCheckNow,
      sessionUsageLimitSwitchAccountNow,
      sessionUsageLimitConsumeResetCredit,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    await executor.execute(
      'session.usageLimit.waitResume.enable' as any,
      { sessionId: 's1', issueFingerprint: 'usage-limit:s1:reset', remember: true, resumePromptMode: 'off' },
      { surface: 'cli' },
    );
    await executor.execute(
      'session.usageLimit.waitResume.enable' as any,
      { sessionId: 's1', issueFingerprint: 'usage-limit:s1:alias', rememberPreference: true },
      { surface: 'cli' },
    );
    await executor.execute(
      'session.usageLimit.waitResume.cancel' as any,
      {
        sessionId: 's1',
        issueFingerprint: 'usage-limit:s1:reset',
        armedAtMs: 123,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      },
      { surface: 'cli' },
    );
    await executor.execute('session.usageLimit.checkNow' as any, { sessionId: 's1', provider: ' codex ' }, { surface: 'cli' });
    const switchResult = await executor.execute(
      'session.usageLimit.checkNow' as any,
      { sessionId: 's1', provider: ' codex ', operation: 'switch_account_now', resumePromptMode: 'custom' },
      { surface: 'cli' },
    );
    const consumeResult = await executor.execute(
      'session.usageLimit.consumeResetCredit' as any,
      {
        sessionId: 's1',
        provider: ' codex ',
        issueFingerprint: ' usage-limit:codex:turn-1 ',
        resumePromptMode: 'custom',
      },
      { surface: 'cli' },
    );

    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenCalledWith({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:reset',
      remember: true,
      resumePromptMode: 'off',
      serverId: 'server-a',
    });
    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:alias',
      remember: true,
      serverId: 'server-a',
    });
    expect(sessionUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:reset',
      armedAtMs: 123,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      serverId: 'server-a',
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledWith({
      sessionId: 's1',
      agentId: 'codex',
      serverId: 'server-a',
    });
    expect(switchResult).toEqual({ ok: true, result: { ok: true, status: 'waiting' } });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 's1',
      agentId: 'codex',
      resumePromptMode: 'custom',
      serverId: 'server-a',
    });
    expect(consumeResult).toEqual({ ok: true, result: { ok: true, status: 'waiting' } });
    expect(sessionUsageLimitConsumeResetCredit).toHaveBeenCalledWith({
      sessionId: 's1',
      agentId: 'codex',
      issueFingerprint: 'usage-limit:codex:turn-1',
      resumePromptMode: 'custom',
      serverId: 'server-a',
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledTimes(1);
  });

  it('does not route mutating reset-credit spend through the safe check-now action', async () => {
    const sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const executor = createExecutor({ sessionUsageLimitConsumeResetCredit });

    const result = await executor.execute(
      'session.usageLimit.checkNow' as any,
      { sessionId: 's1', provider: 'codex', operation: 'consume_reset_credit' },
      { surface: 'cli' },
    );

    expect(result).toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
    expect(sessionUsageLimitConsumeResetCredit).not.toHaveBeenCalled();
  });

  it('rejects retired Session spawn fields before the canonical dependency', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ type: 'success' as const }));
    const executor = createExecutor({ sessionSpawnNew });

    const result = await executor.execute(
      'session.spawn_new' as any,
      {
        ...canonicalSessionSpawnInput,
        backendTargetKey: 'backend:codex',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('preserves a thrown session.spawn_new attempt nonce so CLI callers can resume without resubmitting', async () => {
    const error = Object.assign(new Error('session_spawn_resolve_unsupported'), {
      code: 'session_spawn_resolve_unsupported',
      details: { spawnResponse: { status: 'pending' }, spawnNonce: 'stable-attempt-1' },
    });
    const executor = createExecutor({ sessionSpawnNew: vi.fn(async () => { throw error; }) });

    const res = await executor.execute(
      'session.spawn_new' as any,
      canonicalSessionSpawnInput,
      { surface: 'cli', defaultSessionId: null, actionRequestId: 'attempt-1' },
    );

    expect(res).toMatchObject({
      ok: false,
      error: 'session_spawn_resolve_unsupported',
      details: { spawnNonce: 'stable-attempt-1', accepted: true },
    });
  });

  it('does not expose arbitrary thrown action details while preserving spawn retry details', async () => {
    const error = Object.assign(new Error('action failed'), {
      details: { token: 'do-not-leak' },
    });
    const executor = createExecutor({ sessionSpawnNew: vi.fn(async () => { throw error; }) });
    const res = await executor.execute(
      'session.spawn_new' as any,
      canonicalSessionSpawnInput,
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).not.toHaveProperty('details');
    expect(JSON.stringify(res)).not.toContain('do-not-leak');
  });

  it('rejects a legacy built-in backend key before Session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        backendTargetKey: 'backend:claude',
        title: 'Canonical backend spawn',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects contradictory structured and Agent spawn targets before calling the spawn dependency', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        agentId: 'claude',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a legacy configured ACP carrier before Session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        agentId: 'customAcp',
        backendTarget: {
          kind: 'backend',
          backendId: 'customAcpRuntimeCarrier',
          configuredBackendId: 'kiro',
          sourceKind: 'configured',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'kiro',
          agent: {},
        },
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical runtime descriptor Agent id before session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        backendTargetKey: 'backend:plugin-review-bot',
        runtimeDescriptorV1: {
          v: 1,
          agentId: ' claude ',
          agent: {},
        },
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a legacy ACP runtime descriptor carrier before configured session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        backendTarget: {
          kind: 'backend',
          backendId: 'customAcpRuntimeCarrier',
          configuredBackendId: 'kiro',
          sourceKind: 'configured',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'customAcp',
          agent: {},
        },
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a V1 plugin key and runtime descriptor carrier before Session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'claude',
      agent: {},
    };

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        backendTargetKey: 'agent:plugin-review-bot',
        runtimeDescriptorV1,
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a V1 plugin key without an explicit runtime carrier before session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        backendTargetKey: 'agent:plugin-review-bot',
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects combined V1 configured and structured targets before Session spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });
    const backendTarget = {
      kind: 'backend' as const,
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured' as const,
    };

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        backendTargetKey: 'acpBackend:kiro',
        backendTarget,
        path: '/repo',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects a legacy built-in backend key outside the direct-session allowlist', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        backendTargetKey: 'backend:gemini',
        title: 'Gemini backend spawn',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('executes session.list via deps.sessionList (including cli filter flags)', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList });

    const res = await executor.execute(
      'session.list' as any,
      {
        limit: 10,
        cursor: 'cursor-1',
        activeOnly: true,
        includeSystem: true,
        resumableOnly: true,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { sessions: [] } });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10,
      cursor: 'cursor-1',
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
    }));
  });

  it('preserves cursor zero when reading execution-run streams', async () => {
    const executionRunStreamRead = vi.fn(async () => ({
      ok: true,
      events: [],
      streamId: 'stream-1',
      nextCursor: 0,
      done: false,
    }));
    const executor = createExecutor({
      executionRunStreamRead,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'execution.run.stream.read' as any,
      {
        sessionId: 's1',
        runId: 'run-1',
        streamId: 'stream-1',
        cursor: 0,
        maxEvents: 128,
      },
      { surface: 'rpc', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        events: [],
        streamId: 'stream-1',
        nextCursor: 0,
        done: false,
      },
    });
    expect(executionRunStreamRead).toHaveBeenCalledWith(
      's1',
      {
        runId: 'run-1',
        streamId: 'stream-1',
        cursor: 0,
        maxEvents: 128,
      },
      { serverId: 'server-a' },
    );
  });

  it('returns unsupported_action when session.permission.respond is not implemented by deps', async () => {
    const executor = createExecutor({ sessionPermissionRespond: undefined as any });

    const res = await executor.execute(
      'session.permission.respond' as any,
      { sessionId: 's1', decision: 'allow' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' });
  });

  it('routes a host-stamped mediator plugin to the canonical remote permission owner', async () => {
    // PERM-03: the mediated arm is the plugin's only way to answer, so the
    // Action authority minimum must be Account automation. A present-user
    // requirement here makes the whole remote-permission vertical unreachable.
    const settlement = {
      status: 'applied' as const,
      settlementId: 'settlement-1',
      requestId: 'request-1',
      decision: 'allow' as const,
      effect: { kind: 'allowOnce' as const },
    };
    const sessionPermissionRemoteAction = vi.fn(async () => settlement);
    const executor = createExecutor({
      sessionPermissionRemoteAction,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as Partial<ActionExecutorDeps>);
    const input = {
      sessionId: 's1',
      turnId: 'turn-1',
      requestId: 'request-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      idempotencyKey: 'retry-1',
      actor: { namespace: 'discord', principalId: 'user-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
    };
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      contributionLocalId: 'discord',
    };

    const res = await executor.execute(
      'session.permission.remote.respond' as any,
      input,
      { surface: 'plugin', actionCaller: caller },
    );

    expect(res).toEqual({ ok: true, result: settlement });
    expect(sessionPermissionRemoteAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.permission.remote.respond',
      caller,
      serverId: 'server-a',
      input: expect.objectContaining({
        sessionId: 's1',
        turnId: 'turn-1',
        requestId: 'request-1',
        decision: 'allow',
        scope: 'request',
      }),
    }));
    // The mediator identity still comes only from host-stamped provenance:
    // an anonymous plugin caller never reaches the owner.
    expect(await executor.execute(
      'session.permission.remote.respond' as any,
      input,
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'happier.channels' },
      },
    )).toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(sessionPermissionRemoteAction).toHaveBeenCalledTimes(1);
  });

  it('routes a host-stamped mediator plugin to the canonical remote user-action answer owner', async () => {
    const sessionPermissionRemoteAction = vi.fn(async () => ({
      status: 'applied' as const,
      requestId: 'question-1',
    }));
    const executor = createExecutor({
      sessionPermissionRemoteAction,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as Partial<ActionExecutorDeps>);
    const input = {
      sessionId: 's1',
      turnId: 'turn-1',
      requestId: 'question-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      answers: [{ questionIndex: 0, values: ['release'] }],
    };
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      contributionLocalId: 'discord',
    };

    await expect(executor.execute(
      'session.user_action.remote.answer' as any,
      input,
      { surface: 'plugin', actionCaller: caller },
    )).resolves.toEqual({ ok: true, result: { status: 'applied', requestId: 'question-1' } });
    expect(sessionPermissionRemoteAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.user_action.remote.answer',
      caller,
      serverId: 'server-a',
      input,
    }));
  });

  it('lets a host-stamped mediator plugin revoke its own remote grant', async () => {
    // PERM-10: owner UI and the stamped mediator share this Action; the
    // caller-scoping decision belongs to the owner below the authority gate.
    const sessionPermissionRemoteAction = vi.fn(async () => ({
      status: 'revoked' as const,
      grantId: 'grant-1',
    }));
    const executor = createExecutor({
      sessionPermissionRemoteAction,
      resolveServerIdForSessionId: () => null,
    } as Partial<ActionExecutorDeps>);
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      contributionLocalId: 'discord',
    };

    await expect(executor.execute(
      'session.permission.remote.grants.revoke' as any,
      { sessionId: 's1', turnId: 'turn-1', requestId: 'request-1', grantId: 'grant-1' },
      { surface: 'plugin', actionCaller: caller },
    )).resolves.toEqual({
      ok: true,
      result: { status: 'revoked', grantId: 'grant-1' },
    });
    expect(sessionPermissionRemoteAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.permission.remote.grants.revoke',
      caller,
    }));
  });

  it('requires an attributable plugin contribution for remote permission pending reads', async () => {
    const sessionPermissionRemoteAction = vi.fn(async () => ({ requests: [], truncated: false }));
    const executor = createExecutor({ sessionPermissionRemoteAction } as Partial<ActionExecutorDeps>);

    await expect(executor.execute('session.permission.remote.pending.list' as any, {
      sessionId: 's1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(sessionPermissionRemoteAction).not.toHaveBeenCalled();
  });

  it.each(['api', 'plugin', 'agent', 'mcp'] as const)(
    'rejects %s automation from responding to session permissions',
    async (surface) => {
      const sessionPermissionRespond = vi.fn(async () => ({ ok: true }));
      const executor = createExecutor({ sessionPermissionRespond });

      const res = await executor.execute(
        'session.permission.respond' as any,
        { sessionId: 's1', decision: 'allow' },
        {
          surface,
          authority: 'account_automation',
          defaultSessionId: null,
          ...(surface === 'api'
            ? { actionCaller: { kind: 'host' } }
            : surface === 'plugin'
              ? { actionCaller: { kind: 'plugin', pluginId: 'acme.test' } }
              : {}),
        } as any,
      );

      expect(res).toEqual({
        ok: false,
        errorCode: 'present_user_required',
        error: 'present_user_required',
      });
      expect(sessionPermissionRespond).not.toHaveBeenCalled();
    },
  );

  it.each(['api', 'plugin'] as const)(
    'rejects %s automation from answering a present-user action request',
    async (surface) => {
      const sessionUserActionAnswer = vi.fn(async () => ({ ok: true }));
      const executor = createExecutor({ sessionUserActionAnswer });

      const res = await executor.execute(
        'session.user_action.answer' as any,
        surface === 'plugin'
          ? { requestId: 'request-1', decision: 'approve' }
          : { sessionId: 's1', requestId: 'request-1', decision: 'approve' },
        {
          surface,
          authority: 'account_automation',
          defaultSessionId: surface === 'plugin' ? 's1' : null,
          ...(surface === 'api'
            ? { actionCaller: { kind: 'host' } }
            : { actionCaller: { kind: 'plugin', pluginId: 'acme.test' } }),
        } as any,
      );

      expect(res).toEqual({
        ok: false,
        errorCode: 'present_user_required',
        error: 'present_user_required',
      });
      expect(sessionUserActionAnswer).not.toHaveBeenCalled();
    },
  );

  it('returns unsupported_action when session.user_action.answer is not implemented by deps', async () => {
    const executor = createExecutor({ sessionUserActionAnswer: undefined as any });

    const res = await executor.execute(
      'session.user_action.answer' as any,
      { sessionId: 's1', decision: 'approve' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.user_action.answer' });
  });
});
