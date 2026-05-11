import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';

export type SegmentedTab<T extends string = string> = Readonly<{
    id: T;
    label: string;
}>;

export type SegmentedTabBarProps<T extends string = string> = Readonly<{
    tabs: ReadonlyArray<SegmentedTab<T>>;
    activeTabId: T;
    onSelectTab: (tabId: T) => void;
    /** Optional testID prefix – tabs get `${testIDPrefix}:${tab.id}` */
    testIDPrefix?: string;
    /** Compact mode with reduced padding and smaller font */
    compact?: boolean;
    /** Optional active-label style override for specific consumers */
    activeLabelStyle?: StyleProp<TextStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.segmentedControl.trackBackground,
        borderRadius: 9,
        padding: 2,
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
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
        overflow: 'hidden',
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
}));

function SegmentedTabBarInner<T extends string>(props: SegmentedTabBarProps<T>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const compact = props.compact;

    return (
        <View style={styles.container}>
            <View
                style={[styles.inner, compact ? styles.innerCompact : null]}
                accessibilityRole="tablist"
            >
                {props.tabs.map((tab) => {
                    const active = props.activeTabId === tab.id;
                    return (
                        <Pressable
                            key={tab.id}
                            testID={props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined}
                            onPress={() => props.onSelectTab(tab.id)}
                            style={[styles.tab, compact ? styles.tabCompact : null, active ? styles.tabActive : null]}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                            aria-selected={active}
                        >
                            {active ? (
                                <GradientSurface
                                    fallbackColor={theme.colors.segmentedControl.activeBackground}
                                    gradient={theme.colors.segmentedControl.activeGradient}
                                    borderRadius={compact ? 5 : 7}
                                    style={StyleSheet.absoluteFillObject}
                                />
                            ) : null}
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[
                                    styles.tabLabel,
                                    compact ? styles.tabLabelCompact : null,
                                    active ? styles.tabLabelActive : null,
                                    active ? props.activeLabelStyle : null,
                                ]}
                            >
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
