import { describe, expect, it, vi } from 'vitest';

import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardCommandId, KeyboardPlatform, KeyboardWebHost, KeybindingRule, NormalizedKeyboardEvent } from './types';

function chord(key: string, modifier: 'ctrl' | 'alt' | 'meta'): NormalizedKeyboardEvent {
    return { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, ctrlKey: modifier === 'ctrl', altKey: modifier === 'alt', metaKey: modifier === 'meta', shiftKey: false, repeat: false, isComposing: false };
}

function harness(platform: KeyboardPlatform, webHost: KeyboardWebHost, editable = false, overrides: Partial<Record<KeyboardCommandId, readonly KeybindingRule[]>> = {}) {
    const select = vi.fn();
    const open = vi.fn();
    const tab = vi.fn();
    const dispatch = createKeyboardShortcutDispatcher({
        platform, surface: 'web', webHost, singleKeyShortcutsEnabled: false,
        disabledCommandIds: [], overrides,
        handlers: { 'sessionList.space.select1': select, 'sessionList.filter.open': open, 'workspace.tab.select1': tab },
        getContext: () => ({ isEditableTarget: editable, isComposing: false }),
    });
    return { dispatch, select, open, tab };
}

describe('session list space keyboard commands', () => {
    it.each(['browser', 'desktop'] as const)('uses Control digits on macOS %s and preserves Command workspace tabs', (host) => {
        const { dispatch, select, tab } = harness('macos', host);
        expect(dispatch(chord('1', 'ctrl'))).toBe(true);
        expect(select).toHaveBeenCalledOnce();
        expect(dispatch(chord('1', 'meta'))).toBe(true);
        expect(tab).toHaveBeenCalledOnce();
    });

    it.each(['windows', 'linux'] as const)('uses Alt digits only on the %s desktop host', (platform) => {
        const desktop = harness(platform, 'desktop');
        const browser = harness(platform, 'browser');
        expect(desktop.dispatch(chord('1', 'alt'))).toBe(true);
        expect(browser.dispatch(chord('1', 'alt'))).toBe(false);
        expect(browser.select).not.toHaveBeenCalled();
        expect(desktop.dispatch(chord('1', 'ctrl'))).toBe(true);
        expect(desktop.tab).toHaveBeenCalledOnce();
    });

    it.each(['macos', 'windows', 'linux'] as const)('opens filters with Alt F only on the %s desktop host', (platform) => {
        expect(harness(platform, 'desktop').dispatch(chord('f', 'alt'))).toBe(true);
        expect(harness(platform, 'browser').dispatch(chord('f', 'alt'))).toBe(false);
    });

    it('respects editable focus and browser user overrides', () => {
        expect(harness('macos', 'desktop', true).dispatch(chord('1', 'ctrl'))).toBe(false);
        expect(harness('macos', 'desktop', true).dispatch(chord('f', 'alt'))).toBe(false);
        const rebound = harness('linux', 'browser', false, { 'sessionList.space.select1': [{ binding: 'Alt+9' }] });
        expect(rebound.dispatch(chord('9', 'alt'))).toBe(true);
        expect(rebound.select).toHaveBeenCalledOnce();
        expect(rebound.dispatch(chord('1', 'alt'))).toBe(false);
    });
});
