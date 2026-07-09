import { afterEach, describe, expect, it, vi } from 'vitest';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
    },
  });
});

const speakDeviceTextSpy = vi.fn().mockResolvedValue(undefined);
const stopDeviceSpeechSpy = vi.fn();
vi.mock('@/voice/local/speakDeviceText', () => ({
  speakDeviceText: (...args: any[]) => speakDeviceTextSpy(...args),
  stopDeviceSpeech: (..._args: any[]) => stopDeviceSpeechSpy(..._args),
}));

const speakOpenAiCompatTextSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/TtsController', () => ({
  speakOpenAiCompatText: (...args: any[]) => speakOpenAiCompatTextSpy(...args),
}));

const speakKokoroTextSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: (...args: any[]) => speakKokoroTextSpy(...args),
}));

const speakGoogleCloudTextSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/GoogleCloudTtsController', () => ({
  speakGoogleCloudText: (...args: any[]) => speakGoogleCloudTextSpy(...args),
}));

const daemonTtsControllerSpeakSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/runtime/daemonInference/DaemonTtsController', () => ({
  DaemonTtsController: vi.fn().mockImplementation(() => ({
    speak: (...args: any[]) => daemonTtsControllerSpeakSpy(...args),
  })),
}));
vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
  resolveLocalNeuralExecutionPolicy: (params: { requestedExecution?: string | null }) => {
    const requestedExecution = params.requestedExecution ?? 'auto';
    const selectableExecution = platformOsMock.value === 'web' && requestedExecution === 'device'
      ? 'daemon'
      : requestedExecution;
    return {
      allowDeviceSelection: platformOsMock.value !== 'web',
      preferredExecution: selectableExecution === 'auto'
        ? platformOsMock.value === 'web'
          ? 'daemon'
          : 'device'
        : selectableExecution,
      requestedExecution,
      selectableExecution,
    };
  },
  resolveDaemonVoiceInferenceExecution: async (params: { requestedExecution?: string | null }) => {
    const requestedExecution = params.requestedExecution ?? 'auto';
    if (platformOsMock.value === 'web') {
      return requestedExecution === 'device' ? 'daemon' : 'daemon';
    }
    return requestedExecution === 'daemon' ? 'daemon' : 'device';
  },
}));

const decryptSecretValueSpy = vi.fn<(value: unknown) => string | null>(() => null);
vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: (value: unknown) => decryptSecretValueSpy(value) },
}));

import { speakAssistantText } from '@/voice/output/speakAssistantText';

describe('speakAssistantText', () => {
  afterEach(() => {
    platformOsMock.value = 'ios';
  });

  it('trims the voice provider id before selecting the TTS adapter', async () => {
    speakDeviceTextSpy.mockClear();
    speakOpenAiCompatTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: ' local_direct ',
          adapters: {
            local_direct: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
            local_conversation: {
              tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakDeviceTextSpy).toHaveBeenCalledWith(
      'hello',
      onSpeaking,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(speakOpenAiCompatTextSpy).not.toHaveBeenCalled();
  });

  it('routes device TTS provider to expo speech', async () => {
    const onSpeaking = vi.fn();
    let stopper: (() => void) | null = null;
    const registerPlaybackStopper = (s: () => void) => {
      stopper = s;
      return () => {};
    };

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakDeviceTextSpy).toHaveBeenCalledWith(
      'hello',
      onSpeaking,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(typeof stopper).toBe('function');
  });

  it('routes OpenAI-compatible provider to speakOpenAiCompatText', async () => {
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakOpenAiCompatTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://example.com/v1',
        model: 'm',
        voice: 'v',
        format: 'wav',
        input: 'hello',
      }),
    );
  });

  it('accepts legacy openai-compatible baseUrl when openaiCompat.baseUrl is unset', async () => {
    speakOpenAiCompatTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'openai_compat',
                baseUrl: 'http://example.com/v1',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakOpenAiCompatTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://example.com/v1',
        input: 'hello',
      }),
    );
  });

  it('routes local_neural (Kokoro model) provider to speakKokoroText', async () => {
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1, execution: 'device' },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakKokoroTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        voiceId: 'af_heart',
      }),
    );
  });

  it('routes local_neural daemon execution to the daemon TTS controller', async () => {
    daemonTtsControllerSpeakSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from daemon',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'daemon',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      text: 'hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
    }));
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
  });

  it('falls back to local_neural device runtime when daemon local_neural synthesis fails (native)', async () => {
    daemonTtsControllerSpeakSpy.mockRejectedValueOnce(new Error('daemon unavailable'));
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from daemon fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-tts-en-v1',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'daemon',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakKokoroTextSpy).toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
  });

  it('clamps web local_neural device execution to the daemon TTS controller', async () => {
    platformOsMock.value = 'web';
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();
    daemonTtsControllerSpeakSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello from web clamp',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'device',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello from web clamp',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
    }));
  });

  it('falls back to device TTS when the web-clamped daemon local_neural path fails', async () => {
    platformOsMock.value = 'web';
    daemonTtsControllerSpeakSpy.mockRejectedValueOnce(new Error('daemon unavailable'));
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from web fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-tts-en-v1',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'device',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      text: 'hello from web fallback',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
    }));
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).toHaveBeenCalledWith(
      'hello from web fallback',
      onSpeaking,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('routes Google Cloud provider to speakGoogleCloudText', async () => {
    decryptSecretValueSpy.mockReturnValueOnce('gcp-key');
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'google_cloud',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                googleCloud: {
                  apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } },
                  voiceName: 'en-US-Wavenet-D',
                  languageCode: 'en-US',
                  format: 'mp3',
                  speakingRate: null,
                  pitch: null,
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakGoogleCloudTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'hello',
      }),
    );
  });

  it('falls back to device TTS when Kokoro synthesis fails', async () => {
    speakKokoroTextSpy.mockRejectedValueOnce(new Error('kokoro failed'));
    speakDeviceTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1 },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakDeviceTextSpy).toHaveBeenCalledWith(
      'hello',
      onSpeaking,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
