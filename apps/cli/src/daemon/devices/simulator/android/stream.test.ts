import { describe, expect, it } from 'vitest';

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

function startCode3(): readonly number[] {
    return [0x00, 0x00, 0x01];
}

function startCode4(): readonly number[] {
    return [0x00, 0x00, 0x00, 0x01];
}

function avccEnvelope(tag: number, payload: Uint8Array): Uint8Array {
    const envelope = new Uint8Array(5 + payload.length);
    new DataView(envelope.buffer).setUint32(0, payload.length + 1, false);
    envelope[4] = tag;
    envelope.set(payload, 5);
    return envelope;
}

function lengthPrefixedNal(...payload: number[]): readonly number[] {
    return [0x00, 0x00, 0x00, payload.length, ...payload];
}

describe('Android scrcpy raw H.264 stream parsing', () => {
    it('parses Annex-B NAL units across partial start-code chunk boundaries', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAnnexBParser');
        if (!('createAndroidScrcpyAnnexBParser' in mod)) return;

        const parser = mod.createAndroidScrcpyAnnexBParser({ maxBufferedBytes: 64 });

        expect(parser.push(bytes(0x00, 0x00))).toMatchObject({
            nalUnits: [],
            bufferedBytes: 2,
        });

        expect(parser.push(bytes(0x01, 0x67, 0x64, 0x00, 0x1f, 0x00))).toMatchObject({
            nalUnits: [],
        });

        const result = parser.push(bytes(0x00, 0x01, 0x68, 0xeb, 0xec, 0x00, 0x00, 0x01, 0x65, 0x88));

        expect(result.nalUnits.map((nal) => ({
            nalType: nal.nalType,
            payload: [...nal.payload],
        }))).toEqual([
            { nalType: 7, payload: [0x67, 0x64, 0x00, 0x1f] },
            { nalType: 8, payload: [0x68, 0xeb, 0xec] },
        ]);
        expect(result.bufferedBytes).toBe(5);
    });

    it('parses multiple NAL units from one chunk while retaining the trailing in-progress NAL', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAnnexBParser');
        if (!('createAndroidScrcpyAnnexBParser' in mod)) return;

        const parser = mod.createAndroidScrcpyAnnexBParser({ maxBufferedBytes: 128 });
        const result = parser.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x88, 0x84,
            ...startCode4(), 0x41, 0x9a,
        ));

        expect(result.nalUnits.map((nal) => nal.nalType)).toEqual([7, 8, 5]);
        expect(result.nalUnits[2]?.keyframe).toBe(true);
        expect(result.bufferedBytes).toBe(6);
    });

    it('fails closed with bounded buffering when no complete NAL boundary arrives', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAnnexBParser');
        if (!('createAndroidScrcpyAnnexBParser' in mod)) return;

        const parser = mod.createAndroidScrcpyAnnexBParser({ maxBufferedBytes: 12 });
        const result = parser.push(bytes(...startCode3(), ...new Array(32).fill(0x55)));

        expect(result).toMatchObject({
            nalUnits: [],
            reasonCode: 'android_scrcpy_raw_stream_buffer_limit_exceeded',
        });
        expect(result.bufferedBytes).toBeLessThanOrEqual(12);
    });

    it('converts SPS/PPS plus IDR access-unit data into AVCC description and keyframe envelopes', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 256 });
        const result = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84,
            ...startCode3(), 0x41, 0x80, 0x9a,
            ...startCode3(), 0x41, 0x80, 0x9b,
        ));

        expect(result).toMatchObject({
            metadata: {
                hasSps: true,
                hasPps: true,
                sawKeyframe: true,
            },
        });
        expect(result.chunks.map((chunk) => ({
            type: chunk.type,
            keyframe: chunk.keyframe,
        }))).toEqual([
            { type: 'description', keyframe: true },
            { type: 'keyframe', keyframe: true },
        ]);
        expect([...result.chunks[0]!.payload]).toEqual([
            ...avccEnvelope(0x01, bytes(
                0x01, 0x64, 0x00, 0x1f,
                0xff,
                0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f,
                0x01, 0x00, 0x03, 0x68, 0xeb, 0xec,
            )),
        ]);
        expect([...result.chunks[1]!.payload]).toEqual([
            ...avccEnvelope(0x02, bytes(...lengthPrefixedNal(0x65, 0x80, 0x84))),
        ]);
    });

    it('retains a key access unit until the next completed slice proves the boundary', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 256 });
        const pending = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84,
            ...startCode3(), 0x41, 0x80, 0x9a,
        ));

        expect(pending.chunks).toEqual([]);
        expect(pending).toMatchObject({
            metadata: {
                hasSps: true,
                hasPps: true,
                sawKeyframe: true,
            },
        });

        const flushed = converter.push(bytes(...startCode3(), 0x41, 0x80, 0x9b));

        expect(flushed.chunks.map((chunk) => ({
            type: chunk.type,
            keyframe: chunk.keyframe,
        }))).toEqual([
            { type: 'description', keyframe: true },
            { type: 'keyframe', keyframe: true },
        ]);
        expect([...flushed.chunks[1]!.payload]).toEqual([
            ...avccEnvelope(0x02, bytes(...lengthPrefixedNal(0x65, 0x80, 0x84))),
        ]);
    });

    it('groups multiple IDR slices into one key access unit', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 256 });
        const result = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84,
            ...startCode3(), 0x65, 0x40, 0x44,
            ...startCode3(), 0x41, 0x80, 0x9a,
            ...startCode3(), 0x41, 0x80, 0x9b,
        ));

        expect(result.chunks.map((chunk) => ({
            type: chunk.type,
            keyframe: chunk.keyframe,
        }))).toEqual([
            { type: 'description', keyframe: true },
            { type: 'keyframe', keyframe: true },
        ]);
        expect([...result.chunks[1]!.payload]).toEqual([
            ...avccEnvelope(0x02, bytes(
                ...lengthPrefixedNal(0x65, 0x80, 0x84),
                ...lengthPrefixedNal(0x65, 0x40, 0x44),
            )),
        ]);
    });

    it('groups multiple non-IDR slices into one delta access unit', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 256 });
        const result = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84,
            ...startCode3(), 0x41, 0x80, 0x9a,
            ...startCode3(), 0x41, 0x40, 0x4a,
            ...startCode3(), 0x65, 0x80, 0x85,
            ...startCode3(), 0x65, 0x80, 0x86,
        ));

        expect(result.chunks.map((chunk) => ({
            type: chunk.type,
            keyframe: chunk.keyframe,
        }))).toEqual([
            { type: 'description', keyframe: true },
            { type: 'keyframe', keyframe: true },
            { type: 'delta', keyframe: false },
        ]);
        expect([...result.chunks[2]!.payload]).toEqual([
            ...avccEnvelope(0x03, bytes(
                ...lengthPrefixedNal(0x41, 0x80, 0x9a),
                ...lengthPrefixedNal(0x41, 0x40, 0x4a),
            )),
        ]);
    });

    it('emits an updated AVCC description before frames after repeated SPS/PPS', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 512 });
        const result = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84,
            ...startCode3(), 0x67, 0x42, 0x80, 0x20,
            ...startCode3(), 0x68, 0xce, 0x06,
            ...startCode3(), 0x65, 0x80, 0x85,
            ...startCode3(), 0x41, 0x80, 0x9a,
            ...startCode3(), 0x41, 0x80, 0x9b,
        ));

        expect(result.chunks.map((chunk) => chunk.type)).toEqual([
            'description',
            'keyframe',
            'description',
            'keyframe',
        ]);
        expect([...result.chunks[2]!.payload]).toEqual([
            ...avccEnvelope(0x01, bytes(
                0x01, 0x42, 0x80, 0x20,
                0xff,
                0xe1, 0x00, 0x04, 0x67, 0x42, 0x80, 0x20,
                0x01, 0x00, 0x03, 0x68, 0xce, 0x06,
            )),
        ]);
    });

    it('fails closed when a pending access unit exceeds the configured buffer limit', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 18 });
        const result = converter.push(bytes(
            ...startCode4(), 0x67, 0x64, 0x00, 0x1f,
            ...startCode3(), 0x68, 0xeb, 0xec,
            ...startCode3(), 0x65, 0x80, 0x84, 0x84, 0x84,
            ...startCode3(), 0x65, 0x40, 0x44, 0x44, 0x44,
            ...startCode3(), 0x65, 0x40, 0x45, 0x45, 0x45,
            ...startCode3(), 0x41, 0x80, 0x9a,
            ...startCode3(), 0x41, 0x80, 0x9b,
        ));

        expect(result).toMatchObject({
            chunks: [],
            reasonCode: 'android_scrcpy_raw_stream_buffer_limit_exceeded',
        });
        expect(result.bufferedBytes).toBeLessThanOrEqual(18);
    });

    it('reports missing codec metadata instead of labeling raw IDR bytes as AVCC', async () => {
        const mod = await import('./stream').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyAvccConverter');
        if (!('createAndroidScrcpyAvccConverter' in mod)) return;

        const converter = mod.createAndroidScrcpyAvccConverter({ maxBufferedBytes: 128 });
        const result = converter.push(bytes(
            ...startCode3(), 0x65, 0x88, 0x84,
            ...startCode3(), 0x41, 0x9a,
        ));

        expect(result).toMatchObject({
            chunks: [],
            reasonCode: 'android_scrcpy_avcc_description_unavailable',
            metadata: {
                hasSps: false,
                hasPps: false,
                sawKeyframe: true,
            },
        });
    });
});
