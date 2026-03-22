import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUser = vi.fn();
const appendAssistant = vi.fn();
const appendNote = vi.fn();
const resolveToolSessionId = vi.fn<(params: unknown) => string>(() => 's1');
const sendSessionMessageHandler = vi.fn<(args: unknown) => Promise<string>>(
  async () => JSON.stringify({ ok: true, status: 'sent' }),
);

vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: { controlSessionId: string }) =>
    params.controlSessionId === 'voice-global'
      ? {
          adapterId: 'local_conversation',
          controlSessionId: 'voice-global',
          conversationSessionId: 'carrier-s1',
          transcriptMode: 'synthetic',
          targetSessionId: 's1',
          updatedAt: 1,
        }
      : null,
  resolveVoiceSessionBindingByConversationSessionId: () => null,
}));

vi.mock('@/voice/sessionBinding/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: (params: any) => appendUser(params),
  appendVoiceConversationAssistantText: (params: any) => appendAssistant(params),
  appendVoiceConversationNoteText: (params: any) => appendNote(params),
}));

vi.mock('@/voice/activity/voiceActivityController', () => ({
  voiceActivityController: {
    appendUserText: vi.fn(),
    appendAssistantText: vi.fn(),
    appendError: vi.fn(),
    appendActionExecuted: vi.fn(),
  },
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
    sendMessage: vi.fn(),
  },
}));

vi.mock('@/voice/local/localVoiceSettings', () => ({
  resolveLocalVoiceAdapterSettings: () => ({
    adapterId: 'local_conversation',
    config: {
      conversationMode: 'agent',
      tts: { autoSpeakReplies: false },
    },
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

vi.mock('./localVoiceState', () => ({
  patchLocalVoiceState: vi.fn(),
  setIdleStateUnlessRecording: vi.fn(),
}));

describe('sendVoiceTextTurn synthetic transcript mirroring', () => {
  beforeEach(() => {
    appendUser.mockReset();
    appendAssistant.mockReset();
    appendNote.mockReset();
    resolveToolSessionId.mockReset();
    resolveToolSessionId.mockReturnValue('s1');
    sendSessionMessageHandler.mockReset();
    sendSessionMessageHandler.mockResolvedValue(JSON.stringify({ ok: true, status: 'sent' }));
  });

  it('mirrors local agent user and assistant turns into the hidden conversation session', async () => {
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
      text: '[Voice] Tool result: sendSessionMessage succeeded',
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
