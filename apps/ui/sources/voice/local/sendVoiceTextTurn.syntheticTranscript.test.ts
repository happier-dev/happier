import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUser = vi.fn();
const appendAssistant = vi.fn();
const appendNote = vi.fn();
const bindingTranscriptModeState: { current: 'synthetic' | 'native_session' } = { current: 'synthetic' };
const conversationModeState: { current: 'synthetic_agent' | 'direct_session' } = { current: 'synthetic_agent' };
const resolveToolSessionId = vi.fn<(params: unknown) => string>(() => 's1');
const sendSessionMessageHandler = vi.fn<(args: unknown) => Promise<string>>(
  async () => JSON.stringify({ ok: true, status: 'sent' }),
);
const sendMessage = vi.fn();

vi.mock('@/voice/binding/resolveVoiceBindingBySessionId', () => ({
  resolveVoiceBindingBySessionId: ({ sessionId }: { sessionId: string }) =>
    sessionId.trim() === 'voice-global'
      ? {
          adapterId: 'local_conversation',
          controlSessionId: 'voice-global',
          conversationSessionId: 'carrier-s1',
          transcriptMode: bindingTranscriptModeState.current,
          targetSessionId: 's1',
          updatedAt: 1,
        }
      : null,
}));

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
        sessionMessages: {},
      }),
    },
  });
});

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: (...args: any[]) => sendMessage(...args),
  },
}));

vi.mock('@/voice/local/localVoiceSettings', () => ({
  resolveLocalVoiceAdapterSettings: () => ({
    adapterId: 'local_conversation',
    config: {
      conversationMode: conversationModeState.current === 'synthetic_agent' ? 'agent' : 'direct_session',
      tts: { autoSpeakReplies: false },
    },
  }),
  parseLocalVoiceTtsSettings: () => ({
    provider: 'openai_compat',
    openaiCompat: { baseUrl: null },
    autoSpeakReplies: false,
  }),
}));

vi.mock('@/voice/runtime/fetchWithTimeout', () => ({
  resolveVoiceNetworkTimeoutMs: () => 15000,
}));

vi.mock('@/voice/output/TtsChunker', () => ({
  createTtsChunker: vi.fn(),
  resolveStreamingTtsChunkChars: () => 120,
}));

vi.mock('@/voice/output/speakAssistantText', () => ({
  speakAssistantText: vi.fn(),
}));

vi.mock('@/voice/runtime/waitForNextAssistantTextMessage', () => ({
  waitForNextAssistantTextMessage: vi.fn(),
}));

vi.mock('./runVoiceAgentTurnWithTools', () => ({
  runVoiceAgentTurnWithTools: async (params: any) => {
    let turnIndex = 0;
    while (true) {
      const turn = await params.voiceAgentSessions.sendTurn(params.sessionId, params.userText, {
        onTextDelta: params.onTextDelta,
        signal: params.signal,
      });
      const actions = Array.isArray(turn.actions) ? turn.actions : [];
      const hasSendAction = actions.some((action: any) => action?.t === 'sendSessionMessage');
      await params.onAssistantTurn?.({
        assistantText: hasSendAction
          ? 'I sent that to the coding assistant and am waiting for its update.'
          : turn.assistantText,
        turnIndex,
      });
      if (actions.length === 0) {
        return;
      }

      const toolResults = [];
      for (const action of actions) {
        if (action?.t !== 'sendSessionMessage') continue;
        const args = action.args ?? {};
        const resolvedSessionId = resolveToolSessionId(args?.sessionId);
        const rawResult = await sendSessionMessageHandler({ ...args, sessionId: resolvedSessionId });
        let result: unknown = rawResult;
        try {
          result = JSON.parse(String(rawResult));
        } catch {
          // Keep the raw result when the handler does not return JSON.
        }
        toolResults.push({ t: 'sendSessionMessage', args, result });
      }
      await params.onToolResults?.({ toolResults });
      turnIndex += 1;
    }
  },
}));

vi.mock('@/voice/tools/handlers', () => ({
  createVoiceToolHandlers: ({ resolveSessionId }: any) => ({
    sendSessionMessage: async (args: any) => {
      const resolvedSessionId = resolveSessionId(args?.sessionId);
      return await sendSessionMessageHandler({ ...args, sessionId: resolvedSessionId });
    },
  }),
}));

vi.mock('@/voice/tools/resolveToolSessionId', () => ({
  resolveToolSessionId: (params: any) => resolveToolSessionId(params),
}));

describe('sendVoiceTextTurn synthetic transcript mirroring', () => {
  beforeEach(() => {
    appendUser.mockReset();
    appendAssistant.mockReset();
    appendNote.mockReset();
    bindingTranscriptModeState.current = 'synthetic';
    conversationModeState.current = 'synthetic_agent';
    resolveToolSessionId.mockReset();
    resolveToolSessionId.mockReturnValue('s1');
    sendSessionMessageHandler.mockReset();
    sendSessionMessageHandler.mockResolvedValue(JSON.stringify({ ok: true, status: 'sent' }));
    sendMessage.mockReset();
    sendMessage.mockResolvedValue(undefined);
  });

  it('sends direct voice turns with an explicit direct-bypass reason', async () => {
    conversationModeState.current = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: {},
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

    expect(sendMessage).toHaveBeenCalledWith('s1', 'send this directly', undefined, undefined, {
      bypassPendingQueueReason: 'voice_turn',
    });
  });

  it('mirrors local agent user and assistant turns into the hidden conversation session without writing legacy activity events', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
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

  it('trims the control session id before mirroring synthetic transcript turns', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: ' voice-global ',
      settings: {},
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

  it('projects the local user turn even when the binding transcript mode is native_session', async () => {
    bindingTranscriptModeState.current = 'native_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
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

    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'project me immediately',
    });
  });

  it('normalizes sendSessionMessage preambles and appends concise tool execution notes into the hidden conversation session', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

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
      sessionId: 'voice-global',
      settings: {},
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
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

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
      sessionId: 'voice-global',
      settings: {},
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
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await expect(
      sendVoiceTextTurn({
        sessionId: 'voice-global',
        settings: {},
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
    ).rejects.toThrow('send_failed');
  });
});
