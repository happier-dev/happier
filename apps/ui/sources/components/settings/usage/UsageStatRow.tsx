import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const Ionicons = SafeIonicons;

/**
 * The ONE compact label/value row for every usage surface (Task 2). Before this,
 * the settings-home banner (`SettingsUsageSummaryStrip`) and the usage page
 * (`InsightsSection`) each hand-rolled their own label/value row at different
 * type sizes and spacing (14px airy rows vs 13px rows). This is their single
 * owner: 13px secondary label · 13px tabular primary value · 8px vertical
 * padding · 36px min row height — a compact, scannable standard, no per-surface
 * forks. The pivot's richer ranked row (rank + sparkline + pill) reuses the same
 * density tokens below without inheriting this row's simple two-slot layout.
 */
export const USAGE_ROW_PAD_V = 8;
export const USAGE_ROW_MIN_HEIGHT = 36;

type UsageStatRowProps = Readonly<{
    label: string;
    value: string;
    icon?: IconName;
    testID?: string;
}>;

export const UsageStatRow = React.memo(function UsageStatRow({ label, value, icon, testID }: UsageStatRowProps) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.row} testID={testID}>
            {icon ? (
                <View style={styles.icon}>
                    <Icon name={icon} size={16} color={theme.colors.text.tertiary} />
                </View>
            ) : null}
            <Text style={styles.label} numberOfLines={1}>{label}</Text>
            <Text style={styles.value} numberOfLines={1}>{value}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: USAGE_ROW_PAD_V,
        minHeight: USAGE_ROW_MIN_HEIGHT,
    },
    icon: {
        width: 20,
        alignItems: 'center',
    },
    label: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        letterSpacing: -0.05,
        color: theme.colors.text.secondary,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        letterSpacing: -0.1,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
    },
}));
