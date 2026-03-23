import { describe, expect, it, vi } from 'vitest';

const startRealtimeSession = vi.fn(async () => {});
const stopRealtimeSession = vi.fn(async () => {});
const getCurrentRealtimeSessionId = vi.fn(() => {
  throw new Error('getCurrentRealtimeSessionId should not be called');
});
const sendTextMessage = vi.fn();
const sendContextualUpdate = vi.fn();
const getVoiceSession = vi.fn(() => ({ sendTextMessage, sendContextualUpdate }));
const isVoiceSessionStarted = vi.fn(() => true);
const appendVoiceConversationUserText = vi.fn();

const onVoiceStarted = vi.fn(() => 'initial-context');
const onVoiceStopped = vi.fn();

const state: any = {
  realtimeStatus: 'disconnected',
  realtimeMode: 'idle',
};

vi.mock('@/realtime/RealtimeSession', () => ({
  startRealtimeSession,
  stopRealtimeSession,
  getCurrentRealtimeSessionId,
  getVoiceSession,
  isVoiceSessionStarted,
}));

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onVoiceStarted,
    onVoiceStopped,
  },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => state,
  },
});
});

vi.mock('@/voice/sessionBinding/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: (params: any) => appendVoiceConversationUserText(params),
}));

describe('realtime elevenlabs voice adapter', () => {
  it('does not expose a per-session id in the snapshot', async () => {
    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    const snap = adapter.getSnapshot();
    expect(snap.sessionId).toBe(null);
  });

  it('starts when disconnected', async () => {
    state.realtimeStatus = 'disconnected';
    state.realtimeMode = 'idle';
    startRealtimeSession.mockReset();
    onVoiceStarted.mockReset();
    onVoiceStarted.mockReturnValueOnce('initial-context');

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });

    expect(onVoiceStarted).toHaveBeenCalledWith('s1');
    expect(startRealtimeSession).toHaveBeenCalledWith('s1', 'initial-context');
  });

  it('stops when connected', async () => {
    state.realtimeStatus = 'connected';
    stopRealtimeSession.mockReset();
    onVoiceStopped.mockReset();

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });

    expect(stopRealtimeSession).toHaveBeenCalledTimes(1);
    expect(onVoiceStopped).toHaveBeenCalledTimes(1);
  });

  it('routes typed sends through the active realtime session when already connected', async () => {
    sendTextMessage.mockReset();
    startRealtimeSession.mockReset();
    appendVoiceConversationUserText.mockReset();
    isVoiceSessionStarted.mockReturnValueOnce(true);

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });

    expect(startRealtimeSession).not.toHaveBeenCalled();
    expect(appendVoiceConversationUserText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });
    expect(sendTextMessage).toHaveBeenCalledWith('hello');
  });

  it('reopens realtime voice in text-only mode before sending when disconnected', async () => {
    sendTextMessage.mockReset();
    startRealtimeSession.mockReset();
    appendVoiceConversationUserText.mockReset();
    isVoiceSessionStarted.mockReturnValueOnce(false);

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });

    expect(startRealtimeSession).toHaveBeenCalledWith('voice-global', undefined, false, { textOnly: true });
    expect(appendVoiceConversationUserText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });
    expect(sendTextMessage).toHaveBeenCalledWith('hello');
  });
});
