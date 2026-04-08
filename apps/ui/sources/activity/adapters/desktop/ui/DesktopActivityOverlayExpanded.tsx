import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    DesktopActivityOverlayChromeBackdrop,
    createDesktopActivityOverlayChromeStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
    DesktopActivityOverlayChromeHighlights,
} from './DesktopActivityOverlayChrome';
import { DesktopActivityOverlayBrandMark } from './DesktopActivityOverlayBrandMark';
import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import { DesktopActivityOverlaySessionRow } from './DesktopActivityOverlaySessionRow';
import {
    resolveDesktopActivityOverlaySurfaceTestID,
    type DesktopActivityOverlayVisualMode,
} from './DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayHoverablePressableState } from './DesktopActivityOverlayHoverablePressableState';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: DesktopActivityOverlayModel;
    visualMode: DesktopActivityOverlayVisualMode;
    onCollapse: () => void;
    onOpenSession: (sessionId: string) => void;
    onOpenInbox: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const isNotchIntegrated = props.visualMode === 'notch_integrated';
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-expanded', props.visualMode);

    return (
        <View
            testID="desktop-activity-overlay-expanded"
            style={[
                styles.container,
                createDesktopActivityOverlayChromeStyle(theme, {
                    visualMode: props.visualMode,
                    tone: 'expanded',
                }),
            ]}
        >
            <View
                pointerEvents="none"
                testID={surfaceTestID}
                style={StyleSheet.absoluteFill}
            >
                <DesktopActivityOverlayChromeBackdrop
                    theme={theme}
                    tone="expanded"
                    visualMode={props.visualMode}
                    width={props.model.window.expanded.width}
                    height={props.model.window.expanded.height}
                />
                <DesktopActivityOverlayChromeHighlights
                    theme={theme}
                    tone="expanded"
                    visualMode={props.visualMode}
                />
            </View>
            <View style={styles.headerRow}>
                <View style={styles.headerIdentity}>
                    <DesktopActivityOverlayBrandMark visualMode={props.visualMode} />
                    {!isNotchIntegrated ? (
                        <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.overlay.text }]}>
                            {props.model.expanded.title}
                        </Text>
                    ) : null}
                </View>
                <View style={styles.headerActions}>
                    <Pressable
                        accessibilityLabel={`${t('common.open')} ${t('tabs.inbox')}`}
                        testID="desktop-activity-overlay-expanded-action-open-inbox"
                        onPress={props.onOpenInbox}
                        style={(state) => {
                            const { pressed } = state;
                            const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                            return [
                                styles.headerAction,
                                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                    visualMode: props.visualMode,
                                    kind: 'action',
                                }),
                                hovered ? { opacity: 0.98 } : null,
                                pressed ? { opacity: 0.92 } : null,
                            ];
                        }}
                    >
                        <SafeIonicons name="albums-outline" size={13} color={theme.colors.overlay.text} />
                    </Pressable>
                    <Pressable
                        accessibilityLabel={t('common.close')}
                        testID="desktop-activity-overlay-expanded-action-collapse"
                        onPress={props.onCollapse}
                        style={(state) => {
                            const { pressed } = state;
                            const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                            return [
                                styles.headerAction,
                                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                    visualMode: props.visualMode,
                                    kind: 'action',
                                }),
                                hovered ? { opacity: 0.98 } : null,
                                pressed ? { opacity: 0.92 } : null,
                            ];
                        }}
                    >
                        <SafeIonicons name="chevron-up" size={14} color={theme.colors.overlay.text} />
                    </Pressable>
                </View>
            </View>
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {props.model.expanded.rows.map((row, rowIndex) => (
                    <DesktopActivityOverlaySessionRow
                        key={row.sessionId}
                        isLast={rowIndex === props.model.expanded.rows.length - 1}
                        visualMode={props.visualMode}
                        title={row.title}
                        subtitle={row.subtitle}
                        statusText={row.statusText}
                        previewText={row.previewText}
                        onPress={() => props.onOpenSession(row.sessionId)}
                    />
                ))}
                {props.model.expanded.rows.length === 0 ? (
                    <Text style={[styles.emptyText, { color: theme.colors.overlay.textSecondary }]}>
                        {props.model.collapsed.title}
                    </Text>
                ) : null}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        paddingHorizontal: desktopActivityOverlayChromeMetrics.expanded.paddingHorizontal,
        paddingTop: desktopActivityOverlayChromeMetrics.expanded.paddingTop,
        paddingBottom: desktopActivityOverlayChromeMetrics.expanded.paddingBottom,
        gap: desktopActivityOverlayChromeMetrics.expanded.gap,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: desktopActivityOverlayChromeMetrics.expanded.headerGap,
    },
    headerIdentity: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    headerTitle: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.12,
        flex: 1,
    },
    headerAction: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        gap: desktopActivityOverlayChromeMetrics.expanded.rowGap,
        paddingBottom: 0,
    },
    emptyText: {
        fontSize: 11,
        textAlign: 'center',
        paddingVertical: 16,
    },
});
