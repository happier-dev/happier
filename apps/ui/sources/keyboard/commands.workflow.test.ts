import { describe, expect, it, vi } from 'vitest';

import { buildKeyboardShortcutSettingsModel } from '@/components/settings/keyboard/keyboardShortcutsSettingsModel';
import type { Settings } from '@/sync/domains/settings/settings';

import { browserShortcutConflicts, keybindingRulesAreSemanticallyEqual } from './bindings';
import { defaultKeyboardCommands, getDefaultKeybinding, getKeyboardCommandSettingsTitleKey } from './commands';
import { createKeyboardShortcutDispatcher, isKeybindingRuleAvailable } from './runtime';
import type { KeyboardShortcutHandlers } from './runtime';
import type { KeyboardCommandId, KeyboardSurface, KeybindingRule, NormalizedKeyboardEvent } from './types';

const baseEvent: NormalizedKeyboardEvent = {
    key: '',
    code: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
};

const modEnter: NormalizedKeyboardEvent = { ...baseEvent, key: 'Enter', code: 'Enter', metaKey: true };
const modS: NormalizedKeyboardEvent = { ...baseEvent, key: 's', code: 'KeyS', metaKey: true };
const altS: NormalizedKeyboardEvent = { ...baseEvent, key: 's', code: 'KeyS', altKey: true };

function dispatchWith(params: Readonly<{
    handlers: KeyboardShortcutHandlers;
    surface: KeyboardSurface;
    event: NormalizedKeyboardEvent;
    isEditableTarget?: boolean;
    isComposing?: boolean;
}>): boolean {
    const dispatch = createKeyboardShortcutDispatcher({
        platform: 'macos',
        surface: params.surface,
        singleKeyShortcutsEnabled: false,
        disabledCommandIds: [],
        overrides: {},
        handlers: params.handlers,
        getContext: () => ({
            isEditableTarget: params.isEditableTarget === true,
            isComposing: params.isComposing === true,
        }),
    });
    return dispatch(params.event);
}

function catalogBindings(commandId: KeyboardCommandId): readonly KeybindingRule[] {
    const command = defaultKeyboardCommands.find((entry) => entry.id === commandId);
    return command?.defaultBindings ?? (command?.defaultBinding ? [command.defaultBinding] : []);
}

function availableBindings(commandId: KeyboardCommandId, surface: KeyboardSurface): readonly KeybindingRule[] {
    return catalogBindings(commandId).filter((rule) => isKeybindingRuleAvailable(rule, {
        platform: 'macos',
        surface,
        singleKeyShortcutsEnabled: false,
    }));
}

const baseSettings = {
    keyboardSingleKeyShortcutsEnabled: false,
    keyboardShortcutDisabledCommandIdsV1: [],
    keyboardShortcutOverridesV1: {},
} as Pick<
    Settings,
    | 'keyboardSingleKeyShortcutsEnabled'
    | 'keyboardShortcutDisabledCommandIdsV1'
    | 'keyboardShortcutOverridesV1'
>;

describe('workflow authoring keyboard commands', () => {
    it('registers save and run in the canonical command catalog', () => {
        expect(getDefaultKeybinding('workflow.save')).toBeDefined();
        expect(getDefaultKeybinding('workflow.run')).toBeDefined();
        expect(getKeyboardCommandSettingsTitleKey('workflow.save')).toBe('settingsKeyboard.commands.workflowSave');
        expect(getKeyboardCommandSettingsTitleKey('workflow.run')).toBe('settingsKeyboard.commands.workflowRun');
    });

    it('runs the workflow from Mod+Enter while the caret is inside an editor field', () => {
        const run = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.run': run },
            surface: 'native',
            event: modEnter,
            isEditableTarget: true,
        })).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not run the workflow for an IME composition or an auto-repeated key', () => {
        const composingRun = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.run': composingRun },
            surface: 'native',
            event: { ...modEnter, isComposing: true },
            isEditableTarget: true,
        })).toBe(false);
        expect(composingRun).not.toHaveBeenCalled();

        const repeatRun = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.run': repeatRun },
            surface: 'native',
            event: { ...modEnter, repeat: true },
            isEditableTarget: true,
        })).toBe(false);
        expect(repeatRun).not.toHaveBeenCalled();
    });

    it('saves from Mod+S on native but yields Mod+S to the host browser on web', () => {
        const nativeSave = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.save': nativeSave },
            surface: 'native',
            event: modS,
            isEditableTarget: true,
        })).toBe(true);
        expect(nativeSave).toHaveBeenCalledTimes(1);

        const webModSave = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.save': webModSave },
            surface: 'web',
            event: modS,
            isEditableTarget: true,
        })).toBe(false);
        expect(webModSave).not.toHaveBeenCalled();

        const webAltSave = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.save': webAltSave },
            surface: 'web',
            event: altS,
            isEditableTarget: true,
        })).toBe(true);
        expect(webAltSave).toHaveBeenCalledTimes(1);

        const nativeAltSave = vi.fn();
        expect(dispatchWith({
            handlers: { 'workflow.save': nativeAltSave },
            surface: 'native',
            event: altS,
            isEditableTarget: true,
        })).toBe(false);
        expect(nativeAltSave).not.toHaveBeenCalled();
    });

    it('keeps exactly one save binding reachable per surface and none of them browser-reserved', () => {
        expect(availableBindings('workflow.save', 'native')).toHaveLength(1);
        const webBindings = availableBindings('workflow.save', 'web');
        expect(webBindings).toHaveLength(1);
        for (const rule of webBindings) {
            expect(browserShortcutConflicts.some((entry) => (
                entry.platforms.includes('web')
                && keybindingRulesAreSemanticallyEqual(rule, entry.binding, 'macos')
            )), `${rule.binding} must not be a browser-reserved web shortcut`).toBe(false);
        }
    });

    it('does not report workflow.run and composer.sendImmediate as a duplicate binding', () => {
        for (const surface of ['native', 'web'] as const) {
            const model = buildKeyboardShortcutSettingsModel({
                settings: baseSettings,
                platform: 'macos',
                surface,
            });
            const workflowConflicts = model.conflicts.filter((conflict) => (
                conflict.commandIds.some((commandId) => commandId.startsWith('workflow.'))
            ));
            expect(workflowConflicts, `unexpected workflow conflicts on ${surface}`).toEqual([]);
        }
    });

    it('still reports a genuine duplicate at the same conflict scope', () => {
        const model = buildKeyboardShortcutSettingsModel({
            settings: {
                ...baseSettings,
                keyboardShortcutOverridesV1: { 'composer.focus': [{ binding: 'Mod+Enter' }] },
            },
            platform: 'macos',
            surface: 'native',
        });

        expect(model.conflicts).toContainEqual({
            id: 'duplicate:composer.focus:composer.sendImmediate',
            kind: 'duplicate',
            commandIds: ['composer.focus', 'composer.sendImmediate'],
        });
    });
});
