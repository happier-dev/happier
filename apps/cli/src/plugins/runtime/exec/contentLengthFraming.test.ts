import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { attachContentLengthFrameReader, encodeContentLengthFrame } from './contentLengthFraming';

describe('content-length framing', () => {
    it('decodes fragmented and coalesced frames in transport order', async () => {
        const stream = new PassThrough();
        const frames: number[][] = [];
        attachContentLengthFrameReader(stream, (frame) => frames.push([...frame]), {
            maxFrameBytes: 4,
            onError: (error) => {
                throw error;
            },
            onTrailingPartialFrame: () => undefined,
        });
        const encoded = Buffer.concat([
            encodeContentLengthFrame(new Uint8Array([0, 1, 2, 3])),
            encodeContentLengthFrame(new Uint8Array([4])),
        ]);

        stream.write(encoded.subarray(0, 5));
        stream.write(encoded.subarray(5, 19));
        stream.end(encoded.subarray(19));

        await expect.poll(() => frames).toEqual([[0, 1, 2, 3], [4]]);
    });

    it('rejects a frame at max plus one before delivering payload', async () => {
        const stream = new PassThrough();
        const onError = vi.fn();
        const onFrame = vi.fn();
        attachContentLengthFrameReader(stream, onFrame, {
            maxFrameBytes: 4,
            onError,
            onTrailingPartialFrame: () => undefined,
        });

        stream.end(encodeContentLengthFrame(new Uint8Array(5)));

        await expect.poll(() => onError).toHaveBeenCalledTimes(1);
        expect(onFrame).not.toHaveBeenCalled();
    });
});
