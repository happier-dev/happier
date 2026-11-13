import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';

const startResult = { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: async () => startResult,
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
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  };
}

const agentCtx = { defaultSessionId: 's1', surface: 'session_agent' as const, callerPermissionMode: 'yolo' };
const delegateInput = { backendTargetKeys: ['agent:claude'], instructions: 'Do the thing.' };

function visibleEcho(request: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const role = typeof request.role === 'string'
    ? { id: request.role, name: request.role === 'reviewer' ? 'Reviewer' : 'Worker', assignmentId: 'assign_1' }
    : null;
  return {
    ...startResult,
    visibility: request.visibility,
    binding: request.visibility === 'session' ? (request.targetSessionId ? 'reused' : 'created') : null,
    linkedSessionId: request.visibility === 'session' ? (request.targetSessionId ?? 'child_1') : null,
    role,
    roleSource: role ? request.roleSource : 'none',
    permissionMode: request.permissionMode,
    modelId: typeof request.modelId === 'string' ? request.modelId : null,
    ...overrides,
  };
}

describe('hidden starts stay byte-identical', () => {
  it('sends the released request through execution.run.start whether visibility is omitted or explicitly hidden', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const executionRunStartV2 = vi.fn(async () => startResult);
    const readVisibleAgentsSettings = vi.fn(async () => ({}));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunStartV2, readVisibleAgentsSettings }));

    await executor.execute('subagents.delegate.start', delegateInput, agentCtx);
    await executor.execute('subagents.delegate.start', { ...delegateInput, visibility: 'hidden' }, agentCtx);

    expect(executionRunStartV2).not.toHaveBeenCalled();
    const [, omitted] = executionRunStart.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    const [, explicitHidden] = executionRunStart.mock.calls[1]! as unknown as [string, Record<string, unknown>];
    expect(JSON.stringify(explicitHidden)).toBe(JSON.stringify(omitted));
    expect(omitted).toEqual({
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Do the thing.',
      // Released behavior: a session-agent delegate start without a mode runs at the caller's mode.
      permissionMode: 'yolo',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      launchOrigin: { kind: 'session', sessionId: 's1' },
      intentInput: { ...delegateInput, permissionMode: undefined, retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', backendTargetKey: 'agent:claude' },
    });
  });

  it('does not read owner defaults on surfaces that cannot start visible runs', async () => {
    const readVisibleAgentsSettings = vi.fn(async () => ({ visibleAgentsV1: { v: 1, defaultVisibilityByIntent: { delegate: 'session' } } }));
    const executionRunStart = vi.fn(async () => startResult);
    const executor = createActionExecutor(createDeps({ executionRunStart, readVisibleAgentsSettings }));
    const res = await executor.execute('subagents.delegate.start', delegateInput, { defaultSessionId: 's1', surface: 'voice_tool' });
    expect(res.ok).toBe(true);
    expect(readVisibleAgentsSettings).not.toHaveBeenCalled();
    expect(executionRunStart).toHaveBeenCalledTimes(1);
  });
});

