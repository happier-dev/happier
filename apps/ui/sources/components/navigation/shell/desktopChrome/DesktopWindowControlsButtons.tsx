import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { t } from '@/text';
import {
    DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
    DESKTOP_WINDOW_CONTROL_GLYPH_SIZE_PX,
    DESKTOP_WINDOW_CONTROL_SURFACE_RADIUS_PX,
    DESKTOP_WINDOW_CONTROL_SURFACE_SIZE_PX,
} from './desktopChromeMetrics';

export type DesktopWindowControlsButtonsProps = Readonly<{
    layout?: 'row' | 'column';
    isMaximized?: boolean;
    onMinimize?: () => void;
    onToggleMaximize?: () => void;
    onClose?: () => void;
}>;

function DesktopWindowControlButton(props: Readonly<{
    testID: string;
    label: string;
    icon: IconName;
    onPress?: () => void;
}>) {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();

    return (
        <View style={styles.windowControlsButton}>
            <PressableSurface
                testID={props.testID}
                onPress={props.onPress}
                accessibilityLabel={props.label}
                webTooltip={props.label}
                focusRingRadius={DESKTOP_WINDOW_CONTROL_SURFACE_RADIUS_PX}
                focusRingPlacement="inside"
                style={styles.windowControlsButton}
                feedbackInset={(DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX - DESKTOP_WINDOW_CONTROL_SURFACE_SIZE_PX) / 2}
            >
                <View pointerEvents="none">
                    <Icon name={props.icon} size={DESKTOP_WINDOW_CONTROL_GLYPH_SIZE_PX} color={theme.colors.chrome.header.foreground} />
                </View>
            </PressableSurface>
        </View>
    );
}

export const DesktopWindowControlsButtons = React.memo((props: DesktopWindowControlsButtonsProps) => {
    const styles = desktopSidebarChromeStyles;
    const layoutStyle = props.layout === 'column' ? styles.windowControlsButtonsColumn : styles.windowControlsButtons;

    return (
        <View style={layoutStyle}>
            <DesktopWindowControlButton
                testID="desktop-window-controls-minimize"
                onPress={props.onMinimize}
                label={t('common.minimizeWindow')}
                icon="minus"
            />
            <DesktopWindowControlButton
                testID="desktop-window-controls-toggle-maximize"
                onPress={props.onToggleMaximize}
                label={t(props.isMaximized ? 'common.restoreWindow' : 'common.maximizeWindow')}
                icon={props.isMaximized ? 'copy' : 'square'}
            />
            <DesktopWindowControlButton
                testID="desktop-window-controls-close"
                onPress={props.onClose}
                label={t('common.closeWindow')}
                icon="x"
            />
        </View>
    );
});
