import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextDecoder as ExpoReferenceTextDecoder } from 'expo/src/winter/TextDecoder';

import { Utf8TextDecoder } from './utf8TextDecoder';

// Node's built-in decoder is the WHATWG reference this replacement must match byte for byte.
const reference = (bytes: Uint8Array, options?: TextDecoderOptions) => new globalThis.TextDecoder('utf-8', options).decode(bytes);

function randomBytes(length: number, seed: number): Uint8Array {
    let state = seed;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
        state = (state * 1103515245 + 12345) >>> 0;
        // Bias towards lead/continuation bytes so malformed and multi-byte paths dominate.
        const pick = state % 7;
        bytes[index] = pick === 0 ? 0x80 + (state >>> 8) % 0x40
            : pick === 1 ? 0xc0 + (state >>> 8) % 0x40
            : pick === 2 ? 0xe0 + (state >>> 8) % 0x10
            : pick === 3 ? 0xf0 + (state >>> 8) % 0x10
            : (state >>> 8) % 0x100;
    }
    return bytes;
}

const EDGE_CASES: readonly number[][] = [
    [], [0xef, 0xbb, 0xbf], [0xef, 0xbb, 0xbf, 0x41], [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf],
    [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0xa0], [0xed, 0xa0, 0x80], [0xf0, 0x8f, 0xbf, 0xbf],
    [0xf4, 0x90, 0x80, 0x80], [0xf5], [0xff], [0x80], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xf0, 0x9f, 0x98, 0x80],
    [0x61, 0xe2, 0x82, 0xac, 0x62], [0xe2, 0x28, 0xa1], [0xf0, 0x28, 0x8c, 0xbc],
];

describe('Utf8TextDecoder', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('decodes a 64 KiB JSON response in bulk instead of one string operation per code point', () => {
        const json = JSON.stringify({ rows: Array.from({ length: 900 }, (_, index) => ({ id: `row-${index}`, title: `Zürich ✓ ${index} 😀` })) });
        const bytes = new TextEncoder().encode(json).subarray(0, 64 * 1024);
        const fromCharCode = vi.spyOn(String, 'fromCharCode');
        new ExpoReferenceTextDecoder().decode(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        const referenceCalls = fromCharCode.mock.calls.length;
        fromCharCode.mockClear();
        const decoded = new Utf8TextDecoder().decode(bytes);
        // Hermes ships no TextDecoder; Expo's reference polyfill builds the string per code point.
        expect(referenceCalls).toBeGreaterThan(bytes.length / 2);
        expect(fromCharCode.mock.calls.length).toBeLessThanOrEqual(Math.ceil(bytes.length / 4096) + 1);
        expect(decoded).toBe(reference(bytes));
    });

    it('matches the WHATWG decoder for edge, random, BOM and fatal inputs', () => {
        const inputs = [...EDGE_CASES.map(bytes => Uint8Array.from(bytes)), ...Array.from({ length: 200 }, (_, seed) => randomBytes(1 + seed * 7, seed + 1))];
        for (const bytes of inputs) {
            expect(new Utf8TextDecoder().decode(bytes)).toBe(reference(bytes));
            expect(new Utf8TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(reference(bytes, { ignoreBOM: true }));
            let expected: string | null = null;
            try { expected = reference(bytes, { fatal: true }); } catch { expected = null; }
            if (expected === null) expect(() => new Utf8TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow(TypeError);
            else expect(new Utf8TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(expected);
        }
    });

    it('carries partial sequences and the BOM decision across streamed chunks', () => {
        for (let seed = 1; seed <= 60; seed += 1) {
            const bytes = seed % 3 === 0 ? Uint8Array.from([0xef, 0xbb, 0xbf, ...randomBytes(97, seed)]) : randomBytes(97, seed);
            const ours = new Utf8TextDecoder();
            const theirs = new globalThis.TextDecoder();
            let actual = '';
            let expected = '';
            for (let offset = 0; offset < bytes.length; offset += 1 + seed % 5) {
                const chunk = bytes.subarray(offset, offset + 1 + seed % 5);
                actual += ours.decode(chunk, { stream: true });
                expected += theirs.decode(chunk, { stream: true });
            }
            actual += ours.decode();
            expected += theirs.decode();
            expect(actual).toBe(expected);
            // A finished stream starts over: the decoder is reusable.
            expect(ours.decode(bytes)).toBe(theirs.decode(bytes));
        }
    });

    it('joins a multibyte sequence split across chunks and throws a fatal decode only where the input is invalid', () => {
        const bytes = new TextEncoder().encode('a😀é✓');
        // Every split point inside the 4-, 2- and 3-byte sequences.
        for (let cut = 1; cut < bytes.length; cut += 1) {
            const decoder = new Utf8TextDecoder('utf-8', { fatal: true });
            expect(decoder.decode(bytes.subarray(0, cut), { stream: true }) + decoder.decode(bytes.subarray(cut))).toBe('a😀é✓');
        }
        const fatal = new Utf8TextDecoder('utf-8', { fatal: true });
        // A stream that ends inside a sequence is invalid at the flush, not before.
        expect(fatal.decode(Uint8Array.from([0x61, 0xf0, 0x9f]), { stream: true })).toBe('a');
        expect(() => fatal.decode()).toThrow(TypeError);
        // The decoder is reusable after a fatal error and does not carry the broken sequence.
        // (Carrying it, these two continuation bytes would complete 😀.)
        expect(() => fatal.decode(Uint8Array.from([0x98, 0x80]))).toThrow(TypeError);
        expect(() => fatal.decode(Uint8Array.from([0x62, 0xe2, 0x28]), { stream: true })).toThrow(TypeError);
        expect(fatal.decode(bytes)).toBe('a😀é✓');
    });

    it('accepts ArrayBuffer and offset views, and only UTF-8 labels', () => {
        const backing = new TextEncoder().encode('xxhéllo😀yy');
        const view = new DataView(backing.buffer, 2, backing.byteLength - 4);
        expect(new Utf8TextDecoder('UTF8').decode(view)).toBe('héllo😀');
        expect(new Utf8TextDecoder(' unicode-1-1-utf-8 ').decode(backing.buffer)).toBe('xxhéllo😀yy');
        expect(new Utf8TextDecoder().encoding).toBe('utf-8');
        expect(() => new Utf8TextDecoder('latin1')).toThrow(RangeError);
    });
});
