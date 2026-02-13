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
    it('round-trips small payloads', () => {
        const bytes = createDeterministicBytes(256);
        const encoded = encodeBase64(bytes, 'base64');
        const decoded = decodeBase64(encoded, 'base64');
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it('round-trips large payloads without throwing', () => {
        const bytes = createDeterministicBytes(200_000);
        const encoded = encodeBase64(bytes, 'base64');
        const decoded = decodeBase64(encoded, 'base64');
        expect(decoded.length).toBe(bytes.length);
        expect(decoded[0]).toBe(bytes[0]);
        expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
    });
});