describe('visible and role-bearing starts', () => {
  it('uses only execution.run.start.v2, carries the fields, and returns the verified echo', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const executionRunStartV2 = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => visibleEcho(request));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunStartV2 }));

    const res = await executor.execute('review.start', {
      engineIds: ['agent:claude'],
      instructions: 'Review the plan.',
      permissionMode: 'read_only',
      visibility: 'session',
      role: 'reviewer',
      targetSessionId: 'reviewer_child',
    }, agentCtx);

    expect(res.ok).toBe(true);
    expect(executionRunStart).not.toHaveBeenCalled();
    const [, request] = executionRunStartV2.mock.calls[0]!;
    expect(request).toEqual(expect.objectContaining({
      intent: 'review', visibility: 'session', role: 'reviewer', roleSource: 'explicit', targetSessionId: 'reviewer_child', permissionMode: 'read_only',
    }));
    expect((request.intentInput as Record<string, unknown>).visibility).toBeUndefined();
    const item = (res as { result: { results: Array<{ ok: boolean; result: Record<string, unknown> }> } }).result.results[0]!;
    expect(item.ok).toBe(true);
    expect(item.result).toEqual(expect.objectContaining({ binding: 'reused', linkedSessionId: 'reviewer_child', roleSource: 'explicit' }));
  });

  it('keeps a start with no visibility on the released hidden path, even with a saved per-intent visibility', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const executionRunStartV2 = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => visibleEcho(request));
    const readVisibleAgentsSettings = vi.fn(async () => ({ visibleAgentsV1: { v: 1, defaultVisibilityByIntent: { delegate: 'session' }, defaultRoleByIntent: { delegate: 'worker' } } }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunStartV2, readVisibleAgentsSettings }));

    const res = await executor.execute('subagents.delegate.start', delegateInput, { ...agentCtx, surface: 'mcp' });

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledTimes(1);
    expect(executionRunStartV2).not.toHaveBeenCalled();
    expect(readVisibleAgentsSettings).not.toHaveBeenCalled();
  });

  it('fills a default role only on an explicit visible start and reports the settings role source', async () => {
    const executionRunStartV2 = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => visibleEcho(request));
    const executor = createActionExecutor(createDeps({
      executionRunStartV2,
      readVisibleAgentsSettings: async () => ({ visibleAgentsV1: { v: 1, defaultRoleByIntent: { delegate: 'worker' } } }),
    }));
    const res = await executor.execute('subagents.delegate.start', { ...delegateInput, visibility: 'session' }, { ...agentCtx, surface: 'mcp' });
    expect(res.ok).toBe(true);
    expect(executionRunStartV2.mock.calls[0]![1]).toEqual(expect.objectContaining({ visibility: 'session', role: 'worker', roleSource: 'settings' }));
  });

  it('rejects visible fields on surfaces outside session_agent, mcp, and cli without starting anything', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const executionRunStartV2 = vi.fn(async () => startResult);
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunStartV2 }));
    for (const surface of ['ui_button', 'voice_tool'] as const) {
      const visible = await executor.execute('subagents.delegate.start', { ...delegateInput, visibility: 'session' }, { defaultSessionId: 's1', surface });
      expect(visible).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_visibility_unsupported' }));
      const roled = await executor.execute('subagents.delegate.start', { ...delegateInput, role: 'worker' }, { defaultSessionId: 's1', surface });
      expect(roled).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    }
    expect(executionRunStart).not.toHaveBeenCalled();
    expect(executionRunStartV2).not.toHaveBeenCalled();
  });

  it('fails closed with a typed error when the host or runner lacks execution.run.start.v2', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const noV2 = createActionExecutor(createDeps({ executionRunStart }));
    const missing = await noV2.execute('subagents.delegate.start', { ...delegateInput, visibility: 'session' }, agentCtx);
    expect(missing).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_visibility_unsupported' }));

    const oldRunner = createActionExecutor(createDeps({
      executionRunStart,
      executionRunStartV2: async () => ({ ok: false, error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' }),
    }));
    const res = await oldRunner.execute('subagents.delegate.start', { ...delegateInput, role: 'worker' }, agentCtx);
    const item = (res as { result: { results: Array<Record<string, unknown>> } }).result.results[0]!;
    expect(item).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('treats a start without the expected echo as an unassigned run', async () => {
    const executor = createActionExecutor(createDeps({
      executionRunStartV2: async (_sessionId: string, request: Record<string, unknown>) => visibleEcho(request, { binding: 'created', linkedSessionId: 'other' }),
    }));
    const res = await executor.execute('subagents.delegate.start', { ...delegateInput, visibility: 'session', targetSessionId: 'worker_child' }, agentCtx);
    const item = (res as { result: { results: Array<Record<string, unknown>> } }).result.results[0]!;
    expect(item).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_visibility_unsupported', runId: 'run_1' }));
  });

  it('rejects invalid combinations before any start', async () => {
    const executionRunStartV2 = vi.fn(async () => startResult);
    const executor = createActionExecutor(createDeps({ executionRunStartV2 }));
    const cases: Array<[string, Record<string, unknown>]> = [
      ['subagents.delegate.start', { ...delegateInput, role: 'project_lead' }],
      ['subagents.delegate.start', { ...delegateInput, backendTargetKeys: ['agent:claude', 'agent:codex'], visibility: 'session', targetSessionId: 'c' }],
      ['subagents.delegate.start', { ...delegateInput, targetSessionId: 'c' }],
      ['review.start', { engineIds: ['agent:claude'], runLocation: 'current_session', visibility: 'session' }],
      ['voice_agent.start', { ...delegateInput, visibility: 'session' }],
    ];
    for (const [actionId, input] of cases) {
      const res = await executor.execute(actionId as 'subagents.delegate.start', input, agentCtx);
      expect(res.ok, `${actionId} ${JSON.stringify(input)}`).toBe(false);
    }
    expect(executionRunStartV2).not.toHaveBeenCalled();
  });

  it('routes the lower-level execution.run.start action through v2 when it carries visible fields', async () => {
    const executionRunStart = vi.fn(async () => startResult);
    const executionRunStartV2 = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => visibleEcho(request));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunStartV2 }));
    const base = {
      intent: 'plan', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Plan.',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    };
    const hidden = await executor.execute('execution.run.start', base, agentCtx);
    expect(hidden.ok).toBe(true);
    expect(executionRunStart.mock.calls[0]![1]).not.toHaveProperty('visibility');
    const visible = await executor.execute('execution.run.start', { ...base, visibility: 'session', role: 'planner' }, agentCtx);
    expect(visible).toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ binding: 'created', linkedSessionId: 'child_1' }) }));
    expect(executionRunStartV2.mock.calls[0]![1]).toEqual(expect.objectContaining({ visibility: 'session', role: 'planner', roleSource: 'explicit' }));
  });
});

describe('session.prompt_preview.get', () => {
  it('asks the session runner for the live prompt preview', async () => {
    const sessionPromptPreviewGet = vi.fn(async () => ({ ok: true, sessionId: 's1', text: 'x', blocks: [], launchForm: 'fresh', providerNotes: [] }));
    const executor = createActionExecutor(createDeps({ sessionPromptPreviewGet }));
    const res = await executor.execute('session.prompt_preview.get', {}, agentCtx);
    expect(res).toEqual(expect.objectContaining({ ok: true }));
    expect(sessionPromptPreviewGet).toHaveBeenCalledWith({ sessionId: 's1' });
    const unsupported = await createActionExecutor(createDeps()).execute('session.prompt_preview.get', {}, agentCtx);
    expect(unsupported).toEqual(expect.objectContaining({ ok: false, errorCode: 'unsupported_action' }));
  });
});

describe('session-agent notices', () => {
  it('accepts kind notice on the session_agent surface and keeps rejecting it on other non-CLI surfaces', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor(createDeps({ sessionSendMessage }));
    const input = { sessionId: 'lead_1', message: 'Final output available.', kind: 'notice' };
    const agent = await executor.execute('session.message.send', input, agentCtx);
    expect(agent.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', callerSurface: 'session_agent' }));
    const voice = await executor.execute('session.message.send', input, { defaultSessionId: 's1', surface: 'voice_tool' });
    expect(voice).toEqual(expect.objectContaining({ ok: false }));
  });
});
