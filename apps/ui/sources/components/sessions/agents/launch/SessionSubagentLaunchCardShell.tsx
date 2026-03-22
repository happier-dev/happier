import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 14,
        gap: 12,
    },
    header: {
        gap: 4,
    },
    title: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    subtitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
}));

export const SessionSubagentLaunchCardShell = React.memo((props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    children: React.ReactNode;
}>) => {
    const styles = stylesheet;

    return (
        <View testID={props.testID} style={styles.card}>
            <View style={styles.header}>
                <Text style={styles.title}>{props.title}</Text>
                <Text style={styles.subtitle}>{props.subtitle}</Text>
            </View>
            {props.children}
        </View>
    );
});
