import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async () => ({ voiceAgentId: 'run_1' }));
const sendTurn = vi.fn(async () => ({ assistantText: 'ok', actions: [] }));
const commit = vi.fn(async () => ({ commitText: 'commit' }));
const welcome = vi.fn(async () => ({ assistantText: '' }));

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
  DaemonVoiceAgentClient: class {
    start = start;
    sendTurn = sendTurn;
    commit = commit;
    welcome = welcome;
    startTurnStream = vi.fn();
    readTurnStream = vi.fn();
    cancelTurnStream = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('@/voice/agent/openaiCompatVoiceAgentClient', () => ({
  OpenAiCompatVoiceAgentClient: class {},
}));

vi.mock('@/voice/context/buildVoiceInitialContext', () => ({
  buildVoiceInitialContext: () => '',
}));

vi.mock('@/voice/agent/resolveDaemonVoiceAgentModels', () => ({
  resolveDaemonVoiceAgentModelIds: () => ({ chatModelId: 'chat', commitModelId: 'commit' }),
}));

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          streaming: { enabled: false },
          agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 1 } },
          networkTimeoutMs: 15_000,
        },
      },
    },
  },
  sessions: {
    sys_voice: {
      id: 'sys_voice',
      updatedAt: 10,
      modelMode: 'default',
      metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
    },
    s1: { id: 's1', updatedAt: 1, modelMode: 'default', metadata: { flavor: 'claude' } },
  },
  sessionMessages: {},
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

// sessionExecutionRunGet is a protocol boundary; keep the mock flexible as the run schema evolves.
const sessionExecutionRunGet = vi.fn(async (..._args: any[]): Promise<any> => ({
  run: {
    runId: 'run_1',
    backendId: 'claude',
    resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
  },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunGet,
}));

const patchSessionMetadataWithRetry = vi.fn(async (sessionId: string, updater: (m: any) => any) => {
  state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
});

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

describe('VoiceAgentSessionController (persistence)', () => {
  beforeEach(() => {
    vi.resetModules();
    start.mockClear();
    sendTurn.mockClear();
    commit.mockClear();
    sessionExecutionRunGet.mockClear();
    patchSessionMetadataWithRetry.mockClear();

    state.sessions.sys_voice.metadata = { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } };
    state.settings.voice.adapters.local_conversation.streaming.enabled = false;
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };
    state.settings.voice.adapters.local_conversation.agent.resumabilityMode = 'replay';

    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: 's1', trackedSessionIds: [], lastFocusedSessionId: null } as any);
  });

  it('persists runId and resumeHandle into carrier session metadata when transcript persistence is enabled', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_1' }),
    });
  });

  it('starts a fresh run when replay mode cannot reattach to an inactive run', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };

    start.mockRejectedValueOnce(Object.assign(new Error('Not running'), { rpcErrorCode: 'execution_run_not_allowed' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: {
        runId: 'run_2',
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_2' },
      },
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_prev',
        resumeWhenInactive: false,
      }),
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
      }),
    );
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_2',
    });
  });

  it('provider-resume mode starts a new run with resumeHandle when the previous runId is not found', async () => {
    state.settings.voice.adapters.local_conversation.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };

    start.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_3' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: true,
        resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_prev' }),
      }),
    );
  });

  it('persists an updated resumeHandle into carrier metadata after commit (e.g. commit session ids)', async () => {
    sessionExecutionRunGet
      .mockResolvedValueOnce({
        run: {
          runId: 'run_1',
          backendId: 'claude',
          resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
        },
      })
      .mockResolvedValueOnce({
        run: {
          runId: 'run_1',
          backendId: 'claude',
          resumeHandle: {
            kind: 'voice_agent_sessions.v1',
            backendId: 'claude',
            chatVendorSessionId: 'vs_1',
            commitVendorSessionId: 'vs_commit',
          },
        },
      });

    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1?.resumeHandle?.kind).toBe('vendor_session.v1');

    await controller.commit(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(sessionExecutionRunGet).toHaveBeenCalledTimes(2);
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({
        kind: 'voice_agent_sessions.v1',
        commitVendorSessionId: 'vs_commit',
      }),
    });
  });
});
