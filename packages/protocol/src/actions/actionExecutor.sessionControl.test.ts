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
    sessionSpawnPicker: async () => ({}),
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

describe('createActionExecutor (session control)', () => {
  it('executes session.message.send via deps.sessionSendMessage (including optional overrides)', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        message: 'Hello',
        permissionModeOverride: 'read_only',
        modelOverride: 'gpt-4o',
        providerConnectionId: 'pc_work',
        wait: true,
        timeoutSeconds: 42,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'Hello',
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
      providerConnectionId: 'pc_work',
      wait: true,
      timeoutSeconds: 42,
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
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionTranscriptGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    } as any);

    const res = await executor.execute(
      'session.transcript.get' as any,
      { sessionId: 's1', limit: 25, roles: ['user', 'assistant'], includeTools: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTranscriptGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      roles: ['user', 'assistant'],
      includeTools: true,
      serverId: 'server-a',
    });
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
      { sessionId: 's1', issueFingerprint: null },
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
      issueFingerprint: null,
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

  it('executes session.spawn_new via deps.sessionSpawnNew (including backendTargetKey/title)', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        backendTargetKey: 'agent:claude',
        title: 'My title',
        tag: 'tag-1',
        initialMessage: 'Hello',
        modelId: 'provider-model',
        providerConnectionId: 'pc_work',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo',
      backendTargetKey: 'agent:claude',
      title: 'My title',
      tag: 'tag-1',
      initialMessage: 'Hello',
      modelId: 'provider-model',
      providerConnectionId: 'pc_work',
    }));
  });

  it('preserves structured session.spawn_new policy failure details from returned envelopes', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: 'spawn_policy_denied',
      errorMessage: 'spawn_policy_denied',
      field: 'path',
      surface: 'agent',
    }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/tmp/other-repo',
        backendTargetKey: 'agent:claude',
      },
      { surface: 'agent', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'spawn_policy_denied',
      error: 'spawn_policy_denied',
      details: {
        field: 'path',
        surface: 'agent',
      },
    });
  });

  it('executes session.spawn_new for a canonical built-in backend key without requiring agentId', async () => {
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

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo',
      backendTargetKey: 'backend:claude',
      title: 'Canonical backend spawn',
    }));
  });

  it('executes session.spawn_picker for a canonical built-in backend key without requiring agentId', async () => {
    const sessionSpawnPicker = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnPicker });

    const res = await executor.execute(
      'session.spawn_picker' as any,
      {
        backendTargetKey: 'backend:claude',
        initialMessage: 'Inspect this workspace',
        modelId: 'provider-model',
        providerConnectionId: 'pc_work',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnPicker).toHaveBeenCalledWith(expect.objectContaining({
      backendTargetKey: 'backend:claude',
      initialMessage: 'Inspect this workspace',
      modelId: 'provider-model',
      providerConnectionId: 'pc_work',
    }));
  });

  it('executes session.spawn_new for a canonical built-in backend key outside the direct-session allowlist', async () => {
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

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo',
      backendTargetKey: 'backend:gemini',
      agentId: 'gemini',
      title: 'Gemini backend spawn',
    }));
  });

  it('executes session.spawn_picker for a canonical built-in backend key outside the direct-session allowlist', async () => {
    const sessionSpawnPicker = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnPicker });

    const res = await executor.execute(
      'session.spawn_picker' as any,
      {
        backendTargetKey: 'backend:gemini',
        initialMessage: 'Inspect this workspace',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnPicker).toHaveBeenCalledWith(expect.objectContaining({
      backendTargetKey: 'backend:gemini',
      agentId: 'gemini',
      initialMessage: 'Inspect this workspace',
    }));
  });

  it('rejects session.spawn_picker for a canonical plugin backend key without an explicit runtime carrier', async () => {
    const sessionSpawnPicker = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnPicker });

    const res = await executor.execute(
      'session.spawn_picker' as any,
      {
        backendTargetKey: 'backend:plugin-review-bot',
        initialMessage: 'Inspect this workspace',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnPicker).not.toHaveBeenCalled();
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
    const executionRunStreamRead = vi.fn(async () => ({ ok: true, events: [] }));
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

    expect(res).toEqual({ ok: true, result: { ok: true, events: [] } });
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
