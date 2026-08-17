import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const Ionicons = SafeIonicons;

type UsageActionChipProps = Readonly<{
    label: string;
    testID?: string;
    iconName?: IconName;
    accessory?: React.ReactNode;
    onPress: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    chip: {
        minHeight: 34,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    chipText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        letterSpacing: -0.04,
    },
}));

export const UsageActionChip = React.memo(function UsageActionChip(props: UsageActionChipProps) {
    const { label, testID, iconName, accessory, onPress } = props;
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            style={styles.chip}
            onPress={onPress}
        >
            {iconName ? (
                <Icon name={iconName} size={14} color={theme.colors.text.secondary} />
            ) : null}
            <View>
                <Text style={styles.chipText}>{label}</Text>
            </View>
            {accessory}
        </Pressable>
    );
});
