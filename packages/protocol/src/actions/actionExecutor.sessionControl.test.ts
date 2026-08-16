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
    sessionWorkStateGet: async () => ({}),
    sessionGoalGet: async () => ({}),
    sessionGoalSet: async () => ({}),
    sessionGoalClear: async () => ({}),
    sessionVendorPluginCatalogList: async () => ({}),
    sessionSkillCatalogList: async () => ({}),
    sessionTranscriptGet: async () => ({}),
    sessionEventsGet: async () => ({}),
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
        requestedAction: { v: 1, kind: 'send_now' },
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
      requestedAction: { v: 1, kind: 'send_now' },
      wait: true,
      timeoutSeconds: 42,
    }));
  });

  it('defaults generic session.message.send callers to conditional steering instead of interruption', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    await expect(executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello' },
      { surface: 'mcp', defaultSessionId: null },
    )).resolves.toEqual({ ok: true, result: { ok: true } });

    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'Hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
  });

  it('preserves exact nonblank opaque model override bytes when sending a message', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'Hello', modelOverride: ' model-a\t' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: ' model-a\t',
    }));
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
    const sessionStop = vi.fn(async () => ({ success: true }));
    const executor = createExecutor({
      sessionStop,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { success: true } });
    expect(sessionStop).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
  });

  it.each([
    {
      label: 'control unavailable',
      dependencyResult: {
        success: false as const,
        message: 'Session controls are unavailable',
        code: 'session_stop_control_unavailable',
        recovery: 'retry_when_runtime_available' as const,
      },
      errorCode: 'session_stop_control_unavailable',
    },
    {
      label: 'rejected',
      dependencyResult: {
        success: false as const,
        message: 'runner refused stop',
        code: 'session_stop_failed',
      },
      errorCode: 'session_stop_failed',
    },
  ])('reports $label session.stop dependency results as top-level action failures', async ({ dependencyResult, errorCode }) => {
    const executor = createExecutor({
      sessionStop: vi.fn(async () => dependencyResult),
    });

    const result = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({
      ok: false,
      errorCode,
      error: dependencyResult.message,
      details: dependencyResult,
    });
  });

  it('reports legacy ok:false session.stop dependency results as top-level action failures', async () => {
    const dependencyResult = {
      ok: false as const,
      code: 'unsupported',
      message: 'session stop is unsupported',
    };
    const executor = createExecutor({
      sessionStop: vi.fn(async () => dependencyResult),
    });

    const result = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported',
      error: 'session stop is unsupported',
      details: dependencyResult,
    });
  });

  it('preserves legacy ok:true session.stop dependency results as top-level action success', async () => {
    const dependencyResult = {
      ok: true as const,
      sessionId: 's1',
      stopped: true,
    };
    const executor = createExecutor({
      sessionStop: vi.fn(async () => dependencyResult),
    });

    const result = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({ ok: true, result: dependencyResult });
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
    const executor = createExecutor({
      sessionStop: vi.fn(async () => dependencyResult),
    });

    const result = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(result).toEqual({ ok: true, result: dependencyResult });
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

  it('preserves exact nonblank opaque model identifiers for session.model.set', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionModelSet,
      resolveServerIdForSessionId: () => 'server-a',
    });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: ' model-a ' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({ sessionId: 's1', modelId: ' model-a ', serverId: 'server-a' });
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

  it('executes session.transcript.get via deps.sessionTranscriptGet', async () => {
    const sessionTranscriptGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionTranscriptGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.transcript.get' as any,
      {
        sessionId: 's1',
        limit: 25,
        cursor: '10',
        direction: 'after',
        scope: 'sidechain',
        sidechainId: 'side-1',
        roles: ['user'],
        includeTools: true,
        includeReasoning: true,
        includeEvents: true,
        includeMeta: true,
        includeStructuredPayload: true,
        includeRaw: true,
        maxCharsPerMessage: 100,
        maxRawPayloadChars: 8192,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTranscriptGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      cursor: '10',
      direction: 'after',
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: ['user'],
      includeTools: true,
      includeReasoning: true,
      includeEvents: true,
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxCharsPerMessage: 100,
      maxRawPayloadChars: 8192,
      serverId: 'server-a',
    });
  });

  it('executes session.events.get via deps.sessionEventsGet', async () => {
    const sessionEventsGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionEventsGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.events.get' as any,
      {
        sessionId: 's1',
        limit: 25,
        cursor: '10',
        direction: 'before',
        scope: 'all',
        roles: ['event'],
        kinds: ['tool_call'],
        format: 'raw',
        includeMeta: true,
        includeStructuredPayload: true,
        includeRaw: true,
        maxTextChars: 100,
        maxPayloadChars: 8192,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionEventsGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      cursor: '10',
      direction: 'before',
      scope: 'all',
      roles: ['event'],
      kinds: ['tool_call'],
      format: 'raw',
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxTextChars: 100,
      maxPayloadChars: 8192,
      serverId: 'server-a',
    });
  });

  it('routes session.history.get to deps.sessionHistoryGet', async () => {
    const sessionHistoryGet = vi.fn(async () => ({ ok: true, format: 'compact', messages: [] }));
    const executor = createExecutor({
      sessionHistoryGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.history.get' as any,
      { sessionId: 's1', limit: 25, format: 'raw', includeMeta: true, includeStructuredPayload: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true, format: 'compact', messages: [] } });
    expect(sessionHistoryGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      format: 'raw',
      includeMeta: true,
      includeStructuredPayload: true,
      serverId: 'server-a',
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

  it('executes status-only session goal mutations through protocol deps', async () => {
    const sessionGoalSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionGoalSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.goal.set' as any,
      { sessionId: 's1', status: 'paused' },
      { surface: 'cli' },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 's1',
      status: 'paused',
      serverId: 'server-a',
    });
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

  it('executes terminal composer clear through protocol deps', async () => {
    const sessionTerminalComposerClear = vi.fn(async () => ({
      ok: true,
      status: 'cleared',
      sessionId: 's1',
    }));
    const executor = createExecutor({
      sessionTerminalComposerClear,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.terminalComposer.clear' as any,
      { sessionId: 's1', expectedStateAtMs: 1_700_000_000_000 },
      { surface: 'cli' },
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
      expectedStateAtMs: 1_700_000_000_000,
      serverId: 'server-a',
    });
  });

  it('fails terminal composer clear closed when deps are unavailable', async () => {
    const executor = createExecutor();

    await expect(executor.execute(
      'session.terminalComposer.clear' as any,
      { sessionId: 's1' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.terminalComposer.clear',
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
    const sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({ ok: true, status: 'ready' }));
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
      { sessionId: 's1', provider: ' codex ', operation: 'switch_account_now', resumePromptMode: 'off' },
      { surface: 'cli' },
    );
    const resetResult = await executor.execute(
      'session.usageLimit.consumeResetCredit' as any,
      { sessionId: 's1', provider: ' codex ', resumePromptMode: 'standard' },
      { surface: 'cli' },
    );

    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenCalledWith({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:reset',
      remember: true,
      resumePromptMode: 'off',
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
      provider: 'codex',
      serverId: 'server-a',
    });
    expect(switchResult).toEqual({
      ok: true,
      result: { ok: true, status: 'waiting', sessionId: 's1' },
    });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'codex',
      resumePromptMode: 'off',
      serverId: 'server-a',
    });
    expect(resetResult).toEqual({
      ok: true,
      result: { ok: true, status: 'ready', sessionId: 's1' },
    });
    expect(sessionUsageLimitConsumeResetCredit).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'codex',
      resumePromptMode: 'standard',
      serverId: 'server-a',
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledTimes(1);
  });

  it('does not execute reset-credit spend through the safe check-now action id', async () => {
    const sessionUsageLimitCheckNow = vi.fn(async () => ({ ok: true }));
    const sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionUsageLimitCheckNow,
      sessionUsageLimitConsumeResetCredit,
    });

    await expect(executor.execute(
      'session.usageLimit.checkNow' as any,
      { sessionId: 's1', provider: ' codex ', operation: 'consume_reset_credit' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionUsageLimitCheckNow).not.toHaveBeenCalled();
    expect(sessionUsageLimitConsumeResetCredit).not.toHaveBeenCalled();
  });

  it('normalizes malformed usage-limit action results to typed failure payloads', async () => {
    const sessionUsageLimitCheckNow = vi.fn(async () => ({
      ok: true,
      status: 'future_success_token',
    }));
    const executor = createExecutor({ sessionUsageLimitCheckNow });

    const result = await executor.execute(
      'session.usageLimit.checkNow' as any,
      { sessionId: 's1' },
      { surface: 'cli' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        status: 'unsupported',
        sessionId: 's1',
        errorCode: 'unsupported_session_usage_limit_recovery_operation_result_status',
        diagnostics: { status: 'future_success_token' },
      },
    });
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
    }));
  });

  it('preserves structured session.spawn_new policy failure details returned by deps.sessionSpawnNew', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: 'spawn_policy_denied',
      errorMessage: 'spawn_policy_denied',
      details: {
        field: 'environmentVariables',
        surface: 'session_agent',
      },
    }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        environmentVariables: { SECRET_TOKEN: 'do-not-leak' },
      },
      { surface: 'session_agent', defaultSessionId: null },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        type: 'error',
        errorCode: 'spawn_policy_denied',
        errorMessage: 'spawn_policy_denied',
        details: {
          field: 'environmentVariables',
          surface: 'session_agent',
        },
      },
    });
    expect(JSON.stringify(res)).not.toContain('do-not-leak');
  });

  it('preserves a thrown session.spawn_new attempt nonce so CLI callers can resume without resubmitting', async () => {
    const error = Object.assign(new Error('session_spawn_resolve_unsupported'), {
      code: 'session_spawn_resolve_unsupported',
      details: { spawnResponse: { status: 'pending' }, spawnNonce: 'stable-attempt-1' },
    });
    const executor = createExecutor({ sessionSpawnNew: vi.fn(async () => { throw error; }) });

    const res = await executor.execute(
      'session.spawn_new' as any,
      { path: '/repo' },
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
      { path: '/repo' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).not.toHaveProperty('details');
    expect(JSON.stringify(res)).not.toContain('do-not-leak');
  });

  it('rejects session-agent spawn permission escalation before deps.sessionSpawnNew runs', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        permissionMode: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: null, callerPermissionMode: 'default' } as any,
    );

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'bypassPermissions',
        callerMode: 'default',
      },
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('rejects session-agent message permission overrides above the caller before deps.sessionSendMessage runs', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's2',
        message: 'Continue',
        permissionModeOverride: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: 's1', callerPermissionMode: 'default' } as any,
    );

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'bypassPermissions',
        callerMode: 'default',
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('clamps a session-agent message without an explicit override to the caller permission', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 'higher-privilege-session',
        message: 'Continue',
      },
      { surface: 'session_agent', defaultSessionId: 'caller', callerPermissionMode: 'read-only' } as any,
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      permissionModeOverride: 'read-only',
      callerSurface: 'session_agent',
      callerPermissionMode: 'read-only',
    }));
  });

  it('rejects session-agent permission mode changes above the caller before deps.sessionPermissionModeSet runs', async () => {
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionPermissionModeSet });

    const res = await executor.execute(
      'session.permission_mode.set' as any,
      {
        sessionId: 's2',
        permissionMode: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: 's1', callerPermissionMode: 'default' } as any,
    );

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'bypassPermissions',
        callerMode: 'default',
      },
    });
    expect(sessionPermissionModeSet).not.toHaveBeenCalled();
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
        includeRows: true,
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
      includeRows: true,
    }));
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
