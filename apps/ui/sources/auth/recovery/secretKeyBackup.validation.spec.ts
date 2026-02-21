import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';

import {
    formatSecretKeyForBackup,
    isValidSecretKey,
    normalizeSecretKey,
    parseBackupSecretKey,
} from './secretKeyBackup';
import {
    fullFFSecretBase64,
    sequentialSecretBase64,
    toBase64Url,
} from './secretKeyBackup.testHelpers';

describe('secretKeyBackup validation', () => {
    it('accepts valid base64url and formatted keys', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        expect(isValidSecretKey(sequentialSecretBase64)).toBe(true);
        expect(isValidSecretKey(fullFFSecretBase64)).toBe(true);
        expect(isValidSecretKey(formatted)).toBe(true);
    });

    it("accepts base64url secrets that include '-' characters", () => {
        const findBase64UrlWithDash = (): string => {
            for (let offset = 0; offset < 256; offset += 1) {
                const candidate = toBase64Url(new Uint8Array(32).fill(offset));
                if (candidate.includes('-')) return candidate;
            }
            throw new Error("Unable to generate a base64url key containing '-'");
        };

        const base64Url = findBase64UrlWithDash();
        expect(base64Url.includes('-')).toBe(true);
        expect(isValidSecretKey(base64Url)).toBe(true);
    });

    it('rejects malformed and empty keys', () => {
        expect(isValidSecretKey('')).toBe(false);
        expect(isValidSecretKey('   ')).toBe(false);
        expect(isValidSecretKey('not-valid')).toBe(false);
    });

    it('rejects wrong-length base64 keys', () => {
        const shortBase64 = encodeBase64(new Uint8Array(16), 'base64url');
        const longBase64 = encodeBase64(new Uint8Array(64), 'base64url');
        expect(isValidSecretKey(shortBase64)).toBe(false);
        expect(isValidSecretKey(longBase64)).toBe(false);
    });

    it('throws clear errors for empty and wrong-length formatted input', () => {
        expect(() => parseBackupSecretKey('!!!')).toThrow('No valid characters found');
        expect(() => parseBackupSecretKey('AAAAA-BBBBB')).toThrow(/Invalid key length/);
    });

    it('throws when normalizeSecretKey cannot parse either format', () => {
        expect(() => normalizeSecretKey('INVALID_SECRET')).toThrow();
    });
});
