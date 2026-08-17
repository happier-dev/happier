import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
  emitSpeechRecEvent,
  expoSpeechSpeak,
  expoSpeechStop,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  registerLocalVoiceEngineHarnessHooks,
  submitMessage,
  speechRecStart,
  speechRecStop,
} from './localVoiceEngine.testHarness';

describe('local voice engine stop', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('stops an in-progress recording turn without sending', async () => {
    const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');

    await stopLocalVoiceSession();
    expect(getLocalVoiceState().status).toBe('idle');
    expect(submitMessage).not.toHaveBeenCalled();
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });

  it('stops device STT recording without sending', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'device',
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
    });

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(speechRecStart).toHaveBeenCalledTimes(1);

    const stopPromise = stopLocalVoiceSession();
    expect(speechRecStop).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });
    emitSpeechRecEvent('end', {});
    await stopPromise;

    expect(submitMessage).not.toHaveBeenCalled();
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'disconnected',
      error: null,
    });
  });

  it('cancels an in-flight turn through an explicit ending-to-connected transition', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
            } },
          },
        },
      },
    });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    });

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { abortLocalVoiceTurn, toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    const stopPromise = toggleLocalVoiceTurn('s1');

    await vi.waitFor(() => {
      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: 's1',
        state: 'thinking',
        error: null,
      });
    });

    const abortPromise = abortLocalVoiceTurn('s1');
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });

    await abortPromise;
    await stopPromise;

    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'connected',
      error: null,
    });
  });


});
