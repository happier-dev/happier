import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

function frame(sequence: number, payloadKind: MachineLiveStreamFrameV1['payloadKind']): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind,
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
}

describe('applyMachineLiveStreamBackpressurePolicy', () => {
    it('keeps a keyframe and latest delta when the bounded queue overflows', async () => {
        const mod = await import('./backpressure').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('applyMachineLiveStreamBackpressurePolicy');
        if (!('applyMachineLiveStreamBackpressurePolicy' in mod)) return;

        const result = mod.applyMachineLiveStreamBackpressurePolicy({
            streamId: 'stream_1',
            routeKind: 'server_relay',
            frames: [
                frame(1, 'image_keyframe'),
                frame(2, 'image_delta'),
                frame(3, 'image_delta'),
                frame(4, 'image_delta'),
            ],
            maxWindowFrames: 2,
            maxWindowBytes: 6,
        });

        expect(result.frames.map((item) => [item.sequence, item.payloadKind])).toEqual([
            [1, 'image_keyframe'],
            [4, 'image_delta'],
        ]);
        expect(result.droppedFrames).toBe(2);
        expect(result.requiresKeyframeResync).toBe(false);
    });
});
