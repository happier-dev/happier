import { describe, expect, it } from 'vitest';

function jpegBytes(seed: number): Uint8Array {
    return new Uint8Array([0xff, 0xd8, seed, 0xff, 0xd9]);
}

function avccEnvelope(tag: number, payload: readonly number[]): Uint8Array {
    const length = payload.length + 1;
    const bytes = new Uint8Array(4 + length);
    new DataView(bytes.buffer).setUint32(0, length, false);
    bytes[4] = tag;
    bytes.set(payload, 5);
    return bytes;
}

describe('machine live-stream viewer frame helpers', () => {
    it('extracts MJPEG frames across chunk boundaries with bounded buffering', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createMachineLiveStreamMjpegExtractor');
        if (!('createMachineLiveStreamMjpegExtractor' in mod)) return;

        const extractor = mod.createMachineLiveStreamMjpegExtractor({ maxBufferedBytes: 32 });
        expect(extractor.push(new Uint8Array([0, 1, 0xff]))).toMatchObject({
            frames: [],
            bufferedBytes: 1,
        });

        const result = extractor.push(new Uint8Array([0xd8, 7, 0xff, 0xd9, 0xff, 0xd8, 8]));
        expect(result.frames.map((frame: Uint8Array) => [...frame])).toEqual([[0xff, 0xd8, 7, 0xff, 0xd9]]);
        expect(result.bufferedBytes).toBe(3);

        const overflow = extractor.push(new Uint8Array(40).fill(3));
        expect(overflow).toMatchObject({
            frames: [],
            reasonCode: 'mjpeg_buffer_limit_exceeded',
        });
        expect(overflow.bufferedBytes).toBeLessThanOrEqual(32);
    });

    it('drops complete MJPEG frames that exceed the configured buffer cap', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createMachineLiveStreamMjpegExtractor');
        if (!('createMachineLiveStreamMjpegExtractor' in mod)) return;

        const extractor = mod.createMachineLiveStreamMjpegExtractor({ maxBufferedBytes: 8 });
        const result = extractor.push(new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xd9]));

        expect(result).toMatchObject({
            frames: [],
            bufferedBytes: 0,
            reasonCode: 'mjpeg_buffer_limit_exceeded',
        });
        expect(result.droppedBytes).toBe(11);
    });

    it('demuxes length-prefixed AVCC chunks and exposes JPEG seed frames', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createMachineLiveStreamAvccDemuxer');
        if (!('createMachineLiveStreamAvccDemuxer' in mod)) return;

        const demuxer = mod.createMachineLiveStreamAvccDemuxer({ maxBufferedBytes: 64 });
        const description = avccEnvelope(0x01, [1, 0x64, 0, 0x28]);
        const seed = avccEnvelope(0x04, [...jpegBytes(9)]);
        const first = demuxer.push(description.slice(0, 3));
        expect(first).toMatchObject({ chunks: [] });

        const second = demuxer.push(new Uint8Array([...description.slice(3), ...seed]));
        expect(second.chunks.map((chunk: { type: string; payload: Uint8Array }) => ({
            type: chunk.type,
            payload: [...chunk.payload],
        }))).toEqual([
            { type: 'description', payload: [1, 0x64, 0, 0x28] },
            { type: 'seed', payload: [0xff, 0xd8, 9, 0xff, 0xd9] },
        ]);
    });

    it('drops AVCC chunks that exceed the configured buffer cap', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createMachineLiveStreamAvccDemuxer');
        if (!('createMachineLiveStreamAvccDemuxer' in mod)) return;

        const demuxer = mod.createMachineLiveStreamAvccDemuxer({ maxBufferedBytes: 8 });
        const result = demuxer.push(avccEnvelope(0x02, [1, 2, 3, 4, 5, 6, 7, 8]));

        expect(result).toMatchObject({
            chunks: [],
            bufferedBytes: 0,
            reasonCode: 'avcc_buffer_limit_exceeded',
        });
        expect(result.droppedBytes).toBe(13);
    });
});
