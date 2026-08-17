import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { recordedAudioTranscriptionController } from '@/voice/runtime/input/recordedAudioTranscriptionController';

const fileBase64Spy = vi.fn<() => Promise<string>>().mockResolvedValue('BASE64_AUDIO');

const ORIGINAL_PLATFORM_OS = Platform.OS;
const ORIGINAL_PLATFORM_SELECT = Platform.select;

class FakeAudioBuffer {
  numberOfChannels = 1;
  sampleRate = 16_000;
  private readonly channelData = new Float32Array([0, 0.25, -0.25, 0]);

  getChannelData(_channel: number) {
    return this.channelData;
  }
}

vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    base64 = fileBase64Spy;
  },
  readAsStringAsync: () => {
    throw new Error('deprecated_readAsStringAsync_called');
  },
}));

vi.mock('expo-audio', () => ({
  RecordingPresets: {
    HIGH_QUALITY: {
      extension: '.m4a',
    },
  },
}));

afterEach(() => {
  openAiCompatTranscribeSpy.mockClear();
  googleGeminiTranscribeSpy.mockClear();
  resetRuntimeFetch();
  (Platform as any).OS = ORIGINAL_PLATFORM_OS;
  (Platform as any).select = ORIGINAL_PLATFORM_SELECT;
});

const daemonSttControllerTranscribeSpy = vi.fn();
const openAiCompatTranscribeSpy = vi.fn(async (_params: unknown) => 'hello openai compat');
const googleGeminiTranscribeSpy = vi.fn(async (_params: unknown) => 'hello gemini');
vi.mock('@/voice/runtime/daemonInference/DaemonSttController', () => ({
  DaemonSttController: vi.fn().mockImplementation(() => ({
    transcribeRecordedAudio: (...args: any[]) => daemonSttControllerTranscribeSpy(...args),
  })),
}));
vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
  resolveDaemonVoiceInferenceExecution: async (params: { requestedExecution?: string | null }) =>
    params.requestedExecution === 'daemon' ? 'daemon' : 'device',
}));
vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
  bundledSpeechDaemonClient: {
    transcribe: (params: Readonly<{ entry?: Readonly<{ providerId?: string }> }>) => (
      params.entry?.providerId === 'happier.voice.openai-compat/stt'
        ? openAiCompatTranscribeSpy(params)
        : googleGeminiTranscribeSpy(params)
    ),
    synthesize: vi.fn(),
  },
}));

