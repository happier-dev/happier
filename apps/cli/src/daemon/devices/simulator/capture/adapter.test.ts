import { describe, expect, it, vi } from 'vitest';

import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamControlSidebandV1,
    MachineLiveStreamFrameV1,
    MachineLiveStreamReceiptV1,
    MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import {
    createSimulatorFrameProducerCaptureAdapter,
    type SimulatorCaptureFrameProducer,
} from './adapter';
import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';

const caps: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 30,
    maxFrameBytes: 8_192,
    maxDurationMs: 60_000,
    maxTotalBytes: 128_000,
};

function startRequest(extra: Partial<MachineLiveStreamStartRequestV1> = {}): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'ios-simulator:A1B2:screen',
        routeKind: 'loopback_direct',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        ...caps,
        ...extra,
    };
}

function startInput(input: Readonly<{
    offerFrame?: MachineLiveStreamCaptureStartInput['offerFrame'];
    emitReceipt?: (receipt: MachineLiveStreamReceiptV1) => void;
    startRequest?: MachineLiveStreamStartRequestV1;
}> = {}): MachineLiveStreamCaptureStartInput {
    const request = input.startRequest ?? startRequest();
    return {
        streamId: request.streamId,
        streamFamily: request.streamFamily,
        sourceMachineId: request.sourceMachineId,
        targetMachineId: request.targetMachineId,
        caps,
        startRequest: request,
        startedAtMs: 1_000,
        expiresAtMs: 61_000,
        nowMs: () => 1_234,
        offerFrame: input.offerFrame ?? (() => ({ ok: true })),
        applyControl: () => ({ ok: true }),
        emitReceipt: input.emitReceipt ?? (() => undefined),
    };
}

