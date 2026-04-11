import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';

const Ionicons = SafeIonicons;

type UsageActionChipProps = Readonly<{
    label: string;
    testID?: string;
    iconName?: React.ComponentProps<typeof Ionicons>['name'];
    onPress: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    chip: {
        minHeight: 34,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 12,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    chipText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
}));

export const UsageActionChip = React.memo(function UsageActionChip(props: UsageActionChipProps) {
    const { label, testID, iconName, onPress } = props;
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            style={styles.chip}
            onPress={onPress}
        >
            {iconName ? (
                <Ionicons name={iconName} size={14} color={theme.colors.textSecondary} />
            ) : null}
            <View>
                <Text style={styles.chipText}>{label}</Text>
            </View>
        </Pressable>
    );
});
