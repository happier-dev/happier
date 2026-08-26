import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

import { resolveSessionLateralSwipeTabRowOpacity } from '../lateralSwipe/sessionLateralSwipeMotion';

const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 1,
        zIndex: 1,
    },
    iconContainer: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Selection highlight behind the whole active tab (icon + label). Subtle
    // overlay of the foreground color so it reads softly over the glass material.
    activePill: {
        position: 'absolute',
        top: 3,
        bottom: 3,
        left: 4,
        right: 4,
        borderRadius: 16,
        backgroundColor: theme.colors.text.primary,
        opacity: 0.05,
    },
    label: {
        marginTop: 4,
        fontSize: 10,
        ...Typography.default(),
    },
    labelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.text.secondary,
    },
}));

export type CockpitTabBadge =
    | Readonly<{ kind: 'count'; value: number }>
    | Readonly<{ kind: 'diff'; added: number; removed: number; modifiedCount: number }>;

export type CockpitTabBarTabDefinition<TSurface extends string> = Readonly<{
    id: TSurface;
    label: string;
    icon: IconName | Readonly<{
        render: (params: Readonly<{ size: number; tintColor: string; active: boolean }>) => React.ReactNode;
    }>;
    badge?: CockpitTabBadge;
}>;

type CockpitTabBarProps<TSurface extends string> = Readonly<{
    activeSurface: TSurface;
    barTestId: string;
    tabs: readonly CockpitTabBarTabDefinition<TSurface>[];
    tabTestIdPrefix: string;
    onSurfacePress: (surface: TSurface) => void;
    /**
     * Readout painted over the tab row while a lateral swipe is under the finger.
     * Both layers fade from the SAME `progress`, and the readout is absolute, so the
     * capsule keeps its tab-derived width for the whole gesture instead of resizing.
     */
    swipeReadout?: Readonly<{
        progress: SharedValue<number>;
        /** The gesture's second axis; floors the dim so an open picker fully clears the row. */
        browseProgress: SharedValue<number>;
        node: React.ReactNode;
    }>;
    /**
     * Actions that belong to the BAND rather than to any one tab — today, the lateral
     * session swipe's non-gesture equivalent.
     *
     * They are attached to every tab because a tab is the only thing here a screen
     * reader can focus: the band's own container is `pointerEvents="box-none"` and is
     * not an accessibility element, so actions placed on it would never reach the
     * VoiceOver rotor or the TalkBack context menu. `SessionItem` uses the same shape —
     * actions ride the row's existing `Pressable` rather than a new element — so this
     * adds no resting pixels and no extra focus stop.
     */
    bandAccessibilityActions?: readonly Readonly<{ name: string; label: string }>[];
    onBandAccessibilityAction?: (actionName: string) => void;
}>;

export function CockpitTabBar<TSurface extends string>(props: CockpitTabBarProps<TSurface>) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'), Platform.OS);
    // Idle stand-in so the row's animated style is unconditional: a bar that swapped
    // between `View` and `Animated.View` would remount its tabs.
    const idleProgress = useSharedValue(0);
    const idleBrowseProgress = useSharedValue(0);
    const rowProgress = props.swipeReadout?.progress ?? idleProgress;
    const rowBrowseProgress = props.swipeReadout?.browseProgress ?? idleBrowseProgress;
    const rowStyle = useAnimatedStyle(
        () => ({ opacity: resolveSessionLateralSwipeTabRowOpacity(rowProgress.value, rowBrowseProgress.value) }),
        [rowBrowseProgress, rowProgress],
    );

    return (
        <FloatingTabBarSurface testID={props.barTestId} bottomInset={insets.bottom} opaqueBand>
            <Animated.View style={[styles.innerContainer, { gap: metrics.rowGap }, rowStyle]}>
                {props.tabs.map((tab) => {
                    const active = tab.id === props.activeSurface;
                    const tintColor = active ? theme.colors.text.primary : theme.colors.text.secondary;
                    const icon = typeof tab.icon === 'string'
                        ? <Icon name={tab.icon} size={metrics.iconSize} color={tintColor} />
                        : tab.icon.render({ size: metrics.iconSize, tintColor, active });
                    return (
                        <Pressable
                            key={tab.id}
                            testID={`${props.tabTestIdPrefix}${tab.id}`}
                            onPress={() => props.onSurfacePress(tab.id)}
                            hitSlop={8}
                            // The visible label is optional (`tabBarShowLabels` defaults off), so the
                            // accessible name has to come from the definition rather than from a child
                            // Text that may not be rendered — otherwise the default bar is a row of
                            // unnamed buttons to a screen reader.
                            accessibilityRole="tab"
                            accessibilityLabel={tab.label}
                            accessibilityState={{ selected: active }}
                            accessibilityActions={props.bandAccessibilityActions}
                            onAccessibilityAction={props.onBandAccessibilityAction
                                ? (event) => props.onBandAccessibilityAction?.(event.nativeEvent.actionName)
                                : undefined}
                            style={[styles.tab, {
                                minWidth: metrics.tabMinWidth,
                                minHeight: metrics.tabMinHeight,
                                paddingVertical: metrics.tabPaddingVertical,
                                paddingHorizontal: metrics.tabPaddingHorizontal,
                            }]}
                        >
                            {active ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                            <View style={styles.iconContainer}>
                                {icon}
                                {renderTabBadge(tab.badge, `${props.tabTestIdPrefix}${tab.id}-badge`)}
                            </View>
                            {metrics.showLabels ? (
                                <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]}>
                                    {tab.label}
                                </Text>
                            ) : null}
                        </Pressable>
                    );
                })}
            </Animated.View>
            {props.swipeReadout?.node ?? null}
        </FloatingTabBarSurface>
    );
}

function renderTabBadge(badge: CockpitTabBadge | undefined, testID: string): React.ReactNode {
    if (!badge) {
        return null;
    }
    if (badge.kind === 'count') {
        return <TabBadge variant="count" value={badge.value} testID={testID} />;
    }
    return (
        <TabBadge
            variant="diff"
            added={badge.added}
            removed={badge.removed}
            modifiedCount={badge.modifiedCount}
            testID={testID}
        />
    );
}
