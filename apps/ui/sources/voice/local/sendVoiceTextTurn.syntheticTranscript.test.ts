import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const appendUser = vi.fn();
const appendAssistant = vi.fn();
const appendNote = vi.fn();
const bindingTranscriptModeState: { current: 'synthetic' | 'native_session' } = { current: 'synthetic' };
const conversationModeState: { current: 'synthetic_agent' | 'direct_session' } = { current: 'synthetic_agent' };
const sendSessionMessageHandler = vi.fn<(args: unknown) => Promise<unknown>>(
  async () => ({ ok: true, status: 'sent' }),
);
const sendMessage = vi.fn();
const submitMessage = vi.fn();
const enqueuePendingMessage = vi.fn();
const markPendingDeliveryHandled = vi.fn();

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: (params: any) => appendUser(params),
  appendVoiceConversationAssistantText: (params: any) => appendAssistant(params),
  appendVoiceConversationNoteText: (params: any) => appendNote(params),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    storage: {
      getState: () => ({
        settings: buildAccountSettings(),
        sessions: {
          s1: {
            id: 's1',
            active: true,
            metadata: { machineId: 'machine-1', path: '/workspace/s1' },
          },
          'carrier-s1': {
            id: 'carrier-s1',
            active: true,
            updatedAt: 1,
            metadata: {
              machineId: 'machine-1',
              path: '/workspace/s1',
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's1' },
            },
          },
        },
        machines: {
          'machine-1': { id: 'machine-1', active: true, metadata: {} },
        },
        sessionMessages: {},
      }),
    },
  });
});

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: (...args: any[]) => sendMessage(...args),
    submitMessage: (...args: any[]) => submitMessage(...args),
    enqueuePendingMessage: (...args: any[]) => enqueuePendingMessage(...args),
    markPendingDeliveryHandled: (...args: any[]) => markPendingDeliveryHandled(...args),
    ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
    refreshSessionMessages: vi.fn(async () => {}),
    patchSessionMetadataWithRetry: vi.fn(async () => {}),
    encryption: { getSessionEncryption: vi.fn(() => ({})) },
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
  sendSessionMessageWithServerScope: (args: unknown) => sendSessionMessageHandler(args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
  subscribeActiveServer: () => () => {},
}));

function buildAccountSettings() {
  return {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: conversationModeState.current === 'synthetic_agent' ? 'agent' : 'direct_session',
            agent: {
              backend: bindingTranscriptModeState.current === 'native_session' ? 'daemon' : 'openai_compat',
            },
            tts: { autoSpeakReplies: false },
            streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 120 },
          },
        },
      },
    },
  };
}

async function loadSendVoiceTextTurnWithProductionBinding() {
  const [
    { createLocalConversationVoiceAdapter },
    { registerVoiceAdapters, resetVoiceAdapterRegistryForTests },
    { voiceSessionBindingManager },
    { voiceSessionBindingStore },
    localVoiceTextTurn,
  ] = await Promise.all([
    import('@/voice/adapters/localConversation/localConversationAdapter'),
    import('@/voice/session/voiceAdapterRegistry'),
    import('@/voice/binding/voiceConversationBindingRuntime'),
    import('@/voice/binding/voiceConversationBindingStore'),
    import('./sendVoiceTextTurn'),
  ]);

  resetVoiceAdapterRegistryForTests();
  registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
  for (const binding of voiceSessionBindingManager.list()) {
    voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
  }
  const binding = await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    requestedTargetSessionId: 's1',
  });
  expect(binding).toMatchObject({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId: 'carrier-s1',
    transcriptMode: bindingTranscriptModeState.current,
    targetSessionId: 's1',
  });
  return localVoiceTextTurn;
}

