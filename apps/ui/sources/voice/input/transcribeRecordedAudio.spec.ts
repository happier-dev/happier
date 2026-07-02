import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

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
  resetRuntimeFetch();
  (Platform as any).OS = ORIGINAL_PLATFORM_OS;
  (Platform as any).select = ORIGINAL_PLATFORM_SELECT;
});

const daemonSttControllerTranscribeSpy = vi.fn();
vi.mock('@/voice/runtime/daemonInference/DaemonSttController', () => ({
  DaemonSttController: vi.fn().mockImplementation(() => ({
    transcribeRecordedAudio: (...args: any[]) => daemonSttControllerTranscribeSpy(...args),
  })),
}));
vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
  resolveDaemonVoiceInferenceExecution: async (params: { requestedExecution?: string | null }) =>
    params.requestedExecution === 'daemon' ? 'daemon' : 'device',
}));

describe('recordedAudioTranscriptionController', () => {
  it('routes openai_compat recorded audio through the trimmed active adapter and caller decrypt override', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello openai compat' }),
    });
    setRuntimeFetch(fetchSpy as any);

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'openai_compat',
                openaiCompat: {
                  baseUrl: 'https://openai-compat.example/api',
                  apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'secret' } },
                  model: 'whisper-1',
                },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
            local_conversation: {
              stt: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
          },
        },
      },
      decryptSecretValue: () => 'openai-key',
    });

    expect(text).toBe('hello openai compat');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openai-compat.example/api/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer openai-key',
        }),
      }),
    );
  });

  it('routes google_gemini STT to the Gemini API', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello gemini' }] } }],
      }),
    });
    setRuntimeFetch(fetchSpy as any);

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'google_gemini',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }, model: 'gemini-2.5-flash', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
          },
        },
      },
      decryptSecretValue: () => 'gemini-key',
    });

    expect(fileBase64Spy).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('generativelanguage.googleapis.com'), expect.anything());
    expect(text).toBe('hello gemini');
  });

  it('trims the voice provider id before selecting the local adapter', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello trimmed provider' }] } }],
      }),
    });
    setRuntimeFetch(fetchSpy as any);

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'google_gemini',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: {
                  apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } },
                  model: 'gemini-2.5-flash',
                  language: 'en',
                },
              },
              networkTimeoutMs: 15000,
            },
            local_conversation: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
          },
        },
      },
      decryptSecretValue: () => 'gemini-key',
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(text).toBe('hello trimmed provider');
  });

  it('treats local_neural STT as non-file-based on web and returns null', async () => {
    const fetchSpy = vi.fn();
    setRuntimeFetch(fetchSpy as any);

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'device' },
              },
              networkTimeoutMs: 15000,
            },
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

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.wav',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            },
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

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            },
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

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            },
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

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            },
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

    const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');

    await expect(
      recordedAudioTranscriptionController.transcribe({
        sessionId: 'session-1',
        uri: 'file:///rec.wav',
        settings: {
          voice: {
            providerId: 'local_direct',
            assistantLanguage: 'en',
            adapters: {
              local_direct: {
                stt: {
                  provider: 'local_neural',
                  openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                  googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                  localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
                },
                networkTimeoutMs: 15000,
              },
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
