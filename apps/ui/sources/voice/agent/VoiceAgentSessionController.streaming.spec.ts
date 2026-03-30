import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { FeatureDecision } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async () => ({ voiceAgentId: 'm1' }));
const startTurnStream = vi.fn(async (_args: unknown) => ({ streamId: 'stream-1' }));
const readTurnStream = vi.fn();
const cancelTurnStream = vi.fn(async () => ({ ok: true }));
const sendTurn = vi.fn(async () => ({ assistantText: 'fallback', actions: [] }));
const welcome = vi.fn(async () => ({ assistantText: 'Welcome!' }));
const commit = vi.fn(async () => ({ commitText: 'commit' }));
const stop = vi.fn(async () => ({ ok: true }));
const openAiStart = vi.fn(async () => ({ voiceAgentId: 'oa1' }));
const openAiWelcome = vi.fn(async () => ({ assistantText: 'Welcome (openai_compat)!' }));
const isRuntimeFeatureEnabled = vi.fn<(args: any) => Promise<boolean>>(async () => true);
const resolveRuntimeFeatureDecision = vi.fn<(args: any) => Promise<FeatureDecision>>(async (args: any) => ({
  featureId: args?.featureId,
  state: 'enabled',
  blockedBy: null,
  blockerCode: 'none',
  diagnostics: [],
  evaluatedAt: Date.now(),
  scope: {
    scopeKind: 'runtime',
    ...(args?.serverId ? { serverId: String(args.serverId) } : {}),
  },
}));
const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: { forceRefresh?: boolean }) => {});
const refreshSessionMessages = vi.fn(async (_sessionId: string) => {});
const ensureVoiceAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const buildVoiceInitialContext = vi.fn((sessionId: string, options?: { targetSessionId?: string | null }) => {
  const targetSessionId = typeof options?.targetSessionId === 'string' ? options.targetSessionId.trim() : '';
  if (targetSessionId) return `TARGET_CONTEXT:${sessionId}->${targetSessionId}`;
  return `ACTIVE_CONTEXT:${sessionId}`;
});

type TurnStreamReadResult = {
  streamId: string;
  events: Array<{ t: 'done'; assistantText: string; actions: unknown[] }>;
  nextCursor: number;
  done: boolean;
};

function trackPromise<T>(promise: Promise<T>): Readonly<{
  isSettled: () => boolean;
  settled: Promise<
    | { status: 'resolved'; value: T }
    | { status: 'rejected'; reason: unknown }
  >;
}> {
  let settled = false;
  const settledPromise = promise.then(
    (value) => {
      settled = true;
      return { status: 'resolved' as const, value };
    },
    (reason) => {
      settled = true;
      return { status: 'rejected' as const, reason };
    },
  );

  return {
    isSettled: () => settled,
    settled: settledPromise,
  };
}

function createVoiceControllerState(options: Readonly<{
  sessions?: Record<string, unknown>;
  sessionMessages?: Record<string, unknown>;
  machines?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  voice?: Readonly<{
    providerId?: string;
    streaming?: Readonly<{
      enabled?: boolean;
      turnReadPollIntervalMs?: number;
      turnReadMaxEvents?: number;
      turnStreamTimeoutMs?: number | null;
    }>;
    agent?: Record<string, unknown>;
    networkTimeoutMs?: number;
  }>;
}> = {}): {
  settings: {
    voice: {
      providerId: string;
      adapters: {
        local_conversation: {
          streaming: {
            enabled: boolean;
            turnReadPollIntervalMs: number;
            turnReadMaxEvents: number;
            turnStreamTimeoutMs: number | null;
          };
          agent: Record<string, unknown>;
          networkTimeoutMs: number;
        };
      };
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  sessions: Record<string, unknown>;
  sessionMessages: Record<string, unknown>;
  machines?: Record<string, unknown>;
} {
  const voice = {
    providerId: options.voice?.providerId ?? 'local_conversation',
    adapters: {
      local_conversation: {
        streaming: {
          enabled: true,
          turnReadPollIntervalMs: 50,
          turnReadMaxEvents: 7,
          turnStreamTimeoutMs: 1200,
          ...(options.voice?.streaming ?? {}),
        },
        agent: {
          backend: 'daemon',
          transcript: { persistenceMode: 'ephemeral', epoch: 0 },
          ...(options.voice?.agent ?? {}),
        },
        networkTimeoutMs: options.voice?.networkTimeoutMs ?? 15_000,
      },
    },
  };

  return {
    settings: {
      voice,
      ...(options.settings ?? {}),
    },
    sessions: options.sessions ?? {
      sys_voice: {
        id: 'sys_voice',
        active: true,
        modelMode: 'default',
        metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
      },
      s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
    },
    sessionMessages: options.sessionMessages ?? {},
    ...(options.machines ? { machines: options.machines } : {}),
  };
}

function setVoiceControllerState(options?: Parameters<typeof createVoiceControllerState>[0]): void {
  getState.mockImplementation(() => createVoiceControllerState(options));
}

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
  DaemonVoiceAgentClient: class {
    start = start;
    startTurnStream = startTurnStream;
    readTurnStream = readTurnStream;
    cancelTurnStream = cancelTurnStream;
    sendTurn = sendTurn;
    welcome = welcome;
    commit = commit;
    stop = stop;
  },
}));

