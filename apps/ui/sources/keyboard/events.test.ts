import { describe, expect, it } from 'vitest';

import { normalizeKeyboardKeyPressEvent, normalizeSupportedKey } from './events';

describe('keyboard event normalization', () => {
    it('normalizes legacy arrow key names', () => {
        expect(normalizeSupportedKey('Up')).toBe('ArrowUp');
        expect(normalizeSupportedKey('Down')).toBe('ArrowDown');
        expect(normalizeSupportedKey('Left')).toBe('ArrowLeft');
        expect(normalizeSupportedKey('Right')).toBe('ArrowRight');
    });

    it('preserves modifier and composition metadata for composer shortcuts', () => {
        expect(normalizeKeyboardKeyPressEvent({
            key: 'Enter',
            code: 'NumpadEnter',
            shiftKey: true,
            altKey: true,
            ctrlKey: false,
            metaKey: true,
            repeat: true,
            isComposing: true,
        })).toEqual({
            key: 'Enter',
            code: 'NumpadEnter',
            shiftKey: true,
            altKey: true,
            ctrlKey: false,
            metaKey: true,
            repeat: true,
            isComposing: true,
        });
    });

    it('drops unsupported keys', () => {
        expect(normalizeKeyboardKeyPressEvent({ key: 'a' })).toBeNull();
    });
});
