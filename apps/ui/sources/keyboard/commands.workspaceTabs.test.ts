import { describe, expect, it, vi } from 'vitest';

import { createKeyboardShortcutDispatcher, resolveNativeHardwareKeyboardConsumableEventSignatures } from './runtime';
import type { KeyboardShortcutDispatcherOptions } from './runtime';
import type { KeyboardCommandId, KeyboardPlatform, KeyboardSurface, NormalizedKeyboardEvent } from './types';

function options(commandId: KeyboardCommandId, platform: KeyboardPlatform, surface: KeyboardSurface) {
    const handler = vi.fn();
    const value: KeyboardShortcutDispatcherOptions = {
        platform, surface, singleKeyShortcutsEnabled: false,
        disabledCommandIds: [], overrides: {}, handlers: { [commandId]: handler },
        getContext: () => ({ isEditableTarget: true, isComposing: false }),
    };
    return { value, handler };
}

describe('workspace tab shortcuts', () => {
    it.each(['macos', 'windows', 'linux'] as const)('closes all tabs with Mod+Shift+W on %s, even in an editor', (platform) => {
        const { value, handler } = options('workspace.tab.closeAll', platform, 'native');
        const event: NormalizedKeyboardEvent = { key: 'W', code: 'KeyW', altKey: false, shiftKey: true,
            metaKey: platform === 'macos', ctrlKey: platform !== 'macos', repeat: false, isComposing: false };
        expect(createKeyboardShortcutDispatcher(value)(event)).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
        expect(createKeyboardShortcutDispatcher({ ...value, disabledCommandIds: ['workspace.tab.closeAll'] })(event)).toBe(false);
        expect(createKeyboardShortcutDispatcher(value)({ ...event, isComposing: true })).toBe(false);
    });

    it('dispatches reopen while editing using the same customizable native command owner', () => {
        const { value, handler } = options('workspace.tab.reopen', 'macos', 'native');
        const event: NormalizedKeyboardEvent = { key: 'T', code: 'KeyT', altKey: false, shiftKey: true, metaKey: true, ctrlKey: false, repeat: false, isComposing: false };
        expect(createKeyboardShortcutDispatcher(value)(event)).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(value)).toContain('t|shift=true|ctrl=false|meta=true|alt=false');
    });
    it.each([['macos', 'native'], ['windows', 'native'], ['macos', 'web']] as const)(
        'dispatches Mod tab chords received by the %s %s owner, including from editors', (platform, surface) => {
            const commands: Array<[KeyboardCommandId, string, string]> = [
                ['workspace.tab.new', 't', 'KeyT'], ['workspace.tab.close', 'w', 'KeyW'],
                ...Array.from({ length: 9 }, (_, index): [KeyboardCommandId, string, string] => [
                    `workspace.tab.select${index + 1}` as KeyboardCommandId, String(index + 1), `Digit${index + 1}`,
                ]),
            ];
            for (const [commandId, key, code] of commands) {
                const { value, handler } = options(commandId, platform, surface);
                const event: NormalizedKeyboardEvent = { key, code, altKey: false, shiftKey: false,
                    metaKey: platform === 'macos', ctrlKey: platform === 'windows', repeat: false, isComposing: false };
                expect(createKeyboardShortcutDispatcher(value)(event), commandId).toBe(true);
                expect(handler).toHaveBeenCalledOnce();
                expect(createKeyboardShortcutDispatcher({ ...value, disabledCommandIds: [commandId] })(event)).toBe(false);
                expect(createKeyboardShortcutDispatcher(value)({ ...event, isComposing: true })).toBe(false);
                expect(createKeyboardShortcutDispatcher(value)({ ...event, repeat: true })).toBe(false);
            }
        },
    );

    it('declares native consumption so delivered hardware chords do not also reach the focused editor', () => {
        const { value } = options('workspace.tab.new', 'ios', 'native');
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(value)).toContain('t|shift=false|ctrl=false|meta=true|alt=false');
    });
});
