import { describe, expect, it } from 'vitest';

import { normalizeCodeLanguageId } from './normalizeCodeLanguageId';

describe('normalizeCodeLanguageId', () => {
    it('normalizes common short ids and extensions', () => {
        expect(normalizeCodeLanguageId('ts')).toBe('typescript');
        expect(normalizeCodeLanguageId('js')).toBe('javascript');
        expect(normalizeCodeLanguageId('md')).toBe('markdown');
        expect(normalizeCodeLanguageId('yml')).toBe('yaml');
        expect(normalizeCodeLanguageId('py')).toBe('python');
        expect(normalizeCodeLanguageId('sh')).toBe('bash');
        expect(normalizeCodeLanguageId('gql')).toBe('graphql');
    });

    it('returns trimmed lower-case ids by default', () => {
        expect(normalizeCodeLanguageId('  JSONC ')).toBe('jsonc');
    });

    it('returns null for empty input', () => {
        expect(normalizeCodeLanguageId('')).toBeNull();
        expect(normalizeCodeLanguageId('   ')).toBeNull();
        expect(normalizeCodeLanguageId(null)).toBeNull();
        expect(normalizeCodeLanguageId(undefined)).toBeNull();
    });
});
