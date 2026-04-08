import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { Text } from '@/components/ui/text/Text';

import {
    DesktopActivityOverlayChromeBackdrop,
    createDesktopActivityOverlayChromeStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
    DesktopActivityOverlayChromeHighlights,
} from './DesktopActivityOverlayChrome';
import { DesktopActivityOverlayBrandMark } from './DesktopActivityOverlayBrandMark';
import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import {
    resolveDesktopActivityOverlaySurfaceTestID,
    type DesktopActivityOverlayVisualMode,
} from './DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayHoverablePressableState } from './DesktopActivityOverlayHoverablePressableState';

export function DesktopActivityOverlayCollapsed(props: Readonly<{
    model: DesktopActivityOverlayModel;
    visualMode: DesktopActivityOverlayVisualMode;
    interactive: boolean;
    dragHandlers: Readonly<Record<string, unknown>>;
    onPress: () => void;
    onHoverIn?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const isNotchIntegrated = props.visualMode === 'notch_integrated';
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-collapsed', props.visualMode);
    const containerStyle = [
        styles.container,
        createDesktopActivityOverlayChromeStyle(theme, {
            visualMode: props.visualMode,
            tone: 'collapsed',
        }),
    ];
    const accessibilityLabel = [
        props.model.collapsed.title,
        props.model.collapsed.statusText,
        typeof props.model.collapsed.sessionCount === 'number' ? String(props.model.collapsed.sessionCount) : null,
    ]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .join('. ');

    return (
        <Pressable
            testID="desktop-activity-overlay-collapsed"
            accessibilityLabel={accessibilityLabel || undefined}
            disabled={!props.interactive}
            onPress={props.onPress}
            onHoverIn={props.onHoverIn}
            style={(state) => {
                const { pressed } = state;
                const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                return [
                    containerStyle,
                    props.interactive && hovered ? { opacity: 0.985 } : null,
                    props.interactive && pressed ? { opacity: 0.92 } : null,
                ];
            }}
            {...props.dragHandlers}
        >
            <View
                pointerEvents="none"
                testID={surfaceTestID}
                style={StyleSheet.absoluteFill}
            >
                <DesktopActivityOverlayChromeBackdrop
                    theme={theme}
                    visualMode={props.visualMode}
                    tone="collapsed"
                    width={props.model.window.collapsed.width}
                    height={props.model.window.collapsed.height}
                />
                <DesktopActivityOverlayChromeHighlights
                    theme={theme}
                    tone="collapsed"
                    visualMode={props.visualMode}
                />
            </View>
            {isNotchIntegrated ? (
                <View style={[styles.contentRow, styles.contentRowNotch]}>
                    <View style={styles.leadingAnchor}>
                        <DesktopActivityOverlayBrandMark
                            visualMode={props.visualMode}
                            testID="desktop-activity-overlay-collapsed-brand-mark"
                        />
                    </View>
                    <View style={styles.notchSpacer} />
                    <View style={styles.notchTrailingCluster}>
                        {props.model.collapsed.statusText ? (
                            <View style={[styles.statusDot, { backgroundColor: theme.colors.accent.orange }]} />
                        ) : null}
                        {typeof props.model.collapsed.sessionCount === 'number' ? (
                            <View style={[
                                styles.countBadge,
                                styles.countBadgeNotch,
                                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                    visualMode: props.visualMode,
                                    kind: 'badge',
                                }),
                            ]}>
                                <Text style={[styles.countText, { color: theme.colors.overlay.text }]}>
                                    {String(props.model.collapsed.sessionCount)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                </View>
            ) : (
                <View style={[styles.contentRow, styles.contentRowFloating]}>
                    <View style={styles.leadingAnchor}>
                        <DesktopActivityOverlayBrandMark
                            visualMode={props.visualMode}
                            testID="desktop-activity-overlay-collapsed-brand-mark"
                        />
                    </View>
                    <View style={styles.textContainer}>
                        <View style={styles.titleRow}>
                            <Text numberOfLines={1} style={[styles.title, { color: theme.colors.overlay.text }]}>
                                {props.model.collapsed.title}
                            </Text>
                            {typeof props.model.collapsed.sessionCount === 'number' ? (
                                <View style={[
                                    styles.countBadge,
                                    styles.countBadgeFloating,
                                    createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                        visualMode: props.visualMode,
                                        kind: 'badge',
                                    }),
                                ]}>
                                    <Text style={[styles.countText, { color: theme.colors.overlay.text }]}>
                                        {String(props.model.collapsed.sessionCount)}
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                        {props.model.collapsed.statusText ? (
                            <Text numberOfLines={1} style={[styles.status, { color: theme.colors.overlay.textSecondary }]}>
                                {props.model.collapsed.statusText}
                            </Text>
                        ) : null}
                    </View>
                </View>
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        minHeight: 42,
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
    },
    contentRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: desktopActivityOverlayChromeMetrics.collapsed.gap,
    },
    leadingAnchor: {
        width: 14,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    contentRowNotch: {
        paddingHorizontal: desktopActivityOverlayChromeMetrics.collapsed.pillPaddingHorizontal,
        paddingVertical: desktopActivityOverlayChromeMetrics.collapsed.pillPaddingVertical,
    },
    contentRowFloating: {
        paddingHorizontal: desktopActivityOverlayChromeMetrics.collapsed.panelPaddingHorizontal,
        paddingVertical: desktopActivityOverlayChromeMetrics.collapsed.panelPaddingVertical,
    },
    textContainer: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    notchSpacer: {
        flex: 1,
    },
    notchTrailingCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        flex: 1,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.1,
    },
    status: {
        fontSize: 9,
        opacity: 0.8,
    },
    countBadge: {
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginLeft: 'auto',
    },
    countBadgeNotch: {
        minWidth: 15,
        height: 14,
        paddingHorizontal: 4,
    },
    countBadgeFloating: {
        minWidth: 16,
        height: 15,
        paddingHorizontal: 4,
    },
    countText: {
        fontSize: 8,
        fontWeight: '600',
        letterSpacing: 0.1,
    },
    statusDot: {
        width: 5,
        height: 5,
        borderRadius: 999,
    },
});
