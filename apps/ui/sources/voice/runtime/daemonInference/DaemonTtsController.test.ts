import { describe, expect, it, vi } from 'vitest';

vi.mock('@/voice/runtime/voiceRuntimeConfigDefaults', () => ({
    VOICE_RUNTIME_CONFIG_DEFAULTS: {
        listeningStartTimeoutMs: 5_000,
        realtimeWatchdogPollMs: 3_000,
        realtimeWatchdogPlateauMs: 10_000,
        daemonInference: {
            warmIdleEvictMs: 5 * 60 * 1000,
            warmOnVoiceHomeAttach: true,
            perModelConcurrency: 1,
            statusPollMs: 750,
            tts: {
                defaultCodec: {
                    codec: 'mp3',
                    mimeType: 'audio/mpeg',
                },
                latencyBudgetMs: 2_000,
                consecutiveSlowCallsBeforeDemotion: 2,
            },
            stt: {
                maxUploadBytes: 25 * 1024 * 1024,
                acceptedInputFormats: ['audio/wav'],
            },
        },
    },
}));

vi.mock('./DaemonVoiceInferenceClient', () => ({
    DaemonVoiceInferenceClient: class {
        synthesizeText = vi.fn();
    },
}));

vi.mock('./daemonVoiceInferencePolicy', () => ({
    recordDaemonVoiceInferenceTtsLatencySample: vi.fn(),
}));

describe('DaemonTtsController', () => {
    it('synthesizes with the daemon client and plays the returned audio bytes', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });
        const playAudioBytesWithStopper = vi.fn().mockResolvedValue(undefined);
        const onSpeaking = vi.fn();
        const registerPlaybackStopper = vi.fn((_stopper: () => void) => () => {});

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper,
            onSpeaking,
        });

        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(synthesizeText).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        }));
        expect(playAudioBytesWithStopper).toHaveBeenCalledWith(expect.objectContaining({
            format: 'mp3',
        }));
    });

    it('allows overriding the daemon TTS output codec on a per-call basis', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const playAudioBytesWithStopper = vi.fn().mockResolvedValue(undefined);

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-override',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking: vi.fn(),
            output: { codec: 'wav', mimeType: 'audio/wav' },
        } as any);

        expect(synthesizeText).toHaveBeenCalledWith(expect.objectContaining({
            output: { codec: 'wav', mimeType: 'audio/wav' },
        }));
        expect(playAudioBytesWithStopper).toHaveBeenCalledWith(expect.objectContaining({
            format: 'wav',
        }));
    });

    it('rejects daemon responses with unsupported playback codecs', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'opus', mimeType: 'audio/opus' },
        });

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });
    });

    it('rejects daemon responses with mismatched codec and mime type', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'mp3', mimeType: 'audio/wav' },
        });

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });
    });
});
