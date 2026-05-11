import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingVertical: 24,
        gap: 10,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    body: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

export function AutomationsEmptyState(props: Readonly<{ title: string; body: string }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <Ionicons name="timer-outline" size={56} color={theme.colors.text.secondary} />
            <Text style={styles.title}>{props.title}</Text>
            <Text style={styles.body}>{props.body}</Text>
        </View>
    );
}
