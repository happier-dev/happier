import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { usageSignatureAccent } from './usageAccent';

interface UsageToggleChipProps {
    label: string;
    selected?: boolean;
    accentColor?: string;
    testID?: string;
    onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
    chip: {
        minHeight: 34,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
        paddingVertical: 7,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    chipSelected: {
        backgroundColor: theme.colors.surface.inset,
    },
    chipText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        letterSpacing: -0.04,
    },
    chipTextSelected: {
        color: theme.colors.text.primary,
    },
    chipDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
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
    const resolvedAccentColor = accentColor ?? usageSignatureAccent(theme);

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
                styles.chip,
                selected && styles.chipSelected,
            ]}
            onPress={onPress}
        >
            {selected ? <View style={[styles.chipDot, { backgroundColor: resolvedAccentColor }]} /> : null}
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {label}
            </Text>
        </Pressable>
    );
};
