import { describe, expect, it } from 'vitest';

import {
  audioStreamStart,
  emitAudioStreamEvent,
  ensureModelPackInstalled,
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  sherpaStreamingCreate,
  sherpaStreamingFinish,
  sherpaStreamingPushFrame,
  sendMessage,
} from './localVoiceEngine.testHarness';

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

    expect(sendMessage).toHaveBeenCalledWith('s1', 'hello sherpa');
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
});
