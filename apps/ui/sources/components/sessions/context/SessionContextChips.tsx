import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export const SessionContextChips = React.memo(function SessionContextChips(props: Readonly<{
    machineLabel: string | null;
    pathLabel: string | null;
}>) {
    const { theme } = useUnistyles();

    if (!props.machineLabel && !props.pathLabel) return null;

    return (
        <View style={styles.row}>
            {props.machineLabel ? (
                <View style={styles.chip}>
                    <Ionicons name="desktop-outline" size={12} color={theme.colors.textSecondary} />
                    <Text style={styles.text} numberOfLines={1}>{props.machineLabel}</Text>
                </View>
            ) : null}
            {props.pathLabel ? (
                <View style={styles.chip}>
                    <Ionicons name="folder-open-outline" size={12} color={theme.colors.textSecondary} />
                    <Text style={styles.text} numberOfLines={1}>{props.pathLabel}</Text>
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        maxWidth: '100%',
    },
    text: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flexShrink: 1,
    },
}));
