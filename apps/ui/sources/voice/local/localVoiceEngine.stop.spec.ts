import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
  emitSpeechRecEvent,
  expoSpeechSpeak,
  expoSpeechStop,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  registerLocalVoiceEngineHarnessHooks,
  sendMessage,
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
    expect(sendMessage).not.toHaveBeenCalled();
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
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_direct: {
              ...storage.getState().settings.voice.adapters.local_direct,
              stt: {
                ...storage.getState().settings.voice.adapters.local_direct.stt,
                useDeviceStt: true,
                baseUrl: null,
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_direct.tts,
                autoSpeakReplies: false,
              },
            },
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

    expect(sendMessage).not.toHaveBeenCalled();
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
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_direct: {
              ...storage.getState().settings.voice.adapters.local_direct,
              tts: {
                ...storage.getState().settings.voice.adapters.local_direct.tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
            },
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

  it('stops typed agent playback started through the local conversation adapter', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_conversation: {
              ...storage.getState().settings.voice.adapters.local_conversation,
              conversationMode: 'agent',
              tts: {
                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
              agent: {
                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                backend: 'openai_compat',
                openaiCompat: {
                  ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                  chatBaseUrl: 'http://localhost:8002',
                  chatApiKey: null,
                  chatModel: 'fast-model',
                  commitModel: 'commit-model',
                },
              },
            },
          },
        },
      },
    });

    const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
    expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
      onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
    });
    expoSpeechStop.mockImplementation(() => {
      onStoppedRef.current?.();
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Adapter reply' } }] }),
    });

    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');

    const adapter = createLocalConversationVoiceAdapter();
    const sendPromise = adapter.sendTextTurn?.({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home',
      text: 'stop this reply',
    });

    if (!sendPromise) {
      throw new Error('Expected local conversation adapter to expose sendTextTurn');
    }

    await vi.waitFor(() => {
      expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        state: 'speaking',
        error: null,
      });
    });

    await adapter.stop({ sessionId: 's1' });

    const settledAfterStop = await Promise.race([
      sendPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 0);
      }),
    ]);

    expect(expoSpeechStop).toHaveBeenCalledTimes(1);
    expect(settledAfterStop).toBe('resolved');
    await sendPromise;

    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      state: 'disconnected',
      error: null,
    });
  });
});
