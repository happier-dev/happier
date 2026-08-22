import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { createPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    createProjectedExternalVoiceProviderDerivedScopeFactory,
    withdrawProjectedExternalVoiceProviders,
} from '@/voice/registry/projectedExternalVoiceProviderActivation';

const resolveDaemonVoiceInferenceExecutionSpy = vi.fn(
    async (_params: unknown) => 'daemon' as const,
);
const daemonSttControllerTranscribeSpy = vi.fn(async (_params: unknown) => undefined);
const prepareDaemonVoiceInferenceSttSourceSpy = vi.fn(async (_params: unknown) => ({
    source: { kind: 'native', uri: 'file:///rec.wav' } as const,
    inputMimeType: 'audio/wav',
    normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
    } as const,
}));
const bundledSpeechTranscribeSpy = vi.fn(async (params: Readonly<{
    entry: Readonly<{ declaration?: Readonly<{ title?: unknown }> }>;
}>) => String(params.entry.declaration?.title ?? 'missing'));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
    });
});

vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
    resolveDaemonVoiceInferenceExecution: (params: unknown) =>
        resolveDaemonVoiceInferenceExecutionSpy(params),
}));

vi.mock('@/voice/runtime/daemonInference/DaemonSttController', () => ({
    DaemonSttController: vi.fn().mockImplementation(() => ({
        transcribeRecordedAudio: (params: unknown) => daemonSttControllerTranscribeSpy(params),
    })),
}));

vi.mock('@/voice/input/prepareDaemonVoiceInferenceSttSource', () => ({
    prepareDaemonVoiceInferenceSttSource: (params: unknown) =>
        prepareDaemonVoiceInferenceSttSourceSpy(params),
}));

vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
    bundledSpeechDaemonClient: {
        transcribe: (params: Parameters<typeof bundledSpeechTranscribeSpy>[0]) =>
            bundledSpeechTranscribeSpy(params),
        synthesize: vi.fn(),
    },
}));

function createExternalSpeechProjection(input: Readonly<{
    generation: number;
    pluginId: string;
    title: string;
}>): PluginUiProjectionModel {
    const declaration = VoiceProviderContributionSchema.parse({
        id: 'stt',
        title: input.title,
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web'],
        settings: {
            schemaVersion: 1,
            fields: [{
                id: 'model',
                title: 'Model',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'synthetic-stt-v1',
                presentation: { control: 'text' },
            }],
        },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const providerId = `${input.pluginId}/${declaration.id}`;
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: input.generation,
        voiceProvidersById: Object.freeze({
            [providerId]: Object.freeze({
                id: providerId,
                pluginId: input.pluginId,
                generation: input.generation,
                contributionKey: providerId,
                definition: declaration,
            }),
        }),
    });
}

