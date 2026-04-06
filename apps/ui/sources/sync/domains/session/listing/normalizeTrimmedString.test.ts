import { describe, expect, it } from 'vitest';

import { normalizeTrimmedString } from './normalizeTrimmedString';

describe('normalizeTrimmedString', () => {
    it('trims string input', () => {
        expect(normalizeTrimmedString('  server-a  ')).toBe('server-a');
    });

    it('preserves String-coerced values before trimming', () => {
        expect(normalizeTrimmedString(42)).toBe('42');
    });

    it('returns an empty string for blank or nullish input', () => {
        expect(normalizeTrimmedString('   ')).toBe('');
        expect(normalizeTrimmedString(null)).toBe('');
        expect(normalizeTrimmedString(undefined)).toBe('');
    });
});
