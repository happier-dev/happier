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

// These cases exercise user overrides, not collisions between unrelated
// registry defaults (the browser and composer both declare a Ctrl+R variant).
const isolatedOverrideSettings = {
    ...baseSettings,
    keyboardShortcutDisabledCommandIdsV1: ['browser.reload', 'composer.prompts.open'],
};

describe('keyboardShortcutsSettingsModel', () => {
    it('does not report a command’s host-specific alternative defaults as a conflict with itself', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: baseSettings,
            platform: 'macos',
            surface: 'native',
        });

        expect(model.conflicts.filter((conflict) => conflict.commandIds.every(
            (commandId) => commandId === 'composer.prompts.open',
        ))).toEqual([]);
    });

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
        expect(model.commandRows.find((row) => row.commandId === 'settings.open')?.defaultLabel).toBe('Cmd+,');
        expect(model.commandRows.every((row) => row.titleKey.startsWith('settingsKeyboard.commands.'))).toBe(true);
    });

    it('groups every command once, by the part of the app it acts on, in reading order', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: baseSettings,
            platform: 'macos',
            surface: 'native',
        });

        expect(model.commandGroups.map((group) => group.id)).toEqual([
            'general', 'sessions', 'composer', 'transcript', 'splitView', 'browser',
        ]);
        const groupOf = (commandId: string) => model.commandGroups
            .find((group) => group.rows.some((row) => row.commandId === commandId))?.id;
        expect(groupOf('commandPalette.open')).toBe('general');
        expect(groupOf('workflow.run')).toBe('general');
        expect(groupOf('session.new')).toBe('sessions');
        expect(groupOf('sessions.selection.clear')).toBe('sessions');
        expect(groupOf('permission.cycle')).toBe('composer');
        expect(groupOf('transcript.scroll.top')).toBe('transcript');
        expect(groupOf('workspace.splitRight')).toBe('splitView');
        expect(groupOf('browser.reload')).toBe('browser');
        const grouped = model.commandGroups.flatMap((group) => group.rows.map((row) => row.commandId));
        expect([...grouped].sort()).toEqual(model.commandRows.map((row) => row.commandId).sort());
    });

    it('keeps the registry default beside a custom shortcut so the row can say what reset restores', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: { 'commandPalette.open': [{ binding: 'Alt+P' }] },
            },
            platform: 'macos',
            surface: 'native',
        });

        const row = model.commandRows.find((entry) => entry.commandId === 'commandPalette.open');
        expect(row?.defaultLabel).toBe('Option+P');
        expect(row?.registryDefaultLabel).toBe('Cmd+K');
        expect(row?.hasOverride).toBe(true);
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

    it('keeps web-safe defaults and reports browser conflicts for the workspace tab chords', () => {
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
        expect(model.commandRows.find((row) => row.commandId === 'workspace.tab.new')?.defaultLabel).toBe('Cmd+T');
        expect(model.commandRows.find((row) => row.commandId === 'workspace.tab.close')?.defaultLabel).toBe('Cmd+W');
        expect(model.conflicts).toEqual([
            { id: 'browser-reserved:workspace.tab.new', kind: 'browser-reserved', commandIds: ['workspace.tab.new'] },
            { id: 'browser-reserved:workspace.tab.close', kind: 'browser-reserved', commandIds: ['workspace.tab.close'] },
        ]);
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
                ...isolatedOverrideSettings,
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
                ...isolatedOverrideSettings,
                keyboardShortcutOverridesV1: {
                    'session.visible.next': [{ binding: 'Alt+ArrowDown', conflictScope: 'sessionNavigation' }],
                    'workspace.focusDown': [{ binding: 'Alt+ArrowDown', conflictScope: 'workspace' }],
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
                ...isolatedOverrideSettings,
                keyboardShortcutOverridesV1: {
                    'workspace.focusDown': [{ binding: 'Alt+ArrowDown', conflictScope: 'workspace' }],
                    'workspace.focusUp': [{ binding: 'Alt+ArrowDown', conflictScope: 'workspace' }],
                },
            },
            platform: 'macos',
            surface: 'native',
        });

        expect(model.conflicts).toEqual([
            {
                id: 'duplicate:workspace.focusDown:workspace.focusUp',
                kind: 'duplicate',
                commandIds: ['workspace.focusDown', 'workspace.focusUp'],
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
            { id: 'browser-reserved:workspace.tab.new', kind: 'browser-reserved', commandIds: ['workspace.tab.new'] },
            { id: 'browser-reserved:workspace.tab.close', kind: 'browser-reserved', commandIds: ['workspace.tab.close'] },
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
