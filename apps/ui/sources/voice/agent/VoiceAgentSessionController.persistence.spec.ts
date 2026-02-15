import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async () => ({ voiceAgentId: 'run_1' }));
const sendTurn = vi.fn(async () => ({ assistantText: 'ok', actions: [] }));

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
  DaemonVoiceAgentClient: class {
    start = start;
    sendTurn = sendTurn;
    startTurnStream = vi.fn();
    readTurnStream = vi.fn();
    cancelTurnStream = vi.fn();
    commit = vi.fn();
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

const sessionExecutionRunGet = vi.fn(async (..._args: any[]) => ({
  run: {
    runId: 'run_1',
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
    sessionExecutionRunGet.mockClear();
    patchSessionMetadataWithRetry.mockClear();

    state.sessions.sys_voice.metadata = { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } };
    state.settings.voice.adapters.local_conversation.streaming.enabled = false;
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

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
});
