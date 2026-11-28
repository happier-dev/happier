import { describe, expect, it } from 'vitest';
import { buildKeyboardShortcutLabels, createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardPlatform, KeyboardSurface, KeyboardWebHost, NormalizedKeyboardEvent } from './types';

describe('file editor Save shortcut', () => {
    it.each([
        ['macos', 'web', 'browser', true, false, 'Option+S'],
        ['macos', 'web', 'desktop', false, true, 'Cmd+S'],
        ['macos', 'native', undefined, false, true, 'Cmd+S'],
        ['windows', 'web', 'desktop', false, false, 'Ctrl+S'],
    ] satisfies Array<[KeyboardPlatform, KeyboardSurface, KeyboardWebHost | undefined, boolean, boolean, string]>)
    ('saves in an editable field on %s/%s/%s and yields the other host chord', (platform, surface, webHost, altKey, metaKey, label) => {
        let saves = 0;
        const options = { platform, surface, webHost, singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers: { 'files.editor.save': () => { saves += 1; } },
            getContext: () => ({ isEditableTarget: true, isComposing: false }) };
        const dispatch = createKeyboardShortcutDispatcher(options);
        const event: NormalizedKeyboardEvent = { key: 's', code: 'KeyS', altKey, metaKey,
            ctrlKey: platform === 'windows', shiftKey: false, repeat: false, isComposing: false };
        expect(dispatch(event)).toBe(true);
        expect(saves).toBe(1);
        expect(dispatch({ ...event, altKey: !altKey, metaKey: !metaKey, ctrlKey: false })).toBe(false);
        expect(dispatch({ ...event, isComposing: true })).toBe(false);
        expect(buildKeyboardShortcutLabels(platform, surface, { webHost })['files.editor.save']).toBe(label);
    });
});
