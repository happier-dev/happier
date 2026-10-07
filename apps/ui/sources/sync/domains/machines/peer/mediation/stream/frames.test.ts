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
    it('demuxes length-prefixed AVCC chunks including description, seed, keyframe, and delta payloads', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('demuxMachineLiveStreamAvccPayload');
        if (!('demuxMachineLiveStreamAvccPayload' in mod)) return;
        const description = avccEnvelope(0x01, [1, 0x64, 0, 0x28]);
        const seed = avccEnvelope(0x04, [...jpegBytes(9)]);
        const keyframe = avccEnvelope(0x02, [0x65, 1, 2]);
        const delta = avccEnvelope(0x03, [0x41, 3, 4]);
        const result = mod.demuxMachineLiveStreamAvccPayload(new Uint8Array([...description, ...seed, ...keyframe, ...delta]));
        expect(result.chunks.map((chunk: { type: string; payload: Uint8Array }) => ({
            type: chunk.type,
            payload: [...chunk.payload],
        }))).toEqual([
            { type: 'description', payload: [1, 0x64, 0, 0x28] },
            { type: 'seed', payload: [0xff, 0xd8, 9, 0xff, 0xd9] },
            { type: 'keyframe', payload: [0x65, 1, 2] },
            { type: 'delta', payload: [0x41, 3, 4] },
        ]);
        expect(result.bufferedBytes).toBe(0);
    });

    it('keeps mid-stream AVCC description changes in sequence for decoder reconfiguration', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('demuxMachineLiveStreamAvccPayload');
        if (!('demuxMachineLiveStreamAvccPayload' in mod)) return;

        const result = mod.demuxMachineLiveStreamAvccPayload(new Uint8Array([
            ...avccEnvelope(0x01, [1, 0x64, 0, 0x28]),
            ...avccEnvelope(0x02, [0x65, 1]),
            ...avccEnvelope(0x01, [1, 0x64, 0, 0x2a]),
            ...avccEnvelope(0x02, [0x65, 2]),
        ]));

        expect(result.chunks.map((chunk: { type: string; payload: Uint8Array }) => ({
            type: chunk.type,
            payload: [...chunk.payload],
        }))).toEqual([
            { type: 'description', payload: [1, 0x64, 0, 0x28] },
            { type: 'keyframe', payload: [0x65, 1] },
            { type: 'description', payload: [1, 0x64, 0, 0x2a] },
            { type: 'keyframe', payload: [0x65, 2] },
        ]);
    });

    it('accepts a complete carrier-admitted envelope beyond the former 4 MiB viewer cap', async () => {
        const mod = await import('./frames').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('demuxMachineLiveStreamAvccPayload');
        if (!('demuxMachineLiveStreamAvccPayload' in mod)) return;

        const payload = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x65);
        const carrier = new Uint8Array(5 + payload.length);
        new DataView(carrier.buffer).setUint32(0, payload.length + 1, false);
        carrier[4] = 0x02;
        carrier.set(payload, 5);
        const result = mod.demuxMachineLiveStreamAvccPayload(carrier);

        expect(result).toMatchObject({
            chunks: [{ type: 'keyframe' }],
            bufferedBytes: 0,
        });
        expect(result.droppedBytes).toBe(0);
        expect(result.chunks[0]?.payload.byteLength).toBe(payload.byteLength);
        expect(result.chunks[0]?.payload[0]).toBe(0x65);
        expect(result.chunks[0]?.payload[payload.length - 1]).toBe(0x65);
        expect(result.reasonCode).toBeUndefined();
    });

    it('does not carry an incomplete envelope into the next delimited carrier payload', async () => {
        const { demuxMachineLiveStreamAvccPayload } = await import('./frames');
        const incomplete = demuxMachineLiveStreamAvccPayload(new Uint8Array([0, 0, 0, 20, 0x02, 0x65]));
        expect(incomplete).toMatchObject({ chunks: [], bufferedBytes: 0, droppedBytes: 6, reasonCode: 'avcc_incomplete_payload' });
        const next = demuxMachineLiveStreamAvccPayload(avccEnvelope(0x02, [0x65, 1]));
        expect(next.chunks).toEqual([{ type: 'keyframe', payload: new Uint8Array([0x65, 1]) }]);
        expect(next.droppedBytes).toBe(0);
    });

    it('rejects invalid tags and zero-length headers without hiding subsequent valid envelopes', async () => {
        const { demuxMachineLiveStreamAvccPayload } = await import('./frames');
        const result = demuxMachineLiveStreamAvccPayload(new Uint8Array([
            0, 0, 0, 0, ...avccEnvelope(0xff, [1]), ...avccEnvelope(0x02, [0x65]),
        ]));
        expect(result).toMatchObject({
            chunks: [{ type: 'keyframe', payload: new Uint8Array([0x65]) }], bufferedBytes: 0,
            droppedBytes: 10, reasonCode: 'avcc_invalid_payload',
        });
    });
});