describe('recordedAudioTranscriptionController', () => {
    it('resolves the current projected external STT contribution for every invocation', async () => {
        const pluginId = 'acme.live-speech';
        const providerId = `${pluginId}/stt`;
        const executableHost = createPluginUiExecutableModuleHost();
        onTestFinished(async () => {
            await withdrawProjectedExternalVoiceProviders(executableHost);
            bundledSpeechTranscribeSpy.mockClear();
        });
        const { createRecordedAudioTranscriptionController } = await import('./recordedAudioTranscriptionController');
        const controller = createRecordedAudioTranscriptionController();
        const request = {
            uri: 'file:///rec.wav',
            settings: {
                voice: {
                    providerId: 'local_direct',
                    assistantLanguage: 'en',
                    providers: {
                        local_direct: {
                            schemaVersion: 1,
                            config: {
                                stt: { provider: providerId },
                                networkTimeoutMs: 15_000,
                            },
                        },
                        [providerId]: {
                            schemaVersion: 1,
                            config: { model: 'synthetic-stt-v1' },
                        },
                    },
                },
            },
        } as const;

        createProjectedExternalVoiceProviderDerivedScopeFactory({
            projection: createExternalSpeechProjection({ generation: 1, pluginId, title: 'Runtime A' }),
            hostPlatform: 'web',
            executableHost,
        });
        await expect(controller.transcribe(request)).resolves.toBe('Runtime A');

        createProjectedExternalVoiceProviderDerivedScopeFactory({
            projection: createExternalSpeechProjection({ generation: 2, pluginId, title: 'Runtime B' }),
            hostPlatform: 'web',
            executableHost,
        });
        await expect(controller.transcribe(request)).resolves.toBe('Runtime B');

        await withdrawProjectedExternalVoiceProviders(executableHost);
        await expect(controller.transcribe(request)).rejects.toMatchObject({
            code: 'provider_unavailable',
        });
        expect(bundledSpeechTranscribeSpy).toHaveBeenCalledTimes(2);
    });

    it('delegates provider routing through the configured recorded-audio STT controller map', async () => {
        const deviceTranscribeSpy = vi.fn(async (_params: unknown) => 'device');
        const openAiCompatTranscribeSpy = vi.fn(async (_params: unknown) => 'openai');
        const googleGeminiTranscribeSpy = vi.fn(async (_params: unknown) => 'gemini');
        const localNeuralTranscribeSpy = vi.fn(async (_params: unknown) => 'local-neural');

        const { createRecordedAudioTranscriptionController } = await import('./recordedAudioTranscriptionController');
        const controller = createRecordedAudioTranscriptionController({
            controllers: {
                device: { transcribe: deviceTranscribeSpy },
                openai_compat: { transcribe: openAiCompatTranscribeSpy },
                'happier.voice.google/gemini-stt': { transcribe: googleGeminiTranscribeSpy },
                local_neural: { transcribe: localNeuralTranscribeSpy },
            },
        });

        await expect(
            controller.transcribe({
                sessionId: 'session-9',
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
                                    localNeural: {
                                        assetId: 'dummy',
                                        language: 'en',
                                        execution: 'daemon',
                                    },
                                },
                                networkTimeoutMs: 15_000,
                            } },
                        },
                    },
                },
            }),
        ).resolves.toBe('local-neural');

        expect(localNeuralTranscribeSpy).toHaveBeenCalledTimes(1);
        expect(localNeuralTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-9',
            uri: 'file:///rec.wav',
        }));
        expect(deviceTranscribeSpy).not.toHaveBeenCalled();
        expect(openAiCompatTranscribeSpy).not.toHaveBeenCalled();
        expect(googleGeminiTranscribeSpy).not.toHaveBeenCalled();
    });

    it.each(['machine_unreachable', 'runtime_unavailable'] as const)(
        'surfaces %s after one daemon attempt when daemon local_neural STT is unavailable',
        async (code) => {
            daemonSttControllerTranscribeSpy.mockReset();
            const error = Object.assign(new Error(`daemon_voice_inference_${code}`), { code });
            daemonSttControllerTranscribeSpy.mockRejectedValueOnce(error);
            resolveDaemonVoiceInferenceExecutionSpy.mockClear();
            prepareDaemonVoiceInferenceSttSourceSpy.mockClear();

            const { createRecordedAudioTranscriptionController } = await import('./recordedAudioTranscriptionController');
            const controller = createRecordedAudioTranscriptionController();

            await expect(
                controller.transcribe({
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
                                        localNeural: {
                                            assetId: 'dummy',
                                            language: 'en',
                                            execution: 'daemon',
                                        },
                                    },
                                    networkTimeoutMs: 15_000,
                                } },
                            },
                        },
                    },
                }),
            ).rejects.toMatchObject({
                code,
                message: `daemon_voice_inference_${code}`,
            });

            expect(resolveDaemonVoiceInferenceExecutionSpy).toHaveBeenCalledTimes(1);
            expect(resolveDaemonVoiceInferenceExecutionSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    requestedExecution: 'daemon',
                    sessionId: 'session-1',
                    surface: 'stt',
                }),
            );
            expect(prepareDaemonVoiceInferenceSttSourceSpy).toHaveBeenCalledTimes(1);
            expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledTimes(1);
        },
    );
});