vi.mock('@/voice/agent/openaiCompatVoiceAgentClient', () => ({
  OpenAiCompatVoiceAgentClient: class {
    start = openAiStart;
    welcome = openAiWelcome;
    startTurnStream = vi.fn();
    readTurnStream = vi.fn();
    cancelTurnStream = vi.fn();
    sendTurn = vi.fn();
    commit = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('@/voice/context/buildVoiceInitialContext', () => ({
  buildVoiceInitialContext: (sessionId: string, options?: { targetSessionId?: string | null }) =>
    buildVoiceInitialContext(sessionId, options),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { forceRefresh?: boolean }) =>
      ensureSessionVisibleForMessageRoute(sessionId, options),
    refreshSessionMessages: (sessionId: string) => refreshSessionMessages(sessionId),
  },
}));

vi.mock('@/voice/agent/ensureVoiceAgentInstallablesBackground', () => ({
  ensureVoiceAgentInstallablesBackground: (args: any) => ensureVoiceAgentInstallablesBackground(args),
}));

vi.mock('@/voice/agent/resolveDaemonVoiceAgentModels', () => ({
  resolveDaemonVoiceAgentModelIds: () => ({ chatModelId: 'chat', commitModelId: 'commit' }),
}));

const getState = vi.fn((): any => ({
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
    sys_voice: { id: 'sys_voice', active: true, modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
    s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
  },
  sessionMessages: {},
}));

const storageListeners = new Set<() => void>();

installVoiceAgentCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => getState(),
        subscribe: (listener: () => void) => {
          storageListeners.add(listener);
          return () => storageListeners.delete(listener);
        },
      },
    });
  },
});

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  isRuntimeFeatureEnabled: (args: any) => isRuntimeFeatureEnabled(args),
  resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
}));

