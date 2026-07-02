import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

function frame(sequence: number): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
}

describe('machine live-stream render state', () => {
    it('preserves the last frame while reconnecting', async () => {
        const mod = await import('./renderState').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceMachineLiveStreamRenderState');
        if (!('reduceMachineLiveStreamRenderState' in mod)) return;

        const connected = mod.reduceMachineLiveStreamRenderState(
            { phase: 'idle', lastFrame: null },
            { type: 'frame', frame: frame(1) },
        );
        const reconnecting = mod.reduceMachineLiveStreamRenderState(connected, {
            type: 'reconnecting',
            reasonCode: 'socket_reconnect',
        });

        expect(reconnecting).toMatchObject({
            phase: 'reconnecting',
            lastFrame: { sequence: 1 },
            diagnostic: { reasonCode: 'socket_reconnect' },
        });
    });
});
