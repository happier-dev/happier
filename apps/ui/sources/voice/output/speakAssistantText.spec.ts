import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

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

const synthesizeBundledSpeechSpy = vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' });
vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
  bundledSpeechDaemonClient: {
    transcribe: vi.fn(),
    synthesize: (...args: any[]) => synthesizeBundledSpeechSpy(...args),
  },
}));
const playAudioBytesWithStopperSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (...args: any[]) => playAudioBytesWithStopperSpy(...args),
}));

const daemonTtsControllerSpeakSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/runtime/daemonInference/DaemonTtsController', () => ({
  DaemonTtsController: vi.fn().mockImplementation(() => ({
    speak: (...args: any[]) => daemonTtsControllerSpeakSpy(...args),
  })),
}));
const resolveDaemonVoiceInferenceExecutionSpy = vi.hoisted(() => vi.fn());
vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
  resolveLocalNeuralExecutionPolicy: (params: { requestedExecution?: string | null }) => {
    const requestedExecution = params.requestedExecution ?? 'auto';
    const selectableExecution = requestedExecution;
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
  resolveDaemonVoiceInferenceExecution: (params: { requestedExecution?: string | null }) =>
    resolveDaemonVoiceInferenceExecutionSpy(params),
}));

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

describe('speakAssistantText', () => {
  beforeEach(() => {
    speakDeviceTextSpy.mockReset();
    speakDeviceTextSpy.mockResolvedValue(undefined);
    speakOpenAiCompatTextSpy.mockReset();
    speakOpenAiCompatTextSpy.mockResolvedValue(undefined);
    speakKokoroTextSpy.mockReset();
    speakKokoroTextSpy.mockResolvedValue(undefined);
    daemonTtsControllerSpeakSpy.mockReset();
    daemonTtsControllerSpeakSpy.mockResolvedValue(undefined);
    synthesizeBundledSpeechSpy.mockClear();
    playAudioBytesWithStopperSpy.mockReset();
    playAudioBytesWithStopperSpy.mockResolvedValue(undefined);
    resolveDaemonVoiceInferenceExecutionSpy.mockReset();
    resolveDaemonVoiceInferenceExecutionSpy.mockImplementation(async (params: { requestedExecution?: string | null }) => {
      const requestedExecution = params.requestedExecution ?? 'auto';
      if (requestedExecution !== 'auto') return requestedExecution;
      return platformOsMock.value === 'web' ? 'daemon' : 'device';
    });
  });

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
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
            local_conversation: { schemaVersion: 1, config: {
              tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
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
        onPlaybackStarted: onSpeaking,
      }),
    );
    expect(onSpeaking).not.toHaveBeenCalled();
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'openai_compat',
                baseUrl: 'http://example.com/v1',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'm', voice: 'v', format: 'wav' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1, execution: 'device' },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
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

  it('rejects delayed local-neural playback from a stopped attempt without poisoning restarted playback', async () => {
    const execution = createDeferred<'device' | 'daemon'>();
    resolveDaemonVoiceInferenceExecutionSpy.mockReturnValueOnce(execution.promise);
    const controller = createVoicePlaybackController();
    const staleOnSpeaking = vi.fn();
    const restartedOnSpeaking = vi.fn();
    speakKokoroTextSpy.mockImplementationOnce(async (params: Readonly<{
      registerPlaybackStopper: VoicePlaybackStopperRegistrar;
      onPlaybackStarted?: () => void;
    }>) => {
      let stopped = false;
      const clearStopper = params.registerPlaybackStopper(() => {
        stopped = true;
      });
      if (!stopped) params.onPlaybackStarted?.();
      clearStopper();
    });
    speakDeviceTextSpy.mockImplementationOnce(async (_text: string, onStart?: () => void, opts?: { signal?: AbortSignal }) => {
      if (!opts?.signal?.aborted) onStart?.();
    });

    const staleAttempt = speakAssistantText({
      text: 'stale local neural reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1, execution: 'auto' },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: staleOnSpeaking,
    });
    await vi.waitFor(() => expect(resolveDaemonVoiceInferenceExecutionSpy).toHaveBeenCalledTimes(1));

    controller.interrupt();
    await speakAssistantText({
      text: 'fresh device reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: restartedOnSpeaking,
    });
    execution.resolve('device');
    await staleAttempt;

    expect(restartedOnSpeaking).toHaveBeenCalledTimes(1);
    expect(staleOnSpeaking).not.toHaveBeenCalled();
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
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
            } },
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
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
    }));
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
  });

  it('reports selected daemon local_neural synthesis failure without changing execution or provider', async () => {
    daemonTtsControllerSpeakSpy.mockRejectedValueOnce(new Error('daemon unavailable'));
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await expect(speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from daemon fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
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
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    })).rejects.toMatchObject({
      kind: 'tts_failed',
      reason: 'daemon unavailable',
    });

    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
  });

  it('keeps explicit web local_neural device execution instead of changing it to daemon', async () => {
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
          providers: {
            local_direct: { schemaVersion: 1, config: {
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
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(speakKokoroTextSpy).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello from web clamp',
    }));
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    expect(daemonTtsControllerSpeakSpy).not.toHaveBeenCalled();
  });

  it('reports explicit web local_neural device failure without daemon or OS speech substitution', async () => {
    platformOsMock.value = 'web';
    speakKokoroTextSpy.mockRejectedValueOnce(new Error('kokoro_runtime_unsupported'));
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const onTtsFailed = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from web fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
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
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
      onTtsFailed,
    });

    expect(daemonTtsControllerSpeakSpy).not.toHaveBeenCalled();
    expect(speakKokoroTextSpy).toHaveBeenCalledTimes(1);
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts_failed',
      reason: 'kokoro_runtime_unsupported',
    }));
  });

  it('routes a bundled speech provider through the package-owned descriptor and selected-daemon client', async () => {
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};
    let notifyPlaybackStarted!: () => void;
    playAudioBytesWithStopperSpy.mockImplementationOnce(async (params: unknown) => {
      const callback = (params as Readonly<{ onPlaybackStarted?: () => void }>).onPlaybackStarted;
      if (!callback) throw new Error('Expected playback-start callback');
      notifyPlaybackStarted = callback;
    });

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'google_cloud',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                providers: {
                  google_cloud: {
                    schemaVersion: 2,
                    config: {
                      voiceName: 'en-US-Wavenet-D',
                      languageCode: 'en-US',
                      format: 'mp3',
                      speakingRate: null,
                      pitch: null,
                    },
                  },
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(synthesizeBundledSpeechSpy).toHaveBeenCalledTimes(1);
    const synthesizeInput = synthesizeBundledSpeechSpy.mock.calls[0]?.[0] as any;
    expect(synthesizeInput.entry?.providerId).toBe('google_cloud');
    expect(synthesizeInput.input).toBe('hello');
    expect(synthesizeBundledSpeechSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: expect.anything(), androidCertSha1: expect.anything() }),
    );
    expect(onSpeaking).not.toHaveBeenCalled();
    notifyPlaybackStarted();
    expect(onSpeaking).toHaveBeenCalledTimes(1);
  });

  it('rejects delayed bundled playback from a stopped attempt without poisoning restarted playback', async () => {
    const synthesis = createDeferred<{ bytes: Uint8Array; mimeType: string }>();
    synthesizeBundledSpeechSpy.mockReturnValueOnce(synthesis.promise);
    const controller = createVoicePlaybackController();
    const staleOnSpeaking = vi.fn();
    const restartedOnSpeaking = vi.fn();
    playAudioBytesWithStopperSpy.mockImplementationOnce(async (params: Readonly<{
      registerPlaybackStopper: VoicePlaybackStopperRegistrar;
      onPlaybackStarted?: () => void;
    }>) => {
      let stopped = false;
      const clearStopper = params.registerPlaybackStopper(() => {
        stopped = true;
      });
      if (!stopped) params.onPlaybackStarted?.();
      clearStopper();
    });
    speakDeviceTextSpy.mockImplementationOnce(async (_text: string, onStart?: () => void, opts?: { signal?: AbortSignal }) => {
      if (!opts?.signal?.aborted) onStart?.();
    });

    const staleAttempt = speakAssistantText({
      text: 'stale bundled reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'google_cloud',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                providers: {
                  google_cloud: {
                    schemaVersion: 2,
                    config: {
                      voiceName: 'en-US-Wavenet-D',
                      languageCode: 'en-US',
                      format: 'mp3',
                      speakingRate: null,
                      pitch: null,
                    },
                  },
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: staleOnSpeaking,
    });
    await vi.waitFor(() => expect(synthesizeBundledSpeechSpy).toHaveBeenCalledTimes(1));

    controller.interrupt();
    await speakAssistantText({
      text: 'fresh device reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: restartedOnSpeaking,
    });
    synthesis.resolve({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' });
    await staleAttempt;

    expect(restartedOnSpeaking).toHaveBeenCalledTimes(1);
    expect(staleOnSpeaking).not.toHaveBeenCalled();
  });

  it('reports selected local_neural device failure without substituting device TTS', async () => {
    speakKokoroTextSpy.mockRejectedValueOnce(new Error('kokoro_runtime_unavailable'));
    speakDeviceTextSpy.mockClear();

    const onSpeaking = vi.fn();
    const onTtsFailed = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1 },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
      onTtsFailed,
    });

    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    expect(speakKokoroTextSpy).toHaveBeenCalledTimes(1);
    expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts_failed',
      reason: 'kokoro_runtime_unavailable',
    }));
  });
});
