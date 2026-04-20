import { describe, expect, it, vi } from 'vitest';

const startRealtimeSession = vi.fn(async () => {});
const stopRealtimeSession = vi.fn(async () => {});
const setRealtimeMicMuted = vi.fn();
const getRealtimeSessionSnapshot = vi.fn(() => ({
  adapterId: 'realtime_elevenlabs',
  sessionId: null,
  status: 'disconnected',
  mode: 'idle',
  canStop: false,
}));
const subscribeRealtimeSessionSnapshot = vi.fn(() => () => {});
const sendTextMessage = vi.fn();
const sendContextualUpdate = vi.fn();
const getVoiceSession = vi.fn(() => ({ sendTextMessage, sendContextualUpdate }));
const isVoiceSessionStarted = vi.fn(() => true);

const onVoiceStarted = vi.fn(() => 'initial-context');
const onVoiceStopped = vi.fn();

const state: any = {
  realtimeStatus: 'disconnected',
  realtimeMode: 'idle',
};

vi.mock('@/voice/runtime/realtime/RealtimeTransport', () => ({
  realtimeTransport: {
    startRealtimeSession,
    stopRealtimeSession,
    setMicMuted: setRealtimeMicMuted,
    getSessionSnapshot: getRealtimeSessionSnapshot,
    subscribe: subscribeRealtimeSessionSnapshot,
    getVoiceSession,
    isVoiceSessionStarted,
  },
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

describe('realtime elevenlabs voice adapter', () => {
  it('does not expose a per-session id in the snapshot', async () => {
    getRealtimeSessionSnapshot.mockReturnValueOnce({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    const snap = adapter.getSnapshot();
    expect(snap.sessionId).toBe(null);
  });

  it('reads transport-owned realtime snapshot instead of storage realtime state', async () => {
    state.realtimeStatus = 'disconnected';
    state.realtimeMode = 'idle';
    getRealtimeSessionSnapshot.mockReturnValueOnce({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
  });

  it('subscribes through the transport-owned realtime snapshot channel', async () => {
    const unsubscribe = vi.fn();
    subscribeRealtimeSessionSnapshot.mockReturnValueOnce(unsubscribe);

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();
    const listener = vi.fn();

    const stop = adapter.subscribe?.(listener);

    expect(subscribeRealtimeSessionSnapshot).toHaveBeenCalledWith(listener);
    expect(stop).toBe(unsubscribe);
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

  it('delegates toggle to the start path even when already connected', async () => {
    getRealtimeSessionSnapshot.mockReturnValueOnce({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
    startRealtimeSession.mockReset();
    onVoiceStarted.mockReset();
    onVoiceStarted.mockReturnValueOnce('initial-context');
    onVoiceStopped.mockReset();

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });

    expect(onVoiceStarted).toHaveBeenCalledWith('s1');
    expect(startRealtimeSession).toHaveBeenCalledWith('s1', 'initial-context');
    expect(stopRealtimeSession).not.toHaveBeenCalled();
    expect(onVoiceStopped).not.toHaveBeenCalled();
  });

  it('routes typed sends through the active realtime session when already connected', async () => {
    sendTextMessage.mockReset();
    startRealtimeSession.mockReset();
    isVoiceSessionStarted.mockReturnValueOnce(true);

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });

    expect(startRealtimeSession).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith('hello');
  });

  it('reopens realtime voice in text-only mode before sending when disconnected', async () => {
    sendTextMessage.mockReset();
    startRealtimeSession.mockReset();
    isVoiceSessionStarted.mockReturnValueOnce(false);

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });

    expect(startRealtimeSession).toHaveBeenCalledWith('voice-global', undefined, false, { textOnly: true });
    expect(sendTextMessage).toHaveBeenCalledWith('hello');
  });

  it('routes mute commands through the realtime transport session seam', async () => {
    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    await adapter.setMuted({ sessionId: 's1', muted: true });

    expect(setRealtimeMicMuted).toHaveBeenCalledWith(true);
  });
});
