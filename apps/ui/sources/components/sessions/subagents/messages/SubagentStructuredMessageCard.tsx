import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export function SubagentStructuredMessageCard(props: Readonly<{
    title: string;
    targetLabel: string;
    messageText: string;
    detailText?: string | null;
}>) {
    return (
        <View style={styles.container}>
            <Text selectable style={styles.headerText}>{props.title}</Text>
            <Text selectable style={styles.targetText}>{props.targetLabel}</Text>
            {props.detailText ? <Text selectable style={styles.detailText}>{props.detailText}</Text> : null}
            <Text selectable style={styles.bodyText}>{props.messageText}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 8,
    },
    headerText: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    targetText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    detailText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    bodyText: {
        color: theme.colors.text,
        fontSize: 13,
    },
}));
