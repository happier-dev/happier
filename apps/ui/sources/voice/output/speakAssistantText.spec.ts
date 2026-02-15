import { describe, expect, it, vi } from 'vitest';

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

const decryptSecretValueSpy = vi.fn<(value: unknown) => string | null>(() => null);
vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: (value: unknown) => decryptSecretValueSpy(value) },
}));

import { speakAssistantText } from '@/voice/output/speakAssistantText';

describe('speakAssistantText', () => {
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

    expect(speakDeviceTextSpy).toHaveBeenCalledWith('hello', onSpeaking);
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

    expect(speakKokoroTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        voiceId: 'af_heart',
      }),
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

    expect(speakDeviceTextSpy).toHaveBeenCalledWith('hello', onSpeaking);
  });
});
