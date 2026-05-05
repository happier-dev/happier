import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import type { DesktopActivityOverlayHoverablePressableState } from './DesktopActivityOverlayHoverablePressableState';
import { DesktopActivityOverlayLeadingIndicator } from './DesktopActivityOverlayLeadingIndicator';
import type { DesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';

export function DesktopActivityOverlaySessionRow(props: Readonly<{
    testID?: string;
    visualMode: DesktopActivityOverlayVisualMode;
    isLast?: boolean;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    previewText: string | null;
    onPress: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            style={(state) => {
                const { pressed } = state;
                const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                return [
                    styles.container,
                    hovered ? [styles.hoveredSurface, { backgroundColor: theme.colors.overlay.scrimStrong }] : null,
                    pressed ? { opacity: 0.9 } : null,
                ];
            }}
        >
            <View style={styles.contentRow}>
                <DesktopActivityOverlayLeadingIndicator
                    visualMode={props.visualMode}
                    tone="row"
                />
                <View style={styles.textWrap}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.colors.overlay.text }]}>
                        {props.title}
                    </Text>
                    {props.subtitle ? (
                        <Text numberOfLines={1} style={[styles.subtitle, { color: theme.colors.overlay.textSecondary }]}>
                            {props.subtitle}
                        </Text>
                    ) : null}
                    {props.statusText ? (
                        <Text numberOfLines={1} style={[styles.status, { color: theme.colors.overlay.textSecondary }]}>
                            {props.statusText}
                        </Text>
                    ) : null}
                    {props.previewText ? (
                        <Text numberOfLines={1} style={[styles.previewText, { color: theme.colors.overlay.textSecondary }]}>
                            {props.previewText}
                        </Text>
                    ) : null}
                </View>
            </View>
            {!props.isLast ? (
                <View style={[styles.separator, { backgroundColor: theme.colors.overlay.text }]} />
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    hoveredSurface: {
        borderRadius: 12,
        opacity: 0.98,
    },
    contentRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: desktopActivityOverlayChromeMetrics.row.gap,
        paddingHorizontal: desktopActivityOverlayChromeMetrics.row.paddingHorizontal,
        paddingVertical: desktopActivityOverlayChromeMetrics.row.paddingVertical,
    },
    textWrap: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    title: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0,
    },
    subtitle: {
        fontSize: 10,
        opacity: 0.78,
    },
    status: {
        fontSize: 10,
        opacity: 0.82,
    },
    previewText: {
        fontSize: 10,
        opacity: 0.8,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        opacity: 0.08,
        marginLeft: 18,
        marginRight: 6,
    },
});
