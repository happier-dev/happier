import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { HappierPressable, HAPPIER_FOCUS_RING_DELEGATED_STYLE } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface, resolveFloatingTabBarAccessorySlotWidth } from '@/components/ui/navigation/FloatingTabBarSurface';
import { layout } from '@/components/ui/layout/layout';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { Typography } from '@/constants/Typography';
import { useSetting } from '@/sync/domains/state/storage';
import { useMainAppTabDefinitions } from './useMainAppTabDefinitions';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

export type { TabType };

type MainAppTabBarProps = Readonly<{
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
    /**
     * A sibling capsule rendered beside the pill (see `FloatingTabBarSurface`). Deliberately not a
     * tab: the bar stays a pure navigation control, and the caller owns which surfaces offer the
     * action.
     */
    trailingAccessory?: React.ReactNode;
    /** The bar's last slot, in the tab row but not a tab: the caller owns what it opens. */
    more?: (metrics: TabBarMetrics) => React.ReactNode;
}>;

/** Holds the accessory's cell on a tab without one, so the tabs stand in the same place on every tab. */
const EMPTY_ACCESSORY = <View />;

const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 1,
    },
    tabContent: {
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
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
        ...Typography.variant('micro'),
        marginTop: 3,
    },
    labelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.text.secondary,
    },
}));

export const MainAppTabBar = React.memo((props: MainAppTabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const tabs = useMainAppTabDefinitions();
    const windowWidth = useWindowDimensions().width;
    const baseMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    // Words size their own tabs; icons share what the "+" and its mirror leave.
    const metrics = baseMetrics.showLabels ? baseMetrics : { ...baseMetrics, tabMinWidth: resolveFloatingTabBarAccessorySlotWidth({
        windowWidth, maxWidth: layout.maxWidth, accessorySize: baseMetrics.iconSize + baseMetrics.tabPaddingVertical * 2,
        slots: tabs.length + (props.more ? 1 : 0), tabMinWidth: baseMetrics.tabMinWidth,
    }) };

    return (
        <FloatingTabBarSurface bottomInset={insets.bottom} trailingAccessory={props.trailingAccessory ?? EMPTY_ACCESSORY}>
            <View
                accessibilityRole="tablist"
                style={[styles.innerContainer, { gap: metrics.rowGap }]}
            >
                {tabs.map((tab) => {
                    const isActive = props.activeTab === tab.key;
                    const accessibilityLabel = tab.accessibilityLabel;
                    return (
                        <HappierPressable
                            key={tab.key}
                            testID={`tabbar-tab-${tab.key}`}
                            style={(state) => [styles.tab, {
                                minWidth: metrics.tabMinWidth,
                                paddingVertical: metrics.tabPaddingVertical,
                                paddingHorizontal: metrics.tabPaddingHorizontal,
                                borderRadius: metrics.activePillRadius,
                            }, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                            onPress={() => props.onTabPress(tab.key)}
                            accessibilityRole="tab"
                            accessibilityLabel={accessibilityLabel}
                            selected={isActive}
                        >
                            {isActive ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                            <View style={styles.tabContent}>
                                <Icon name={tab.icon} size={metrics.iconSize} color={isActive ? theme.colors.text.primary : theme.colors.text.secondary} />
                                {tab.badge && (
                                    tab.badge.kind === 'count' ? <TabBadge variant="count" value={tab.badge.value} /> : <TabBadge variant="dot" />
                                )}
                            </View>
                            {metrics.showLabels ? (
                                <Text style={[
                                    styles.label,
                                    isActive ? styles.labelActive : styles.labelInactive,
                                ]}>
                                    {tab.label}
                                </Text>
                            ) : null}
                        </HappierPressable>
                    );
                })}
                {props.more?.(metrics)}
            </View>
        </FloatingTabBarSurface>
    );
});
