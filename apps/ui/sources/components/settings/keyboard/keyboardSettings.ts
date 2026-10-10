import { defineSettingsPage, type SettingRef, type SettingsPageDeclaration, type SettingsSectionDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { defaultKeyboardCommands } from '@/keyboard/commands';
import type { KeyboardCommandId } from '@/keyboard/types';
import type { TranslationKeyNoParams } from '@/text';

import {
    KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER,
    resolveKeyboardShortcutCommandGroupId,
    type KeyboardShortcutCommandGroupId,
} from './keyboardShortcutsSettingsModel';

import { commandStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

export const KEYBOARD_COMMAND_GROUP_TITLE_KEYS: Readonly<Record<KeyboardShortcutCommandGroupId, TranslationKeyNoParams>> = {
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
            .map((command) => [command.id, { storage: commandStorage(command.id) }])),
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
    return settings[commandId];
}
