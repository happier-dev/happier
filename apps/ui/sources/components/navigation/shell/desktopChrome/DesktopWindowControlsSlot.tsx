import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';

type DesktopWindowControlsSlotProps = Readonly<{
    children?: React.ReactNode;
    slotStyle?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    dragRegionStyle?: StyleProp<ViewStyle>;
    enableDragging?: boolean;
    onStartDragging?: () => void;
}>;

export const DesktopWindowControlsSlot = React.memo((props: DesktopWindowControlsSlotProps) => {
    const styles = desktopSidebarChromeStyles;

    return (
        <View testID="desktop-window-controls-slot" style={[styles.windowControlsSlot, props.slotStyle]}>
            <Pressable
                testID="desktop-window-drag-region"
                style={[styles.windowDragRegion, props.dragRegionStyle]}
                onPressIn={props.enableDragging ? props.onStartDragging : undefined}
            />
            <View style={[styles.windowControlsContent, props.contentStyle]}>
                {props.children}
            </View>
        </View>
    );
});
