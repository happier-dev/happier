import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';

export function DesktopActivityOverlayLeadingIndicator(props: Readonly<{
    tone: 'collapsed' | 'row';
    visualMode: 'notch_integrated' | 'floating_overlay';
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const isNotchIntegrated = props.visualMode === 'notch_integrated';
    const isCollapsed = props.tone === 'collapsed';

    return (
        <View style={[
            styles.column,
            isCollapsed ? styles.columnCollapsed : styles.columnRow,
            isNotchIntegrated ? styles.columnNotch : styles.columnFloating,
        ]}>
            <View
                style={[
                    styles.bar,
                    isCollapsed
                        ? (isNotchIntegrated ? styles.barCollapsedNotch : styles.barCollapsedFloating)
                        : (isNotchIntegrated ? styles.barNotch : styles.barFloating),
                    { backgroundColor: theme.colors.overlay.textSecondary },
                ]}
            />
            <View
                style={[
                    styles.dot,
                    isCollapsed
                        ? (isNotchIntegrated ? styles.dotCollapsedNotch : styles.dotCollapsedFloating)
                        : (isNotchIntegrated ? styles.dotNotch : styles.dotFloating),
                    { backgroundColor: theme.colors.accent.orange },
                ]}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    column: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    columnRow: {
        width: desktopActivityOverlayChromeMetrics.indicator.rowWidth,
        justifyContent: 'center',
    },
    columnCollapsed: {
        width: desktopActivityOverlayChromeMetrics.indicator.collapsedWidth,
        justifyContent: 'center',
        paddingTop: 0,
    },
    columnNotch: {
        paddingTop: 0,
    },
    columnFloating: {
        paddingTop: 0,
    },
    bar: {
        position: 'absolute',
        borderRadius: 999,
    },
    barNotch: {
        width: 3,
        height: 16,
        opacity: 0.28,
    },
    barFloating: {
        width: 3,
        height: 18,
        opacity: 0.22,
    },
    barCollapsedNotch: {
        width: 8,
        height: 8,
        opacity: 0.1,
    },
    barCollapsedFloating: {
        width: 9,
        height: 9,
        opacity: 0.1,
    },
    dot: {
        borderRadius: 999,
        flexShrink: 0,
    },
    dotNotch: {
        width: 5,
        height: 5,
    },
    dotFloating: {
        width: 5,
        height: 5,
    },
    dotCollapsedNotch: {
        width: 3,
        height: 3,
    },
    dotCollapsedFloating: {
        width: 3.5,
        height: 3.5,
    },
});
