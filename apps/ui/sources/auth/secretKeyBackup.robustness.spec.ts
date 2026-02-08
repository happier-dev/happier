import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '@/encryption/base64';

import {
    formatSecretKeyForBackup,
    parseBackupSecretKey,
} from './secretKeyBackup';
import {
    fullFFSecretBase64,
    fullFFSecretBytes,
    patternedSecretBase64,
    patternedSecretBytes,
    sequentialSecretBase64,
} from './secretKeyBackup.testHelpers';

describe('secretKeyBackup robustness', () => {
    it('recovers from common character confusion (0/1/8) in formatted keys', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        const confused = formatted.replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8');
        expect(parseBackupSecretKey(confused)).toBe(sequentialSecretBase64);
    });

    it('accepts separator and wrapper variants from copy/paste', () => {
        const formatted = formatSecretKeyForBackup(sequentialSecretBase64);
        const withMixedSeparators = `[${formatted.replace(/-/g, '._/')}]`;
        expect(parseBackupSecretKey(withMixedSeparators)).toBe(sequentialSecretBase64);
    });

    it('handles all-255 byte keys without data loss', () => {
        const formatted = formatSecretKeyForBackup(fullFFSecretBase64);
        const parsed = parseBackupSecretKey(formatted);
        expect(decodeBase64(parsed, 'base64url')).toEqual(fullFFSecretBytes);
    });

    it('handles deterministic patterned keys without data loss', () => {
        const formatted = formatSecretKeyForBackup(patternedSecretBase64);
        const parsed = parseBackupSecretKey(formatted);
        expect(decodeBase64(parsed, 'base64url')).toEqual(patternedSecretBytes);
    });

    it('preserves data through repeated format/parse cycles', () => {
        let current = sequentialSecretBase64;
        for (let count = 0; count < 5; count += 1) {
            current = parseBackupSecretKey(formatSecretKeyForBackup(current));
        }
        expect(current).toBe(sequentialSecretBase64);
    });
});
