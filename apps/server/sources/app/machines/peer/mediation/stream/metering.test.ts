import { describe, expect, it } from 'vitest';

import { applyMachineLiveStreamRelayBackpressure } from './metering';

function relayFrame(sequence: number, payloadKind: 'image_delta' | 'image_keyframe', payloadSizeBytes: number) {
    return {
        v: 1 as const,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind,
        payloadEncoding: 'binary_base64' as const,
        payload: { t: 'plain' as const, v: Buffer.from(new Uint8Array(payloadSizeBytes)).toString('base64') },
        payloadSizeBytes,
    };
}

describe('applyMachineLiveStreamRelayBackpressure', () => {
    it.each([true, false])('returns drop facts independently of receipt admission (receipt=%s)', (capIntervalExceeded) => {
        const result = applyMachineLiveStreamRelayBackpressure({
            streamId: 'stream_1',
            routeKind: 'server_relay',
            frames: [
                relayFrame(1, 'image_keyframe', 4),
                relayFrame(2, 'image_delta', 4),
                relayFrame(3, 'image_delta', 4),
                relayFrame(4, 'image_keyframe', 4),
            ],
            maxWindowFrames: 2,
            maxWindowBytes: 8,
            capIntervalExceeded,
        });

        expect(result.frames.map((frame) => [frame.sequence, frame.payloadKind])).toEqual([
            [1, 'image_keyframe'],
            [4, 'image_keyframe'],
        ]);
        expect(result).toMatchObject({ framesDropped: 2, bytesDropped: 8 });
        if (capIntervalExceeded) expect(result.receipt).toMatchObject({
            id: 'peer.stream.bandwidth_capped',
            streamId: 'stream_1',
            framesDropped: 2,
            bytesDropped: 8,
        });
        else expect(result.receipt).toBeNull();
    });
});
