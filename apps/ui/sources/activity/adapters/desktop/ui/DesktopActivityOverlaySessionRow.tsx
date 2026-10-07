import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { createDesktopActivityOverlayFocusRingStyle } from './DesktopActivityOverlayChrome';
import { composeDesktopActivityOverlayAccessibilityLabel } from './desktopActivityOverlayAccessibilityLabel';
import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import { DesktopActivityOverlayLeadingIndicator } from './DesktopActivityOverlayLeadingIndicator';
import type { DesktopActivityOverlayPressableInteractionState } from './DesktopActivityOverlayPressableInteractionState';
import type { DesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export function DesktopActivityOverlaySessionRow(props: Readonly<{
    testID?: string;
    visualMode: DesktopActivityOverlayVisualMode;
    isLast?: boolean;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    previewText: string | null;
    pressableRef?: React.Ref<View>;
    onPress: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // Identity and state only: the preview repeats agent/session content and stays out of the name.
    const accessibilityLabel = composeDesktopActivityOverlayAccessibilityLabel([
        props.title,
        props.subtitle,
        props.statusText,
    ]);

    return (
        <Pressable
            ref={props.pressableRef}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={props.onPress}
            style={(state) => {
                const { pressed } = state;
                const interaction = state as DesktopActivityOverlayPressableInteractionState;
                const hovered = interaction.hovered === true;

                return [
                    styles.container,
                    hovered ? [styles.hoveredSurface, { backgroundColor: theme.colors.overlay.scrimStrong }] : null,
                    pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
                    createDesktopActivityOverlayFocusRingStyle(theme, interaction.focused),
                ];
            }}
        >
            <View style={styles.contentRow}>
                <DesktopActivityOverlayLeadingIndicator
                    visualMode={props.visualMode}
                    tone="row"
                />
                <View style={styles.textWrap}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.colors.overlay.foreground }]}>
                        {props.title}
                    </Text>
                    {props.subtitle ? (
                        <Text numberOfLines={1} style={[styles.subtitle, { color: theme.colors.overlay.secondaryForeground }]}>
                            {props.subtitle}
                        </Text>
                    ) : null}
                    {props.statusText ? (
                        <Text numberOfLines={1} style={[styles.status, { color: theme.colors.overlay.secondaryForeground }]}>
                            {props.statusText}
                        </Text>
                    ) : null}
                    {props.previewText ? (
                        <Text numberOfLines={1} style={[styles.previewText, { color: theme.colors.overlay.secondaryForeground }]}>
                            {props.previewText}
                        </Text>
                    ) : null}
                </View>
            </View>
            {!props.isLast ? (
                <View style={[styles.separator, { backgroundColor: theme.colors.overlay.foreground }]} />
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        // Carried on the base row so the hover wash and the keyboard focus outline share one shape.
        borderRadius: 12,
    },
    hoveredSurface: {
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
