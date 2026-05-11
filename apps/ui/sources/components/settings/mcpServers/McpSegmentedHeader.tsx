import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export const McpSegmentedHeader = React.memo(function McpSegmentedHeader(props: Readonly<{
    title: string;
    subtitle: string;
    tabs: ReadonlyArray<{ id: string; label: string }>;
    activeTabId: string;
    onSelectTab: (tabId: any) => void;
    testIDPrefix: string;
}>) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.wrapper}>
            <View style={styles.container}>
                <View style={styles.copyBlock}>
                    <Text style={[styles.title, { color: theme.colors.text.secondary }]}>
                        {props.title}
                    </Text>
                    <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]}>
                        {props.subtitle}
                    </Text>
                </View>
                <View style={styles.tabsContainer}>
                    <SegmentedTabBar
                        tabs={props.tabs}
                        activeTabId={props.activeTabId}
                        onSelectTab={props.onSelectTab}
                        testIDPrefix={props.testIDPrefix}
                    />
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    wrapper: {
        alignItems: 'center',
    },
    container: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: 16,
        paddingTop: 18,
        paddingBottom: 12,
        gap: 10,
    },
    copyBlock: {
        paddingHorizontal: 8,
        gap: 4,
    },
    title: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        textTransform: 'uppercase',
        fontWeight: '500',
        letterSpacing: 0.1,
    },
    subtitle: {
        fontSize: 14,
        lineHeight: 20,
    },
    tabsContainer: {
        paddingHorizontal: 8,
    },
}));
