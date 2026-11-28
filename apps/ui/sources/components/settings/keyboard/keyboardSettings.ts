import { defineSettingsPage, type SettingRef, type SettingsPageDeclaration, type SettingsSectionDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { defaultKeyboardCommands, getKeyboardCommand } from '@/keyboard/commands';
import { readPluginKeyboardCommands } from '@/keyboard/pluginCommands';
import type { KeyboardCommand, KeyboardCommandId } from '@/keyboard/types';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { TranslationKeyNoParams } from '@/text';

import {
    KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER,
    resolveKeyboardShortcutCommandGroupId,
    type KeyboardShortcutCommandGroupId,
} from './keyboardShortcutsSettingsModel';

import { commandStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

export const KEYBOARD_COMMAND_GROUP_TITLE_KEYS: Readonly<Record<KeyboardShortcutCommandGroupId, TranslationKeyNoParams>> = {
    annotate: 'settingsKeyboard.commands.annotationGroup',
    panes: 'settingsKeyboard.paneGroups.panes',
    terminal: 'settingsKeyboard.paneGroups.terminal',
    search: 'settingsKeyboard.paneGroups.search',
    files: 'settingsKeyboard.paneGroups.files',
    code: 'settingsKeyboard.paneGroups.code',
    review: 'settingsKeyboard.groupReview',
    general: 'settingsKeyboard.groupApp',
    sessions: 'settingsKeyboard.groupSessions',
    composer: 'settingsKeyboard.groupComposer',
    transcript: 'settingsKeyboard.groupTranscript',
    splitView: 'settingsKeyboard.groupSplitView',
    browser: 'settingsKeyboard.groupBrowser',
};

/** One section per command group; each command is a setting anchored by its command id. */
const commandSections: Record<string, SettingsSectionDeclaration> = Object.fromEntries(
    KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER.map((groupId) => [`commands.${groupId}`, {
        titleKey: KEYBOARD_COMMAND_GROUP_TITLE_KEYS[groupId],
        settings: Object.fromEntries(defaultKeyboardCommands
            .filter((command) => resolveKeyboardShortcutCommandGroupId(command.id) === groupId)
            .map((command) => [command.id, { storage: commandStorage(command.id), ...(command.settingsTitle ? { title: command.settingsTitle } : {}) }])),
    }]),
);

/** The searchable settings of the `keyboard` page. Rows render their labels from these declarations. */
export const KEYBOARD_SETTINGS: SettingsPageDeclaration = defineSettingsPage({
    pageId: 'keyboard',
    sections: {
        generalGroup: {
            titleKey: 'settingsKeyboard.generalGroupTitle',
            settings: {
                enableShortcuts: {},
                singleKey: {},
            },
        },
        ...commandSections,
    },
});

/** A command's declared setting (its search anchor); commands are declared from the registry above. */
export function resolveKeyboardCommandSetting(commandId: KeyboardCommandId): SettingRef | undefined {
    const settings: Readonly<Record<string, SettingRef>> = KEYBOARD_SETTINGS.settings;
    if (settings[commandId]) return settings[commandId];
    const command = readPluginKeyboardCommands().find(command => command.id === commandId) ?? getKeyboardCommand(commandId);
    return command ? getPluginKeyboardSettingsDeclarations([command])[0]?.settings[commandId] : undefined;
}

export function getPluginKeyboardSettingsDeclarations(commands: readonly KeyboardCommand[] = readPluginKeyboardCommands()): readonly SettingsPageDeclaration[] {
    const settings = Object.fromEntries(commands.flatMap(command => {
        const identity = command.id.startsWith('action:') ? parseQualifiedPluginActionId(command.id.slice('action:'.length)) : null;
        return identity ? [[command.id, { titleKey: command.settingsTitleKey, title: command.settingsTitle,
            contribution: identity, storage: commandStorage(command.id) }]] : [];
    }));
    return Object.keys(settings).length ? [defineSettingsPage({ pageId: 'keyboard', sections: {
        'commands.general': { titleKey: 'settingsKeyboard.groupApp', settings },
    } })] : [];
}
