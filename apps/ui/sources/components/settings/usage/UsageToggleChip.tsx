import React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';

interface UsageToggleChipProps {
    label: string;
    selected?: boolean;
    accentColor?: string;
    testID?: string;
    onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
    chip: {
        minHeight: 32,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chipSelected: {
        borderColor: 'transparent',
    },
    chipText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    chipTextSelected: {
        color: theme.colors.overlay.text,
    },
}));

export const UsageToggleChip: React.FC<UsageToggleChipProps> = ({
    label,
    selected = false,
    accentColor,
    testID,
    onPress,
}) => {
    const { theme } = useUnistyles();
    const backgroundColor = selected ? (accentColor ?? theme.colors.accent.blue) : theme.colors.surface;

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
                styles.chip,
                selected && styles.chipSelected,
                { backgroundColor },
            ]}
            onPress={onPress}
        >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {label}
            </Text>
        </Pressable>
    );
};
