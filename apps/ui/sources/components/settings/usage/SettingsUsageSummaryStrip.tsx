import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { UsageAnalyticsSummaryViewModel } from '@/sync/api/account/usageAnalytics';

import { UsageActivitySquareMatrix, UsageProgressMeter, UsageSparkBars } from './UsageMiniVisuals';
import { UsageStatCard } from './UsageStatCard';
import { formatUsageCurrency } from './formatUsageCurrency';
import { buildUsageSettingsRouteTarget } from './usageRouteParams';

type SettingsUsageSummaryStripProps = Readonly<{
    summary: UsageAnalyticsSummaryViewModel | null;
    isLoading?: boolean;
    errorMessage?: string | null;
    onOpenUsage?: (target: ReturnType<typeof buildUsageSettingsRouteTarget>) => void;
}>;

const styles = StyleSheet.create((theme) => ({
    stripBody: {
        paddingBottom: 16,
    },
    stripColumn: {
        minWidth: 170,
    },
    emptyState: {
        paddingVertical: 10,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    errorCard: {
        marginHorizontal: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.status.error,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 4,
    },
    errorTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: theme.colors.text,
    },
    errorSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
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
    const { summary, isLoading = false, errorMessage = null, onOpenUsage } = props;

    if (!isLoading && summary == null && !errorMessage) {
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

    return (
        <ItemGroup
            title={t('usage.summary.title')}
            containerStyle={{ overflow: 'visible' }}
        >
            <View testID="settings-usage-summary-strip" style={styles.stripBody}>
                {errorMessage ? (
                    <View style={styles.errorCard}>
                        <Text style={styles.errorTitle}>{t('usage.summary.title')}</Text>
                        <Text style={styles.errorSubtitle}>{errorMessage}</Text>
                    </View>
                ) : current.hasData ? (
                    <ItemGroupColumns
                        columns={4}
                        collapseBelow="medium"
                        paddingHorizontal={16}
                        paddingVertical={0}
                        columnGap={12}
                        rowGap={12}
                    >
                        <ItemGroupColumn style={styles.stripColumn}>
                            <UsageStatCard
                                testID="settings-usage-summary-streak-card"
                                variant="inset"
                                label={t('usage.summary.currentStreak')}
                                value={`${current.currentStreakDays}d`}
                                subtitle={t('usage.summary.currentStreakSubtitle', { count: current.activeDays })}
                                visual={(
                                    <UsageActivitySquareMatrix
                                        activity={current.recentActivity}
                                        color={theme.colors.accent.orange}
                                    />
                                )}
                                accentColor={theme.colors.accent.orange}
                                onPress={onOpenUsage
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: '30days',
                                        metric: 'tokens',
                                    }))
                                    : undefined}
                            />
                        </ItemGroupColumn>

                        <ItemGroupColumn style={styles.stripColumn}>
                            <UsageStatCard
                                testID="settings-usage-summary-week-card"
                                variant="inset"
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
                                accentColor={theme.colors.accent.blue}
                                onPress={onOpenUsage
                                    ? () => onOpenUsage(buildUsageSettingsRouteTarget({
                                        period: '7days',
                                        metric: 'tokens',
                                    }))
                                    : undefined}
                            />
                        </ItemGroupColumn>

                        <ItemGroupColumn style={styles.stripColumn}>
                            <UsageStatCard
                                testID="settings-usage-summary-model-card"
                                variant="inset"
                                valueTone="compact"
                                label={t('usage.summary.topModel')}
                                value={topModel?.label ?? '—'}
                                subtitle={topModel ? `${formatTokens(topModel.totalTokens)} ${t('usage.tokens').toLowerCase()}` : t('usage.noData')}
                                visual={(
                                    <UsageProgressMeter
                                        ratio={topModelShare}
                                        color={theme.colors.accent.purple}
                                    />
                                )}
                                accentColor={theme.colors.accent.purple}
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
                        </ItemGroupColumn>

                        <ItemGroupColumn style={styles.stripColumn}>
                            <UsageStatCard
                                testID="settings-usage-summary-engine-card"
                                variant="inset"
                                valueTone="compact"
                                label={t('usage.summary.engine')}
                                value={topEngine?.label ?? '—'}
                                subtitle={current.busiestWindowLabel ?? (topEngine ? `${formatTokens(topEngine.totalTokens)} ${t('usage.tokens').toLowerCase()}` : t('usage.noData'))}
                                visual={(
                                    <UsageSparkBars
                                        activity={current.recentActivity}
                                        color={theme.colors.accent.green}
                                    />
                                )}
                                accentColor={theme.colors.accent.green}
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
                        </ItemGroupColumn>
                    </ItemGroupColumns>
                ) : (
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyText}>{t('usage.noData')}</Text>
                    </View>
                )}
            </View>
        </ItemGroup>
    );
});
