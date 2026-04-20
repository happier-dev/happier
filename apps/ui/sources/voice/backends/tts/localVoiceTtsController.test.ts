import { describe, expect, it, vi } from 'vitest';

const resolveDaemonVoiceInferenceExecutionSpy = vi.fn(
    async (_params: unknown) => 'daemon' as const,
);
const daemonTtsControllerSpeakSpy = vi.fn(async (_params: unknown) => undefined);
const speakDeviceTextSpy = vi.fn(
    async (_text: string, _onSpeaking: () => void) => undefined,
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
    speakDeviceText: (text: string, onSpeaking: () => void) =>
        speakDeviceTextSpy(text, onSpeaking),
    stopDeviceSpeech: () => stopDeviceSpeechSpy(),
}));

vi.mock('@/voice/output/KokoroTtsController', () => ({
    speakKokoroText: (params: unknown) => speakKokoroTextSpy(params),
}));

vi.mock('@/voice/output/GoogleCloudTtsController', () => ({
    speakGoogleCloudText: vi.fn(),
}));

vi.mock('@/voice/output/TtsController', () => ({
    speakOpenAiCompatText: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: () => null,
    },
}));

describe('localVoiceTtsController', () => {
    it('delegates provider routing through the configured TTS controller map', async () => {
        const deviceSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const localNeuralSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const googleCloudSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);
        const openAiCompatSpeakSpy = vi.fn(async (_ctx: unknown) => undefined);

        const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
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
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                localNeural: {
                    model: 'kokoro',
                    assetId: 'kokoro-tts-en-v1',
                    voiceId: 'af_heart',
                    speed: 1,
                    execution: 'daemon',
                },
                googleCloud: {
                    apiKey: null,
                    voiceName: null,
                    languageCode: null,
                    androidCertSha1: null,
                    format: 'mp3',
                    speakingRate: null,
                    pitch: null,
                },
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

  it.each(['machine_unreachable', 'runtime_unavailable'] as const)(
    'falls back to native local-neural device runtime after one daemon attempt when %s blocks daemon local_neural TTS',
    async (code) => {
      daemonTtsControllerSpeakSpy.mockReset();
      daemonTtsControllerSpeakSpy.mockRejectedValueOnce(
        Object.assign(new Error(`daemon_voice_inference_${code}`), { code }),
      );
            resolveDaemonVoiceInferenceExecutionSpy.mockClear();
            speakDeviceTextSpy.mockClear();
            speakKokoroTextSpy.mockClear();

            const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
            const controller = createLocalVoiceTtsController();

            await controller.speak({
                sessionId: 'session-1',
                text: 'hello from daemon fallback',
                settings: {},
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
                    googleCloud: {
                        apiKey: null,
                        voiceName: null,
                        languageCode: null,
                        androidCertSha1: null,
                        format: 'mp3',
                        speakingRate: null,
                        pitch: null,
                    },
                    autoSpeakReplies: true,
                    bargeInEnabled: true,
                },
                networkTimeoutMs: 15_000,
                registerPlaybackStopper: () => () => {},
                onSpeaking: vi.fn(),
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
      expect(speakKokoroTextSpy).toHaveBeenCalledTimes(1);
      expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['model_not_installed', 'request_timeout'] as const)(
    'falls back to native local-neural device runtime when daemon local_neural TTS fails with %s',
    async (code) => {
      daemonTtsControllerSpeakSpy.mockReset();
      daemonTtsControllerSpeakSpy.mockRejectedValueOnce(
        Object.assign(new Error(`daemon_voice_inference_${code}`), { code }),
      );
      speakDeviceTextSpy.mockClear();
      speakKokoroTextSpy.mockClear();

      const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
      const controller = createLocalVoiceTtsController();

      await controller.speak({
        sessionId: 'session-1',
        text: 'hello from daemon fallback',
        settings: {},
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
          googleCloud: {
            apiKey: null,
            voiceName: null,
            languageCode: null,
            androidCertSha1: null,
            format: 'mp3',
            speakingRate: null,
            pitch: null,
          },
          autoSpeakReplies: true,
          bargeInEnabled: true,
        },
        networkTimeoutMs: 15_000,
        registerPlaybackStopper: () => () => {},
        onSpeaking: vi.fn(),
      });

      expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledTimes(1);
      expect(speakKokoroTextSpy).toHaveBeenCalledTimes(1);
      expect(speakDeviceTextSpy).not.toHaveBeenCalled();
    },
  );

  it('does not fall back to other TTS providers when the daemon synthesis is cancelled', async () => {
    daemonTtsControllerSpeakSpy.mockReset();
    daemonTtsControllerSpeakSpy.mockRejectedValueOnce(
      Object.assign(new Error('daemon_voice_inference_cancelled'), { code: 'cancelled' }),
    );
    speakDeviceTextSpy.mockClear();
    speakKokoroTextSpy.mockClear();

    const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
    const controller = createLocalVoiceTtsController();

    await expect(controller.speak({
      sessionId: 'session-1',
      text: 'hello from daemon cancellation',
      settings: {},
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
        googleCloud: {
          apiKey: null,
          voiceName: null,
          languageCode: null,
          androidCertSha1: null,
          format: 'mp3',
          speakingRate: null,
          pitch: null,
        },
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
