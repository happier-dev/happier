import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { DaemonTtsController } from './DaemonTtsController';

vi.mock('@/voice/runtime/voiceRuntimeConfigDefaults', () => ({
    VOICE_RUNTIME_CONFIG_DEFAULTS: {
        realtimeWatchdogPollMs: 3_000,
        realtimeWatchdogPlateauMs: 10_000,
        daemonInference: {
            warmIdleEvictMs: 5 * 60 * 1000,
            warmOnVoiceHomeAttach: true,
            perModelConcurrency: 1,
            statusPollMs: 750,
            tts: {
                defaultCodec: {
                    codec: 'wav',
                    mimeType: 'audio/wav',
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

// This suite exercises daemon TTS. Keep the unrelated OpenAI-compatible daemon
// client boundary out of the module graph pulled in by the shared queue owner.
vi.mock('@/voice/local/openaiCompat/client', () => ({
    OpenAiCompatDaemonClient: class {},
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
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const onSpeaking = vi.fn();
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            expect(onSpeaking).not.toHaveBeenCalled();
            opts.onPlaybackStarted?.();
            expect(onSpeaking).toHaveBeenCalledTimes(1);
        });
        const registerPlaybackStopper = vi.fn((_stopper: () => void) => () => {});

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper,
            onSpeaking,
        });

        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(synthesizeText).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            output: { codec: 'wav', mimeType: 'audio/wav' },
        }));
        expect(playAudioBytesWithStopper).toHaveBeenCalledWith(expect.objectContaining({
            format: 'wav',
            onPlaybackStarted: expect.any(Function),
        }));
    });

    it('does not enter speaking when batch synthesis fails before audio is playable', async () => {
        const synthesizeText = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), {
            code: 'runtime_unavailable',
        }));
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('decode failed');
            }),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
                output: { codec: 'wav', mimeType: 'audio/wav' },
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

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Hello. Still synthesizing.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
            output: { codec: 'wav', mimeType: 'audio/wav' },
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

    it('keeps segmented audio residency bounded while remote confirmations remain asynchronous', async () => {
        let releaseFirstPlayback!: () => void;
        const firstPlayback = new Promise<void>((resolve) => { releaseFirstPlayback = resolve; });
        let markSecondSegmentReturned!: () => void;
        const secondSegmentReturned = new Promise<void>((resolve) => { markSecondSegmentReturned = resolve; });
        const segments = Array.from({ length: 4 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-bounded',
            generation: 0,
            segmentId: `tts-stream-bounded:${segmentIndex}`,
            segmentIndex,
            segmentCount: 4,
            bytes: new Uint8Array(256).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: segmentIndex === 3,
        }));
        const next = vi.fn(async () => {
            const segment = segments.shift()!;
            if (segment.segmentIndex === 1) {
                markSecondSegmentReturned();
            }
            return segment;
        });
        const ackSegment = vi.fn(async () => {});
        let streamSignal: AbortSignal | null = null;
        const startSegmentedTts = vi.fn(async (params: { signal: AbortSignal }) => {
            streamSignal = params.signal;
            return ({
            streamId: 'tts-stream-bounded',
            generation: 0,
            segmentCount: 4,
            next,
            ackSegment,
            cancel: vi.fn(async () => {}),
            });
        });
        let playbackCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playbackCalls += 1;
            opts.onPlaybackStarted?.();
            if (playbackCalls === 1) await firstPlayback;
        });
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });
        const speaking = controller.speak({
            text: 'One. Two. Three. Four.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });

        await secondSegmentReturned;
        expect(next).toHaveBeenCalledTimes(2);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        releaseFirstPlayback();
        await speaking;
        expect(next).toHaveBeenCalledTimes(4);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(4);
        expect(ackSegment).toHaveBeenCalledTimes(4);
        expect(streamSignal).not.toBeNull();
        expect(getEventListeners(streamSignal!, 'abort')).toHaveLength(0);
    });

    it('stops the segmented producer when playback fails with later segments still available', async () => {
        const segments = Array.from({ length: 2 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-playback-failure',
            generation: 0,
            segmentId: `tts-stream-playback-failure:${segmentIndex}`,
            segmentIndex,
            segmentCount: 4,
            bytes: new Uint8Array(256).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: false,
        }));
        let markSecondSegmentReturned!: () => void;
        const secondSegmentReturned = new Promise<void>((resolve) => { markSecondSegmentReturned = resolve; });
        let markThirdNextStarted!: () => void;
        const thirdNextStarted = new Promise<void>((resolve) => { markThirdNextStarted = resolve; });
        const pendingThirdNext = new Promise<never>(() => {});
        const next = vi.fn(async () => {
            const segment = segments.shift();
            if (segment) {
                if (segment.segmentIndex === 1) {
                    markSecondSegmentReturned();
                }
                return segment;
            }
            markThirdNextStarted();
            return pendingThirdNext;
        });
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-playback-failure',
            generation: 0,
            segmentCount: 4,
            next,
            ackSegment,
            cancel,
        }));
        let failFirstPlayback!: () => void;
        const firstPlaybackFailure = new Promise<void>((_resolve, reject) => {
            failFirstPlayback = () => reject(new Error('playback failed'));
        });
        const playAudioBytesWithStopper = vi.fn(async () => {
            await firstPlaybackFailure;
        });
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });
        const speaking = controller.speak({
            text: 'One. Two. Three. Four.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });
        await secondSegmentReturned;
        expect(next).toHaveBeenCalledTimes(2);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        failFirstPlayback();
        await thirdNextStarted;
        await speaking;
        expect(next).toHaveBeenCalledTimes(3);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(ackSegment).not.toHaveBeenCalled();
    });

    it('stops active local playback when an asynchronous confirmation fails', async () => {
        const segments = Array.from({ length: 2 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-confirmation-failure',
            generation: 0,
            segmentId: `tts-stream-confirmation-failure:${segmentIndex}`,
            segmentIndex,
            segmentCount: 2,
            bytes: new Uint8Array(16).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: segmentIndex === 1,
        }));
        let rejectFirstConfirmation!: () => void;
        const firstConfirmation = new Promise<void>((_resolve, reject) => {
            rejectFirstConfirmation = () => reject(new Error('confirmation failed'));
        });
        const ackSegment = vi.fn(async () => await firstConfirmation);
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-confirmation-failure',
            generation: 0,
            segmentCount: 2,
            next: vi.fn(async () => segments.shift()!),
            ackSegment,
            cancel,
        }));
        let releaseSecondPlayback!: () => void;
        const secondPlayback = new Promise<void>((resolve) => { releaseSecondPlayback = resolve; });
        let markSecondPlaybackStarted!: () => void;
        const secondPlaybackStarted = new Promise<void>((resolve) => { markSecondPlaybackStarted = resolve; });
        const stopActivePlayback = vi.fn(() => releaseSecondPlayback());
        let playbackCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playbackCalls += 1;
            opts.onPlaybackStarted?.();
            if (playbackCalls !== 2) {
                return;
            }
            const clearStopper = opts.registerPlaybackStopper(stopActivePlayback);
            markSecondPlaybackStarted();
            try {
                await secondPlayback;
            } finally {
                clearStopper();
            }
        });
        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'One. Two.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });
        await secondPlaybackStarted;
        rejectFirstConfirmation();
        await speaking;

        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(2);
        expect(ackSegment).toHaveBeenCalledTimes(1);
        expect(stopActivePlayback).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
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

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Still synthesizing.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
            output: { codec: 'wav', mimeType: 'audio/wav' },
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
                output: { codec: 'wav', mimeType: 'audio/wav' },
                isLastSegment: true,
            })),
            ackSegment,
            cancel,
        }));
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('playback failed');
            }),
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
                output: { codec: 'wav', mimeType: 'audio/wav' },
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
                output: { codec: 'wav', mimeType: 'audio/wav' },
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

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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

        const controller = new DaemonTtsController({
            client: { synthesizeText: vi.fn(), startSegmentedTts } as any,
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'Abort before audio arrives.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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
            output: { codec: 'wav', mimeType: 'audio/wav' },
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

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-override',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
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

        const controller = new DaemonTtsController({
            client: { synthesizeText } as any,
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });
    });
});
