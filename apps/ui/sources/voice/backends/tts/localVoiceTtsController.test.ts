import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveDaemonVoiceInferenceExecutionSpy = vi.fn<
    (_params: unknown) => Promise<'device' | 'daemon'>
>(
    async (_params: unknown) => 'daemon' as const,
);
const daemonTtsControllerSpeakSpy = vi.fn(async (_params: unknown) => undefined);
const speakDeviceTextSpy = vi.fn(
    async (_text: string, _onSpeaking: () => void, _options?: unknown) => undefined,
);
const stopDeviceSpeechSpy = vi.fn((_stopper?: unknown) => undefined);
const speakKokoroTextSpy = vi.fn(async (_params: unknown) => undefined);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
    });
});

vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
    resolveDaemonVoiceInferenceExecution: (params: unknown) =>
        resolveDaemonVoiceInferenceExecutionSpy(params),
    resolveLocalNeuralExecutionPolicy: (params: { requestedExecution?: string | null }) => {
        const requestedExecution = params.requestedExecution ?? 'auto';
        return {
            allowDeviceSelection: true,
            preferredExecution: requestedExecution === 'daemon' ? 'daemon' : 'device',
            requestedExecution,
            selectableExecution: requestedExecution,
        };
    },
}));

vi.mock('@/voice/runtime/daemonInference/DaemonTtsController', () => ({
    DaemonTtsController: vi.fn().mockImplementation(() => ({
        speak: (params: unknown) => daemonTtsControllerSpeakSpy(params),
    })),
}));

vi.mock('@/voice/local/speakDeviceText', () => ({
    speakDeviceText: (text: string, onSpeaking: () => void, options?: unknown) =>
        speakDeviceTextSpy(text, onSpeaking, options),
    stopDeviceSpeech: () => stopDeviceSpeechSpy(),
}));

vi.mock('@/voice/output/KokoroTtsController', () => ({
    speakKokoroText: (params: unknown) => speakKokoroTextSpy(params),
}));

vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
    bundledSpeechDaemonClient: { transcribe: vi.fn(), synthesize: vi.fn() },
}));

vi.mock('@/voice/output/TtsController', () => ({
    speakOpenAiCompatText: vi.fn(),
}));

import { createLocalVoiceTtsController } from './localVoiceTtsController';

