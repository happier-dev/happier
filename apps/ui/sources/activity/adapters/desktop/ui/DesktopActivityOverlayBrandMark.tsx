import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Path } from 'react-native-svg';

import { resolveDesktopOverlayMatchedGeometryStyle } from '../motion/useDesktopOverlayMatchedGeometry';
import { DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR } from './DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';
import { useDesktopActivityOverlayMotionProgress } from './DesktopActivityOverlayMotionFrame';

export function DesktopActivityOverlayBrandMark(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const openProgress = useDesktopActivityOverlayMotionProgress();
    const markFill = props.visualMode === 'notch_integrated'
        ? theme.colors.accent.orange
        : theme.colors.overlay.foreground;
    const smileCutout = DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR;

    const matchedGeometryStyle = resolveDesktopOverlayMatchedGeometryStyle({
        progress: openProgress,
        collapsed: { x: 0, y: 0, scale: 1 },
        expanded: props.visualMode === 'notch_integrated'
            ? { x: 0, y: 1, scale: 1.04 }
            : { x: 0, y: 0, scale: 1.02 },
    });

    return (
        <View testID={props.testID} style={[styles.root, matchedGeometryStyle]}>
            <Svg width="100%" height="100%" viewBox="0 0 24 24" fill="none">
                <Path
                    fill={markFill}
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M4.25 1.5C2.73122 1.5 1.5 2.73122 1.5 4.25V19.75C1.5 21.2688 2.73122 22.5 4.25 22.5H19.75C21.2688 22.5 22.5 21.2688 22.5 19.75V4.25C22.5 2.73122 21.2688 1.5 19.75 1.5H14.75V7C14.75 8.51878 13.5188 9.75 12 9.75C10.4812 9.75 9.25 8.51878 9.25 7V1.5H4.25ZM10.75 1.5H13.25V7C13.25 7.69036 12.6904 8.25 12 8.25C11.3096 8.25 10.75 7.69036 10.75 7V1.5Z"
                />
                <Path
                    d="M6.8 14.25C8.15 16.3 9.85 17.35 12 17.35C14.15 17.35 15.85 16.3 17.2 14.25"
                    stroke={smileCutout}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                />
            </Svg>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        width: 13,
        height: 13,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
