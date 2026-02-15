import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async () => ({ voiceAgentId: 'm1' }));
const startTurnStream = vi.fn(async () => ({ streamId: 'stream-1' }));
const readTurnStream = vi.fn();
const cancelTurnStream = vi.fn(async () => ({ ok: true }));
const sendTurn = vi.fn(async () => ({ assistantText: 'fallback', actions: [] }));
const commit = vi.fn(async () => ({ commitText: 'commit' }));
const stop = vi.fn(async () => ({ ok: true }));

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
  DaemonVoiceAgentClient: class {
    start = start;
    startTurnStream = startTurnStream;
    readTurnStream = readTurnStream;
    cancelTurnStream = cancelTurnStream;
    sendTurn = sendTurn;
    commit = commit;
    stop = stop;
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

const getState = vi.fn(() => ({
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          streaming: {
            enabled: true,
            // new config knobs (expected to be respected by VoiceAgentSessionController)
            turnReadPollIntervalMs: 50,
            turnReadMaxEvents: 7,
            turnStreamTimeoutMs: 1200,
          },
          agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
          networkTimeoutMs: 15_000,
        },
      },
    },
  },
  sessions: {
    sys_voice: { id: 'sys_voice', modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
    s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
  },
  sessionMessages: {},
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => getState(),
  },
}));

describe('VoiceAgentSessionController (streaming)', () => {
  beforeEach(() => {
    vi.resetModules();
    getState.mockReset();
	    getState.mockImplementation(() => ({
	      settings: {
	        voice: {
	          providerId: 'local_conversation',
	          adapters: {
	            local_conversation: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
        s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));
    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, trackedSessionIds: [], lastFocusedSessionId: null } as any);
    start.mockClear();
    startTurnStream.mockClear();
    readTurnStream.mockReset();
    readTurnStream.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [{ t: 'done', assistantText: 'ok', actions: [] }],
      nextCursor: 1,
      done: true,
    }));
    cancelTurnStream.mockClear();
    sendTurn.mockClear();
    commit.mockClear();
    stop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses configured maxEvents when reading the streamed turn', async () => {
    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn('s1', 'hello');

    expect(readTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 7,
      }),
    );
  });

  it('times out using configured turnStreamTimeoutMs (not a hard-coded poll count)', async () => {
    vi.useFakeTimers();
    readTurnStream.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    let settled = false;
    let rejectedError: unknown = null;
    controller.sendTurn('s1', 'hello').then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejectedError = err;
      },
    );

    // Advance past the configured 1200ms timeout.
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(String((rejectedError as any)?.message ?? rejectedError)).toContain('stream_timeout');
    expect(cancelTurnStream).toHaveBeenCalledTimes(1);
  });

	  it('ignores non-finite or invalid streaming config values (does not short-circuit the stream loop)', async () => {
	    const { voiceSettingsDefaults } = await import('@/sync/domains/settings/voiceSettings');

	    getState.mockImplementation(() => ({
	      settings: {
	        voice: {
	          providerId: 'local_conversation',
	          adapters: {
	            local_conversation: {
	              streaming: {
	                enabled: true,
	                turnReadPollIntervalMs: -10,
	                turnReadMaxEvents: Number.NaN,
	                turnStreamTimeoutMs: Number.NaN,
	              },
		              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
		              networkTimeoutMs: 15_000,
		            },
		          },
		        },
		      },
		      sessions: {
		        sys_voice: {
		          id: 'sys_voice',
		          modelMode: 'default',
		          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
		        },
		        s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
		      },
		      sessionMessages: {},
		    }));

    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({ assistantText: 'ok' });
    expect(readTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: voiceSettingsDefaults.adapters.local_conversation.streaming.turnReadMaxEvents,
      }),
    );
    expect(cancelTurnStream).toHaveBeenCalledTimes(0);
  });

  it('uses a real carrier session id when starting the daemon agent for the global agent session', async () => {
    // Global agent has no real session encryption key; it must borrow a real session id for daemon RPC.
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(startTurnStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(readTurnStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('seeds initialContext with persisted agent transcript turns when persistence is enabled', async () => {
    // Carrier session transcript should be used to seed voice agent context across restarts.
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

    getState.mockImplementation(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 3 } },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            voiceAgentRunV1: {
              v: 1,
              runId: 'run_prev',
              backendId: 'claude',
              resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
              updatedAtMs: 123,
            },
          },
        },
        s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {
        sys_voice: {
          isLoaded: true,
          messages: [
            {
              kind: 'user-text',
              id: 'm1',
              localId: null,
              createdAt: 100,
              text: 'USER',
              meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
            },
            {
              kind: 'agent-text',
              id: 'm2',
              localId: null,
              createdAt: 200,
              text: 'ASSIST',
              meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'mid', ts: 200 } } },
            },
          ],
        },
      },
    }));

    const { createVoiceAgentSessionController } = await import('./VoiceAgentSessionController');
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_prev',
        retentionPolicy: 'resumable',
        initialContext: expect.stringContaining('USER'),
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        initialContext: expect.stringContaining('ASSIST'),
      }),
    );
  });
});
