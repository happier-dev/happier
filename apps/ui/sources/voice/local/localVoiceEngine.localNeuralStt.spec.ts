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
  submitMessage,
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en', execution: 'auto' },
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en' },
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
                enabled: false,
              },
            } },
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

    expect(submitMessage).toHaveBeenCalledWith('s1', 'hello sherpa', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
    });
  });

  it('does not submit the latest provisional Sherpa partial when finalization fails', async () => {
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
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
                enabled: false,
              },
            } },
          },
        },
      },
    });
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'provisional command', isEndpoint: false });
    sherpaStreamingFinish.mockRejectedValueOnce(new Error('recognizer_finalization_failed'));

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s-finalization-failure');
    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });
    await vi.waitFor(() => {
      expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);
    });

    await toggleLocalVoiceTurn('s-finalization-failure');

    expect(submitMessage).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      sessionId: 's-finalization-failure',
      error: 'local_neural_stt_finalization_failed',
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
                enabled: true,
              },
            } },
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
      expect(submitMessage).toHaveBeenCalledWith('s1', 'hands free sherpa', undefined, undefined, {
        callerSurface: 'voice_turn',
        forceImmediate: true,
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: null, language: 'en' },
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...storage.getState().settings.voice.providers.local_direct.config.handsFree,
                enabled: false,
              },
            } },
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
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'local_neural',
                localNeural: { assetId: 'dummy-pack', language: 'en' },
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

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s1');

    expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      provider: 'local_neural',
    }));
    expect(getLocalVoiceState().status).toBe('recording');
  });
});
