import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { Icon } from '@/components/ui/icons/Icon';

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

    return (
        <View style={layoutStyle}>
            <Pressable
                testID="desktop-window-controls-minimize"
                onPress={props.onMinimize}
                accessibilityRole="button"
                style={styles.windowControlsButton}
            >
                <Icon name="minus" size={16} color={theme.colors.chrome.header.foreground} />
            </Pressable>
            <Pressable
                testID="desktop-window-controls-toggle-maximize"
                onPress={props.onToggleMaximize}
                accessibilityRole="button"
                style={styles.windowControlsButton}
            >
                <Icon
                    name={props.isMaximized ? 'arrows-in' : 'arrows-out'}
                    size={14}
                    color={theme.colors.chrome.header.foreground}
                />
            </Pressable>
            <Pressable
                testID="desktop-window-controls-close"
                onPress={props.onClose}
                accessibilityRole="button"
                style={styles.windowControlsButton}
            >
                <Icon name="x" size={16} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        </View>
    );
});
