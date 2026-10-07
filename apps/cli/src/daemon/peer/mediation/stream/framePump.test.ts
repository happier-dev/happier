import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS, type MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

import { startMachineLiveStreamFramePump } from './framePump';

function frame(sequence: number, payloadKind: MachineLiveStreamFrameV1['payloadKind'], bytes = 3): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind,
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: bytes,
    };
}

describe('startMachineLiveStreamFramePump', () => {
    it('pauses direct credit without consuming metering or producer sequence and resumes on credit', () => {
        const frames: MachineLiveStreamFrameV1[] = [];
        const receipts: unknown[] = [];
        const pump = startMachineLiveStreamFramePump({
            streamId: 'stream_1', routeKind: 'loopback_direct',
            caps: { maxFramesPerSecond: 1 }, startedAtMs: 1_000, nowMs: () => 1_000,
            emitFrame: (frame) => frames.push(frame), emitReceipt: (receipt) => receipts.push(receipt),
        });
        pump.applyControl({ v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 1, windowFrames: 0 });
        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: false, reasonCode: 'backpressure_window_exhausted' });
        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: false, reasonCode: 'backpressure_window_exhausted' });
        expect(pump.offerFrame(frame(1, 'metadata'))).toEqual({ ok: false, reasonCode: 'backpressure_window_exhausted' });
        expect(receipts.every((receipt) => typeof receipt === 'object' && receipt !== null && !('terminal' in receipt))).toBe(true);
        pump.applyControl({ v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 1, windowFrames: 1, windowBytes: 2 });
        expect(pump.offerFrame(frame(1, 'metadata'))).toEqual({ ok: false, reasonCode: 'backpressure_window_exhausted' });
        pump.applyControl({ v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 1, windowFrames: 2, windowBytes: 6 });
        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: true });
        expect(pump.offerFrame(frame(2, 'metadata'))).toEqual({ ok: true });
        expect(pump.offerFrame(frame(3, 'metadata'))).toEqual({ ok: false, reasonCode: 'backpressure_window_exhausted' });
        expect(frames.map((value) => [value.sequence, value.payloadKind])).toEqual([[1, 'image_keyframe'], [2, 'metadata']]);
    });
    it('leaves relay credit and viewer ACK cursors to the server without changing producer sequencing', () => {
        const emittedFrames: MachineLiveStreamFrameV1[] = [];
        const receipts: unknown[] = [];
        const pump = startMachineLiveStreamFramePump({
            streamId: 'stream_1',
            routeKind: 'server_relay',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            startedAtMs: 1_000,
            nowMs: () => 1_000,
            emitFrame: (next) => emittedFrames.push(next),
            emitReceipt: (receipt) => receipts.push(receipt),
        });

        pump.applyControl({
            v: 1,
            streamId: 'stream_1',
            kind: 'ack',
            nextSequence: 90,
            windowFrames: 0,
            windowBytes: 0,
        });

        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: true });
        expect(pump.offerFrame(frame(2, 'image_delta'))).toEqual({ ok: true });
        expect(emittedFrames.map((item) => item.sequence)).toEqual([1, 2]);
        expect(receipts).toEqual([]);
    });

    it('caps oversized frames without leaking payload bytes into receipts', () => {
        const receipts: unknown[] = [];
        const pump = startMachineLiveStreamFramePump({
            streamId: 'stream_1',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 2,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            startedAtMs: 1_000,
            nowMs: () => 1_000,
            emitFrame: () => undefined,
            emitReceipt: (receipt) => receipts.push(receipt),
        });

        expect(pump.offerFrame({
            ...frame(1, 'image_keyframe'),
            payloadBase64: 'c2VudGluZWw=',
            payloadSizeBytes: 8,
        })).toEqual({
            ok: false,
            reasonCode: 'max_frame_bytes_exceeded',
        });
        expect(receipts).toContainEqual(expect.objectContaining({
            id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
            reasonCode: 'max_frame_bytes_exceeded',
            terminal: true,
            terminalOutcome: 'error',
        }));
        expect(JSON.stringify(receipts)).not.toContain('c2VudGluZWw=');
        expect(JSON.stringify(receipts)).not.toContain('sentinel');
    });

    it('rejects repeated or skipped frame sequences before metering or emitting frames', () => {
        const emittedFrames: MachineLiveStreamFrameV1[] = [];
        const receipts: unknown[] = [];
        const pump = startMachineLiveStreamFramePump({
            streamId: 'stream_1',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            startedAtMs: 1_000,
            nowMs: () => 1_000,
            emitFrame: (next) => emittedFrames.push(next),
            emitReceipt: (receipt) => receipts.push(receipt),
        });

        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: true });
        expect(pump.offerFrame(frame(1, 'image_delta'))).toEqual({
            ok: false,
            reasonCode: 'non_monotonic_sequence',
        });
        expect(pump.offerFrame(frame(3, 'image_delta'))).toEqual({
            ok: false,
            reasonCode: 'non_monotonic_sequence',
        });
        expect(emittedFrames.map((item) => item.sequence)).toEqual([1]);
        expect(receipts).toContainEqual(expect.objectContaining({
            id: PEER_MEDIATION_RECEIPTS.streamPaused,
            reasonCode: 'non_monotonic_sequence',
        }));
    });

    it('rejects stale direct credit updates without using ACK cursors as producer sequencing', () => {
        const emittedFrames: MachineLiveStreamFrameV1[] = [];
        const pump = startMachineLiveStreamFramePump({
            streamId: 'stream_1',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            startedAtMs: 1_000,
            nowMs: () => 1_000,
            emitFrame: (next) => emittedFrames.push(next),
            emitReceipt: () => undefined,
        });

        expect(pump.offerFrame(frame(1, 'image_keyframe'))).toEqual({ ok: true });
        expect(pump.offerFrame(frame(2, 'image_delta'))).toEqual({ ok: true });
        expect(pump.applyControl({
            v: 1,
            streamId: 'stream_1',
            kind: 'ack',
            nextSequence: 3,
            windowFrames: 10,
            windowBytes: 30,
        })).toEqual({ ok: true });
        expect(pump.applyControl({
            v: 1,
            streamId: 'stream_1',
            kind: 'ack',
            nextSequence: 1,
            windowFrames: 10,
            windowBytes: 30,
        })).toEqual({
            ok: false,
            reasonCode: 'stale_ack',
        });
        expect(pump.offerFrame(frame(1, 'image_delta'))).toEqual({
            ok: false,
            reasonCode: 'non_monotonic_sequence',
        });
        expect(emittedFrames.map((item) => item.sequence)).toEqual([1, 2]);
    });
});
