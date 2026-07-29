import { describe, expect, it } from 'vitest';

describe('live-stream viewer adaptation policy', () => {
    it('requests bounded quality degradation for slow viewers and rate-limits follow-up requests', async () => {
        const mod = await import('./adaptation').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('initialLiveStreamAdaptationState');
        expect(mod).toHaveProperty('resolveLiveStreamAdaptationDecision');
        if (!('initialLiveStreamAdaptationState' in mod) || !('resolveLiveStreamAdaptationDecision' in mod)) return;

        const first = mod.resolveLiveStreamAdaptationDecision({
            state: mod.initialLiveStreamAdaptationState,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_1',
            nowMs: 1_000,
            metrics: {
                decodeLagMs: 120,
                droppedFrames: 8,
                bufferedBytes: 1_500_000,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
            },
        });
        const rateLimited = mod.resolveLiveStreamAdaptationDecision({
            state: first.state,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_2',
            nowMs: 1_200,
            metrics: {
                decodeLagMs: 120,
                droppedFrames: 8,
                bufferedBytes: 1_500_000,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
            },
        });

        expect(first.controls).toEqual([{
            v: 1,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_1',
            kind: 'set_quality',
            maxFramesPerSecond: 15,
            maxBitrateBps: 1_500_000,
        }]);
        expect(first.state).toMatchObject({
            degraded: true,
            lastQualityRequestAtMs: 1_000,
        });
        expect(rateLimited).toMatchObject({
            controls: [],
            reasonCode: 'adaptation_rate_limited',
        });

        const alreadyDegraded = mod.resolveLiveStreamAdaptationDecision({
            state: first.state,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_3',
            nowMs: 2_000,
            metrics: {
                decodeLagMs: 120,
                droppedFrames: 8,
                bufferedBytes: 1_500_000,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
            },
        });

        expect(alreadyDegraded).toEqual({
            state: first.state,
            controls: [],
            reasonCode: 'viewer_degraded',
        });
    });

    it('requests keyframe recovery for decoder failures without sharing raw error details', async () => {
        const mod = await import('./adaptation').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('initialLiveStreamAdaptationState');
        expect(mod).toHaveProperty('resolveLiveStreamAdaptationDecision');
        if (!('initialLiveStreamAdaptationState' in mod) || !('resolveLiveStreamAdaptationDecision' in mod)) return;

        const decision = mod.resolveLiveStreamAdaptationDecision({
            state: mod.initialLiveStreamAdaptationState,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_keyframe',
            nowMs: 2_000,
            metrics: {
                decodeLagMs: 0,
                droppedFrames: 0,
                bufferedBytes: 0,
                needsKeyframe: true,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
            },
        });

        expect(decision.controls).toEqual([{
            v: 1,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_keyframe',
            kind: 'request_keyframe',
        }]);
        expect(decision.state).toMatchObject({
            needsKeyframe: true,
            lastKeyframeRequestAtMs: 2_000,
        });
    });

    it('can include scale bounds in quality degradation requests without repeating identical controls', async () => {
        const mod = await import('./adaptation').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('initialLiveStreamAdaptationState');
        expect(mod).toHaveProperty('resolveLiveStreamAdaptationDecision');
        if (!('initialLiveStreamAdaptationState' in mod) || !('resolveLiveStreamAdaptationDecision' in mod)) return;

        const first = mod.resolveLiveStreamAdaptationDecision({
            state: mod.initialLiveStreamAdaptationState,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_scaled',
            nowMs: 1_000,
            metrics: {
                decodeLagMs: 180,
                droppedFrames: 12,
                bufferedBytes: 2_000_000,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
                degradedQuality: {
                    maxFramesPerSecond: 10,
                    maxBitrateBps: 900_000,
                    maxWidth: 960,
                    maxHeight: 540,
                },
            },
        });
        const repeated = mod.resolveLiveStreamAdaptationDecision({
            state: first.state,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_scaled_repeat',
            nowMs: 2_000,
            metrics: {
                decodeLagMs: 180,
                droppedFrames: 12,
                bufferedBytes: 2_000_000,
            },
            limits: {
                minRequestIntervalMs: 500,
                maxBufferedBytes: 1_000_000,
                maxDecodeLagMs: 80,
                maxDroppedFrames: 3,
                degradedQuality: {
                    maxFramesPerSecond: 10,
                    maxBitrateBps: 900_000,
                    maxWidth: 960,
                    maxHeight: 540,
                },
            },
        });

        expect(first.controls).toEqual([{
            v: 1,
            streamId: 'stream_1',
            sourceId: 'source_1',
            eventId: 'event_scaled',
            kind: 'set_quality',
            maxFramesPerSecond: 10,
            maxBitrateBps: 900_000,
            maxWidth: 960,
            maxHeight: 540,
        }]);
        expect(repeated).toEqual({
            state: first.state,
            controls: [],
            reasonCode: 'viewer_degraded',
        });
    });
});
