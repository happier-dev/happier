import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import type { KeyboardCommandId } from '@/keyboard/types';
import { Modal } from '@/modal';
import { useSettings } from '@/sync/domains/state/storage';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import {
    buildKeyboardShortcutResetDelta,
    buildKeyboardShortcutSetDelta,
    buildKeyboardShortcutSettingsModel,
    buildKeyboardShortcutToggleDelta,
} from './keyboardShortcutsSettingsModel';
import { showKeyboardShortcutCapturePrompt } from './showKeyboardShortcutCapturePrompt';
import { Icon } from '@/components/ui/icons/Icon';

export const KeyboardShortcutsSettingsView = React.memo(function KeyboardShortcutsSettingsView() {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const applySettings = useApplySettings();
    const platform = React.useMemo(() => resolveKeyboardPlatform(), []);
    const surface = Platform.OS === 'web' ? 'web' : 'native';
    const model = React.useMemo(() => buildKeyboardShortcutSettingsModel({
        settings: settings,
        platform,
        surface,
    }), [settings, platform, surface]);

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

    return (
        <ItemList testID="settings-keyboard-shortcuts-screen" style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsKeyboard.generalGroupTitle')}
                footer={t('settingsKeyboard.generalGroupFooter')}
            >
                <Item
                    testID="settings-keyboard-shortcuts-enabled-row"
                    title={t('settingsKeyboard.enableShortcutsTitle')}
                    subtitle={t('settingsKeyboard.enableShortcutsSubtitle')}
                    icon={<Icon name="squares-four" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            testID="settings-keyboard-shortcuts-enabled"
                            value={model.shortcutsEnabled}
                            onValueChange={(value) => applySettings({ keyboardShortcutsV2Enabled: value })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    testID="settings-keyboard-shortcuts-single-key-enabled-row"
                    title={t('settingsKeyboard.singleKeyTitle')}
                    subtitle={t('settingsKeyboard.singleKeySubtitle')}
                    icon={<Icon name="question" size={29} color={theme.colors.accent.orange} />}
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

            {model.conflicts.length > 0 ? (
                <ItemGroup title={t('settingsKeyboard.conflictsGroupTitle')}>
                    <Item
                        testID="settings-keyboard-shortcuts-conflicts"
                        title={t('settingsKeyboard.conflictsTitle', { count: model.conflicts.length })}
                        subtitle={t('settingsKeyboard.conflictsSubtitle', { count: model.conflicts.length })}
                        icon={<Icon name="warning" size={29} color={theme.colors.state.warning.foreground} />}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsKeyboard.commandsGroupTitle')}
                footer={t('settingsKeyboard.commandsGroupFooter')}
            >
                {model.commandRows.map((row) => (
                    <Item
                        key={row.commandId}
                        testID={`settings-keyboard-shortcut-row-${row.commandId}`}
                        title={t(row.titleKey)}
                        subtitle={row.defaultLabel ?? t('settingsKeyboard.noDefaultShortcut')}
                        icon={<Icon name="radio-button" size={29} color={theme.colors.text.secondary} />}
                        rightElement={(
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Pressable
                                    testID={`settings-keyboard-shortcut-set-${row.commandId}`}
                                    onPress={() => {
                                        void setCommandShortcut(row.commandId, t(row.titleKey), row.bindingValue);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('settingsKeyboard.setCommandAccessibility', {
                                        command: t(row.titleKey),
                                    })}
                                    style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                                >
                                    <Text style={{ color: theme.colors.button.secondary.tint }}>
                                        {t('settingsKeyboard.setCommandButton')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    testID={`settings-keyboard-shortcut-reset-${row.commandId}`}
                                    onPress={() => resetCommand(row.commandId)}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('settingsKeyboard.resetCommandAccessibility', {
                                        command: t(row.titleKey),
                                    })}
                                    style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                                >
                                    <Text style={{ color: theme.colors.button.secondary.tint }}>
                                        {t('common.reset')}
                                    </Text>
                                </Pressable>
                                <Switch
                                    testID={`settings-keyboard-shortcut-enabled-${row.commandId}`}
                                    value={!row.disabled}
                                    onValueChange={(enabled) => setCommandEnabled(row.commandId, enabled)}
                                />
                            </View>
                        )}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});