describe('VoiceAgentSessionController (streaming)', () => {
  let createVoiceAgentSessionController: () => any;

  beforeAll(async () => {
    ({ createVoiceAgentSessionController } = await import('./VoiceAgentSessionController'));
  }, 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    getState.mockReset();
    setVoiceControllerState();
    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, trackedSessionIds: [], lastFocusedSessionId: null } as any);
    isRuntimeFeatureEnabled.mockReset();
    isRuntimeFeatureEnabled.mockResolvedValue(true);
    ensureSessionVisibleForMessageRoute.mockReset();
    refreshSessionMessages.mockReset();
    ensureVoiceAgentInstallablesBackground.mockReset();
    buildVoiceInitialContext.mockClear();
    voiceSessionBindingStore.setState((state) => ({ ...state, bindingsByConversationSessionId: {} }));
    start.mockReset();
    start.mockImplementation(async () => ({ voiceAgentId: 'm1' }));
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
    welcome.mockClear();
    openAiStart.mockClear();
    openAiWelcome.mockClear();
    commit.mockClear();
    stop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    storageListeners.clear();
  });

  it('uses configured maxEvents when reading the streamed turn', async () => {
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn('s1', 'hello');

    expect(readTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 7,
      }),
    );
  });

  it('hydrates the bound target session before starting global local voice', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    } as any);

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(refreshSessionMessages).toHaveBeenCalledWith('s1');
  });

  it('refreshes stale bound target state before starting global local voice', async () => {
    const state = {
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
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    };
    getState.mockImplementation(() => state);
    ensureSessionVisibleForMessageRoute.mockImplementationOnce(async (_sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh === true) {
        state.sessions.s1 = {
          ...state.sessions.s1,
          active: false,
          presence: 'offline',
        };
      }
    });
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    } as any);

    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      message: 'Target session is inactive. Resume it before starting local voice.',
      code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE',
    });

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(start).not.toHaveBeenCalled();
  });

  it('restarts the daemon voice agent and retries once when the run reports execution_run_busy', async () => {
    start
      .mockResolvedValueOnce({ voiceAgentId: 'busy-run' })
      .mockResolvedValueOnce({ voiceAgentId: 'fresh-run' });
    startTurnStream
      .mockRejectedValueOnce(Object.assign(new Error('Voice agent busy'), { rpcErrorCode: 'execution_run_busy' }))
      .mockResolvedValueOnce({ streamId: 'stream-2' });
    readTurnStream.mockResolvedValueOnce({
      streamId: 'stream-2',
      events: [{ t: 'done', assistantText: 'recovered', actions: [] }],
      nextCursor: 1,
      done: true,
    } satisfies TurnStreamReadResult);

    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(stop).toHaveBeenCalledWith({ sessionId: 's1', voiceAgentId: 'busy-run' });
    expect(start).toHaveBeenCalledTimes(2);
    expect(startTurnStream).toHaveBeenCalledTimes(2);
  });

  it('surfaces a clear error when starting local voice on an inactive target session', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: false, modelMode: 'default', metadata: { flavor: 'claude' } },
      },
    });

    const controller = createVoiceAgentSessionController();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session is inactive. Resume it before starting local voice.',
      code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when starting local voice on an offline target session', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: true, presence: 'offline', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
    });

    const controller = createVoiceAgentSessionController();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session is offline. Reconnect it before starting local voice.',
      code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when starting local voice on a target flavor without local control support', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'kimi' } },
      },
    });

    const controller = createVoiceAgentSessionController();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session provider does not support local voice control.',
      code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when starting local voice on an OpenCode ACP session without effective local control support', async () => {
    setVoiceControllerState({
      settings: {
        opencodeBackendMode: 'server',
      },
      sessions: {
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'opencode', opencodeBackendMode: 'acp' },
        },
      },
    });

    const controller = createVoiceAgentSessionController();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session provider does not support local voice control.',
      code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('always enables daemon transcript persistence for the hidden voice conversation session', async () => {
    setVoiceControllerState({
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
    });

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        transcript: { persistenceMode: 'persistent', epoch: 0 },
      }),
    );
  });

  it('injects a one-time welcome instruction into the first user turn when welcome is enabled (on_first_turn)', async () => {
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
              agent: {
                backend: 'daemon',
                welcome: { enabled: true, mode: 'on_first_turn', templateId: null },
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', active: true, modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    await controller.sendTurn('s1', 'hello');

    expect(startTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: expect.stringContaining('greeting'),
      }),
    );
  });

  it('delivers interrupting text updates as immediate follow-up turns', async () => {
    const controller: any = createVoiceAgentSessionController();

    await controller.sendTextUpdate('s1', 'Permission required for writing /tmp/file.txt. Ask whether to allow it.');

    expect(startTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'Permission required for writing /tmp/file.txt. Ask whether to allow it.',
      }),
    );
  });

  it('queues interrupting text updates behind an in-flight turn for the same session', async () => {
    const firstStartTurn = createDeferred<void>();
    const firstReadReady = createDeferred<void>();
    const streamReadState: {
      resolveFirstRead: ((value: TurnStreamReadResult) => void) | null;
    } = {
      resolveFirstRead: null,
    };
    readTurnStream.mockImplementation(async ({ streamId }: any) => {
      if (streamId === 'stream-1') {
        return await new Promise<TurnStreamReadResult>((resolve) => {
          streamReadState.resolveFirstRead = resolve;
          firstReadReady.resolve();
        });
      }
      return {
        streamId,
        events: [{ t: 'done', assistantText: 'follow-up', actions: [] }],
        nextCursor: 1,
        done: true,
      };
    });
    startTurnStream.mockImplementation(async ({ userText }: any) => {
      if (userText === 'hello') {
        firstStartTurn.resolve();
      }
      return {
        streamId: userText === 'hello' ? 'stream-1' : 'stream-2',
      };
    });

    const controller: any = createVoiceAgentSessionController();

    const firstTurn = controller.sendTurn('s1', 'hello');
    await firstStartTurn.promise;
    await firstReadReady.promise;
    expect(startTurnStream).toHaveBeenCalledTimes(1);
    const textUpdate = controller.sendTextUpdate('s1', 'Permission required. Ask the human whether to allow it.');

    expect(startTurnStream).toHaveBeenCalledTimes(1);

    const finishFirstRead = streamReadState.resolveFirstRead;
    if (!finishFirstRead) {
      throw new Error('Expected first stream read resolver to be captured');
    }
    finishFirstRead({
      streamId: 'stream-1',
      events: [{ t: 'done', assistantText: 'ok', actions: [] }],
      nextCursor: 1,
      done: true,
    });

    await expect(firstTurn).resolves.toMatchObject({ assistantText: 'ok' });
    await expect(textUpdate).resolves.toMatchObject({ assistantText: 'follow-up' });
    expect(startTurnStream).toHaveBeenCalledTimes(2);
    expect(startTurnStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userText: 'Permission required. Ask the human whether to allow it.',
      }),
    );
  });

  it('can emit an immediate welcome via ensureRunningAndMaybeWelcome, and does not inject a greeting into the next user turn', async () => {
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
              agent: {
                backend: 'daemon',
                welcome: { enabled: true, mode: 'immediate', templateId: null },
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
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
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    const welcomed = await controller.ensureRunningAndMaybeWelcome('s1');
    expect(welcomed).toBe('Welcome!');
    expect(welcome).toHaveBeenCalledTimes(1);

    await controller.sendTurn('s1', 'hello');
    const payload = (startTurnStream.mock.calls[0]?.[0] as any)?.userText ?? '';
    expect(String(payload)).not.toContain('greeting');
  });

  it('can emit an immediate welcome for openai_compat backend', async () => {
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
              agent: {
                backend: 'openai_compat',
                welcome: { enabled: true, mode: 'immediate', templateId: null },
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
                openaiCompat: {
                  chatBaseUrl: 'http://localhost:9999',
                  chatApiKey: null,
                  chatModel: 'default',
                  commitModel: 'default',
                },
              },
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
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    const welcomed = await controller.ensureRunningAndMaybeWelcome('s1');
    expect(welcomed).toBe('Welcome (openai_compat)!');
    expect(openAiWelcome).toHaveBeenCalledTimes(1);
  });

  it('does not use ready_handshake bootstrap when immediate welcome is enabled (welcome acts as the bootstrap prompt)', async () => {
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
              tts: { autoSpeakReplies: true },
              agent: {
                backend: 'daemon',
                prewarmOnConnect: true,
                welcome: { enabled: true, mode: 'immediate', templateId: null },
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
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
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    await controller.ensureRunningAndMaybeWelcome('s1');

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ bootstrapMode: 'none' }));
    expect(welcome).toHaveBeenCalledTimes(1);
  });

  it('uses ready_handshake bootstrap when prewarm is enabled but auto-speak is disabled (even if welcome immediate is enabled)', async () => {
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
              tts: { autoSpeakReplies: false },
              agent: {
                backend: 'daemon',
                prewarmOnConnect: true,
                welcome: { enabled: true, mode: 'immediate', templateId: null },
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
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
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
    }));

    const controller = createVoiceAgentSessionController();
    await controller.ensureRunning('s1');

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ bootstrapMode: 'ready_handshake', bootstrapTimeoutMs: 60_000 }));
  });

  it('prefetches relevant agent installables before starting a daemon voice agent session', async () => {
    getState.mockImplementation(() => ({
      settings: {
        codexBackendMode: 'acp',
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
              agent: {
                backend: 'daemon',
                agentSource: 'agent',
                agentId: 'codex',
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude', machineId: 'machine-1' },
        },
      },
      machines: {
        'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    await controller.ensureRunning('s1');

    expect(ensureVoiceAgentInstallablesBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        sessionId: 's1',
      }),
    );
    expect(start).toHaveBeenCalled();
  });

  it('passes the effective disabled voice action ids into daemon starts', async () => {
    getState.mockImplementation(() => ({
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'review.start': { enabled: true, disabledSurfaces: ['voice_tool'], disabledPlacements: [] },
          },
        },
        voice: {
          privacy: {
            shareDeviceInventory: false,
          },
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();
    await controller.ensureRunning('s1');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        disabledActionIds: expect.arrayContaining([
          'review.start',
          'paths.list_recent',
          'machines.list',
          'servers.list',
        ]),
      }),
    );
  });

  it('times out using configured turnStreamTimeoutMs (not a hard-coded poll count)', async () => {
    readTurnStream.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    const controller = createVoiceAgentSessionController();
    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1300 });

    const outcome = await sendTurnOutcome.settled;
    if (outcome.status !== 'rejected') {
      throw new Error(`Expected rejection outcome, received ${outcome.status}`);
    }
    expect(String(outcome.reason)).toContain('stream_timeout');
    expect(cancelTurnStream).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to networkTimeoutMs when turnStreamTimeoutMs is null', async () => {
    let readCount = 0;
    readTurnStream.mockImplementation(async () => {
      readCount += 1;
      if (readCount >= 8) {
        return {
          streamId: 'stream-1',
          events: [{ t: 'done', assistantText: 'ok', actions: [] }],
          nextCursor: readCount,
          done: true,
        };
      }
      return {
        streamId: 'stream-1',
        events: [],
        nextCursor: readCount,
        done: false,
      };
    });
    getState.mockImplementation(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: 250,
            turnStreamTimeoutMs: null,
          },
          networkTimeoutMs: 1000,
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
        },
      }),
    );

    const controller = createVoiceAgentSessionController();
    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1800 });

    await expect(sendTurnOutcome.settled).resolves.toMatchObject({
      status: 'resolved',
      value: { assistantText: 'ok', actions: [] },
    });
    expect(readCount).toBeGreaterThanOrEqual(8);
    expect(cancelTurnStream).toHaveBeenCalledTimes(0);
  });

  it('supports long streamed turns (does not clamp turnStreamTimeoutMs to 60s)', async () => {
    readTurnStream.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    getState.mockImplementation(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnStreamTimeoutMs: 65_000,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
        },
      }),
    );

    const controller = createVoiceAgentSessionController();

    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 61_000 });
    expect(sendTurnOutcome.isSettled()).toBe(false);

    await flushHookEffects({ cycles: 1, advanceTimersMs: 4_000 });
    const outcome = await sendTurnOutcome.settled;
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(String((outcome.status === 'rejected' ? outcome.reason : null) as any)).toContain('stream_timeout');
  });

  it('aborts a streamed turn when the provided abort signal is aborted', async () => {
    try {
      const readTurnStarted = createDeferred<void>();
      readTurnStream.mockImplementation(async () => {
        readTurnStarted.resolve();
        return {
          streamId: 'stream-1',
          events: [],
          nextCursor: 1,
          done: false,
        };
      });

      const controller = createVoiceAgentSessionController();
      const abortController = new AbortController();

      const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello', { signal: abortController.signal } as any));

      await readTurnStarted.promise;

      abortController.abort();

      await flushHookEffects({ cycles: 1, advanceTimersMs: 10 });

      const outcome = await sendTurnOutcome.settled;
      if (outcome.status !== 'rejected') {
        throw new Error(`Expected rejected outcome, received ${outcome.status}`);
      }
      expect(String(outcome.reason)).toContain('turn_aborted');
      expect(cancelTurnStream).toHaveBeenCalledTimes(1);
    } finally {
      // Ensure we don't leak the in-flight promise if abort isn't implemented yet.
      await flushHookEffects({ cycles: 1, advanceTimersMs: 10 });
      vi.useRealTimers();
    }
  });

  it('supports very long streamed turns (does not clamp turnStreamTimeoutMs to 10min)', async () => {
    readTurnStream.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    getState.mockImplementation(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: 500,
            turnStreamTimeoutMs: 900_000,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
        },
      }),
    );

    const controller = createVoiceAgentSessionController();

    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 899_000 });
    expect(sendTurnOutcome.isSettled()).toBe(false);

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
    const outcome = await sendTurnOutcome.settled;
    if (outcome.status !== 'rejected') {
      throw new Error(`Expected rejection outcome, received ${outcome.status}`);
    }
    expect(String(outcome.reason)).toContain('stream_timeout');
    expect(cancelTurnStream).toHaveBeenCalledTimes(1);
  });

  it('ignores non-finite or invalid streaming config values (does not short-circuit the stream loop)', async () => {
    const { voiceSettingsDefaults } = await import('@/sync/domains/settings/voiceSettings');

    getState.mockImplementation(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: -10,
            turnReadMaxEvents: Number.NaN,
            turnStreamTimeoutMs: Number.NaN,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
        },
      }),
    );

    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({ assistantText: 'ok' });
    expect(readTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: voiceSettingsDefaults.adapters.local_conversation.streaming.turnReadMaxEvents,
      }),
    );
      expect(cancelTurnStream).toHaveBeenCalledTimes(0);
  });

  it('uses the hidden voice conversation session id when starting the daemon agent for the global agent session', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(startTurnStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(readTurnStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('queues the full target-session context into the first turn instead of the bootstrap prompt for hidden voice-home starts', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    } as any);

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        initialContext: 'ACTIVE_CONTEXT:__voice_agent__',
      }),
    );
    expect(startTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        userText: expect.stringContaining('TARGET_CONTEXT:__voice_agent__->s1'),
        displayUserText: 'hello',
      }),
    );
  });

  it('passes the clean user turn separately from wrapped context updates when streaming a daemon voice turn', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

    const controller = createVoiceAgentSessionController();
    controller.appendContextUpdate(VOICE_AGENT_GLOBAL_SESSION_ID, 'Session asks what should be handled in this workspace.');

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Create the file.');

    expect(startTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        userText: expect.stringContaining('Context updates since your last voice turn'),
        displayUserText: 'Create the file.',
      }),
    );
  });

  it('recovers empty daemon streamed assistant text from the hidden session transcript when the transcript already contains the committed reply', async () => {
    const sessionState: any = {
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
              agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 0 } },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {
        sys_voice: {
          isLoaded: true,
          messages: [],
        },
      },
    };
    getState.mockImplementation(() => sessionState);
    readTurnStream.mockImplementation(async () => {
      sessionState.sessionMessages.sys_voice.messages = [
        {
          kind: 'agent-text',
          id: 'm-agent-1',
          localId: null,
          createdAt: 123,
          text: 'LOCAL_HELLO',
        },
      ];
      storageListeners.forEach((listener) => listener());
      return {
        streamId: 'stream-1',
        events: [{ t: 'done', assistantText: '', actions: [] }],
        nextCursor: 1,
        done: true,
      };
    });

    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'LOCAL_HELLO',
      actions: [],
    });
  });

  it('keeps the hidden voice conversation session as the global daemon anchor even when another target session is active', async () => {
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
              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      machines: {
        machine_stale: { id: 'machine_stale', active: false, metadata: { host: 'stale', happyHomeDir: '/Users/leeroy/.happier/stale' } },
        machine_active: { id: 'machine_active', active: true, metadata: { host: 'active', happyHomeDir: '/Users/leeroy/.happier/active' } },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            machineId: 'machine_active',
            path: '/Users/leeroy/.happier/active/voice-agent',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude', machineId: 'machine_active', path: '/Users/leeroy/Documents/Development/happier/dev' },
        },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(startTurnStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('does not retry global daemon start on another session when the hidden voice conversation session rejects the payload', async () => {
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
      machines: {
        machine_active: { id: 'machine_active', active: true, metadata: { host: 'active' } },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          updatedAt: 20,
          modelMode: 'default',
          metadata: { flavor: 'claude', machineId: 'machine_active', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s_good: { id: 's_good', active: true, presence: 'online', updatedAt: 10, modelMode: 'default', metadata: { flavor: 'claude', machineId: 'machine_active' } },
      },
      sessionMessages: {},
    }));
    start.mockImplementation((async (params: any) => {
      if (params.sessionId === 'sys_voice') {
        throw Object.assign(new Error('Invalid params'), { rpcErrorCode: 'execution_run_invalid_action_input' });
      }
      return { voiceAgentId: 'm1' };
    }) as any);

    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      rpcErrorCode: 'execution_run_invalid_action_input',
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(startTurnStream).not.toHaveBeenCalled();
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
              agent: {
                backend: 'daemon',
                transcript: { persistenceMode: 'persistent', epoch: 3 },
                replay: { strategy: 'summary_plus_recent', recentMessagesCount: 16 },
              },
              networkTimeoutMs: 15_000,
            },
          },
        },
        sessionReplaySummaryRunnerV1: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            voiceAgentRunV1: {
              v: 1,
              runId: 'run_prev',
              backendId: 'claude',
              resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
              updatedAtMs: 123,
              transcriptContractVersion: 2,
            },
          },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
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

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        retentionPolicy: 'resumable',
        replay: expect.objectContaining({
          kind: 'voice_session.v1',
          previousSessionId: 'sys_voice',
          transcriptEpoch: 3,
          strategy: 'summary_plus_recent',
          recentMessagesCount: 16,
        }),
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: expect.objectContaining({
          summaryRunner: expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          }),
        }),
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.not.objectContaining({
        initialContext: expect.stringContaining('USER'),
      }),
    );
  });

  it('passes resume=true to stream_start when provider-resume is enabled for a persistent global agent', async () => {
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
              agent: {
                backend: 'daemon',
                resumabilityMode: 'provider_resume',
                providerResume: { fallbackToReplay: false },
                transcript: { persistenceMode: 'persistent', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', active: true, modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(startTurnStream).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });
});
