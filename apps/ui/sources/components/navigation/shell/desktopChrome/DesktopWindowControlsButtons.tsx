import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import {
    DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
    DESKTOP_WINDOW_CONTROL_SURFACE_SIZE_PX,
    DESKTOP_WINDOW_CONTROL_GLYPH_SIZE_PX,
} from './desktopChromeMetrics';

export type DesktopWindowControlsButtonsProps = Readonly<{
    layout?: 'row' | 'column';
    isMaximized?: boolean;
    onMinimize?: () => void;
    onToggleMaximize?: () => void;
    onClose?: () => void;
}>;

export const DesktopWindowControlsButtons = React.memo((props: DesktopWindowControlsButtonsProps) => {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const layoutStyle = props.layout === 'column' ? styles.windowControlsButtonsColumn : styles.windowControlsButtons;
    const targetInset = (DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX - DESKTOP_WINDOW_CONTROL_SURFACE_SIZE_PX) / 2;
    const controls = [
        { action: 'minimize', icon: 'minus', label: t('common.minimizeWindow'), onPress: props.onMinimize },
        { action: 'toggle-maximize', icon: props.isMaximized ? 'copy' : 'square', label: t(props.isMaximized ? 'common.restoreWindow' : 'common.maximizeWindow'), onPress: props.onToggleMaximize },
        { action: 'close', icon: 'x', label: t('common.closeWindow'), onPress: props.onClose },
    ] as const;

    return (
        <View style={layoutStyle}>
            {controls.map((control) => (
                <View key={control.action} style={styles.windowControlsButton}>
                    <IconButton
                        testID={`desktop-window-controls-${control.action}`}
                        icon={<Icon name={control.icon} size={DESKTOP_WINDOW_CONTROL_GLYPH_SIZE_PX} color={theme.colors.chrome.header.foreground} />}
                        accessibilityLabel={control.label}
                        tooltip={control.label}
                        size={DESKTOP_WINDOW_CONTROL_SURFACE_SIZE_PX}
                        iconSize={DESKTOP_WINDOW_CONTROL_GLYPH_SIZE_PX}
                        minimumInteractiveTargetSize={DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX}
                        interactiveTargetEdgesPx={{ leading: targetInset, trailing: targetInset, top: targetInset, bottom: targetInset }}
                        variant="plain"
                        onPress={() => control.onPress?.()}
                    />
                </View>
            ))}
        </View>
    );
});
