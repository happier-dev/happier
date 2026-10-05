import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { NormalizedKeyboardEvent } from './types';

afterEach(() => vi.unstubAllGlobals());

describe('Appearance keyboard shortcut', () => {
    it.each([
        ['Mozilla/5.0 Chrome/130 Safari/537.36', false],
        ['Mozilla/5.0 Version/18.0 Safari/605.1.15', true],
    ] as const)('uses the Safari fallback only for Safari (%s)', (userAgent, safari) => {
        vi.stubGlobal('navigator', { userAgent });
        const toggle = vi.fn();
        const dispatch = createKeyboardShortcutDispatcher({
            enabled: true, platform: 'macos', surface: 'web', webHost: 'browser',
            singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
            handlers: { 'appearance.theme.toggle': toggle },
            getContext: () => ({ isEditableTarget: false, isComposing: false }),
        });
        const event: NormalizedKeyboardEvent = { key: 'l', code: 'KeyL', metaKey: true, ctrlKey: false, altKey: safari, shiftKey: !safari, repeat: false, isComposing: false };
        expect(dispatch(event)).toBe(true);
        expect(dispatch({ ...event, altKey: !safari, shiftKey: safari })).toBe(false);
        expect(toggle).toHaveBeenCalledOnce();
    });
});
