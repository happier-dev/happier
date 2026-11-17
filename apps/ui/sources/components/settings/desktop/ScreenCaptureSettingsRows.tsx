import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyCombinationHint } from '@/components/ui/keyboard/KeyHint';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SystemPermissionRow, type SystemPermissionRowState } from '@/components/systemPermissions/SystemPermissionRow';
import { Text } from '@/components/ui/text/Text';
import type { NativeCaptureBindingKey, NativeCapturePermissionState, NativeWindowShadowPreference } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';

import { DESKTOP_SETTINGS } from './desktopSettings';
import type { CaptureSettingsRead } from './useScreenCaptureSettings';

const ACTION_HEIGHT = 32;

export type CaptureShortcutRow = Readonly<{
    status: CaptureSettingsRead<unknown>['status'];
    /** The keys that work now, already in the person's platform spelling. */
    label: string | null;
    /** What stopped a new binding, or why this platform can't bind one. */
    note: string | null;
    /** Off, the row explains and can't record (Wayland's instant window shortcut). */
    editable: boolean;
}>;

/** The Screen capture section (lab has no frame; the reference is this page). */
export function ScreenCaptureSettingsRows(props: Readonly<{
    shortcuts: Readonly<Record<NativeCaptureBindingKey, CaptureShortcutRow>>;
    sound: boolean;
    onSoundChange: (value: boolean) => void;
    includeWindowText: boolean;
    onIncludeWindowTextChange: (value: boolean) => void;
    windowShadow: NativeWindowShadowPreference | null;
    onIncludeWindowShadowChange: (value: boolean) => void;
    folder: string | null;
    onChooseFolder: () => void;
    onShowFolder: () => void;
    onRecordShortcut: (key: NativeCaptureBindingKey) => void;
    permissions: Readonly<{ screen: NativeCapturePermissionState; windowText: NativeCapturePermissionState }> | null;
    onOpenPermission: (subject: 'screen' | 'window_text') => void;
    onReopen: () => void;
    onOpenApprovals: () => void;
}>) {
    const { settings } = DESKTOP_SETTINGS;
    const shortcut = (key: NativeCaptureBindingKey, setting: typeof settings.captureShortcut) => {
        const row = props.shortcuts[key];
        const title = setting.title ?? t(setting.titleKey);
        // The keyboard settings' shortcut row: the keys as they are now, then the one button that records new ones.
        return (
            <SettingRow
                setting={setting}
                subtitle={row.note ?? undefined}
                rightElement={(
                    <View style={styles.actions}>
                        {row.label ? <KeyCombinationHint label={row.label} /> : <Text variant="meta" style={styles.unset}>{t(row.status === 'loading'
                            ? 'common.loading' : row.status === 'failed' ? 'common.unavailable' : 'screenCapture.settings.notSet')}</Text>}
                        {row.editable ? (
                            <RoundButton
                                size="small"
                                capsuleHeight={ACTION_HEIGHT}
                                display="secondary"
                                title={t('settingsKeyboard.setCommandButton')}
                                accessibilityLabel={t('settingsKeyboard.setCommandAccessibility', { command: title })}
                                onPress={() => props.onRecordShortcut(key)}
                                testID={`settings-capture-record-${key}`}
                            />
                        ) : null}
                    </View>
                )}
                showChevron={false}
            />
        );
    };
    return (
        <>
            <SettingSection section={DESKTOP_SETTINGS.sectionRefs.screenCapture}>
                <ItemGroup title={t('screenCapture.settings.title')} description={t('screenCapture.settings.description')}>
                    {shortcut('captureShortcut', settings.captureShortcut)}
                    {shortcut('instantWindowShortcut', settings.instantWindowShortcut)}
                    {shortcut('recordingShortcut', settings.recordingShortcut)}
                    <SettingRow
                        setting={settings.captureSound}
                        subtitle={t('screenCapture.settings.soundDescription')}
                        rightElement={<Switch value={props.sound} onValueChange={props.onSoundChange} />}
                        showChevron={false}
                    />
                    <SettingRow
                        setting={settings.captureIncludeWindowText}
                        subtitle={t('screenCapture.settings.windowTextDescription')}
                        rightElement={<Switch value={props.includeWindowText} onValueChange={props.onIncludeWindowTextChange} />}
                        showChevron={false}
                    />
                    <SettingRow
                        setting={settings.captureIncludeWindowShadow}
                        subtitle={props.windowShadow?.supported ? t('screenCapture.settings.windowShadowDescription')
                            : props.windowShadow ? t('screenCapture.settings.windowShadowUnavailable') : undefined}
                        rightElement={<Switch value={props.windowShadow?.enabled ?? false} disabled={!props.windowShadow?.supported}
                            onValueChange={props.onIncludeWindowShadowChange} />}
                        showChevron={false}
                    />
                    <SettingRow
                        setting={settings.captureFolder}
                        subtitle={props.folder ?? undefined}
                        // Two buttons are wider than a phone row allows beside the path, so they move beneath it there.
                        accessoryLayout="adaptive"
                        rightElement={(
                            <View style={styles.actions}>
                                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} display="secondary" title={t('screenCapture.window.showInFolder')} onPress={props.onShowFolder} testID="settings-capture-show-folder" />
                                <RoundButton size="small" capsuleHeight={ACTION_HEIGHT} display="secondary" title={t('screenCapture.settings.changeFolder')} onPress={props.onChooseFolder} testID="settings-capture-change-folder" />
                            </View>
                        )}
                        showChevron={false}
                    />
                </ItemGroup>
            </SettingSection>
            {props.permissions ? (
                <ItemGroup title={t('screenCapture.settings.permissionsTitle')} description={t('screenCapture.settings.permissionsDescription')}>
                    <PermissionRow title={t('screenCapture.settings.screenPermission')} purpose={t('screenCapture.settings.screenFor')} state={props.permissions.screen}
                        onOpen={() => props.onOpenPermission('screen')} onReopen={props.onReopen} testID="settings-capture-permission-screen" />
                    <PermissionRow title={t('screenCapture.settings.accessibilityPermission')} purpose={t('screenCapture.settings.windowTextFor')} state={props.permissions.windowText}
                        onOpen={() => props.onOpenPermission('window_text')} onReopen={props.onReopen} testID="settings-capture-permission-text" />
                </ItemGroup>
            ) : null}
            <ItemGroup>
                <Item
                    title={t('screenCapture.settings.approvals')}
                    subtitle={t('screenCapture.settings.approvalsDescription')}
                    icon={<Icon name="shield-check" size={20} />}
                    onPress={props.onOpenApprovals}
                    testID="settings-capture-approvals"
                />
            </ItemGroup>
        </>
    );
}

/** The capture grant owner's states as the shared grant row reads them; platforms that never ask show no row. */
const PERMISSION_ROW_STATE: Readonly<Record<NativeCapturePermissionState, SystemPermissionRowState | null>> = {
    granted: 'granted', request_required: 'missing', denied: 'missing', restart_required: 'reopen', unknown: 'unknown',
    not_required: null, per_request: null, unavailable: null,
};

function PermissionRow(props: Readonly<{ title: string; purpose: string; state: NativeCapturePermissionState; onOpen: () => void; onReopen: () => void; testID: string }>) {
    const state = PERMISSION_ROW_STATE[props.state];
    if (state === null) return null;
    return <SystemPermissionRow title={props.title} purpose={props.purpose} state={state} onOpenSettings={props.onOpen} onReopen={props.onReopen} testID={props.testID} />;
}

const styles = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    unset: {
        color: theme.colors.text.secondary,
    },
}));
