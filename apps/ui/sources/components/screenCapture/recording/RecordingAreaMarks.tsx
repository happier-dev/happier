import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CaptureRect } from '../window/resolveCaptureWindowFrame';

const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;

/** The area's four corner marks while it records (lab `rc` BAR): the screen stays undimmed. */
export function RecordingAreaMarks(props: Readonly<{ area: CaptureRect }>) {
    const { x, y, width, height } = props.area;
    return (
        <View pointerEvents="none" style={[styles.area, { left: x, top: y, width, height }]} testID="recording-area-marks">
            {CORNERS.map((corner) => <View key={corner} style={[styles.corner, styles[corner]]} />)}
        </View>
    );
}

// Marks stand over any picture, so they are paper white with a dark halo rather than a theme ink.
const styles = StyleSheet.create((theme) => {
    const reach = theme.space.s24;
    const line = theme.space.s4;
    const offset = -theme.space.s2;
    const corner = theme.borderRadius.lg;
    return {
        area: {
            position: 'absolute',
        },
        corner: {
            position: 'absolute',
            width: reach,
            height: reach,
            borderColor: theme.colors.overlay.foreground,
            filter: `drop-shadow(0 0 1.5px ${theme.colors.overlay.scrim})`,
        },
        topLeft: { left: offset, top: offset, borderLeftWidth: line, borderTopWidth: line, borderTopLeftRadius: corner },
        topRight: { right: offset, top: offset, borderRightWidth: line, borderTopWidth: line, borderTopRightRadius: corner },
        bottomLeft: { left: offset, bottom: offset, borderLeftWidth: line, borderBottomWidth: line, borderBottomLeftRadius: corner },
        bottomRight: { right: offset, bottom: offset, borderRightWidth: line, borderBottomWidth: line, borderBottomRightRadius: corner },
    };
});
