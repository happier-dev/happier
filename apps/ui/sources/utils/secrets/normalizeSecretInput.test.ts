import { describe, expect, it } from 'vitest';

import { normalizeSecretPromptInput } from './normalizeSecretInput';

describe('normalizeSecretPromptInput', () => {
    it('returns null for null or empty/whitespace', () => {
        expect(normalizeSecretPromptInput(null)).toBeNull();
        expect(normalizeSecretPromptInput('')).toBeNull();
        expect(normalizeSecretPromptInput('   ')).toBeNull();
        expect(normalizeSecretPromptInput('\n\t')).toBeNull();
    });

    it('trims and returns the secret value', () => {
        expect(normalizeSecretPromptInput(' abc ')).toBe('abc');
        expect(normalizeSecretPromptInput('\nabc\t')).toBe('abc');
    });

    it('preserves non-empty internal whitespace and control-adjacent content', () => {
        expect(normalizeSecretPromptInput(' key\tvalue ')).toBe('key\tvalue');
        expect(normalizeSecretPromptInput('\u2003secret\u2003')).toBe('secret');
    });
});
