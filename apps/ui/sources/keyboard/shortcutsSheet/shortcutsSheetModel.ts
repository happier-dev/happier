import { Platform } from 'react-native';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER, resolveKeyboardShortcutCommandGroupId, type KeyboardShortcutCommandGroupId } from '@/components/settings/keyboard/keyboardShortcutsSettingsModel';
import { resolveKeyboardCommands } from '../commands';
import { buildKeyboardShortcutLabels } from '../runtime';
import type { KeyboardCommand, KeyboardCommandId, KeyboardCommandSettingsTitleKey, KeyboardPlatform, KeyboardSurface, KeyboardWebHost, KeybindingRule } from '../types';

export type ShortcutsSheetRow = Readonly<{ commandId: KeyboardCommandId; titleKey: KeyboardCommandSettingsTitleKey; title?: string; label?: string }>;
export type ShortcutsSheetModel = Readonly<{
    host: KeyboardWebHost;
    groups: readonly Readonly<{ id: KeyboardShortcutCommandGroupId; rows: readonly ShortcutsSheetRow[] }>[];
}>;

/** Both sheet segments share the command catalog, grouping and binding policy used by Settings. */
export function buildShortcutsSheetModel(options: Readonly<{
    commands?: readonly KeyboardCommand[];
    platform: KeyboardPlatform;
    surface?: KeyboardSurface;
    host?: KeyboardWebHost;
    singleKeyShortcutsEnabled: boolean;
    disabledCommandIds?: readonly string[];
    overrides?: Readonly<Record<string, readonly KeybindingRule[]>>;
}>): ShortcutsSheetModel {
    const currentSurface = options.surface ?? (Platform.OS === 'web' ? 'web' : 'native');
    const host = options.host ?? (currentSurface === 'web' && !isDesktopHost() ? 'browser' : 'desktop');
    const surface = host === 'browser' ? 'web' : currentSurface;
    const commands = options.commands ?? resolveKeyboardCommands(options.overrides);
    const labels = buildKeyboardShortcutLabels(options.platform, surface, {
        webHost: host,
        singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
        disabledCommandIds: options.disabledCommandIds,
        overrides: options.overrides,
    });
    return {
        host,
        groups: KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER.map(id => ({ id,
            rows: commands.filter(command => resolveKeyboardShortcutCommandGroupId(command.id) === id)
                .map(command => ({ commandId: command.id, titleKey: command.settingsTitleKey, title: command.settingsTitle, label: labels[command.id] })),
        })).filter(group => group.rows.length > 0),
    };
}
