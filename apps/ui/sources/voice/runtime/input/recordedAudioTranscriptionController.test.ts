import { describe, expect, it, vi } from 'vitest';

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

describe('recordedAudioTranscriptionController', () => {
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
                google_gemini: { transcribe: googleGeminiTranscribeSpy },
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