describe('recordedAudioTranscriptionController', () => {
  it('routes qualified OpenAI-compatible recorded audio through the generic selected-daemon speech client', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.openai-compat/stt',
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            } },
            'happier.voice.openai-compat/stt': {
              schemaVersion: 2,
              config: {
                baseUrl: 'https://openai-compat.example/api',
                insecureLocalOriginConsent: '',
                insecureLocalConsentMachineId: '',
                model: 'whisper-1',
                language: 'en',
              },
            },
          },
        },
      },
    });

    expect(text).toBe('hello openai compat');
    expect(openAiCompatTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'happier.voice.openai-compat/stt' }),
      model: 'whisper-1',
      language: 'en',
      source: { kind: 'native', uri: 'file:///rec.m4a' },
    }));
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
  });

  it('routes canonical qualified Google STT settings through the selected-daemon credential client without a synced key', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.google/gemini-stt',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
              },
              networkTimeoutMs: 15000,
            } },
            'happier.voice.google/gemini-stt': {
              schemaVersion: 2,
              config: { model: 'gemini-2.5-flash', language: 'en' },
            },
          },
        },
      },
    });

    expect(googleGeminiTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'happier.voice.google/gemini-stt' }),
      model: 'gemini-2.5-flash',
      source: { kind: 'native', uri: 'file:///rec.m4a' },
      mimeType: 'audio/mp4',
      language: 'en',
    }));
    expect(googleGeminiTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(text).toBe('hello gemini');
  });

  it('normalizes the released secret-bearing Google adapter shape without disclosing the secret', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: {
                provider: 'google_gemini',
                googleGemini: {
                  apiKey: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'legacy-google-secret-ciphertext' },
                  },
                  model: 'gemini-2.5-flash',
                  language: 'en',
                },
              },
            },
          },
        },
      },
    });

    expect(text).toBe('hello gemini');
    expect(googleGeminiTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(googleGeminiTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'happier.voice.google/gemini-stt' }),
      model: 'gemini-2.5-flash',
      language: 'en',
    }));
    const dispatch = googleGeminiTranscribeSpy.mock.calls[0]?.[0];
    expect(dispatch).not.toHaveProperty('apiKey');
    expect(JSON.stringify(dispatch)).not.toContain('legacy-google-secret-ciphertext');
  });

  it('trims the voice provider id before selecting the local adapter', async () => {
    googleGeminiTranscribeSpy.mockResolvedValueOnce('hello trimmed provider');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          providers: {
            'happier.voice.google/gemini-stt': {
              schemaVersion: 2,
              config: { model: 'gemini-2.5-flash', language: 'en' },
            },
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.google/gemini-stt',
              },
              networkTimeoutMs: 15000,
            } },
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                providers: {},
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(googleGeminiTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(text).toBe('hello trimmed provider');
  });

  it('treats local_neural STT as non-file-based on web and returns null', async () => {
    const fetchSpy = vi.fn();
    setRuntimeFetch(fetchSpy as any);

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'device' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(text).toBeNull();
  });

  it('routes local_neural daemon execution to the daemon STT controller', async () => {
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.wav',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon stt');
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      source: { kind: 'native', uri: 'file:///rec.wav' },
      inputMimeType: 'audio/wav',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      packId: 'dummy',
      language: 'en',
    }));
  });

  it('routes blob recordings through a web file source for daemon local_neural STT', async () => {
    (Platform as any).OS = 'web';
    (Platform as any).select = (spec: Record<string, unknown>) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'blob:voice-recording') {
        return {
          blob: async () => new Blob(['webm-bytes'], { type: 'audio/webm' }),
        };
      }
      return await (globalThis.fetch as any)(input, init);
    });
    setRuntimeFetch(runtimeFetchSpy as any);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon web',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon web');
    expect(runtimeFetchSpy).toHaveBeenCalledWith('blob:voice-recording', undefined);
    const call = daemonSttControllerTranscribeSpy.mock.calls.at(-1)?.[0];
    expect(call).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      inputMimeType: 'audio/webm',
      packId: 'dummy',
      language: 'en',
      source: expect.objectContaining({ kind: 'web' }),
    }));
    expect(call?.source.file).toBeInstanceOf(File);
    expect(call?.source.file.type).toBe('audio/webm');
  });

  it('reuses the admitted web recording blob instead of reading its object URL again before daemon upload', async () => {
    (Platform as unknown as { OS: string }).OS = 'web';
    (Platform as unknown as {
      select: (spec: Record<string, unknown>) => unknown;
    }).select = (spec) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async () => {
      throw new Error('recording_blob_refetched');
    });
    setRuntimeFetch(
      runtimeFetchSpy as unknown as Parameters<typeof setRuntimeFetch>[0],
    );
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello admitted daemon web',
      language: 'en',
      modelPackId: 'dummy',
    });
    const webBlob = new Blob(['already-admitted-webm-bytes'], { type: 'audio/webm' });
    (globalThis as unknown as {
      AudioContext?: new () => unknown;
    }).AudioContext = class {
      constructor() {
        throw new Error('web_audio_context_unavailable');
      }
    };

    const request: Parameters<typeof recordedAudioTranscriptionController.transcribe>[0] & Readonly<{
      webBlob: Blob;
    }> = {
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      webBlob,
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    };

    await expect(recordedAudioTranscriptionController.transcribe(request)).resolves.toBe(
      'hello admitted daemon web',
    );
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ kind: 'web' }),
      inputMimeType: 'audio/webm',
    }));
    (globalThis as unknown as {
      AudioContext?: unknown;
    }).AudioContext = undefined;
  });

  it('falls back to daemon decode for an admitted Chrome WebM recording that Web Audio cannot decode', async () => {
    (Platform as unknown as { OS: string }).OS = 'web';
    (Platform as unknown as {
      select: (spec: Record<string, unknown>) => unknown;
    }).select = (spec) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async () => {
      throw new Error('recording_blob_refetched');
    });
    setRuntimeFetch(
      runtimeFetchSpy as unknown as Parameters<typeof setRuntimeFetch>[0],
    );
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'open the project settings',
      language: 'en',
      modelPackId: 'dummy',
    });
    const webBlob = new Blob(
      [new Uint8Array(1_080)],
      { type: 'audio/webm;codecs=opus' },
    );
    const close = vi.fn(async () => {});
    (globalThis as unknown as {
      AudioContext?: new () => unknown;
    }).AudioContext = class {
      decodeAudioData = vi.fn(async () => {
        throw new DOMException('Unable to decode audio data', 'EncodingError');
      });
      close = close;
    };

    const request: Parameters<typeof recordedAudioTranscriptionController.transcribe>[0] = {
      sessionId: 'session-1',
      uri: 'blob:chrome-recording',
      webBlob,
      executionMachineId: 'machine-ready-at-start',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    };

    await expect(recordedAudioTranscriptionController.transcribe(request)).resolves.toBe(
      'open the project settings',
    );
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineTarget: { machineId: 'machine-ready-at-start' },
      source: expect.objectContaining({
        kind: 'web',
        file: expect.objectContaining({
          size: 1_080,
          type: 'audio/webm;codecs=opus',
        }),
      }),
      inputMimeType: 'audio/webm;codecs=opus',
      normalization: expect.objectContaining({ strategy: 'daemon_decode' }),
    }));
    (globalThis as unknown as {
      AudioContext?: unknown;
    }).AudioContext = undefined;
  });

  it('pretranscodes web recordings to wav before daemon local_neural STT when browser decode is available', async () => {
    (Platform as any).OS = 'web';
    (Platform as any).select = (spec: Record<string, unknown>) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'blob:voice-recording') {
        return {
          blob: async () => new Blob(['webm-bytes'], { type: 'audio/webm' }),
        };
      }
      return await (globalThis.fetch as any)(input, init);
    });
    setRuntimeFetch(runtimeFetchSpy as any);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon web wav',
      language: 'en',
      modelPackId: 'dummy',
    });
    const decodeAudioData = vi.fn(async () => new FakeAudioBuffer());
    (globalThis as any).AudioContext = class {
      decodeAudioData = decodeAudioData;
    };

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon web wav');
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    const call = daemonSttControllerTranscribeSpy.mock.calls.at(-1)?.[0];
    expect(call).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      inputMimeType: 'audio/wav',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
      packId: 'dummy',
      language: 'en',
      source: expect.objectContaining({ kind: 'web' }),
    }));
    expect(call?.source.file).toBeInstanceOf(File);
    expect(call?.source.file.name).toMatch(/\.wav$/);
    expect(call?.source.file.type).toBe('audio/wav');
    (globalThis as any).AudioContext = undefined;
  });

  it('guesses audio/mp4 for native m4a recordings when routing daemon local_neural STT', async () => {
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon m4a',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon m4a');
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      inputMimeType: 'audio/mp4',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      source: { kind: 'native', uri: 'file:///rec.m4a' },
    }));
  });

  it('preserves daemon local_neural STT unavailability details instead of flattening them to null', async () => {
    daemonSttControllerTranscribeSpy.mockRejectedValueOnce(
      Object.assign(new Error('daemon_voice_inference_runtime_unavailable'), {
        code: 'runtime_unavailable',
      }),
    );

    await expect(
      recordedAudioTranscriptionController.transcribe({
        sessionId: 'session-1',
        uri: 'file:///rec.wav',
        settings: {
          voice: {
            providerId: 'local_direct',
            assistantLanguage: 'en',
            providers: {
              local_direct: { schemaVersion: 1, config: {
                stt: {
                  provider: 'local_neural',
                  openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                  googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                  localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
                },
                networkTimeoutMs: 15000,
              } },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'daemon_voice_inference_runtime_unavailable',
    });
  });
});
