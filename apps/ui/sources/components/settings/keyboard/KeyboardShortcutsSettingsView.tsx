import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyCombinationHint } from '@/components/ui/keyboard/KeyHint';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import type { KeyboardCommandId } from '@/keyboard/types';
import { resolveKeyboardCommands } from '@/keyboard/commands';
import { usePluginKeyboardCommands } from '@/keyboard/usePluginKeyboardCommands';
import { Modal } from '@/modal';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTING_ANCHOR_QUERY_PARAM, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, useRequestedSettingAnchor } from '@/components/settings/shell/SettingRow';
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';

import {
    buildKeyboardShortcutSetDelta,
    buildKeyboardShortcutSettingsModel,
    type KeyboardShortcutSettingsCommandRow,
    type KeyboardShortcutSettingsConflict,
} from './keyboardShortcutsSettingsModel';
import { KEYBOARD_COMMAND_GROUP_TITLE_KEYS, KEYBOARD_SETTINGS, getPluginKeyboardSettingsDeclarations } from './keyboardSettings';
import { showKeyboardShortcutCapturePrompt } from './showKeyboardShortcutCapturePrompt';

export const KeyboardShortcutsSettingsView = React.memo(function KeyboardShortcutsSettingsView() {
    const { theme } = useUnistyles();
    const settings = useSettingsSelector((settings) => ({
        keyboardSingleKeyShortcutsEnabled: settings.keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutDisabledCommandIdsV1: settings.keyboardShortcutDisabledCommandIdsV1,
        keyboardShortcutOverridesV1: settings.keyboardShortcutOverridesV1,
    }), ["keyboardSingleKeyShortcutsEnabled","keyboardShortcutDisabledCommandIdsV1","keyboardShortcutOverridesV1"]);
    const { setSetting } = useSettingActionFeedback();
    const reducedMotion = useReducedMotionPreference();
    const platform = React.useMemo(() => resolveKeyboardPlatform(), []);
    const surface = Platform.OS === 'web' ? 'web' : 'native';
    const pluginCommands = usePluginKeyboardCommands();
    const commands = React.useMemo(() => resolveKeyboardCommands(settings.keyboardShortcutOverridesV1, pluginCommands), [settings.keyboardShortcutOverridesV1, pluginCommands]);
    const commandSettings: Readonly<Record<string, SettingRef>> = React.useMemo(() => Object.assign({}, KEYBOARD_SETTINGS.settings,
        ...getPluginKeyboardSettingsDeclarations(commands).map(declaration => declaration.settings)), [commands]);
    const model = React.useMemo(() => buildKeyboardShortcutSettingsModel({
        commands,
        settings: settings,
        platform,
        surface,
    }), [settings, platform, surface, commands]);
    const [expandedCommandId, setExpandedCommandId] = React.useState<KeyboardCommandId | null>(null);
    const requestedAnchor = useRequestedSettingAnchor();
    // Each command group's place before it is measured: its rows at the compact list row's minimum height.
    const rowMinHeight = usePageRowMetrics('list').minHeightPx;
    const groupLowerBounds = React.useMemo(() => {
        let top = 0;
        return model.commandGroups.map((group) => {
            const bound = { top, height: group.rows.length * rowMinHeight };
            top += bound.height;
            return bound;
        });
    }, [model.commandGroups, rowMinHeight]);

    const commandTitleById = React.useMemo(() => new Map(
        model.commandRows.map((row) => [row.commandId, row.title ?? t(row.titleKey)] as const),
    ), [model.commandRows]);

    const setCommandEnabled = React.useCallback((commandId: KeyboardCommandId, enabled: boolean) => {
        const setting = commandSettings[commandId];
        if (setting) void setSetting(setting, { enabled });
    }, [setSetting, commandSettings]);

    const resetCommand = React.useCallback((commandId: KeyboardCommandId) => {
        const setting = commandSettings[commandId];
        if (setting) void setSetting(setting, { enabled: true, binding: null });
    }, [setSetting, commandSettings]);

    const setCommandShortcut = React.useCallback(async (commandId: KeyboardCommandId, commandTitle: string, currentBinding: string | null) => {
        const nextBinding = await showKeyboardShortcutCapturePrompt({
            title: t('settingsKeyboard.setShortcutPromptTitle', { command: commandTitle }),
            message: t('settingsKeyboard.setShortcutPromptMessage'),
            defaultValue: currentBinding ?? '',
            placeholder: t('settingsKeyboard.setShortcutPromptPlaceholder'),
            platform,
        });
        if (nextBinding == null) return;
        const delta = buildKeyboardShortcutSetDelta({
            disabledCommandIds: settings.keyboardShortcutDisabledCommandIdsV1,
            overrides: settings.keyboardShortcutOverridesV1,
            commandId,
            binding: nextBinding,
        });
        if (!delta) {
            await Modal.alertAsync(
                t('settingsKeyboard.setShortcutInvalidTitle'),
                t('settingsKeyboard.setShortcutInvalidMessage'),
            );
            return;
        }
        const setting = commandSettings[commandId];
        if (setting) await setSetting(setting, { enabled: true, binding: nextBinding.trim() });
    }, [
        setSetting,
        settings.keyboardShortcutDisabledCommandIdsV1,
        settings.keyboardShortcutOverridesV1,
        platform,
        commandSettings,
    ]);

    // A conflict opens the command it names: the row expands and its search anchor scrolls it into
    // view and pulses it (the same reveal search uses), so the row is never left off screen.
    const router = useRouter();
    const revealCommand = React.useCallback((commandId: KeyboardCommandId | null) => {
        setExpandedCommandId(commandId);
        const setting = commandId ? commandSettings[commandId] : undefined;
        if (setting) router.setParams({ [SETTING_ANCHOR_QUERY_PARAM]: setting.anchor });
    }, [router, commandSettings]);

    const conflictTitle = React.useCallback((conflict: KeyboardShortcutSettingsConflict) => (
        conflict.commandIds.map((commandId) => commandTitleById.get(commandId) ?? commandId).join(' · ')
    ), [commandTitleById]);

    return (
        <ItemList testID="settings-keyboard-shortcuts-screen" style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsKeyboard.entrySubtitle')} />
            <ItemGroup
                title={t('settingsKeyboard.generalGroupTitle')}
                description={t('settingsKeyboard.generalGroupFooter')}
            >
                <SettingRow
                    testID="settings-keyboard-shortcuts-single-key-enabled-row"
                    setting={KEYBOARD_SETTINGS.settings.singleKey}
                    rightElement={(
                        <Switch
                            testID="settings-keyboard-shortcuts-single-key-enabled"
                            value={model.singleKeyShortcutsEnabled}
                            onValueChange={(value) => { void setSetting(KEYBOARD_SETTINGS.settings.singleKey, value); }}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Conflicts block shortcuts, so they come before the commands, each naming what clashes. */}
            {model.conflicts.length > 0 ? (
                <ItemGroup
                    title={t('settingsKeyboard.conflictsGroupTitle')}
                    description={t('settingsKeyboard.conflictsSubtitle', { count: model.conflicts.length })}
                >
                    {model.conflicts.map((conflict) => (
                        <Item
                            key={conflict.id}
                            testID={`settings-keyboard-shortcuts-conflict-${conflict.id}`}
                            title={conflictTitle(conflict)}
                            subtitle={conflict.kind === 'browser-reserved'
                                ? t('settingsKeyboard.conflictBrowserReserved')
                                : t('settingsKeyboard.conflictDuplicate')}
                            subtitleLines={0}
                            icon={<Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} />}
                            onPress={() => revealCommand(conflict.commandIds[0] ?? null)}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {model.commandGroups.map((group, index) => (
                <NearViewportWindow
                    key={group.id}
                    id={group.id}
                    testID={`settings-keyboard-group-window-${group.id}`}
                    estimatedTop={groupLowerBounds[index]!.top}
                    estimatedHeight={groupLowerBounds[index]!.height}
                    pinned={group.rows.some((row) => row.commandId === expandedCommandId
                        || (requestedAnchor !== null && commandSettings[row.commandId]?.anchor === requestedAnchor))}
                >
                    <ItemGroup title={t(KEYBOARD_COMMAND_GROUP_TITLE_KEYS[group.id])} density="compact">
                        {group.rows.map((row) => (
                            <KeyboardShortcutCommandRow
                                key={row.commandId}
                                row={row}
                                setting={commandSettings[row.commandId]}
                                expanded={expandedCommandId === row.commandId}
                                reducedMotion={reducedMotion}
                                onExpandedChange={(next) => setExpandedCommandId(next ? row.commandId : null)}
                                onEnabledChange={setCommandEnabled}
                                onReset={resetCommand}
                                onChangeShortcut={setCommandShortcut}
                            />
                        ))}
                    </ItemGroup>
                </NearViewportWindow>
            ))}
        </ItemList>
    );
});

/**
 * One command, expanded in place: closed it shows its keys (or Off); open it holds the three things
 * a command has — whether it is on, its keys, and a way back to the default.
 */
const KeyboardShortcutCommandRow = React.memo(function KeyboardShortcutCommandRow(props: Readonly<{
    setting: SettingRef | undefined;
    row: KeyboardShortcutSettingsCommandRow;
    expanded: boolean;
    reducedMotion: boolean;
    showDivider?: boolean;
    onExpandedChange: (next: boolean) => void;
    onEnabledChange: (commandId: KeyboardCommandId, enabled: boolean) => void;
    onReset: (commandId: KeyboardCommandId) => void;
    onChangeShortcut: (commandId: KeyboardCommandId, commandTitle: string, currentBinding: string | null) => Promise<void>;
}>) {
    const { row } = props;
    const title = row.title ?? t(row.titleKey);
    const setting = props.setting;
    // Closed, the row says what the command does now: its keys, Off, or that it has none.
    const keys = !row.disabled && row.defaultLabel
        ? <KeyCombinationHint label={row.defaultLabel} testID={`settings-keyboard-shortcut-keys-${row.commandId}`} />
        : undefined;
    const summaryText = row.disabled
        ? t('settingsKeyboard.commandOff')
        : row.defaultLabel ? undefined : t('settingsKeyboard.noShortcut');

    const disclosure = (
        <ExpandableItem
            expanded={props.expanded}
            onExpandedChange={props.onExpandedChange}
            reducedMotion={props.reducedMotion}
            showDivider={props.showDivider}
            header={({ headerProps }) => (
                <Item
                    {...headerProps}
                    testID={`settings-keyboard-shortcut-row-${row.commandId}`}
                    title={title}
                    subtitle={row.hasOverride ? t('settingsKeyboard.customShortcut') : undefined}
                    rightElement={keys}
                    detail={summaryText}
                    keepChevronWithRightElement
                />
            )}
        >
            <Item
                title={t('settingsKeyboard.commandEnabledTitle')}
                rightElement={(
                    <Switch
                        testID={`settings-keyboard-shortcut-enabled-${row.commandId}`}
                        value={!row.disabled}
                        onValueChange={(enabled) => props.onEnabledChange(row.commandId, enabled)}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsKeyboard.keysTitle')}
                subtitle={row.defaultLabel ?? t('settingsKeyboard.noShortcut')}
                rightElement={(
                    <RoundButton
                        testID={`settings-keyboard-shortcut-set-${row.commandId}`}
                        size="small"
                        display="secondary"
                        title={t('settingsKeyboard.setCommandButton')}
                        accessibilityLabel={t('settingsKeyboard.setCommandAccessibility', { command: title })}
                        onPress={() => { void props.onChangeShortcut(row.commandId, title, row.bindingValue); }}
                    />
                )}
                showChevron={false}
            />
            {row.hasOverride || row.disabled ? (
                <Item
                    testID={`settings-keyboard-shortcut-reset-${row.commandId}`}
                    title={t('settingsKeyboard.resetToDefaultTitle')}
                    subtitle={row.registryDefaultLabel ?? t('settingsKeyboard.noDefaultShortcut')}
                    accessibilityLabel={t('settingsKeyboard.resetCommandAccessibility', { command: title })}
                    accessibilityRole="button"
                    onPress={() => props.onReset(row.commandId)}
                    showChevron={false}
                />
            ) : null}
        </ExpandableItem>
    );

    return setting ? <SettingAnchor setting={setting} showDivider={props.showDivider}>{disclosure}</SettingAnchor> : disclosure;
});
