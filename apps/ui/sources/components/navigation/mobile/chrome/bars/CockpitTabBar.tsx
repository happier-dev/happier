import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        backgroundColor: theme.colors.surface.base,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-around',
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 4,
        zIndex: 1,
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

    return (
        <View testID={props.barTestId} style={[styles.outerContainer, { paddingBottom: insets.bottom }]}>
            <View style={styles.innerContainer}>
                {props.tabs.map((tab) => {
                    const active = tab.id === props.activeSurface;
                    const tintColor = active ? theme.colors.text.primary : theme.colors.text.secondary;
                    return (
                        <Pressable
                            key={tab.id}
                            testID={`${props.tabTestIdPrefix}${tab.id}`}
                            onPress={() => props.onSurfacePress(tab.id)}
                            hitSlop={8}
                            style={styles.tab}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                        >
                            {typeof tab.icon === 'string' ? (
                                <Ionicons name={tab.icon} size={22} color={tintColor} />
                            ) : (
                                tab.icon.render({ active, size: 22, tintColor })
                            )}
                            <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
