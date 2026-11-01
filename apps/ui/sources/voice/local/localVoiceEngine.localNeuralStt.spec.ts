import { describe, expect, it, vi } from 'vitest';

import {
  audioStreamStart,
  emitAudioStreamEvent,
  ensureModelPackInstalled,
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  setPlatformOs,
  sherpaStreamingCreate,
  sherpaStreamingFinish,
  sherpaStreamingPushFrame,
  speechRecStart,
  submitMessage,
} from './localVoiceEngine.testHarness';

async function useLocalNeuralSettings(handsFree: { enabled: boolean }) {
  const storage = await getStorage();
  const localDirect = storage.getState().settings.voice.adapters.local_direct;
  storage.__setState({
    settings: {
      ...storage.getState().settings,
      voice: {
        ...storage.getState().settings.voice,
        providerId: 'local_direct',
        adapters: {
          ...storage.getState().settings.voice.adapters,
          local_direct: {
            ...localDirect,
            stt: {
              provider: 'local_neural',
              openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
              googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
              localNeural: { assetId: 'dummy-pack', language: null },
            },
            tts: { ...localDirect.tts, autoSpeakReplies: false },
            handsFree: { enabled: handsFree.enabled, endpointing: { silenceMs: 0, minSpeechMs: 0 } },
          },
        },
      },
    },
  });
}

// 100 ms of 16 kHz mono PCM16: one native push batch.
const PCM_100MS = Buffer.from(new Uint8Array(3200)).toString('base64');

describe('local voice engine local neural STT (streaming)', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('streams audio frames into Sherpa and sends the final transcript on stop', async () => {
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
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy-pack', language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_direct.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                enabled: false,
              },
            },
          },
        },
      },
    });

    sherpaStreamingPushFrame.mockResolvedValue({ text: 'hello sherpa', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValue({ text: 'hello sherpa' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');
    expect(ensureModelPackInstalled).toHaveBeenCalled();
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalled();

    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });

    const stopPromise = toggleLocalVoiceTurn('s1');
    await stopPromise;

    expect(submitMessage).toHaveBeenCalledWith('s1', 'hello sherpa', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
    });
  });

  it('falls back to the default local_neural pack when assetId is missing', async () => {
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
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: null, language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_direct.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.adapters.local_direct.handsFree,
                enabled: false,
              },
            },
          },
        },
      },
    });

    sherpaStreamingPushFrame.mockResolvedValue({ text: 'hello sherpa', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValue({ text: 'hello sherpa' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');
    expect(ensureModelPackInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' }),
      undefined,
    );
  });

  it('ends a hands-free turn on the native endpoint, sends it, and re-arms the microphone', async () => {
    await useLocalNeuralSettings({ enabled: true });
    sherpaStreamingPushFrame.mockResolvedValue({ text: 'hands free hello', isEndpoint: true });
    sherpaStreamingFinish.mockResolvedValue({ text: 'hands free hello' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');
    expect(audioStreamStart).toHaveBeenCalledTimes(1);

    // First push recognizes the words; the next one reports the endpoint with the words unchanged.
    const pushesBefore = sherpaStreamingPushFrame.mock.calls.length;
    emitAudioStreamEvent('audioFrame', { streamId: 'audio-stream-1', pcm16leBase64: PCM_100MS, sampleRate: 16000, channels: 1 });
    await vi.waitFor(() => expect(sherpaStreamingPushFrame.mock.calls.length).toBeGreaterThan(pushesBefore));
    emitAudioStreamEvent('audioFrame', { streamId: 'audio-stream-1', pcm16leBase64: PCM_100MS, sampleRate: 16000, channels: 1 });

    await vi.waitFor(() => {
      expect(submitMessage).toHaveBeenCalledWith('s1', 'hands free hello', undefined, undefined, {
        callerSurface: 'voice_turn',
        forceImmediate: true,
      });
    });
    await vi.waitFor(() => expect(audioStreamStart).toHaveBeenCalledTimes(2));
    expect(getLocalVoiceState().status).toBe('recording');
  });

  it('runs device speech recognition on web when the synced provider is native-only local_neural', async () => {
    setPlatformOs('web');
    await useLocalNeuralSettings({ enabled: false });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
    await toggleLocalVoiceTurn('s1');

    expect(speechRecStart).toHaveBeenCalled();
    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({ status: 'recording', error: null });
  });
});
