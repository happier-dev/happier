import { beforeEach, describe, expect, it, vi } from 'vitest';

const executionRunStart = vi.fn(async () => ({ ok: true, runId: 'run_1' }));
const executionRunList = vi.fn(async () => []);
const executionRunGet = vi.fn(async () => null);
const executionRunSend = vi.fn(async () => ({ ok: true }));
const executionRunStop = vi.fn(async () => ({ ok: true }));
const executionRunAction = vi.fn(async () => ({ ok: true }));
const listAgentBackendsForVoiceTool = vi.fn(async () => ({ items: [] }));
const listAgentModelsForVoiceTool = vi.fn(async () => ({ items: [] }));
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, updater: (metadata: any) => any) => {
  updater({ path: '/tmp/project', host: 'localhost' });
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunStart: executionRunStart,
  sessionExecutionRunList: executionRunList,
  sessionExecutionRunGet: executionRunGet,
  sessionExecutionRunSend: executionRunSend,
  sessionExecutionRunStop: executionRunStop,
  sessionExecutionRunAction: executionRunAction,
}));

vi.mock('@/sync/ops/sessions', () => ({
  forkSession: vi.fn(),
  rollbackSessionConversation: vi.fn(),
  sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
  sendSessionMessageWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: vi.fn(),
}));

vi.mock('@/voice/activity/voiceActivityController', () => ({
  voiceActivityController: { clearSession: vi.fn() },
}));

vi.mock('@/voice/session/voiceSession', () => ({
  voiceSessionManager: { stopSession: vi.fn() },
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
  openSessionForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/spawnSession', () => ({
  spawnSessionForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/spawnSessionPicker', () => ({
  spawnSessionWithPickerForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionTargets', () => ({
  setPrimaryActionSessionId: vi.fn(),
  setTrackedSessionIds: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionList', () => ({
  listSessionsForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionActivity', () => ({
  getSessionActivityForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionRecentMessages', () => ({
  getSessionRecentMessagesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/pathsListRecent', () => ({
  listRecentPathsForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/machinesList', () => ({
  listMachinesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/serversList', () => ({
  listServersForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/reviewEnginesList', () => ({
  listReviewEnginesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/agentCatalogList', () => ({
  listAgentBackendsForVoiceTool,
  listAgentModelsForVoiceTool,
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry,
  },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({
      settings: { actionsSettingsV1: { v: 1, actions: {} } },
      sessions: {
        s1: { id: 's1', metadata: { path: '/tmp/project', host: 'localhost' } },
        s_acp: {
          id: 's_acp',
          metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'opencode',
            acpSessionModesV1: {
              v: 1,
              provider: 'opencode',
              updatedAt: 1,
              currentModeId: 'build',
              availableModes: [
                { id: 'build', name: 'Build', description: 'Do the work' },
                { id: 'plan', name: 'Plan', description: 'Think first' },
              ],
            },
          },
        },
        s_codex: {
          id: 's_codex',
          metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            sessionModesV1: {
              v: 1,
              provider: 'codex',
              updatedAt: 1,
              currentModeId: 'plan',
              availableModes: [
                { id: 'default', name: 'Default', description: 'Standard collaboration mode' },
                { id: 'plan', name: 'Plan', description: 'Think first' },
              ],
            },
          },
        },
      },
    }),
  },
    useSession: vi.fn(),
});
});

describe('createDefaultActionExecutor plan mode integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards limit to agents.backends.list voice-tool routing', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'agents.backends.list',
      { includeDisabled: true, limit: 2 },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(listAgentBackendsForVoiceTool).toHaveBeenCalledWith({ includeDisabled: true, limit: 2 });
  });

  it('forwards limit to agents.models.list voice-tool routing', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'agents.models.list',
      { agentId: 'claude', machineId: 'm1', limit: 3 },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(listAgentModelsForVoiceTool).toHaveBeenCalledWith({ agentId: 'claude', machineId: 'm1', limit: 3 });
  });

  it('forwards backendTargetKey to agents.models.list voice-tool routing', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'agents.models.list',
      { backendTargetKey: 'acpBackend:review-bot', machineId: 'm1', limit: 2 },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(listAgentModelsForVoiceTool).toHaveBeenCalledWith({
      agentId: 'customAcp',
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('does not publish a session-mode override when starting a planner subagent run', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan the changes.' },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('publishes a session-mode override when session.mode.set succeeds', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 's1', modeId: 'plan' },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s1', expect.any(Function));
    const updater = patchSessionMetadataWithRetry.mock.calls[0]?.[1];
    const next = updater({ path: '/tmp/project', host: 'localhost' });
    expect(next.acpSessionModeOverrideV1).toEqual(
      expect.objectContaining({ v: 1, modeId: 'plan' }),
    );
  });

  it('rejects session.mode.set when the requested mode is unavailable for the session', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 's1', modeId: 'not-a-real-mode' },
      { defaultSessionId: 's1', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('clears the session-mode override when session.mode.set uses default', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 's_acp', modeId: 'default' },
      { defaultSessionId: 's_acp', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_acp', expect.any(Function));
    const updater = patchSessionMetadataWithRetry.mock.calls[0]?.[1];
    const next = updater({
      path: '/tmp/project',
      host: 'localhost',
      acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
    });
    expect(next.acpSessionModeOverrideV1).toEqual(
      expect.objectContaining({ v: 1, modeId: null }),
    );
  });

  it('includes a default option when resolving session.mode.set options for ACP-backed modes', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'action.options.resolve',
      { actionId: 'session.mode.set', fieldPath: 'modeId', sessionId: 's_acp' },
      { defaultSessionId: 's_acp', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect((result as any).result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'default', label: 'Default' }),
        expect.objectContaining({ value: 'build', label: 'Build' }),
        expect.objectContaining({ value: 'plan', label: 'Plan' }),
      ]),
    );
  });

  it('publishes the real default mode id when session.mode.set targets a provider mode literally named default', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
    const { normalizeRequestedSessionModeId, resolveSessionModeActionControl } = await import('./sessionModeActionSupport');

    const control = resolveSessionModeActionControl({
      metadata: {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex',
        sessionModesV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [
            { id: 'default', name: 'Default', description: 'Standard collaboration mode' },
            { id: 'plan', name: 'Plan', description: 'Think first' },
          ],
        },
      },
    } as any);
    expect(control?.options.map((option) => option.id)).toEqual(['default', 'plan']);
    expect(normalizeRequestedSessionModeId(control, 'default')).toBe('default');

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 's_codex', modeId: 'default' },
      { defaultSessionId: 's_codex', surface: 'voice_tool', placement: 'voice_panel' },
    );

    expect(result.ok).toBe(true);
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_codex', expect.any(Function));
    const updater = patchSessionMetadataWithRetry.mock.calls[0]?.[1];
    const next = updater({
      path: '/tmp/project',
      host: 'localhost',
      sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
    });
    expect(next.sessionModeOverrideV1).toEqual(
      expect.objectContaining({ v: 1, modeId: 'default' }),
    );
  });
});
