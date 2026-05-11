import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export function SessionContextChips(props: Readonly<{
    machineLabel: string | null;
    pathLabel: string | null;
}>) {
    const { theme } = useUnistyles();

    if (!props.machineLabel && !props.pathLabel) return null;

    return (
        <View style={styles.row}>
            {props.machineLabel ? (
                <View style={styles.chip}>
                    <Ionicons name="desktop-outline" size={12} color={theme.colors.text.secondary} />
                    <Text style={styles.text} numberOfLines={1}>{props.machineLabel}</Text>
                </View>
            ) : null}
            {props.pathLabel ? (
                <View style={styles.chip}>
                    <Ionicons name="folder-open-outline" size={12} color={theme.colors.text.secondary} />
                    <Text style={styles.text} numberOfLines={1}>{props.pathLabel}</Text>
                </View>
            ) : null}
        </View>
    );
}

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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        maxWidth: '100%',
    },
    text: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
}));
