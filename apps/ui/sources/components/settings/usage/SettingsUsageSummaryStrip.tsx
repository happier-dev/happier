import * as React from 'react';
import { ActivityIndicator, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { CardGrid, CardGridColumn } from '@/components/ui/cards/CardGrid';
import { MetricCard } from '@/components/ui/cards/MetricCard';
import { t } from '@/text';
import type { UsageAnalyticsSummaryViewModel } from '@/sync/api/account/usageAnalytics';
import { shadowLevelStyle } from '@/shadowElevation';

import { UsageActivitySquareMatrix, UsageProgressMeter } from './UsageMiniVisuals';
import { formatUsageCurrency } from './formatUsageCurrency';
import { buildUsageSettingsRouteTarget } from './usageRouteParams';

type SettingsUsageSummaryStripProps = Readonly<{
    summary: UsageAnalyticsSummaryViewModel | null;
    isLoading?: boolean;
    errorMessage?: string | null;
    onOpenUsage?: (target: ReturnType<typeof buildUsageSettingsRouteTarget>) => void;
}>;

const styles = StyleSheet.create((theme) => ({
    stripWrapper: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 10,
    },
    stripBody: {
        gap: 14,
    },
    stripColumn: {
        minWidth: 0,
    },
    summaryCard: {
        minHeight: 148,
        justifyContent: 'space-between',
    },
    emptyState: {
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        paddingVertical: 18,
        alignItems: 'center',
        gap: 8,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    errorCard: {
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 4,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));

function formatTokens(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return value.toLocaleString();
}

export const SettingsUsageSummaryStrip = React.memo(function SettingsUsageSummaryStrip(props: SettingsUsageSummaryStripProps) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const { summary, isLoading = false, errorMessage = null, onOpenUsage } = props;

    if (!isLoading && !errorMessage && (summary == null || summary.hasData === false)) {
        return null;
    }

    const current = summary ?? {
        activeDays: 0,
        currentStreakDays: 0,
        totalTokens: 0,
        totalCost: 0,
        currency: 'USD',
        weekTokens: 0,
        weekCost: 0,
        topModel: null,
        topEngine: null,
        busiestWindowLabel: null,
        recentActivity: [],
        hasData: false,
    };

    const weekRatio = current.totalTokens > 0 ? current.weekTokens / current.totalTokens : 0;
    const topModel = current.topModel;
    const topEngine = current.topEngine;
    const topModelShare = topModel && current.totalTokens > 0
        ? topModel.totalTokens / current.totalTokens
        : 0;
    const columns = width >= 1180 ? 4 : width >= 720 ? 2 : 1;
    const topEngineShare = topEngine && current.totalTokens > 0
        ? topEngine.totalTokens / current.totalTokens
        : 0;

    return (
        <View style={styles.stripWrapper}>
            <View testID="settings-usage-summary-strip" style={styles.stripBody}>
                {isLoading && summary == null ? (
                    <View style={styles.emptyState}>
                        <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                        <Text style={styles.emptyText}>{t('common.loading')}</Text>
                    </View>
                ) : errorMessage ? (
                    <View style={styles.errorCard}>
                        <Text style={styles.emptyText}>{errorMessage}</Text>
                    </View>
                ) : current.hasData ? (
                    <CardGrid
                        columns={columns as 1 | 2 | 3 | 4}
                        collapseBelow="compact"
                        columnGap={12}
                        rowGap={12}
                    >
                        <CardGridColumn style={styles.stripColumn}>
                            <MetricCard
                                testID="settings-usage-summary-streak-card"
                                label={t('usage.summary.currentStreak')}
                                value={`${current.currentStreakDays}d`}
                                subtitle={t('usage.summary.currentStreakSubtitle', { count: current.activeDays })}
                                visual={(
                                    <UsageActivitySquareMatrix
                                        activity={current.recentActivity}
                                        squareCount={14}
                                        rowSize={7}
                                        color={theme.colors.accent.orange}
                                    />
                                )}
                                contentStyle={styles.summaryCard}
                                onPress={onOpenUsage
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: 'year',
                                        metric: 'tokens',
                                    }))
                                    : undefined}
                            />
                        </CardGridColumn>

                        <CardGridColumn style={styles.stripColumn}>
                            <MetricCard
                                testID="settings-usage-summary-week-card"
                                label={t('usage.summary.thisWeek')}
                                value={formatTokens(current.weekTokens)}
                                subtitle={`${formatUsageCurrency(current.weekCost, current.currency, {
                                    minimumFractionDigits: current.weekCost >= 100 ? 0 : current.weekCost >= 10 ? 1 : 2,
                                    maximumFractionDigits: current.weekCost >= 100 ? 0 : current.weekCost >= 10 ? 1 : 2,
                                })} · ${t('usage.summary.thisWeekSubtitle')}`}
                                visual={(
                                    <UsageProgressMeter
                                        ratio={weekRatio}
                                        color={theme.colors.accent.blue}
                                    />
                                )}
                                contentStyle={styles.summaryCard}
                                onPress={onOpenUsage
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: '7days',
                                        metric: 'tokens',
                                    }))
                                    : undefined}
                            />
                        </CardGridColumn>

                        <CardGridColumn style={styles.stripColumn}>
                            <MetricCard
                                testID="settings-usage-summary-model-card"
                                valueTone="compact"
                                label={t('usage.summary.topModel')}
                                value={topModel?.label ?? '—'}
                                subtitle={topModel ? `${formatTokens(topModel.totalTokens)} ${t('usage.tokens')}` : t('usage.noData')}
                                visual={(
                                    <UsageProgressMeter
                                        ratio={topModelShare}
                                        color={theme.colors.accent.purple}
                                    />
                                )}
                                contentStyle={styles.summaryCard}
                                onPress={onOpenUsage && topModel
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: '30days',
                                        metric: 'tokens',
                                        focus: {
                                            dimension: 'model',
                                            key: topModel.key,
                                            label: topModel.label,
                                        },
                                    }))
                                    : undefined}
                            />
                        </CardGridColumn>

                        <CardGridColumn style={styles.stripColumn}>
                            <MetricCard
                                testID="settings-usage-summary-engine-card"
                                valueTone="compact"
                                label={t('usage.summary.engine')}
                                value={topEngine?.label ?? '—'}
                                subtitle={current.busiestWindowLabel ?? t('usage.noData')}
                                visual={(
                                    <UsageProgressMeter
                                        ratio={topEngineShare}
                                        color={theme.colors.accent.green}
                                    />
                                )}
                                contentStyle={styles.summaryCard}
                                onPress={onOpenUsage && topEngine
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: '30days',
                                        metric: 'tokens',
                                        focus: {
                                            dimension: 'backendMode',
                                            key: topEngine.key,
                                            label: topEngine.label,
                                        },
                                    }))
                                    : undefined}
                            />
                        </CardGridColumn>
                    </CardGrid>
                ) : null}
            </View>
        </View>
    );
});
