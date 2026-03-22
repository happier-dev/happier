import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

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
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: theme.colors.surface,
    },
    tab: {
        flex: 1,
        paddingVertical: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: {
        backgroundColor: theme.colors.surface,
    },
    tabLabel: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    tabLabelActive: {
        color: theme.colors.text,
        fontWeight: '600',
    },
}));

function SegmentedTabBarInner<T extends string>(props: SegmentedTabBarProps<T>) {
    const styles = stylesheet;
    useUnistyles();

    return (
        <View style={styles.container}>
            <View style={styles.inner}>
                {props.tabs.map((tab) => {
                    const active = props.activeTabId === tab.id;
                    return (
                        <Pressable
                            key={tab.id}
                            testID={props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined}
                            onPress={() => props.onSelectTab(tab.id)}
                            style={[styles.tab, active ? styles.tabActive : null]}
                            accessibilityRole="button"
                        >
                            <Text style={[styles.tabLabel, active ? styles.tabLabelActive : null]}>{tab.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
