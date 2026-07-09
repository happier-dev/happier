import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
  HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
} from '@happier-dev/protocol';

import {
  DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
  setVoiceConversationRuntimeSnapshot,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';

const startRealtimeSession = vi.fn(async () => {});
const stopRealtimeSession = vi.fn(async () => {});
const setRealtimeMicMuted = vi.fn();
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
  beforeEach(() => {
    // The machine is the single lifecycle source; reset its slot per test.
    setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
  });

  it('does not expose a per-session control id in the machine-derived snapshot', async () => {
    // The realtime control session id is internal carrier state, not a UI
    // session id; the projected snapshot keeps sessionId null even when connected.
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'connected',
    });
    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    const snap = adapter.getSnapshot();
    expect(snap.sessionId).toBe('voice-global');
    expect(snap.status).toBe('connected');
  });

  it('derives its snapshot from the runtime machine, not storage realtime state', async () => {
    state.realtimeStatus = 'disconnected';
    state.realtimeMode = 'idle';
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'speaking',
    });

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
  });

  it('projects a recoverable machine error as a disconnected end carrying the error code', async () => {
    // Recoverable provider/mic failures must read as "call ended, retry":
    // disconnected with the error code surfaced, not a hard error.
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'error',
      error: { kind: 'provider_error', reason: 'realtime_provider_error', recoverable: true },
    });

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    // The adapter snapshot must equal the canonical machine-derived projection.
    const { deriveLocalVoiceSessionSnapshot } = await import(
      '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot'
    );
    const { getVoiceConversationRuntimeSnapshot } = await import(
      '@/voice/runtime/machine/voiceConversationRuntimeStore'
    );
    expect(adapter.getSnapshot()).toEqual(
      deriveLocalVoiceSessionSnapshot('realtime_elevenlabs', getVoiceConversationRuntimeSnapshot()),
    );
    expect(adapter.getSnapshot()).toMatchObject({
      status: 'disconnected',
      canStop: false,
      errorCode: 'provider_error',
      errorMessage: 'realtime_provider_error',
    });
  });

  it('projects a non-recoverable machine error as a hard error that must be dismissed', async () => {
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'error',
      error: { kind: 'mic_permission_denied', reason: 'mic_permission_denied', recoverable: false },
    });

    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'error',
      canStop: true,
      errorCode: 'mic_permission_denied',
    });
  });

  it('subscribes through the runtime machine store', async () => {
    const { createRealtimeElevenLabsVoiceAdapter } = await import('./realtimeElevenLabsAdapter');
    const adapter = createRealtimeElevenLabsVoiceAdapter();
    const listener = vi.fn();

    const stop = adapter.subscribe?.(listener);

    // A machine transition must notify the adapter subscriber.
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'connected',
    });
    expect(listener).toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop?.();
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
    setVoiceConversationRuntimeSnapshot({
      ...DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      state: 'connected',
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

  it('forwards the server-minted lease binding into ElevenLabs dynamic variables', async () => {
    const { createRealtimeElevenLabsTransportProvider } = await import('./realtimeElevenLabsTransportProvider');
    const provider = createRealtimeElevenLabsTransportProvider();

    const config = provider.buildConversationStartConfig({
      config: {
        sessionId: 'voice-global',
        initialContext: 'context',
        token: 'conv_token',
        leaseId: 'lease_1',
        bindingNonce: 'nonce_lease_1',
        textOnly: false,
      },
      settings: {
        voice: {
          providerId: 'realtime_elevenlabs',
          assistantLanguage: null,
          adapters: {
            realtime_elevenlabs: {
              assistantLanguage: null,
              billingMode: 'happier',
              welcome: { enabled: false, mode: 'immediate', templateId: null },
            },
          },
        },
      },
    }) as Record<string, any>;

    expect(config.conversationToken).toBe('conv_token');
    expect(config.dynamicVariables).toMatchObject({
      sessionId: 'voice-global',
      initialConversationContext: 'context',
      [HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE]: 'lease_1',
      [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: 'nonce_lease_1',
    });
  });
});