describe('createSimulatorFrameProducerCaptureAdapter', () => {
    it('emits MJPEG frames with base64 payload size and monotonic sequence numbers', async () => {
        const offeredFrames: MachineLiveStreamFrameV1[] = [];
        const producer: SimulatorCaptureFrameProducer = {
            start: async ({ emitFrame }) => {
                emitFrame({
                    codecId: 'image.mjpeg',
                    payload: new Uint8Array([1, 2, 3, 4]),
                    keyframe: true,
                });
                emitFrame({
                    codecId: 'image.mjpeg',
                    payload: Buffer.from([5, 6, 7]),
                });
                return { stop: () => undefined };
            },
        };
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer,
        });

        const result = await adapter.start(startInput({
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        expect(offeredFrames).toEqual([
            expect.objectContaining({
                streamId: 'stream_1',
                sequence: 1,
                timestampMs: 1_234,
                payloadKind: 'image_keyframe',
                payloadEncoding: 'binary_base64',
                payloadBase64: 'AQIDBA==',
                payloadSizeBytes: 4,
            }),
            expect.objectContaining({
                streamId: 'stream_1',
                sequence: 2,
                timestampMs: 1_234,
                payloadKind: 'image_keyframe',
                payloadEncoding: 'binary_base64',
                payloadBase64: 'BQYH',
                payloadSizeBytes: 3,
            }),
        ]);
    });

    it('rejects an explicitly requested codec that the producer source does not support', async () => {
        const receipts: MachineLiveStreamReceiptV1[] = [];
        const producer: SimulatorCaptureFrameProducer = {
            start: vi.fn(async () => ({ stop: () => undefined })),
        };
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer,
        });

        const result = await adapter.start(startInput({
            startRequest: startRequest({ preferredCodec: 'h264.avcc' } as Partial<MachineLiveStreamStartRequestV1>),
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toEqual({ ok: false, reasonCode: 'unsupported_codec' });
        expect(producer.start).not.toHaveBeenCalled();
        expect(receipts).toEqual([expect.objectContaining({
            id: 'peer.stream.paused',
            streamId: 'stream_1',
            routeKind: 'loopback_direct',
            reasonCode: 'unsupported_codec',
        })]);
    });

    it('stops the producer session exactly once', async () => {
        const stop = vi.fn();
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer: { start: async () => ({ stop }) },
        });

        const result = await adapter.start(startInput());
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected capture start');

        await result.session.stop();
        await result.session.stop();

        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('fails startup and stops the producer when a synchronous frame is rejected before the session is assigned', async () => {
        const stop = vi.fn();
        const receipts: MachineLiveStreamReceiptV1[] = [];
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer: {
                start: async ({ emitFrame }) => {
                    emitFrame({
                        codecId: 'image.mjpeg',
                        payload: new Uint8Array([1]),
                    });
                    return { stop };
                },
            },
        });

        const result = await adapter.start(startInput({
            offerFrame: () => ({ ok: false, reasonCode: 'max_frame_bytes_exceeded' }),
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toEqual({ ok: false, reasonCode: 'max_frame_bytes_exceeded' });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(receipts).toEqual([expect.objectContaining({
            id: 'peer.stream.bandwidth_capped',
            reasonCode: 'max_frame_bytes_exceeded',
        })]);
    });

    it('emits a receipt and closes capture when a running producer reports a fatal error', async () => {
        const stop = vi.fn();
        const receipts: MachineLiveStreamReceiptV1[] = [];
        let failProducer: (reasonCode: string) => void = () => {
            throw new Error('producer fail callback was not initialized');
        };
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer: {
                start: async (input) => {
                    failProducer = input.fail;
                    return { stop };
                },
            },
        });

        const result = await adapter.start(startInput({
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('expected capture start');

        failProducer('producer_async_failed');
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(receipts).toEqual([expect.objectContaining({
            id: 'peer.stream.paused',
            reasonCode: 'producer_async_failed',
        })]);
        expect(result.session.applySidebandControl?.({
            v: 1,
            streamId: 'stream_1',
            sourceId: 'ios-simulator:A1B2:screen',
            eventId: 'event_keyframe',
            kind: 'request_keyframe',
        })).toEqual({ ok: false, reasonCode: 'capture_stopped' });
    });

    it('forwards request_keyframe and set_quality controls to producer hooks', async () => {
        const requestKeyframe = vi.fn(() => ({ ok: true as const }));
        const setQuality = vi.fn(() => ({ ok: true as const }));
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            producer: { start: async () => ({ stop: () => undefined, requestKeyframe, setQuality }) },
        });
        const result = await adapter.start(startInput());
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected capture start');

        const keyframeControl: MachineLiveStreamControlSidebandV1 = {
            v: 1,
            streamId: 'stream_1',
            sourceId: 'ios-simulator:A1B2:screen',
            eventId: 'event_keyframe',
            kind: 'request_keyframe',
        };
        const qualityControl: MachineLiveStreamControlSidebandV1 = {
            v: 1,
            streamId: 'stream_1',
            sourceId: 'ios-simulator:A1B2:screen',
            eventId: 'event_quality',
            kind: 'set_quality',
            maxBitrateBps: 32_000,
            maxFramesPerSecond: 15,
        };

        expect(result.session.applySidebandControl?.(keyframeControl)).toEqual({ ok: true });
        expect(result.session.applySidebandControl?.(qualityControl)).toEqual({ ok: true });
        expect(requestKeyframe).toHaveBeenCalledWith(keyframeControl);
        expect(setQuality).toHaveBeenCalledWith(qualityControl);
    });

    it('fails startup on invalid synchronous producer frames without leaking payload material in diagnostics', async () => {
        const receipts: MachineLiveStreamReceiptV1[] = [];
        const stop = vi.fn();
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'ios-simulator:A1B2:screen',
            sourceCodecs: ['image.mjpeg'],
            producer: {
                start: async ({ emitFrame }) => {
                    emitFrame({
                        codecId: 'image.mjpeg',
                        payload: '',
                    });
                    return { stop };
                },
            },
        });

        const result = await adapter.start(startInput({
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toEqual({ ok: false, reasonCode: 'invalid_frame' });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(receipts).toEqual([expect.objectContaining({
            id: 'peer.stream.paused',
            reasonCode: 'invalid_frame',
        })]);
        expect(JSON.stringify(receipts)).not.toContain('payload');
    });
});
