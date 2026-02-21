import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '@/encryption/base64';

import {
    formatSecretKeyForBackup,
    normalizeSecretKey,
    parseBackupSecretKey,
} from './secretKeyBackup';
import {
    patternedSecretBase64,
    sequentialSecretBase64,
    sequentialSecretBytes,
    toBase64Url,
} from './secretKeyBackup.testHelpers';

describe('secretKeyBackup format/parse', () => {
    it('formats a 32-byte base64url secret key into grouped base32 text', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        expect(formatted).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})*$/);
        expect(formatted.split('-').length).toBeGreaterThanOrEqual(10);
    });

    it('round-trips a formatted key back to its original base64url secret', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        const parsed = parseBackupSecretKey(formatted);
        expect(parsed).toBe(sequentialSecretBase64);
        expect(decodeBase64(parsed, 'base64url')).toEqual(sequentialSecretBytes);
    });

    it('parses lowercase and whitespace-heavy formatted keys', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        const noisy = ` \n\t${formatted.toLowerCase().replace(/-/g, ' - ')}\t\n `;
        expect(parseBackupSecretKey(noisy)).toBe(sequentialSecretBase64);
    });

    it('keeps formatting deterministic for the same source key', () => {
        expect(formatSecretKeyForBackup(patternedSecretBase64)).toBe(
            formatSecretKeyForBackup(patternedSecretBase64),
        );
    });

    it('normalizes formatted keys and base64url keys to base64url output', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        expect(normalizeSecretKey(sequentialSecretBase64)).toBe(sequentialSecretBase64);
        expect(normalizeSecretKey(formatted)).toBe(sequentialSecretBase64);
    });

    it("does not treat base64url keys containing '-' as formatted backup keys", () => {
        const findBase64UrlWithDash = (): string => {
            for (let offset = 0; offset < 256; offset += 1) {
                const candidate = toBase64Url(new Uint8Array(32).fill(offset));
                if (candidate.includes('-')) return candidate;
            }
            throw new Error("Unable to generate a base64url key containing '-'");
        };

        const base64Url = findBase64UrlWithDash();
        expect(base64Url.includes('-')).toBe(true);
        expect(decodeBase64(base64Url, 'base64url')).toHaveLength(32);
        expect(normalizeSecretKey(base64Url)).toBe(base64Url);
    });
});
