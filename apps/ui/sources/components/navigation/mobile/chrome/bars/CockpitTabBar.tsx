import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable, HAPPIER_FOCUS_RING_DELEGATED_STYLE } from '@happier-dev/plugin-ui/presentation';
import { ScrollView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';


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
    // The leading tab stays put while the rest scroll; a short hairline marks where the track starts.
    trackDivider: {
        width: StyleSheet.hairlineWidth,
        alignSelf: 'center',
        height: 20,
        marginHorizontal: 2,
        backgroundColor: theme.colors.border.default,
    },
    track: {
        flexGrow: 0,
        flexShrink: 1,
    },
    trackContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));

export type CockpitTabBadge =
    | Readonly<{ kind: 'count'; value: number }>
    /** Something on this surface is waiting for the person (the Companion's amber dot). */
    | Readonly<{ kind: 'attention' }>
    | Readonly<{ kind: 'diff'; added: number; removed: number; changedFileCount: number }>;

export type CockpitTabBarTabDefinition<TSurface extends string> = Readonly<{
    id: TSurface;
    label: string;
    icon: IconName | Readonly<{
        render: (params: Readonly<{
            active: boolean;
            size: number;
            tintColor: string;
        }>) => React.ReactNode;
    }>;
    badge?: CockpitTabBadge;
    /** The announced name when it says more than the visible label ("Companion, 1 waiting for you"). */
    accessibilityLabel?: string;
}>;

type CockpitTabBarProps<TSurface extends string> = Readonly<{
    activeSurface: TSurface;
    barTestId: string;
    tabs: readonly CockpitTabBarTabDefinition<TSurface>[];
    tabTestIdPrefix: string;
    onSurfacePress: (surface: TSurface) => void;
    trailing?: React.ReactNode;
    /**
     * `scroll` when the tabs do not fit the capsule: the first tab stays fixed and the rest (with
     * `trailing`) scroll sideways under an edge fade. The bar decides this from its width
     * (`resolveFloatingTabBarSlotCount`); `fit` (the default) renders one row.
     */
    layout?: 'fit' | 'scroll';
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
    const insets = useChromeSafeAreaInsets();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const renderTab = (tab: CockpitTabBarTabDefinition<TSurface>) => {
        const active = tab.id === props.activeSurface;
        const tintColor = active ? theme.colors.text.primary : theme.colors.text.secondary;
        return (
            <HappierPressable
                key={tab.id}
                testID={`${props.tabTestIdPrefix}${tab.id}`}
                onPress={() => props.onSurfacePress(tab.id)}
                hitSlop={{ top: 8, bottom: 8 }}
                style={(state) => [styles.tab, {
                    minWidth: metrics.tabMinWidth,
                    paddingVertical: metrics.tabPaddingVertical,
                    paddingHorizontal: metrics.tabPaddingHorizontal,
                    borderRadius: metrics.activePillRadius,
                }, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                accessibilityRole="tab"
                accessibilityLabel={tab.accessibilityLabel ?? tab.label}
                selected={active}
                accessibilityActions={props.bandAccessibilityActions}
                onAccessibilityAction={props.onBandAccessibilityAction
                    ? (event) => props.onBandAccessibilityAction?.(event.nativeEvent.actionName)
                    : undefined}
            >
                {active ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                <View style={styles.iconContainer}>
                    {typeof tab.icon === 'string' ? (
                        <Icon name={tab.icon} size={metrics.iconSize} color={tintColor} />
                    ) : (
                        tab.icon.render({ active, size: metrics.iconSize, tintColor })
                    )}
                    {renderTabBadge(tab.badge, `${props.tabTestIdPrefix}${tab.id}-badge`)}
                </View>
                {metrics.showLabels ? (
                    <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]}>
                        {tab.label}
                    </Text>
                ) : null}
            </HappierPressable>
        );
    };
    const scrolls = props.layout === 'scroll' && props.tabs.length > 1;

    return (
        <FloatingTabBarSurface testID={props.barTestId} bottomInset={insets.bottom} opaqueBand>
            <Animated.View accessibilityRole="tablist" style={[styles.innerContainer, { gap: metrics.rowGap }]}>
                {scrolls ? (
                    <>
                        {props.tabs[0] ? renderTab(props.tabs[0]) : null}
                        <View style={styles.trackDivider} />
                        <CockpitTabBarTrack>
                            {props.tabs.slice(1).map(renderTab)}
                            {props.trailing}
                        </CockpitTabBarTrack>
                    </>
                ) : (
                    <>
                        {props.tabs.map(renderTab)}
                        {props.trailing}
                    </>
                )}
            </Animated.View>
        </FloatingTabBarSurface>
    );
}

/**
 * The scrolling part of an overflowing bar. Gesture-handler's ScrollView so it takes part in
 * arbitration with the band's pan, which stays off the horizontal axis while the bar scrolls
 * (`publishCockpitBarScrolls`). The fades say "more this way" only while there is more.
 */
function CockpitTabBarTrack(props: Readonly<{ children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 4, edgeThreshold: 2 });
    return (
        <View style={styles.track} onLayout={fades.onViewportLayout}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.trackContent}
                onContentSizeChange={fades.onContentSizeChange}
                onScroll={fades.onScroll}
                scrollEventThrottle={32}
            >
                {props.children}
            </ScrollView>
            <ScrollEdgeFades color={theme.colors.surface.base} size={16} edges={fades.visibility} />
        </View>
    );
}

export const CockpitTabBarAction = React.forwardRef<View, Readonly<{
    testID: string;
    label: string;
    icon: IconName;
    expanded?: boolean;
    /** The open surface lives behind this action (a tool opened from More): it reads as the active tab. */
    selected?: boolean;
    onPress: () => void;
}>>((props, ref) => {
    const { theme } = useUnistyles();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    return (
        <HappierPressable
            controlRef={(node) => {
                // The shared portable focus handle is this concrete native/Web View.
                const view = node as View | null;
                if (typeof ref === 'function') ref(view);
                else if (ref) ref.current = view;
            }}
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={{ top: 8, bottom: 8 }}
            style={(state) => [styles.tab, {
                minWidth: metrics.tabMinWidth,
                paddingVertical: metrics.tabPaddingVertical,
                paddingHorizontal: metrics.tabPaddingHorizontal,
                borderRadius: metrics.activePillRadius,
            }, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            accessibilityRole={props.selected ? 'tab' : 'button'}
            accessibilityLabel={props.label}
            expanded={props.expanded}
            selected={props.selected === true}
        >
            {props.selected ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
            <View style={styles.iconContainer}>
                <Icon name={props.icon} size={metrics.iconSize} color={props.selected ? theme.colors.text.primary : theme.colors.text.secondary} />
            </View>
            {metrics.showLabels ? (
                <Text style={[styles.label, props.selected ? styles.labelActive : styles.labelInactive]}>{props.label}</Text>
            ) : null}
        </HappierPressable>
    );
});
CockpitTabBarAction.displayName = 'CockpitTabBarAction';

function renderTabBadge(badge: CockpitTabBadge | undefined, testID: string): React.ReactNode {
    if (!badge) {
        return null;
    }
    if (badge.kind === 'count') {
        return <TabBadge variant="count" value={badge.value} tone="neutral" testID={testID} />;
    }
    if (badge.kind === 'attention') {
        return <TabBadge variant="dot" tone="attention" testID={testID} />;
    }
    return (
        <TabBadge
            variant="diff"
            added={badge.added}
            removed={badge.removed}
            changedFileCount={badge.changedFileCount}
            testID={testID}
        />
    );
}
