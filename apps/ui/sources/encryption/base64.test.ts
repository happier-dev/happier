import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64 } from './base64';

function createDeterministicBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
        out[i] = i % 251;
    }
    return out;
}

describe('base64 helpers', () => {
    it('works without atob/btoa globals (node compat)', () => {
        const prevAtob = (globalThis as any).atob;
        const prevBtoa = (globalThis as any).btoa;
        (globalThis as any).atob = undefined;
        (globalThis as any).btoa = undefined;

        try {
            const bytes = createDeterministicBytes(512);
            const encoded = encodeBase64(bytes, 'base64');
            const decoded = decodeBase64(encoded, 'base64');
            expect(Array.from(decoded)).toEqual(Array.from(bytes));
        } finally {
            (globalThis as any).atob = prevAtob;
            (globalThis as any).btoa = prevBtoa;
        }
    });

    it('round-trips small payloads', () => {
        const bytes = createDeterministicBytes(256);
        const encoded = encodeBase64(bytes, 'base64');
        const decoded = decodeBase64(encoded, 'base64');
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it('round-trips multi-megabyte base64 payloads', () => {
        for (const length of [200_000, 5_000_000]) {
            const bytes = createDeterministicBytes(length);
            const encoded = encodeBase64(bytes, 'base64');
            const decoded = decodeBase64(encoded, 'base64');

            expect(decoded.length).toBe(bytes.length);
            expect(decoded[0]).toBe(bytes[0]);
            expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
            expect(decoded.every((value, index) => value === bytes[index])).toBe(true);
        }
        // A mutually wrong encoder/decoder must not substitute the URL alphabet here.
        expect(encodeBase64(Uint8Array.from([251, 255]), 'base64')).toBe('+/8=');
        expect(decodeBase64('+/8=', 'base64')).toEqual(Uint8Array.from([251, 255]));
    });

    it('round-trips multi-megabyte base64url payloads', () => {
        const bytes = createDeterministicBytes(3_000_000);
        const encoded = encodeBase64(bytes, 'base64url');
        const decoded = decodeBase64(encoded, 'base64url');

        expect(decoded.length).toBe(bytes.length);
        expect(decoded[0]).toBe(bytes[0]);
        expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
        expect(decoded.every((value, index) => value === bytes[index])).toBe(true);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
        // Independent alphabet witness: a matching, but standard-base64, pair must not pass.
        expect(encodeBase64(Uint8Array.from([251, 255]), 'base64url')).toBe('-_8');
        expect(decodeBase64('-_8', 'base64url')).toEqual(Uint8Array.from([251, 255]));
    });
});
