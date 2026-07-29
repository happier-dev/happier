import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 50,
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
    icon: keyof typeof Ionicons.glyphMap | Readonly<{
        render: (params: Readonly<{
            active: boolean;
            size: number;
            tintColor: string;
        }>) => React.ReactNode;
    }>;
    badge?: CockpitTabBadge;
}>;

type CockpitTabBarProps<TSurface extends string> = Readonly<{
    activeSurface: TSurface;
    barTestId: string;
    tabs: readonly CockpitTabBarTabDefinition<TSurface>[];
    tabTestIdPrefix: string;
    onSurfacePress: (surface: TSurface) => void;
}>;

export function CockpitTabBar<TSurface extends string>(props: CockpitTabBarProps<TSurface>) {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));

    return (
        <FloatingTabBarSurface testID={props.barTestId} bottomInset={insets.bottom} opaqueBand>
            <View style={[styles.innerContainer, { gap: metrics.rowGap }]}>
                {props.tabs.map((tab) => {
                    const active = tab.id === props.activeSurface;
                    const tintColor = active ? theme.colors.text.primary : theme.colors.text.secondary;
                    return (
                        <Pressable
                            key={tab.id}
                            testID={`${props.tabTestIdPrefix}${tab.id}`}
                            onPress={() => props.onSurfacePress(tab.id)}
                            hitSlop={8}
                            style={[styles.tab, { paddingVertical: metrics.tabPaddingVertical, paddingHorizontal: metrics.tabPaddingHorizontal }]}
                            accessibilityRole="tab"
                            accessibilityLabel={tab.label}
                            accessibilityState={{ selected: active }}
                        >
                            {active ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                            <View style={styles.iconContainer}>
                                {typeof tab.icon === 'string' ? (
                                    <Ionicons name={tab.icon} size={metrics.iconSize} color={tintColor} />
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
                        </Pressable>
                    );
                })}
            </View>
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
