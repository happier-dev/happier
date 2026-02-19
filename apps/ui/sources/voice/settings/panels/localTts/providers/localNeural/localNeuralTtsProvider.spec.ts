import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';

const speakKokoroTextSpy = vi.fn().mockResolvedValue(undefined);

vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: (...args: any[]) => speakKokoroTextSpy(...args),
}));

vi.mock('@/voice/settings/panels/localTts/LocalNeuralTtsSettings', () => ({
  LocalNeuralTtsSettings: () => null,
}));

describe('localNeuralTtsProviderSpec', () => {
  const envKey = 'EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS';
  let priorEnv: string | undefined;

  beforeEach(() => {
    speakKokoroTextSpy.mockClear();
    priorEnv = process.env[envKey];
    process.env[envKey] = '120000';
  });

  afterEach(() => {
    if (priorEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = priorEnv;
    }
  });

  it('uses Kokoro operation timeout (not a fixed 60s floor) for Test TTS', async () => {
    const { localNeuralTtsProviderSpec } = await import('./localNeuralTtsProvider');

    const cfgTts: VoiceLocalTtsSettings = {
      provider: 'local_neural',
      openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
      localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
      googleCloud: {
        apiKey: null,
        androidCertSha1: null,
        voiceName: null,
        languageCode: null,
        format: 'mp3',
        speakingRate: null,
        pitch: null,
      },
      autoSpeakReplies: true,
      bargeInEnabled: true,
    };

    await localNeuralTtsProviderSpec.test({ cfgTts, networkTimeoutMs: 15_000, sample: 'Hello' });

    expect(speakKokoroTextSpy).toHaveBeenCalled();
    const arg = speakKokoroTextSpy.mock.calls[0]?.[0];
    expect(arg?.timeoutMs).toBe(120_000);
  });
});
