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
        const onSpeaking = vi.fn();
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            expect(onSpeaking).not.toHaveBeenCalled();
            opts.onPlaybackStarted?.();
            expect(onSpeaking).toHaveBeenCalledTimes(1);
        });
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
            onPlaybackStarted: expect.any(Function),
        }));
    });

    it('does not enter speaking when batch synthesis fails before audio is playable', async () => {
        const synthesizeText = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), {
            code: 'runtime_unavailable',
        }));
        const onSpeaking = vi.fn();

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('boom');

        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('does not enter speaking when batch playback fails before start', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });
        const onSpeaking = vi.fn();

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('decode failed');
            }),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('decode failed');

        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('plays the first daemon segment before the second segment is ready and acks after playback', async () => {
        const secondSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const next = vi.fn()
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-1',
                generation: 0,
                segmentId: 'tts-stream-1:0',
                segmentIndex: 0,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                isLastSegment: false,
            })
            .mockReturnValueOnce(secondSegment.promise);
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-1',
            generation: 0,
            segmentCount: 2,
            next,
            ackSegment,
            cancel,
        }));
        const onSpeaking = vi.fn();
        let playCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playCalls += 1;
            if (playCalls === 1) {
                expect(onSpeaking).not.toHaveBeenCalled();
            }
            opts.onPlaybackStarted?.();
        });

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Hello. Still synthesizing.',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        });

        await vi.waitFor(() => {
            expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        });
        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(ackSegment).toHaveBeenCalledWith(expect.objectContaining({
            segmentId: 'tts-stream-1:0',
            segmentIndex: 0,
        }));
        expect(next).toHaveBeenCalledTimes(2);

        secondSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-1',
            generation: 0,
            segmentId: 'tts-stream-1:1',
            segmentIndex: 1,
            segmentCount: 2,
            bytes: new Uint8Array(Buffer.from('audio-1')),
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
            isLastSegment: true,
        });
        await speaking;
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(2);
        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(ackSegment).toHaveBeenCalledWith(expect.objectContaining({
            segmentId: 'tts-stream-1:1',
            segmentIndex: 1,
        }));
        expect(cancel).not.toHaveBeenCalled();
    });

    it('does not enter speaking before the first daemon segment is available', async () => {
        const firstSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-pending',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(() => firstSegment.promise),
            ackSegment: vi.fn(async () => {}),
            cancel: vi.fn(async () => {}),
        }));
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            opts.onPlaybackStarted?.();
        });
        const onSpeaking = vi.fn();

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Still synthesizing.',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        });

        await vi.waitFor(() => {
            expect(startSegmentedTts).toHaveBeenCalledTimes(1);
        });
        expect(onSpeaking).not.toHaveBeenCalled();

        firstSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-pending',
            generation: 0,
            segmentId: 'tts-stream-pending:0',
            segmentIndex: 0,
            segmentCount: 1,
            bytes: new Uint8Array(Buffer.from('audio-0')),
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
            isLastSegment: true,
        });

        await speaking;
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(onSpeaking).toHaveBeenCalledTimes(1);
    });

    it('does not enter speaking when first segmented playback fails before start', async () => {
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-play-fail',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(async () => ({
                type: 'segment',
                streamId: 'tts-stream-play-fail',
                generation: 0,
                segmentId: 'tts-stream-play-fail:0',
                segmentIndex: 0,
                segmentCount: 1,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                isLastSegment: true,
            })),
            ackSegment,
            cancel,
        }));
        const onSpeaking = vi.fn();

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('playback failed');
            }),
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        });

        expect(onSpeaking).not.toHaveBeenCalled();
        expect(ackSegment).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('aborts queued daemon TTS playback when a prefetched segment fails to play', async () => {
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const next = vi.fn()
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-prefetch-fail',
                generation: 0,
                segmentId: 'tts-stream-prefetch-fail:0',
                segmentIndex: 0,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                isLastSegment: false,
            })
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-prefetch-fail',
                generation: 0,
                segmentId: 'tts-stream-prefetch-fail:1',
                segmentIndex: 1,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-1')),
                output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                isLastSegment: true,
            });
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-prefetch-fail',
            generation: 0,
            segmentCount: 2,
            next,
            ackSegment,
            cancel,
        }));
        const playAudioBytesWithStopper = vi.fn(async () => {
            throw new Error('playback failed');
        });

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking: vi.fn(),
        });

        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(ackSegment).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does not enter speaking when segmented stream start fails before audio is playable', async () => {
        const startSegmentedTts = vi.fn().mockRejectedValue(Object.assign(new Error('stream start failed'), {
            code: 'runtime_unavailable',
        }));
        const onSpeaking = vi.fn();

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('stream start failed');

        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('cancels segmented daemon TTS and discards stale prefetched segments on abort', async () => {
        const abortController = new AbortController();
        const delayedSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-abort',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(() => delayedSegment.promise),
            ackSegment: vi.fn(async () => {}),
            cancel,
        }));
        const playAudioBytesWithStopper = vi.fn().mockResolvedValue(undefined);

        const { DaemonTtsController } = await import('./DaemonTtsController');
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'Abort before audio arrives.',
            packId: 'kokoro-tts-en-v1',
            voiceId: null,
            speed: null,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking: vi.fn(),
            signal: abortController.signal,
        });
        await vi.waitFor(() => {
            expect(startSegmentedTts).toHaveBeenCalledTimes(1);
        });
        abortController.abort();
        delayedSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-abort',
            generation: 0,
            segmentId: 'tts-stream-abort:0',
            segmentIndex: 0,
            segmentCount: 1,
            bytes: new Uint8Array(Buffer.from('stale')),
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
            isLastSegment: true,
        });

        await speaking;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
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
