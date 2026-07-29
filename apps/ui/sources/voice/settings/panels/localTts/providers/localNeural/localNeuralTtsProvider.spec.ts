import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';

const speakKokoroTextSpy = vi.fn().mockResolvedValue(undefined);
const daemonSpeakSpy = vi.fn().mockResolvedValue(undefined);
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

vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: (...args: any[]) => speakKokoroTextSpy(...args),
}));

vi.mock('@/voice/runtime/daemonInference/DaemonTtsController', () => ({
  DaemonTtsController: vi.fn().mockImplementation(() => ({
    speak: (...args: any[]) => daemonSpeakSpy(...args),
  })),
}));

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
  resolveDaemonVoiceInferenceExecution: async (params: { requestedExecution?: string | null }) => {
    const requestedExecution = params.requestedExecution ?? 'auto';
    if (requestedExecution !== 'auto') return requestedExecution;
    return platformOsMock.value === 'web' ? 'daemon' : 'device';
  },
}));

vi.mock('@/voice/settings/panels/localTts/LocalNeuralTtsSettings', () => ({
  LocalNeuralTtsSettings: () => null,
}));

describe('localNeuralTtsProviderSpec', () => {
  const envKey = 'EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS';
  let priorEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    speakKokoroTextSpy.mockClear();
    daemonSpeakSpy.mockClear();
    platformOsMock.value = 'ios';
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
      openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
      localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
      providers: {},
      autoSpeakReplies: true,
      bargeInEnabled: true,
    };

    await localNeuralTtsProviderSpec.test({ cfgTts, networkTimeoutMs: 15_000, sample: 'Hello' });

    expect(speakKokoroTextSpy).toHaveBeenCalled();
    const arg = speakKokoroTextSpy.mock.calls[0]?.[0];
    expect(arg?.timeoutMs).toBe(120_000);
  });

  it('routes Test TTS through the daemon controller for the default web auto execution path', async () => {
    platformOsMock.value = 'web';
    const { localNeuralTtsProviderSpec } = await import('./localNeuralTtsProvider');

    const cfgTts: VoiceLocalTtsSettings = {
      provider: 'local_neural',
      openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
      localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'auto' },
      providers: {},
      autoSpeakReplies: true,
      bargeInEnabled: true,
    };

    await localNeuralTtsProviderSpec.test({ cfgTts, networkTimeoutMs: 15_000, sample: 'Hello' });

    expect(daemonSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Hello',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
    }));
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
  });

  it('preserves explicit web device execution for Test TTS', async () => {
    platformOsMock.value = 'web';
    const { localNeuralTtsProviderSpec } = await import('./localNeuralTtsProvider');

    const cfgTts: VoiceLocalTtsSettings = {
      provider: 'local_neural',
      openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
      localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'device' },
      providers: {},
      autoSpeakReplies: true,
      bargeInEnabled: true,
    };

    await localNeuralTtsProviderSpec.test({ cfgTts, networkTimeoutMs: 15_000, sample: 'Hello from web device' });

    expect(speakKokoroTextSpy).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Hello from web device',
    }));
    expect(daemonSpeakSpy).not.toHaveBeenCalled();
  });
});
