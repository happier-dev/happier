import { describe, expect, it, vi } from 'vitest';

import { buildKeyboardShortcutLabels, createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardShortcutDispatcherOptions } from './runtime';
import type { KeyboardPlatform, NormalizedKeyboardEvent } from './types';

function copyEvent(platform: KeyboardPlatform): NormalizedKeyboardEvent {
    return { key: 'c', code: 'KeyC', metaKey: platform === 'macos', ctrlKey: platform !== 'macos',
        altKey: false, shiftKey: false, repeat: false, isComposing: false };
}

function options(platform: KeyboardPlatform, editable = false) {
    const copy = vi.fn();
    const value: KeyboardShortcutDispatcherOptions = {
        enabled: true, platform, surface: 'web', webHost: 'desktop', singleKeyShortcutsEnabled: false,
        disabledCommandIds: [], overrides: {}, handlers: { 'screenCapture.copy': copy },
        getContext: () => ({ isEditableTarget: editable, isComposing: false }),
    };
    return { value, copy };
}

describe('Capture image copy keyboard command', () => {
    it('toggles recording with Space only while the focused pill has registered its handler', () => {
        const { value } = options('macos');
        const toggle = vi.fn();
        const event: NormalizedKeyboardEvent = { key: ' ', code: 'Space', metaKey: false, ctrlKey: false,
            altKey: false, shiftKey: false, repeat: false, isComposing: false };
        const focused = { ...value, handlers: { 'screenCapture.recording.playPause': toggle } };
        expect(createKeyboardShortcutDispatcher(focused)(event)).toBe(true);
        expect(toggle).toHaveBeenCalledOnce();
        expect(createKeyboardShortcutDispatcher({ ...value, handlers: {} })(event)).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...focused, getContext: () => ({ isEditableTarget: true, isComposing: false }) })(event)).toBe(false);
    });
    it.each(['macos', 'windows', 'linux'] as const)('copies from the capture surface with Mod+C on %s', platform => {
        const { value, copy } = options(platform);
        expect(createKeyboardShortcutDispatcher(value)(copyEvent(platform))).toBe(true);
        expect(copy).toHaveBeenCalledOnce();
        expect(createKeyboardShortcutDispatcher({ ...value, handlers: {} })(copyEvent(platform))).toBe(false);
    });

    it('leaves editable note and annotation text copy to their native editor, even with an editable override', () => {
        const { value, copy } = options('macos', true);
        expect(createKeyboardShortcutDispatcher(value)(copyEvent('macos'))).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...value, overrides: {
            'screenCapture.copy': [{ binding: 'Mod+C', allowInEditable: true }],
        } })(copyEvent('macos'))).toBe(false);
        expect(copy).not.toHaveBeenCalled();
    });

    it('honors customization, exposes its canonical label, and ignores repeated/composing copy', () => {
        const { value, copy } = options('macos');
        const overrides = { 'screenCapture.copy': [{ binding: 'Mod+Shift+C' }] };
        const dispatch = createKeyboardShortcutDispatcher({ ...value, overrides });
        expect(dispatch(copyEvent('macos'))).toBe(false);
        expect(dispatch({ ...copyEvent('macos'), shiftKey: true })).toBe(true);
        expect(dispatch({ ...copyEvent('macos'), shiftKey: true, repeat: true })).toBe(false);
        expect(dispatch({ ...copyEvent('macos'), shiftKey: true, isComposing: true })).toBe(false);
        expect(copy).toHaveBeenCalledOnce();
        expect(buildKeyboardShortcutLabels('macos', 'web', { overrides })['screenCapture.copy']).toBe('Cmd+Shift+C');
        expect(buildKeyboardShortcutLabels('windows', 'web')['screenCapture.copy']).toBe('Ctrl+C');
    });
});
