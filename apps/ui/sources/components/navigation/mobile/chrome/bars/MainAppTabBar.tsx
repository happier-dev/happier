import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';

import { resolveFloatingTabBarAccessorySlotWidth, resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { layout } from '@/components/ui/layout/layout';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';
import { useMainAppTabDefinitions } from './useMainAppTabDefinitions';

export type { TabType };

/** The destinations the person keeps on the bar (Bar in Customize), in their order, after the tabs. */
export type MainAppTabBarDestinations = Readonly<{
    tabs: readonly CockpitTabBarTabDefinition<string>[];
    onPress: (id: string) => void;
}>;

type MainAppTabBarProps = Readonly<{
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
    /**
     * A sibling capsule rendered beside the pill (see `FloatingTabBarSurface`). Deliberately not a
     * tab: the bar stays a pure navigation control, and the caller owns which surfaces offer the
     * action.
     */
    trailingAccessory?: React.ReactNode;
    destinations?: MainAppTabBarDestinations;
    /** The bar's last slot, in the tab row but not a tab: the caller owns what it opens. */
    more?: (metrics: TabBarMetrics) => React.ReactNode;
}>;

/** Holds the accessory's cell on a tab without one, so the tabs stand in the same place on every tab. */
const EMPTY_ACCESSORY = <View />;
const NO_DESTINATIONS: readonly CockpitTabBarTabDefinition<string>[] = [];

/**
 * The phone's main bar (owner 11-06): the tabs, then the destinations kept on the bar, then More, through the
 * one phone bar. A Bar item never moves to More on its own; when they do not fit, the bar scrolls with
 * Sessions fixed.
 */
export const MainAppTabBar = React.memo((props: MainAppTabBarProps) => {
    const definitions = useMainAppTabDefinitions();
    const windowWidth = useWindowDimensions().width;
    const baseMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const destinations = props.destinations?.tabs ?? NO_DESTINATIONS;
    const accessorySize = baseMetrics.iconSize + baseMetrics.tabPaddingVertical * 2;
    const slots = definitions.length + destinations.length + (props.more ? 1 : 0);
    // The "+" keeps its square and only its centring mirror gives way, so the items have the rest.
    const scrolls = slots > resolveFloatingTabBarSlotCount({
        windowWidth, maxWidth: layout.maxWidth, tabMinWidth: baseMetrics.tabMinWidth, accessorySize,
    });
    // Fitting icons share what the "+" and its mirror leave; scrolling tabs keep their own width.
    const metrics = baseMetrics.showLabels || scrolls ? baseMetrics : { ...baseMetrics, tabMinWidth: resolveFloatingTabBarAccessorySlotWidth({
        windowWidth, maxWidth: layout.maxWidth, accessorySize, slots, tabMinWidth: baseMetrics.tabMinWidth,
    }) };
    const tabs: readonly CockpitTabBarTabDefinition<string>[] = [...definitions.map((tab) => ({
        id: tab.key, label: tab.label, icon: tab.icon, accessibilityLabel: tab.accessibilityLabel, badge: tab.badge,
    })), ...destinations];
    const onPress = (id: string) => {
        const tab = definitions.find((definition) => definition.key === id);
        if (tab) props.onTabPress(tab.key);
        else props.destinations?.onPress(id);
    };
    return (
        <CockpitTabBar
            activeSurface={props.activeTab}
            barTestId="main-app-tabbar"
            tabs={tabs}
            tabTestIdPrefix="tabbar-tab-"
            layout={scrolls ? 'scroll' : 'fit'}
            metrics={metrics}
            opaqueBand={false}
            trailingAccessory={props.trailingAccessory ?? EMPTY_ACCESSORY}
            onSurfacePress={onPress}
            trailing={props.more?.(metrics)}
        />
    );
});
