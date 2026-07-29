import { describe, expect, it } from 'vitest';

import {
    SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH,
    normalizeSessionMessagePinLabel,
    resolveSessionMessagePinDisplayRole,
} from './sessionMessagePinDisplay';

describe('session message pin display', () => {
    it('normalizes optional labels without turning blank text into persisted content', () => {
        expect(normalizeSessionMessagePinLabel('  Keep this turn  ')).toBe('Keep this turn');
        expect(normalizeSessionMessagePinLabel('    ')).toBeNull();
        expect(normalizeSessionMessagePinLabel(null)).toBeNull();
    });

    it('caps labels for local-only metadata', () => {
        const longLabel = 'a'.repeat(SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH + 25);

        expect(normalizeSessionMessagePinLabel(longLabel)).toHaveLength(SESSION_MESSAGE_PIN_LABEL_MAX_LENGTH);
    });

    it('preserves display roles for pinnable user, assistant, and tool rows', () => {
        expect(resolveSessionMessagePinDisplayRole('user')).toBe('user');
        expect(resolveSessionMessagePinDisplayRole('assistant')).toBe('assistant');
        expect(resolveSessionMessagePinDisplayRole('tool')).toBe('tool');
        expect(resolveSessionMessagePinDisplayRole('system')).toBe('unknown');
        expect(resolveSessionMessagePinDisplayRole('unknown')).toBe('unknown');
    });
});
