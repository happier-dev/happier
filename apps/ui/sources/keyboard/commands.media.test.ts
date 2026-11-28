import { describe, expect, it, vi } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardCommandId, NormalizedKeyboardEvent } from './types';

describe('media stage keyboard commands', () => {
    it.each([['media.zoomIn', '+', 'NumpadAdd'], ['media.zoomOut', '-', 'NumpadSubtract']] as const)(
        'accepts the numeric keypad for %s', (id, key, code) => {
            const run = vi.fn();
            const dispatch = createKeyboardShortcutDispatcher({ platform: 'macos', surface: 'web',
                singleKeyShortcutsEnabled: true, disabledCommandIds: [], overrides: {}, handlers: { [id]: run },
                getContext: () => ({ isEditableTarget: false, isComposing: false }) });
            expect(dispatch({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
                repeat: false, isComposing: false })).toBe(true);
            expect(run).toHaveBeenCalledOnce();
        });
    it.each([
        ['media.previous', 'ArrowLeft'], ['media.next', 'ArrowRight'],
        ['media.zoomIn', '+'], ['media.zoomOut', '-'],
        ['media.fit', '0'], ['media.actualSize', '1'], ['media.playPause', ' '],
        ['media.annotate', 'e'], ['annotation.select', 'v'], ['annotation.arrow', 'a'],
        ['annotation.rectangle', 'r'], ['annotation.text', 't'], ['annotation.blur', 'b'],
    ] as const)('dispatches %s only while a stage handler is registered and yields to text inputs', (id, key) => {
        const run = vi.fn();
        const code = key === ' ' ? 'Space' : key === '+' ? 'Equal' : /^[01]$/.test(key) ? `Digit${key}` : /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key;
        const event: NormalizedKeyboardEvent = { key, code, metaKey: false,
            ctrlKey: false, altKey: false, shiftKey: key === '+', repeat: false, isComposing: false };
        const options = { platform: 'macos' as const, surface: 'web' as const,
            singleKeyShortcutsEnabled: true, disabledCommandIds: [], overrides: {},
            getContext: () => ({ isEditableTarget: false, isComposing: false }) };
        const handlers: Partial<Record<KeyboardCommandId, () => void>> = { [id]: run };
        expect(createKeyboardShortcutDispatcher({ ...options, handlers })(event)).toBe(true);
        expect(run).toHaveBeenCalledOnce();
        expect(createKeyboardShortcutDispatcher({ ...options, handlers: {} })(event)).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...options, handlers,
            getContext: () => ({ isEditableTarget: true, isComposing: false }) })(event)).toBe(false);
    });
});
