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

        try {
            const estimate = estimateCryptoWorkerBase64BridgeBytes(value);

            expect(estimate.decodedBytes).toBe(2998);
            expect(estimate.base64Utf16Bytes).toBe(8000);
            expect(estimate.totalBridgeBytes).toBe(10998);
            expect(charCodeAtSpy.mock.calls.length).toBeLessThan(16);
        } finally {
            charCodeAtSpy.mockRestore();
        }
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
