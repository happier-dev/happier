import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';

/**
 * The glyph size for an icon-only segmented bar.
 *
 * Owned here rather than at the call site because the bar reserves the matching slot height below:
 * the two numbers have to move together, and when they lived apart the icons were sized to the
 * LABEL's optical height (16) and then drawn at 14, so an iconic bar read lighter than the textual
 * one it replaced. A tab is a primary control in its pane — it takes the standard toolbar step.
 */
export const SEGMENTED_TAB_ICON_SIZE_PX = ICON_SIZE.md;

export type SegmentedTab<T extends string = string> = Readonly<{
    id: T;
    label: string;
    /**
     * Optional glyph. When every tab in a bar supplies one, the bar renders icons alone and the
     * label becomes the accessible name — a four-word row of text costs more vertical space than
     * the tabs are worth in a narrow docked panel. Mixed bars keep their labels, so this stays
     * opt-in and the other consumers are unaffected.
     */
    icon?: React.ReactNode;
    /**
     * Live count riding the tab's top-right corner; nothing renders at zero or below. A count, not
     * a word: an iconic bar in a narrow pane has no room for a second string, and the number is the
     * part that changes.
     */
    badgeCount?: number;
    /**
     * Overrides the accessible name. `label` is the default and is right for a plain tab; a tab
     * carrying a badge needs a name that says what the number means, because the badge itself is
     * unreadable to a screen reader.
     */
    accessibilityLabel?: string;
}>;

export type SegmentedTabBarProps<T extends string = string> = Readonly<{
    tabs: ReadonlyArray<SegmentedTab<T>>;
    activeTabId: T;
    onSelectTab: (tabId: T) => void;
    /** Optional testID prefix – tabs get `${testIDPrefix}:${tab.id}` */
    testIDPrefix?: string;
    /** Compact mode with reduced padding and smaller font */
    compact?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.segmentedControl.trackBackground,
        borderRadius: 9,
        padding: 2,
    },
    innerCompact: {
        borderRadius: 7,
    },
    tab: {
        flex: 1,
        paddingVertical: 7,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
    },
    tabCompact: {
        paddingVertical: 4,
        borderRadius: 5,
    },
    tabActive: {
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    tabLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    tabLabelCompact: {
        fontSize: 10,
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    // Sized to the glyph, not to the label it replaces. Holding the slot at the label's 16px optical
    // height kept an iconic bar exactly as tall as a textual one, which sounds right and is not: the
    // glyph then has to shrink below its own step to fit, and the bar reads weaker than the words.
    tabIcon: {
        alignItems: 'center',
        justifyContent: 'center',
        height: SEGMENTED_TAB_ICON_SIZE_PX,
    },
    // Only wraps content that actually carries a badge, so an unbadged bar keeps its current tree.
    tabBadgeAnchor: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

function SegmentedTabBarInner<T extends string>(props: SegmentedTabBarProps<T>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const compact = props.compact;
    // Icons replace labels only when the whole bar is iconic; a half-iconic row reads as broken.
    const iconOnly = props.tabs.length > 0 && props.tabs.every((tab) => tab.icon != null);

    return (
        <View style={styles.container}>
            <View
                style={[styles.inner, compact ? styles.innerCompact : null]}
                accessibilityRole="tablist"
            >
                {props.tabs.map((tab) => {
                    const active = props.activeTabId === tab.id;
                    const badgeCount = tab.badgeCount ?? 0;
                    const accessibleName = tab.accessibilityLabel ?? tab.label;
                    const content = iconOnly ? (
                        <View style={styles.tabIcon}>{tab.icon}</View>
                    ) : (
                        <Text style={[styles.tabLabel, compact ? styles.tabLabelCompact : null, active ? styles.tabLabelActive : null]}>{tab.label}</Text>
                    );
                    return (
                        <Pressable
                            key={tab.id}
                            testID={props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined}
                            onPress={() => props.onSelectTab(tab.id)}
                            style={[styles.tab, compact ? styles.tabCompact : null, active ? styles.tabActive : null]}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                            aria-selected={active}
                            // The label is still the accessible name when the glyph replaces it,
                            // and it doubles as the native tooltip on web.
                            accessibilityLabel={iconOnly || tab.accessibilityLabel ? accessibleName : undefined}
                            {...(iconOnly ? ({ title: accessibleName } as object) : {})}
                        >
                            {active ? (
                                <GradientSurface
                                    fallbackColor={theme.colors.segmentedControl.activeBackground}
                                    gradient={theme.colors.segmentedControl.activeGradient}
                                    borderRadius={compact ? 5 : 7}
                                    style={StyleSheet.absoluteFillObject}
                                />
                            ) : null}
                            {badgeCount > 0 ? (
                                <View style={styles.tabBadgeAnchor}>
                                    {content}
                                    <TabBadge
                                        variant="count"
                                        value={badgeCount}
                                        tone="neutral"
                                        testID={props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}:badge` : undefined}
                                    />
                                </View>
                            ) : content}
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
