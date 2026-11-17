import * as React from 'react';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { t } from '@/text';
import { ThemeDevicePickerView } from './ThemeDevicePickerView';
import { useThemeDevicePicker, type ThemeDevicePickerInput } from './useThemeDevicePicker';
import type { ThemeUiActionExecute } from './useThemeActionExecution';
import { ThemeDevicePickerPopover } from './ThemeDevicePickerPopover';

/** Mounted only while requested, shared by the transcript card and either library slot. */
export function ThemeDevicePickerHost(props: Readonly<{
    theme: ThemeDevicePickerInput['theme'];
    anchorRef: React.RefObject<unknown>;
    execute: ThemeUiActionExecute;
    onDismiss: () => void;
    onDistribution?: ThemeDevicePickerInput['onDistribution'];
}>) {
    const picker = useThemeDevicePicker({ enabled: true, theme: props.theme,
        currentClientId: apiSocket.getSocketId() ?? '', unnamedDeviceLabel: t('themeDevices.unnamed'),
        onDismiss: props.onDismiss, onDistribution: props.onDistribution }, props.execute);
    return <ThemeDevicePickerPopover themeName={props.theme.name} anchorRef={props.anchorRef} onDismiss={props.onDismiss}
        list={picker.rows.length > 0}>
        <ThemeDevicePickerView {...picker} testID="theme-device-picker" />
    </ThemeDevicePickerPopover>;
}
