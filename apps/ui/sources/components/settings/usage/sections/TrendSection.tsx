import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageFilterState, UsageMetric } from '@/sync/api/account/usageAnalytics';
import { usageSignatureAccent } from '../usageAccent';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { UsageVolumeBarChart } from '../UsageVolumeBarChart';

interface TrendSectionProps {
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    isRefreshing: boolean;
    onMetricChange: (metric: UsageMetric) => void;
}

const styles = StyleSheet.create((theme) => ({
    sectionBody: {
        gap: 12,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    sectionSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    toggleWrap: {
        // Size the segmented toggle to its content so a 6-char label ("Tokens")
        // never ellipsizes to "Tok…" (D-R3-3). Do not let it collapse to
        // min-content inside the space-between header row.
        alignSelf: 'flex-start',
        flexShrink: 0,
    },
    chartWrap: {},
}));

export const TrendSection: React.FC<TrendSectionProps> = ({
    viewModel,
    filters,
    isRefreshing,
    onMetricChange,
}) => {
    const { theme } = useUnistyles();
    const hasTrendData = viewModel.trend.length > 0;
    const metricTabs = React.useMemo(() => ([
        { id: 'tokens' as const, label: t('usage.tokens') },
        { id: 'cost' as const, label: t('usage.cost') },
    ]), []);

    return (
        <View style={styles.sectionBody}>
            <View style={styles.cardHeader}>
                <View style={styles.toggleWrap}>
                    <SegmentedTabBar
                        testIDPrefix="usage-trend-metric"
                        tabs={metricTabs}
                        activeTabId={filters.metric}
                        onSelectTab={(tabId) => onMetricChange(tabId)}
                        compact
                        slidingThumb
                        segmentSizing="content"
                    />
                </View>
                {isRefreshing ? (
                    <ActivitySpinner size="small" color={usageSignatureAccent(theme)} />
                ) : null}
            </View>
            <View style={styles.chartWrap}>
                {hasTrendData ? (
                    <UsageVolumeBarChart
                        testID="usage-trend-chart"
                        points={viewModel.trend}
                        metric={filters.metric}
                        currency={viewModel.costPresentation.currency}
                    />
                ) : (
                    <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                        <Text style={styles.sectionSubtitle}>{t('usage.noData.title')}</Text>
                    </View>
                )}
            </View>
        </View>
    );
};
