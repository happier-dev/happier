import { describe, expect, it, vi } from 'vitest';

import { decodeBase64 } from '@/encryption/base64';

import {
    cryptoWorkerBase64ToBytes,
    estimateCryptoWorkerBase64BridgeBytes,
    estimateCryptoWorkerBatchBridgeBytes,
    bytesToCryptoWorkerBase64,
} from './nativeCryptoWorkerBridgePayload';

describe('native crypto worker bridge payload helpers', () => {
    it('roundtrips bytes through the canonical base64 boundary', () => {
        const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
        const encoded = bytesToCryptoWorkerBase64(bytes);

        expect(encoded).toBe('AAEC/f7/');
        expect(cryptoWorkerBase64ToBytes(encoded)).toEqual(bytes);
    });

    it('decodes lenient base64 payloads exactly like the protocol helper', () => {
        for (const value of ['AAE', ' A A E \n', 'not-base64 ***', '@@@']) {
            expect(cryptoWorkerBase64ToBytes(value)).toEqual(decodeBase64(value, 'base64'));
        }
    });

    it('estimates bridge bytes including UTF-16 base64 string cost', () => {
        const estimate = estimateCryptoWorkerBase64BridgeBytes('AAEC/f7/');

        expect(estimate.decodedBytes).toBe(6);
        expect(estimate.base64Utf16Bytes).toBe(16);
        expect(estimate.totalBridgeBytes).toBe(22);
    });

    it('estimates decoded bytes for lenient-valid base64 payloads', () => {
        const unpadded = estimateCryptoWorkerBase64BridgeBytes('AAE');
        expect(unpadded.decodedBytes).toBe(2);
        expect(unpadded.base64Utf16Bytes).toBe(6);
        expect(unpadded.totalBridgeBytes).toBe(8);

        const whitespaceBearingValue = ' A A E \n';
        const whitespaceBearing = estimateCryptoWorkerBase64BridgeBytes(whitespaceBearingValue);
        expect(whitespaceBearing.decodedBytes).toBe(2);
        expect(whitespaceBearing.base64Utf16Bytes).toBe(whitespaceBearingValue.length * 2);
        expect(whitespaceBearing.totalBridgeBytes).toBe(2 + whitespaceBearingValue.length * 2);
    });

    it('estimates large canonical padded base64 payloads without scanning every character', () => {
        const value = `${'A'.repeat(3998)}==`;
        const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt');
        // Regex engines scan without charCodeAt; the no-full-scan contract must also
        // exclude whole-string regex evaluation on the fast path.
        const regExpTestSpy = vi.spyOn(RegExp.prototype, 'test');

        try {
            const estimate = estimateCryptoWorkerBase64BridgeBytes(value);

            expect(estimate.decodedBytes).toBe(2998);
            expect(estimate.base64Utf16Bytes).toBe(8000);
            expect(estimate.totalBridgeBytes).toBe(10998);
            expect(charCodeAtSpy.mock.calls.length).toBeLessThan(24);
            const fullStringRegexScans = regExpTestSpy.mock.calls.filter(
                (call) => typeof call[0] === 'string' && call[0].length >= value.length,
            );
            expect(fullStringRegexScans).toHaveLength(0);
        } finally {
            charCodeAtSpy.mockRestore();
            regExpTestSpy.mockRestore();
        }
    });

    it('conservatively overestimates large length-aligned payloads with interior noise', () => {
        // Interior noise on a 4-aligned large string takes the fast path; counting the
        // noise as data only overestimates, which is the safe direction for bridge
        // byte budgeting (smaller batches).
        const canonical = 'AAEC'.repeat(300);
        const value = `${canonical.slice(0, 600)}\n\n\n\n${canonical.slice(600)}`;
        expect(value.length % 4).toBe(0);

        const estimate = estimateCryptoWorkerBase64BridgeBytes(value);
        expect(estimate.decodedBytes).toBeGreaterThanOrEqual(900);
        expect(estimate.base64Utf16Bytes).toBe(value.length * 2);
    });

    it('falls back to lenient normalization for large non-canonical base64 estimates', () => {
        const canonical = 'AAEC'.repeat(300);
        const value = ` ${canonical.slice(0, 600)}\n\t${canonical.slice(600)} `;
        const estimate = estimateCryptoWorkerBase64BridgeBytes(value);

        expect(estimate.decodedBytes).toBe(900);
        expect(estimate.base64Utf16Bytes).toBe(value.length * 2);
        expect(estimate.totalBridgeBytes).toBe(900 + value.length * 2);
    });

    it('aggregates batch bridge costs', () => {
        const estimate = estimateCryptoWorkerBatchBridgeBytes(['AAEC', 'AQIDBA==']);

        expect(estimate.items).toBe(2);
        expect(estimate.decodedBytes).toBe(7);
        expect(estimate.base64Utf16Bytes).toBe(24);
        expect(estimate.totalBridgeBytes).toBe(31);
    });
});
