import { describe, expect, it, vi } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';

describe('editor change navigation commands', () => {
    it('dispatches both directions in an editable target and yields during composition', () => {
        const next = vi.fn();
        const previous = vi.fn();
        const dispatch = createKeyboardShortcutDispatcher({
            platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {},
            handlers: { 'files.editor.change.next': next, 'files.editor.change.previous': previous },
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        });
        const event = { key: 'F5', code: 'F5', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false };
        expect(dispatch(event)).toBe(true);
        expect(next).toHaveBeenCalledOnce();
        expect(dispatch({ ...event, shiftKey: true })).toBe(true);
        expect(previous).toHaveBeenCalledOnce();
        expect(dispatch({ ...event, isComposing: true })).toBe(false);
    });
});
