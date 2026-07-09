import { describe, expect, it, vi } from 'vitest';

import {
  audioStreamStart,
  emitAudioStreamEvent,
  ensureModelPackInstalled,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  registerLocalVoiceEngineHarnessHooks,
  sherpaStreamingCreate,
  sherpaStreamingFinish,
  sherpaStreamingPushFrame,
  sendMessage,
  setPlatformOs,
} from './localVoiceEngine.testHarness';

describe('local voice engine local neural STT (streaming)', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('does not start the native sherpa stream for web daemon local-neural capture', async () => {
    setPlatformOs('web');
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
                localNeural: { assetId: 'dummy-pack', language: 'en', execution: 'auto' },
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

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s-web-daemon');
    const stateAfterStart = getLocalVoiceState();
    if (stateAfterStart.status === 'recording' || stateAfterStart.status === 'listening') {
      await toggleLocalVoiceTurn('s-web-daemon');
    }

    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(sherpaStreamingCreate).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      sessionId: 's-web-daemon',
      error: 'daemon_streaming_stt_start_failed',
    });
  });

  it('surfaces mic permission denial as a recoverable idle error instead of entering recording', async () => {
    const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
    vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: false, canAskAgain: false });

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
            },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s1');

    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      sessionId: 's1',
      error: 'mic_permission_denied',
    });
  });

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

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

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

    expect(sendMessage).toHaveBeenCalledWith('s1', 'hello sherpa', undefined, undefined, {
      bypassPendingQueueReason: 'voice_turn',
    });
  });

  it('hands-free mode auto-sends endpointed local-neural turns and restarts listening', async () => {
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
                enabled: true,
              },
            },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');
    expect(audioStreamStart).toHaveBeenCalledTimes(1);

    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'hands free sherpa', isEndpoint: true });

    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('s1', 'hands free sherpa', undefined, undefined, {
        bypassPendingQueueReason: 'voice_turn',
      });
    });
    await vi.waitFor(() => {
      expect(audioStreamStart).toHaveBeenCalledTimes(2);
    });
    expect(getLocalVoiceState().status).toBe('recording');
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

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');
    expect(ensureModelPackInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' }),
      undefined,
    );
  });

  it('delegates local-neural STT ownership to LocalVoiceCaptureOwner instead of constructing the Sherpa controller in localVoiceEngine', async () => {
    const startCapture = vi.fn(async () => {});

    vi.doMock('@/voice/input/SherpaStreamingSttController', () => ({
      createSherpaStreamingSttController: () => {
        throw new Error('localVoiceEngine should not create SherpaStreamingSttController directly');
      },
    }));
    vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
      createLocalVoiceCaptureOwner: () => ({
        resolveManualBargeInAction: vi.fn(() => ({
          kind: 'noop',
          reason: 'not_speaking',
        })),
        resolveEndpointSignalAction: vi.fn(() => ({
          kind: 'ignore',
          reason: 'not_hands_free',
        })),
        startCapture,
        stopCapture: vi.fn(async () => ({
          provider: 'local_neural',
          text: '',
          continueHandsFree: false,
        })),
        stopEndpointDrivenCapture: vi.fn(async () => ({
          kind: 'ignore',
          reason: 'empty_transcript',
          shouldRearm: false,
        })),
        isHandsFreeCaptureSession: vi.fn(() => false),
        clearHandsFree: vi.fn(),
        stopSession: vi.fn(async () => {}),
      }),
    }));

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
            },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s1');

    expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      provider: 'local_neural',
    }));
    expect(getLocalVoiceState().status).toBe('recording');
  });
});
