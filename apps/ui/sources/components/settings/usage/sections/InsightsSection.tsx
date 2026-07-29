import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import type {
    UsageAnalyticsInsightsViewModel,
    UsageCacheSavingsViewModel,
    UsageFilterState,
} from '@/sync/api/account/usageAnalytics';
import { formatCount } from './shared';
import { EntranceView } from './EntranceView';
import { UsageStatRow } from '../UsageStatRow';

const Ionicons = SafeIonicons;

interface InsightsSectionProps {
    period: UsageFilterState['period'];
    insights: UsageAnalyticsInsightsViewModel;
    cacheSavings: UsageCacheSavingsViewModel | null;
}

const styles = StyleSheet.create(() => ({
    rows: {
        gap: 2,
    },
}));

interface RowModel {
    key: string;
    testID: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    value: string;
}

/**
 * Band 6 "Efficiency" insights — icon + label + tabular value ROWS inside the
 * surface (D-R2-3), replacing the mini-cards. The value carries the whole
 * signal (streak in days, busiest window, models tried, cache savings USD-first
 * when present) so there is no mismatched caption underneath.
 */
export const InsightsSection: React.FC<InsightsSectionProps> = ({ insights, cacheSavings }) => {
    const rows: RowModel[] = [
        {
            key: 'streak',
            testID: 'usage-insight-streak',
            icon: 'flame-outline',
            label: t('usage.summary.currentStreak'),
            value: t('usage.daysShort', { count: insights.currentStreakDays }),
        },
        {
            key: 'busiest',
            testID: 'usage-insight-busiest',
            icon: 'time-outline',
            label: t('usage.busiestWindow'),
            value: insights.busiestHour?.label ?? t('usage.noData.title'),
        },
        {
            key: 'models',
            testID: 'usage-insight-models-tried',
            icon: 'cube-outline',
            label: t('usage.modelsTried'),
            value: insights.favoriteModel
                ? `${formatCount(insights.modelsTried)} · ${insights.favoriteModel.label}`
                : formatCount(insights.modelsTried),
        },
    ];

    if (cacheSavings) {
        rows.push({
            key: 'cache',
            testID: 'usage-insight-cache-savings',
            icon: 'flash-outline',
            label: t('usage.cacheSavings'),
            value: cacheSavings.cacheSavingsUsd !== null
                ? formatUsageCost(cacheSavings.cacheSavingsUsd, 'USD')
                : `${formatTokenCount(cacheSavings.cachedReadTokens)} ${t('usage.tokens')}`,
        });
    }

    return (
        <View style={styles.rows} testID="usage-insights-section">
            {rows.map((row, index) => (
                <EntranceView key={row.key} entranceId={`usage-insight-${row.key}`} index={index}>
                    <UsageStatRow testID={row.testID} icon={row.icon} label={row.label} value={row.value} />
                </EntranceView>
            ))}
        </View>
    );
};
