import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';

type DesktopShellUpdateIndicatorHostProps = Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export const DesktopShellUpdateIndicatorHost = React.memo((props: DesktopShellUpdateIndicatorHostProps) => {
    const styles = desktopSidebarChromeStyles;
    if (props.children == null) {
        return null;
    }

    return (
        <View testID="desktop-update-indicator-host" style={[styles.updateIndicatorHost, props.style]}>
            {props.children}
        </View>
    );
});
