import { describe, expect, it, vi } from 'vitest';

import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardCommandId, KeyboardPlatform, KeyboardSurface, NormalizedKeyboardEvent } from './types';

function dispatcher(platform: KeyboardPlatform, surface: KeyboardSurface, editable = false) {
    const handler = vi.fn();
    const dispatch = createKeyboardShortcutDispatcher({
        platform, surface, singleKeyShortcutsEnabled: false,
        disabledCommandIds: [], overrides: {}, handlers: { 'terminal.jump': handler },
        getContext: () => ({ isEditableTarget: editable, isComposing: false }),
    });
    return { dispatch, handler };
}

function chord(platform: KeyboardPlatform, modifier: 'mod' | 'alt'): NormalizedKeyboardEvent {
    const mod = modifier === 'mod';
    return { key: 'j', code: 'KeyJ', altKey: !mod, shiftKey: false, metaKey: mod && platform === 'macos', ctrlKey: mod && platform !== 'macos', repeat: false, isComposing: false };
}

describe('Jump to a terminal shortcut (terminal lab B4)', () => {
    it.each([['macos', 'native'], ['windows', 'native']] as const)('opens on Mod+J in the %s app', (platform, surface) => {
        const { dispatch, handler } = dispatcher(platform, surface);
        expect(dispatch(chord(platform, 'mod'))).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
    });

    it('uses Alt+J on the web surface, where the host browser keeps Mod+J', () => {
        const { dispatch, handler } = dispatcher('macos', 'web');
        expect(dispatch(chord('macos', 'mod'))).toBe(false);
        expect(dispatch(chord('macos', 'alt'))).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
    });

    it('leaves the chord to a focused text field', () => {
        const { dispatch, handler } = dispatcher('macos', 'native', true);
        expect(dispatch(chord('macos', 'mod'))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('terminal workspace shortcuts', () => {
    it.each(['macos', 'windows', 'linux'] as const)('runs terminal commands from an editable terminal on %s', (platform) => {
        const toggle = vi.fn();
        const shell = vi.fn();
        const split = vi.fn();
        const handlers: Partial<Record<KeyboardCommandId, () => void>> = {
            'terminal.toggle': toggle, 'terminal.newShell': shell, 'terminal.split': split,
        };
        const dispatch = createKeyboardShortcutDispatcher({
            platform, surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers,
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        });
        const event = { ...chord(platform, 'mod'), key: '`', code: 'Backquote', metaKey: false, ctrlKey: true };
        expect(dispatch(event)).toBe(true);
        expect(toggle).toHaveBeenCalledOnce();
        expect(dispatch({ ...event, key: '~', shiftKey: true })).toBe(true);
        expect(shell).toHaveBeenCalledOnce();
        expect(dispatch({ ...chord(platform, 'mod'), key: '\\', code: 'Backslash' })).toBe(true);
        expect(split).toHaveBeenCalledOnce();
    });
});
