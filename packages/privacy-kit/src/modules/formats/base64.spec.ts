import { describe, it, expect } from 'vitest';
import { encodeBase64, decodeBase64 } from './base64';

describe('base64', () => {
    describe('encodeBase64', () => {
        it('should encode empty buffer', () => {
            const input = new Uint8Array(0);
            expect(encodeBase64(input)).toBe('');
            expect(encodeBase64(input, 'base64url')).toBe('');
        });

        it('should encode single byte', () => {
            const input = new Uint8Array([65]); // 'A'
            expect(encodeBase64(input)).toBe('QQ==');
            expect(encodeBase64(input, 'base64url')).toBe('QQ==');
        });

        it('should encode multiple bytes with padding', () => {
            const input = new Uint8Array([72, 101, 108, 108, 111]); // 'Hello'
            expect(encodeBase64(input)).toBe('SGVsbG8=');
            expect(encodeBase64(input, 'base64url')).toBe('SGVsbG8=');
        });

        it('should encode without padding when length is multiple of 3', () => {
            const input = new Uint8Array([72, 101, 108]); // 'Hel'
            expect(encodeBase64(input)).toBe('SGVs');
            expect(encodeBase64(input, 'base64url')).toBe('SGVs');
        });

        it('should handle base64url special characters', () => {
            // This input produces '+' and '/' in standard base64
            const input = new Uint8Array([251, 255]);
            expect(encodeBase64(input)).toBe('+/8=');
            expect(encodeBase64(input, 'base64url')).toBe('-_8=');
        });

        it('should encode binary data', () => {
            const input = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            expect(encodeBase64(input)).toBe('AAECAwQFBgcICQ==');
            expect(encodeBase64(input, 'base64url')).toBe('AAECAwQFBgcICQ==');
        });

        it('should encode all byte values', () => {
            const input = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                input[i] = i;
            }
            const encoded = encodeBase64(input);
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });
    });

    describe('decodeBase64', () => {
        it('should decode empty string', () => {
            expect(decodeBase64('')).toEqual(new Uint8Array(0));
            expect(decodeBase64('', 'base64url')).toEqual(new Uint8Array(0));
        });

        it('should decode single character with padding', () => {
            expect(decodeBase64('QQ==')).toEqual(new Uint8Array([65]));
            expect(decodeBase64('QQ==', 'base64url')).toEqual(new Uint8Array([65]));
        });

        it('should decode with padding', () => {
            expect(decodeBase64('SGVsbG8=')).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
            expect(decodeBase64('SGVsbG8=', 'base64url')).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
        });

        it('should decode without padding', () => {
            expect(decodeBase64('SGVs')).toEqual(new Uint8Array([72, 101, 108]));
            expect(decodeBase64('SGVs', 'base64url')).toEqual(new Uint8Array([72, 101, 108]));
        });

        it('should handle base64url special characters', () => {
            expect(decodeBase64('+/8=')).toEqual(new Uint8Array([251, 255]));
            expect(decodeBase64('-_8=', 'base64url')).toEqual(new Uint8Array([251, 255]));
        });

        it('should decode binary data', () => {
            expect(decodeBase64('AAECAwQFBgcICQ==')).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
            expect(decodeBase64('AAECAwQFBgcICQ==', 'base64url')).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
        });

        it('should throw on invalid base64 characters', () => {
            expect(() => decodeBase64('SGVsbG8!')).toThrow();
            expect(() => decodeBase64('SGVs bG8=')).toThrow();
            expect(() => decodeBase64('SGV@bG8=')).toThrow();
        });

        it('should handle strings without padding', () => {
            // The library handles missing padding gracefully
            expect(decodeBase64('SGVsbG8')).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
            expect(() => decodeBase64('Q')).toThrow(); // Invalid length
            expect(() => decodeBase64('QQ=')).toThrow(); // Wrong padding
        });
    });

    describe('round-trip', () => {
        it('should round-trip various data sizes', () => {
            const testSizes = [0, 1, 2, 3, 4, 5, 10, 16, 32, 64, 100, 255, 256, 1000];

            for (const size of testSizes) {
                const input = new Uint8Array(size);
                for (let i = 0; i < size; i++) {
                    input[i] = (i * 7 + 13) % 256; // Pseudo-random pattern
                }

                // Test standard base64
                const encoded64 = encodeBase64(input);
                const decoded64 = decodeBase64(encoded64);
                expect(decoded64).toEqual(input);

                // Test base64url
                const encoded64url = encodeBase64(input, 'base64url');
                const decoded64url = decodeBase64(encoded64url, 'base64url');
                expect(decoded64url).toEqual(input);
            }
        });

        it('should handle known test vectors', () => {
            const testVectors = [
                { text: '', base64: '' },
                { text: 'f', base64: 'Zg==' },
                { text: 'fo', base64: 'Zm8=' },
                { text: 'foo', base64: 'Zm9v' },
                { text: 'foob', base64: 'Zm9vYg==' },
                { text: 'fooba', base64: 'Zm9vYmE=' },
                { text: 'foobar', base64: 'Zm9vYmFy' },
            ];

            for (const { text, base64 } of testVectors) {
                const bytes = new TextEncoder().encode(text);
                expect(encodeBase64(bytes)).toBe(base64);
                expect(decodeBase64(base64)).toEqual(bytes);
            }
        });
    });
});