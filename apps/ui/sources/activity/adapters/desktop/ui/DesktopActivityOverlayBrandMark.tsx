import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';

export function DesktopActivityOverlayBrandMark(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const pixelColor = props.visualMode === 'notch_integrated'
        ? theme.colors.accent.orange
        : theme.colors.overlay.text;

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={[styles.pixel, styles.pixelTopLeft, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelTopRight, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelCenter, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelLowerLeft, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelLowerRight, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelFootLeft, { backgroundColor: pixelColor }]} />
            <View style={[styles.pixel, styles.pixelFootRight, { backgroundColor: pixelColor }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        width: 12,
        height: 12,
        position: 'relative',
        flexShrink: 0,
    },
    pixel: {
        position: 'absolute',
        width: 3,
        height: 3,
        borderRadius: 1,
    },
    pixelTopLeft: {
        left: 1,
        top: 0,
    },
    pixelTopRight: {
        right: 1,
        top: 0,
    },
    pixelCenter: {
        left: 4.5,
        top: 3,
    },
    pixelLowerLeft: {
        left: 0,
        top: 5.5,
    },
    pixelLowerRight: {
        right: 0,
        top: 5.5,
    },
    pixelFootLeft: {
        left: 2,
        bottom: 0,
    },
    pixelFootRight: {
        right: 2,
        bottom: 0,
    },
});