describe('sendVoiceTextTurn synthetic transcript mirroring', () => {
  beforeEach(async () => {
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.reset();
    appendUser.mockReset();
    appendAssistant.mockReset();
    appendNote.mockReset();
    bindingTranscriptModeState.current = 'synthetic';
    conversationModeState.current = 'synthetic_agent';
    sendSessionMessageHandler.mockReset();
    sendSessionMessageHandler.mockResolvedValue({ ok: true, status: 'sent' });
    sendMessage.mockReset();
    sendMessage.mockResolvedValue(undefined);
    submitMessage.mockReset();
    submitMessage.mockResolvedValue(undefined);
    enqueuePendingMessage.mockReset();
    enqueuePendingMessage.mockImplementation(async (_sessionId, _text, _displayText, _meta, options) => ({
      localId: options.localId,
      accepted: true,
      externalHandoffClaimed: true,
    }));
    markPendingDeliveryHandled.mockReset();
    markPendingDeliveryHandled.mockResolvedValue(undefined);
  });

  it('submits direct coding-session voice turns through durable immediate delivery', async () => {
    conversationModeState.current = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: buildAccountSettings(),
      userText: 'send this directly',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: async () => ({ assistantText: '', actions: [] }),
      },
    });

    expect(submitMessage).toHaveBeenCalledWith('s1', 'send this directly', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('mirrors local agent user and assistant turns into the hidden conversation session without writing legacy activity events', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'list the backends',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: async () => ({ assistantText: 'I found Claude and Codex.', actions: [] }),
      },
    });

    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'list the backends',
    });
    expect(appendAssistant).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'I found Claude and Codex.',
    });
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('durably enqueues synthetic speech input before one local-agent dispatch', async () => {
    const events: string[] = [];
    enqueuePendingMessage.mockImplementationOnce(async (_sessionId, _text, _displayText, _meta, options) => {
      events.push(`enqueue:${options.localId}`);
      return { localId: options.localId, accepted: true, externalHandoffClaimed: true };
    });
    const sendTurn = vi.fn(async () => {
      const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
      events.push(`dispatch:${localId}`);
      return { assistantText: 'done', actions: [] };
    });
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'from microphone',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: { sendTurn },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(localId).toEqual(expect.any(String));
    expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([`enqueue:${localId}`, `dispatch:${localId}`]);
  });

  it('trims the control session id before mirroring synthetic transcript turns', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: ` ${VOICE_AGENT_GLOBAL_SESSION_ID} `,
      settings: buildAccountSettings(),
      userText: 'list the backends',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: async () => ({ assistantText: 'I found Claude and Codex.', actions: [] }),
      },
    });

    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'list the backends',
    });
    expect(appendAssistant).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'I found Claude and Codex.',
    });
  });

  it('does not duplicate daemon-owned transcript projection for native-session bindings', async () => {
    bindingTranscriptModeState.current = 'native_session';
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'project me immediately',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: async () => ({ assistantText: 'Projected.', actions: [] }),
      },
    });

    expect(appendUser).not.toHaveBeenCalled();
    expect(appendAssistant).not.toHaveBeenCalled();
  });

  it('normalizes sendSessionMessage preambles and appends concise tool execution notes into the hidden conversation session', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(appendAssistant).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'carrier-s1',
      text: 'I sent that to the coding assistant and am waiting for its update.',
    });
    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Tool result: sendSessionMessage succeeded',
    });
  });

  it('resolves implicit tool session ids from the bound target session', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(sendSessionMessageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
      }),
    );
  });

  it('rethrows agent-mode send failures after recording the error state', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await expect(
      sendVoiceTextTurn({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        settings: buildAccountSettings(),
        userText: 'send hello',
        playbackController: {
          registerStopper: () => () => {},
          interrupt: () => {},
          captureEpoch: () => 1,
          isEpochCurrent: () => true,
        },
        voiceAgentSessions: {
          sendTurn: async () => {
            throw new Error('send_failed');
          },
        },
      }),
    ).rejects.toThrow('voice_turn_dispatch_ambiguous');
  });
});
