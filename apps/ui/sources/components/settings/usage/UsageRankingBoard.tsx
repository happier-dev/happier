import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageAnalyticsLeaderRow } from '@/sync/api/account/usageAnalytics';

const styles = StyleSheet.create((theme) => ({
    board: {
        gap: 18,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 12,
    },
    rank: {
        width: 18,
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
    },
    labelWrap: {
        flex: 1,
        minWidth: 0,
    },
    labelPrimary: {
        ...Typography.default('semiBold'),
        fontSize: 42,
        lineHeight: 46,
        color: theme.colors.text,
    },
    labelSecondary: {
        ...Typography.default('semiBold'),
        fontSize: 30,
        lineHeight: 34,
        color: theme.colors.text,
    },
    labelCompact: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 28,
        color: theme.colors.text,
    },
    count: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
}));

function formatCount(value: number): string {
    return value.toLocaleString();
}

export function UsageRankingBoard(props: Readonly<{
    rows: readonly UsageAnalyticsLeaderRow[];
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const rows = props.rows.slice(0, 5);
    if (rows.length === 0) {
        return null;
    }

    return (
        <View style={styles.board}>
            {rows.map((row, index) => (
                <View key={row.key} style={styles.row}>
                    <Text style={[styles.rank, index === 0 ? { color: theme.colors.accent.orange } : null]}>
                        {index + 1}
                    </Text>
                    <View style={styles.labelWrap}>
                        <Text
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            style={
                                index === 0
                                    ? styles.labelPrimary
                                    : index < 3
                                        ? styles.labelSecondary
                                        : styles.labelCompact
                            }
                        >
                            {row.label}
                        </Text>
                    </View>
                    <Text style={styles.count}>
                        {formatCount(row.eventCount)} {t('usage.events')}
                    </Text>
                </View>
            ))}
        </View>
    );
}
