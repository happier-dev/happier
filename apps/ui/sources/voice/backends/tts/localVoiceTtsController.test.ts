import { VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
    commitExternalVoiceProviderRegistration,
    removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

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
const bundledSpeechSynthesizeSpy = vi.fn(async (_params: unknown) => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/wav' as const,
}));
const playAudioBytesWithStopperSpy = vi.fn(async (params: Readonly<{
    onPlaybackStarted?: () => void;
}>) => {
    params.onPlaybackStarted?.();
});

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
    bundledSpeechDaemonClient: {
        transcribe: vi.fn(),
        synthesize: (params: unknown) => bundledSpeechSynthesizeSpy(params),
    },
}));

vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
    playAudioBytesWithStopper: (params: Readonly<{ onPlaybackStarted?: () => void }>) =>
        playAudioBytesWithStopperSpy(params),
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
        bundledSpeechSynthesizeSpy.mockReset();
        bundledSpeechSynthesizeSpy.mockResolvedValue({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'audio/wav',
        });
        playAudioBytesWithStopperSpy.mockClear();
    });

    it('dispatches a current external dual-role speech provider through normal Local Voice TTS', async () => {
        const declaration = VoiceProviderContributionSchema.parse({
            id: 'speech',
            title: 'External speech',
            kind: 'speech',
            roles: ['conversation_stt', 'conversation_tts'],
            platforms: ['web'],
            settings: {
                schemaVersion: 2,
                fields: [
                    {
                        id: 'model',
                        title: 'Model',
                        schema: { type: 'string', minLength: 1, maxLength: 256 },
                        default: 'external-model',
                        presentation: { control: 'text' },
                    },
                    {
                        id: 'voiceName',
                        title: 'Voice',
                        schema: { type: 'string', minLength: 1, maxLength: 256 },
                        default: 'external-voice',
                        presentation: { control: 'text' },
                    },
                    {
                        id: 'format',
                        title: 'Format',
                        schema: { type: 'string', enum: ['mp3', 'wav'] },
                        default: 'wav',
                        presentation: {
                            control: 'select',
                            options: [
                                { value: 'mp3', title: 'MP3' },
                                { value: 'wav', title: 'WAV' },
                            ],
                        },
                    },
                ],
            },
        });
        if (declaration.kind !== 'speech') throw new Error('expected speech declaration');

        const pluginId = 'acme.external';
        const providerId = `${pluginId}/${declaration.id}`;
        const token = {};
        const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
        const descriptor = {
            kind: 'voice.speech-engine.v1',
            pluginId,
            providerId,
            settingsSectionId: providerId,
            roles: declaration.roles,
            requirements: ['execution_machine'],
            supportedPlatforms: declaration.platforms,
            role: 'both',
            declaration,
            catalogs: declaration.catalogs,
            limits: declaration.limits,
            presentation: {
                providerId,
                settingsSectionId: providerId,
                createSettingsSpec: () => ({
                    titleKey: 'External speech',
                    subtitleKey: 'External speech',
                    detailKey: 'External speech',
                    iconName: 'extension',
                    fields: declaration.settings.fields.map((field) => ({
                        fieldId: field.id,
                        titleKey: typeof field.title === 'string' ? field.title : field.id,
                        subtitleKey: typeof field.title === 'string' ? field.title : field.id,
                    })),
                    test: null,
                }),
            },
            providerSettings,
            source: { kind: 'external', pluginId, localId: declaration.id },
        } satisfies VoiceProviderRegistryEntry;
        commitExternalVoiceProviderRegistration({
            token,
            pluginId,
            localId: declaration.id,
            providerId,
            descriptor,
            adapter: null,
        });

        const onSpeaking = vi.fn();
        const controller = createLocalVoiceTtsController();
        const request = {
            sessionId: 'session-external',
            text: 'speak through both roles',
            settings: {
                voice: {
                    providers: {
                        [providerId]: {
                            schemaVersion: 2,
                            config: providerSettings.defaultConfig,
                        },
                    },
                },
            },
            tts: {
                provider: providerId,
                localNeural: {
                    model: 'kokoro',
                    assetId: null,
                    voiceId: null,
                    speed: null,
                    execution: 'auto',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
            },
            networkTimeoutMs: 15_000,
            registerPlaybackStopper: () => () => {},
            onSpeaking,
        } as const;

        try {
            await expect(controller.speak(request)).resolves.toBeUndefined();
            expect(bundledSpeechSynthesizeSpy).toHaveBeenCalledWith(expect.objectContaining({
                entry: expect.objectContaining({ providerId, role: 'both' }),
                input: 'speak through both roles',
                model: 'external-model',
                voiceName: 'external-voice',
                format: 'wav',
            }));
            expect(playAudioBytesWithStopperSpy).toHaveBeenCalledTimes(1);
            expect(onSpeaking).toHaveBeenCalledTimes(1);

            removeExternalVoiceProviderRegistration(token);
            await expect(controller.speak(request)).rejects.toMatchObject({
                code: 'provider_unavailable',
            });
        } finally {
            removeExternalVoiceProviderRegistration(token);
        }
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
                'happier.voice.google/google-cloud-tts': { speak: googleCloudSpeakSpy },
                openai_compat: { speak: openAiCompatSpeakSpy },
            },
        });

        await controller.speak({
            sessionId: 'session-9',
            text: 'delegate me',
            settings: {},
            tts: {
                provider: 'local_neural',
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

    it('leaves an unset daemon voice null so the selected pack runtime owns its declared default', async () => {
        resolveDaemonVoiceInferenceExecutionSpy.mockResolvedValueOnce('daemon');
        daemonTtsControllerSpeakSpy.mockResolvedValueOnce(undefined);
        const controller = createLocalVoiceTtsController();

        await controller.speak({
            sessionId: 'session-default-voice',
            text: 'use the declared default',
            settings: {},
            tts: {
                provider: 'local_neural',
                localNeural: {
                    model: 'kokoro',
                    assetId: 'acme.voice/tts-pack',
                    voiceId: null,
                    speed: 1,
                    execution: 'daemon',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
            },
            networkTimeoutMs: 15_000,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });

        expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledWith(expect.objectContaining({
            packId: 'acme.voice/tts-pack',
            voiceId: null,
        }));
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
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: () => () => {},
      onSpeaking: vi.fn(),
    })).resolves.toBeUndefined();

    expect(daemonTtsControllerSpeakSpy).toHaveBeenCalledTimes(1);
    expect(speakKokoroTextSpy).not.toHaveBeenCalled();
    expect(speakDeviceTextSpy).not.toHaveBeenCalled();
  });
});
