import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { DesktopWindowControlsSlot } from './DesktopWindowControlsSlot';

type DesktopShellWindowControlsHostProps = Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    slotStyle?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    dragRegionStyle?: StyleProp<ViewStyle>;
}>;

export const DesktopShellWindowControlsHost = React.memo((props: DesktopShellWindowControlsHostProps) => {
    const styles = desktopSidebarChromeStyles;
    if (props.children == null) {
        return null;
    }

    return (
        <View testID="desktop-window-controls-host" style={[styles.windowControlsHost, props.style]}>
            <DesktopWindowControlsSlot
                slotStyle={props.slotStyle}
                contentStyle={props.contentStyle}
                dragRegionStyle={props.dragRegionStyle}
            >
                {props.children}
            </DesktopWindowControlsSlot>
        </View>
    );
});
