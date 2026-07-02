import { describe, expect, it } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';

import {
    buildKeyboardShortcutResetDelta,
    buildKeyboardShortcutSetDelta,
    buildKeyboardShortcutSettingsModel,
    buildKeyboardShortcutToggleDelta,
} from './keyboardShortcutsSettingsModel';

const baseSettings = {
    commandPaletteEnabled: true,
    keyboardShortcutsV2Enabled: false,
    keyboardSingleKeyShortcutsEnabled: false,
    keyboardShortcutDisabledCommandIdsV1: [],
    keyboardShortcutOverridesV1: {},
} as Pick<
    Settings,
    | 'commandPaletteEnabled'
    | 'keyboardShortcutsV2Enabled'
    | 'keyboardSingleKeyShortcutsEnabled'
    | 'keyboardShortcutDisabledCommandIdsV1'
    | 'keyboardShortcutOverridesV1'
>;

describe('keyboardShortcutsSettingsModel', () => {
    it('builds command rows from explicit keyboard registry metadata', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: baseSettings,
            platform: 'macos',
            surface: 'native',
        });

        expect(model.commandRows.map((row) => row.commandId)).toEqual(expect.arrayContaining([
            'commandPalette.open',
            'composer.sendPending',
            'shortcutsHelp.open',
            'session.new',
            'settings.open',
        ]));
        expect(model.commandRows.find((row) => row.commandId === 'composer.sendPending')?.defaultLabel).toBe('Cmd+Shift+Enter');
        expect(model.commandRows.find((row) => row.commandId === 'commandPalette.open')?.defaultLabel).toBe('Cmd+K');
        expect(model.commandRows.find((row) => row.commandId === 'settings.open')?.defaultLabel).toBeNull();
        expect(model.commandRows.every((row) => row.titleKey.startsWith('settingsKeyboard.commands.'))).toBe(true);
    });

    it('shows registry defaults even when single-key shortcuts are currently inactive', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardSingleKeyShortcutsEnabled: false,
            },
            platform: 'macos',
            surface: 'web',
        });

        expect(model.commandRows.find((row) => row.commandId === 'shortcutsHelp.open')?.defaultLabel).toBe('?');
    });

    it('shows active web-safe defaults instead of browser-reserved native defaults on web', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardSingleKeyShortcutsEnabled: true,
            },
            platform: 'macos',
            surface: 'web',
        });

        expect(model.commandRows.find((row) => row.commandId === 'commandPalette.open')?.defaultLabel).toBe('Option+K');
        expect(model.commandRows.find((row) => row.commandId === 'session.new')?.defaultLabel).toBe('Option+N');
        expect(model.commandRows.find((row) => row.commandId === 'session.mru.next')?.defaultLabel).toBe('Option+PageDown');
        expect(model.commandRows.find((row) => row.commandId === 'mode.cycle')?.defaultLabel).toBe('Option+Shift+M');
        expect(model.commandRows.find((row) => row.commandId === 'composer.abortConfirm')?.defaultLabel).toBe('Cmd+.');
        expect(model.conflicts).toEqual([]);
    });

    it('uses the legacy command palette setting as the command palette shortcut enable state', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                commandPaletteEnabled: false,
            },
            platform: 'macos',
            surface: 'native',
        });

        expect(model.commandRows.find((row) => row.commandId === 'commandPalette.open')?.disabled).toBe(true);
        expect(model.conflicts.some((conflict) => conflict.commandIds.includes('commandPalette.open'))).toBe(false);
    });

    it('detects duplicate override bindings without exposing raw binding values', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: {
                    'commandPalette.open': [{ binding: 'Mod+K' }],
                    'session.new': [{ binding: 'Mod+K' }],
                },
            },
            platform: 'windows',
            surface: 'native',
        });

        expect(model.conflicts).toEqual([
            {
                id: 'duplicate:commandPalette.open:session.new',
                kind: 'duplicate',
                commandIds: ['commandPalette.open', 'session.new'],
            },
        ]);
    });

    it('does not report duplicates for bindings isolated to different shortcut scopes', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: {
                    'session.visible.next': [{ binding: 'Alt+ArrowDown', conflictScope: 'sessionNavigation' }],
                    'splitCanvas.focusDown': [{ binding: 'Alt+ArrowDown', conflictScope: 'splitCanvas' }],
                },
            },
            platform: 'macos',
            surface: 'native',
        });

        expect(model.conflicts).toEqual([]);
    });

    it('still reports duplicates within the same shortcut scope', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: {
                    'splitCanvas.focusDown': [{ binding: 'Alt+ArrowDown', conflictScope: 'splitCanvas' }],
                    'splitCanvas.focusUp': [{ binding: 'Alt+ArrowDown', conflictScope: 'splitCanvas' }],
                },
            },
            platform: 'macos',
            surface: 'native',
        });

        expect(model.conflicts).toEqual([
            {
                id: 'duplicate:splitCanvas.focusDown:splitCanvas.focusUp',
                kind: 'duplicate',
                commandIds: ['splitCanvas.focusDown', 'splitCanvas.focusUp'],
            },
        ]);
    });

    it('detects browser-reserved conflicts by semantic binding equivalence', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: {
                    'commandPalette.open': [{ binding: 'Command+K' }],
                    'session.new': [{ binding: 'Command+Shift+N' }],
                },
            },
            platform: 'macos',
            surface: 'web',
        });

        expect(model.conflicts).toEqual([
            {
                id: 'browser-reserved:commandPalette.open',
                kind: 'browser-reserved',
                commandIds: ['commandPalette.open'],
            },
            {
                id: 'browser-reserved:session.new',
                kind: 'browser-reserved',
                commandIds: ['session.new'],
            },
        ]);
    });

    it('builds disable and reset deltas without touching unrelated commands', () => {
        expect(buildKeyboardShortcutToggleDelta(['commandPalette.open'], 'session.new', true)).toEqual({
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', 'session.new'],
        });
        expect(buildKeyboardShortcutToggleDelta(['commandPalette.open', 'session.new'], 'commandPalette.open', false)).toEqual({
            keyboardShortcutDisabledCommandIdsV1: ['session.new'],
            commandPaletteEnabled: true,
        });

        expect(buildKeyboardShortcutResetDelta({
            disabledCommandIds: ['commandPalette.open', 'session.new'],
            overrides: {
                'commandPalette.open': [{ binding: 'Mod+K' }],
                'session.new': [{ binding: 'Mod+Shift+N' }],
            },
            commandId: 'commandPalette.open',
        })).toEqual({
            keyboardShortcutDisabledCommandIdsV1: ['session.new'],
            commandPaletteEnabled: true,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+Shift+N' }],
            },
        });
    });

    it('builds set deltas that store a validated override and re-enable the command', () => {
        expect(buildKeyboardShortcutSetDelta({
            disabledCommandIds: ['commandPalette.open', 'session.new'],
            overrides: {
                'session.new': [{ binding: 'Mod+Shift+N' }],
            },
            commandId: 'session.new',
            binding: ' Alt+S ',
        })).toEqual({
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Alt+S' }],
            },
        });

        expect(buildKeyboardShortcutSetDelta({
            disabledCommandIds: ['commandPalette.open'],
            overrides: {},
            commandId: 'commandPalette.open',
            binding: 'Mod+',
        })).toBeNull();
    });
});