describe('localVoiceTtsController', () => {
    beforeEach(() => {
        resolveDaemonVoiceInferenceExecutionSpy.mockReset();
        resolveDaemonVoiceInferenceExecutionSpy.mockResolvedValue('daemon');
        daemonTtsControllerSpeakSpy.mockReset();
        daemonTtsControllerSpeakSpy.mockResolvedValue(undefined);
        speakDeviceTextSpy.mockReset();
        speakDeviceTextSpy.mockResolvedValue(undefined);
        speakKokoroTextSpy.mockReset();
        speakKokoroTextSpy.mockResolvedValue(undefined);
    });

    it('delegates provider routing through the configured TTS controller map', async () => {
        const deviceSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const localNeuralSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const googleCloudSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const openAiCompatSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);

        const controller = createLocalVoiceTtsController({
            controllers: {
                device: { speak: deviceSpeakSpy },
                local_neural: { speak: localNeuralSpeakSpy },
                google_cloud: { speak: googleCloudSpeakSpy },
                openai_compat: { speak: openAiCompatSpeakSpy },
            },
        });

        await controller.speak({
            sessionId: 'session-9',
            text: 'delegate me',
            settings: {},
            tts: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                    model: 'kokoro',
                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                    voiceId: 'af_heart',
                    speed: 1,
                    execution: 'daemon',
                },
                providers: {},
                autoSpeakReplies: true,
                bargeInEnabled: true,
            },
            networkTimeoutMs: 15_000,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });

        expect(localNeuralSpeakSpy).toHaveBeenCalledTimes(1);
        expect(localNeuralSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-9',
            text: 'delegate me',
        }));
        expect(deviceSpeakSpy).not.toHaveBeenCalled();
        expect(googleCloudSpeakSpy).not.toHaveBeenCalled();
        expect(openAiCompatSpeakSpy).not.toHaveBeenCalled();
    });

  it.each([
    'machine_unreachable',
    'runtime_unavailable',
    'model_not_installed',
    'request_timeout',
    'unsupported_codec',
    'download_failed',
    'internal_error',
  ] as const)(
    'reports %s from explicit daemon local_neural TTS without changing execution or provider',
    async (code) => {
      daemonTtsControllerSpeakSpy.mockReset();
      daemonTtsControllerSpeakSpy.mockRejectedValueOnce(
        Object.assign(new Error(`daemon_voice_inference_${code}`), { code }),
      );
      const onTtsFailed = vi.fn();

            const controller = createLocalVoiceTtsController();

            await controller.speak({
                sessionId: 'session-1',
                text: 'hello from daemon fallback',
                settings: {},
                tts: {
                    provider: 'local_neural',
                    openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                    localNeural: {
                        model: 'kokoro',
                        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                        voiceId: 'af_heart',
                        speed: 1,
                        execution: 'daemon',
                    },
                    providers: {},
                    autoSpeakReplies: true,
                    bargeInEnabled: true,
                },
                networkTimeoutMs: 15_000,
                registerPlaybackStopper: () => () => {},
                onSpeaking: vi.fn(),
                onTtsFailed,
            });

      expect(resolveDaemonVoiceInferenceExecutionSpy).toHaveBeenCalledTimes(1);
      expect(resolveDaemonVoiceInferenceExecutionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedExecution: 'daemon',
          sessionId: 'session-1',
          surface: 'tts',
        }),
      );
      expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledTimes(1);
      expect(speakKokoroTextSpy).not.toHaveBeenCalled();
      expect(speakDeviceTextSpy).not.toHaveBeenCalled();
      expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'tts_failed',
        reason: `daemon_voice_inference_${code}`,
      }));
    },
  );

  it.each([
    Object.assign(new Error('daemon_voice_inference_feature_disabled'), { code: 'feature_disabled' }),
    new Error('daemon_voice_inference_feature_probe_failed'),
  ])('reports execution-policy failure without invoking any TTS implementation', async (resolutionError) => {
      resolveDaemonVoiceInferenceExecutionSpy.mockRejectedValueOnce(resolutionError);
      const onTtsFailed = vi.fn();

      const controller = createLocalVoiceTtsController();

      await controller.speak({
        sessionId: 'session-1',
        text: 'hello from daemon fallback',
        settings: {},
        tts: {
          provider: 'local_neural',
          openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
          localNeural: {
            model: 'kokoro',
            assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            execution: 'daemon',
          },
          providers: {},
          autoSpeakReplies: true,
          bargeInEnabled: true,
        },
        networkTimeoutMs: 15_000,
          registerPlaybackStopper: () => () => {},
          onSpeaking: vi.fn(),
          onTtsFailed,
        });

      expect(daemonTtsControllerSpeakSpy).not.toHaveBeenCalled();
      expect(speakKokoroTextSpy).not.toHaveBeenCalled();
      expect(speakDeviceTextSpy).not.toHaveBeenCalled();
      expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'tts_failed',
        reason: resolutionError.message,
      }));
  });

  it('reports explicit device local_neural failure without substituting OS speech', async () => {
    resolveDaemonVoiceInferenceExecutionSpy.mockResolvedValueOnce('device');
    speakKokoroTextSpy.mockRejectedValueOnce(new Error('kokoro_runtime_unavailable'));
    const onTtsFailed = vi.fn();

    const controller = createLocalVoiceTtsController();
    await controller.speak({
      sessionId: 'session-1',
      text: 'device kokoro',
      settings: {},
      tts: {
        provider: 'local_neural',
        openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
        localNeural: {
          model: 'kokoro',
          assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
          voiceId: 'af_heart',
          speed: 1,
          execution: 'device',
        },
        providers: {},
        autoSpeakReplies: true,
        bargeInEnabled: true,
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: () => () => {},
      onSpeaking: vi.fn(),
      onTtsFailed,
    });

    expect(speakKokoroTextSpy).toHaveBeenCalledTimes(1);
    expect(daemonTtsControllerSpeakSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts_failed',
      reason: 'kokoro_runtime_unavailable',
    }));
  });

  it('does not fall back to other TTS providers when the daemon synthesis is cancelled', async () => {
    daemonTtsControllerSpeakSpy.mockReset();
    daemonTtsControllerSpeakSpy.mockRejectedValueOnce(
      Object.assign(new Error('daemon_voice_inference_cancelled'), { code: 'cancelled' }),
    );
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const controller = createLocalVoiceTtsController();

    await expect(controller.speak({
      sessionId: 'session-1',
      text: 'hello from daemon cancellation',
      settings: {},
      tts: {
        provider: 'local_neural',
        openaiCompat: { baseUrl: null, insecureLocalOriginConsent: null, insecureLocalConsentMachineId: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
        localNeural: {
          model: 'kokoro',
          assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
          voiceId: 'af_heart',
          speed: 1,
          execution: 'daemon',
        },
        providers: {},
        autoSpeakReplies: true,
        bargeInEnabled: true,
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: () => () => {},
      onSpeaking: vi.fn(),
    })).resolves.toBeUndefined();

    expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledTimes(1);
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
  });
});
