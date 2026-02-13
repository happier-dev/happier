import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64 } from './base64';

function createDeterministicBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
        out[i] = i % 251;
    }
    return out;
}

function computeChecksum(bytes: Uint8Array): number {
    let checksum = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        checksum = (checksum + bytes[i]) % 1_000_000_007;
    }
    return checksum;
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

    it('round-trips multi-megabyte base64 payloads', () => {
        const bytes = createDeterministicBytes(5_000_000);
        const expectedChecksum = computeChecksum(bytes);
        const encoded = encodeBase64(bytes, 'base64');
        const decoded = decodeBase64(encoded, 'base64');

        expect(decoded.length).toBe(bytes.length);
        expect(decoded[0]).toBe(bytes[0]);
        expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
        expect(computeChecksum(decoded)).toBe(expectedChecksum);
    });

    it('round-trips multi-megabyte base64url payloads', () => {
        const bytes = createDeterministicBytes(3_000_000);
        const expectedChecksum = computeChecksum(bytes);
        const encoded = encodeBase64(bytes, 'base64url');
        const decoded = decodeBase64(encoded, 'base64url');

        expect(decoded.length).toBe(bytes.length);
        expect(decoded[0]).toBe(bytes[0]);
        expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
        expect(computeChecksum(decoded)).toBe(expectedChecksum);
    });
});
