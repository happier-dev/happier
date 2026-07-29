import { describe, expect, it } from 'vitest';

import { normalizeSecretStringPromptInput } from './normalizeSecretStringPromptInput';

describe('normalizeSecretStringPromptInput', () => {
    it('returns null for null input', () => {
        expect(normalizeSecretStringPromptInput(null)).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
        expect(normalizeSecretStringPromptInput('   ')).toBeNull();
    });

    it('wraps trimmed non-empty input as a sealed secret value', () => {
        expect(normalizeSecretStringPromptInput('  sk-123  ')).toEqual({
            _isSecretValue: true,
            value: 'sk-123',
        });
    });
});
