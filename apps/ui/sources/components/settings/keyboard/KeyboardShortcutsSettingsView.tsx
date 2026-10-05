import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { splitKeybindingLabel } from '@/keyboard/shortcutLabels';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import type { KeyboardCommandId } from '@/keyboard/types';
import { Modal } from '@/modal';
import { useSettings } from '@/sync/domains/state/storage';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTING_ANCHOR_QUERY_PARAM } from '@/components/settings/catalog/settingDeclarations';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';

import {
    buildKeyboardShortcutResetDelta,
    buildKeyboardShortcutSetDelta,
    buildKeyboardShortcutSettingsModel,
    buildKeyboardShortcutToggleDelta,
    type KeyboardShortcutSettingsCommandRow,
    type KeyboardShortcutSettingsConflict,
} from './keyboardShortcutsSettingsModel';
import { KEYBOARD_COMMAND_GROUP_TITLE_KEYS, KEYBOARD_SETTINGS, resolveKeyboardCommandSetting } from './keyboardSettings';
import { showKeyboardShortcutCapturePrompt } from './showKeyboardShortcutCapturePrompt';

const Keycaps = React.memo(function Keycaps(props: Readonly<{ label: string; testID?: string }>) {
    return (
        <View style={styles.keycaps} testID={props.testID} accessibilityLabel={props.label}>
            {splitKeybindingLabel(props.label).map((key, index) => <KeyHint key={`${key}-${index}`} label={key} />)}
        </View>
    );
});

export const KeyboardShortcutsSettingsView = React.memo(function KeyboardShortcutsSettingsView() {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const applySettings = useApplySettings();
    const reducedMotion = useReducedMotionPreference();
    const platform = React.useMemo(() => resolveKeyboardPlatform(), []);
    const surface = Platform.OS === 'web' ? 'web' : 'native';
    const model = React.useMemo(() => buildKeyboardShortcutSettingsModel({
        settings: settings,
        platform,
        surface,
    }), [settings, platform, surface]);
    const [expandedCommandId, setExpandedCommandId] = React.useState<KeyboardCommandId | null>(null);

    const commandTitleById = React.useMemo(() => new Map(
        model.commandRows.map((row) => [row.commandId, t(row.titleKey)] as const),
    ), [model.commandRows]);

    const setCommandEnabled = React.useCallback((commandId: KeyboardCommandId, enabled: boolean) => {
        applySettings(buildKeyboardShortcutToggleDelta(
            settings.keyboardShortcutDisabledCommandIdsV1,
            commandId,
            !enabled,
        ));
    }, [applySettings, settings.keyboardShortcutDisabledCommandIdsV1]);

    const resetCommand = React.useCallback((commandId: KeyboardCommandId) => {
        applySettings(buildKeyboardShortcutResetDelta({
            disabledCommandIds: settings.keyboardShortcutDisabledCommandIdsV1,
            overrides: settings.keyboardShortcutOverridesV1,
            commandId,
        }));
    }, [
        applySettings,
        settings.keyboardShortcutDisabledCommandIdsV1,
        settings.keyboardShortcutOverridesV1,
    ]);

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
        applySettings(delta);
    }, [
        applySettings,
        settings.keyboardShortcutDisabledCommandIdsV1,
        settings.keyboardShortcutOverridesV1,
        platform,
    ]);

    // A conflict opens the command it names: the row expands and its search anchor scrolls it into
    // view and pulses it (the same reveal search uses), so the row is never left off screen.
    const router = useRouter();
    const revealCommand = React.useCallback((commandId: KeyboardCommandId | null) => {
        setExpandedCommandId(commandId);
        const setting = commandId ? resolveKeyboardCommandSetting(commandId) : undefined;
        if (setting) router.setParams({ [SETTING_ANCHOR_QUERY_PARAM]: setting.anchor });
    }, [router]);

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
                    testID="settings-keyboard-shortcuts-enabled-row"
                    setting={KEYBOARD_SETTINGS.settings.enableShortcuts}
                    rightElement={(
                        <Switch
                            testID="settings-keyboard-shortcuts-enabled"
                            value={model.shortcutsEnabled}
                            onValueChange={(value) => applySettings({ keyboardShortcutsV2Enabled: value })}
                        />
                    )}
                    showChevron={false}
                />
                <SettingRow
                    testID="settings-keyboard-shortcuts-single-key-enabled-row"
                    setting={KEYBOARD_SETTINGS.settings.singleKey}
                    rightElement={(
                        <Switch
                            testID="settings-keyboard-shortcuts-single-key-enabled"
                            value={model.singleKeyShortcutsEnabled}
                            onValueChange={(value) => applySettings({ keyboardSingleKeyShortcutsEnabled: value })}
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

            {model.commandGroups.map((group) => (
                <ItemGroup key={group.id} title={t(KEYBOARD_COMMAND_GROUP_TITLE_KEYS[group.id])} density="compact">
                    {group.rows.map((row) => (
                        <KeyboardShortcutCommandRow
                            key={row.commandId}
                            row={row}
                            expanded={expandedCommandId === row.commandId}
                            reducedMotion={reducedMotion}
                            onExpandedChange={(next) => setExpandedCommandId(next ? row.commandId : null)}
                            onEnabledChange={setCommandEnabled}
                            onReset={resetCommand}
                            onChangeShortcut={setCommandShortcut}
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});

/**
 * One command, expanded in place: closed it shows its keys (or Off); open it holds the three things
 * a command has — whether it is on, its keys, and a way back to the default.
 */
const KeyboardShortcutCommandRow = React.memo(function KeyboardShortcutCommandRow(props: Readonly<{
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
    const title = t(row.titleKey);
    const setting = resolveKeyboardCommandSetting(row.commandId);
    // Closed, the row says what the command does now: its keys, Off, or that it has none.
    const keys = !row.disabled && row.defaultLabel
        ? <Keycaps label={row.defaultLabel} testID={`settings-keyboard-shortcut-keys-${row.commandId}`} />
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

const styles = StyleSheet.create(() => ({
    keycaps: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
}));
