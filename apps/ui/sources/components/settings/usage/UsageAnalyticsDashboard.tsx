import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { CardGrid, CardGridColumn, CardSection, MetricCard, PanelCard } from '@/components/ui/cards';
import { Text } from '@/components/ui/text/Text';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { formatUsageWeekdayHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { USAGE_PERIODS, getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { UsageBar } from './UsageBar';
import { UsageActivityPoster } from './UsageActivityPoster';
import { UsageExportActions } from './UsageExportActions';
import { UsageRankingBoard } from './UsageRankingBoard';
import { UsageRecapHighlightsSection } from './UsageRecapHighlightsSection';
import { UsageTimelineSection } from './UsageTimelineSection';
import { UsageToggleChip } from './UsageToggleChip';
import { UsageVolumeBubbleChart } from './UsageVolumeBubbleChart';
import { buildUsageCurrentStreakSubtitle } from './buildUsageCurrentStreakSubtitle';
import { formatUsageCurrency } from './formatUsageCurrency';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import type {
    UsageAnalyticsActivityViewModel,
    UsageAnalyticsInsightsViewModel,
    UsageAnalyticsLeaderRow,
    UsageAnalyticsLeaderSections,
    UsageAnalyticsViewModel,
    UsageBreakdownRow,
    UsageDimension,
    UsageCostMode,
    UsageFilterState,
    UsageFocus,
    UsageMetric,
} from '@/sync/api/account/usageAnalytics';

const Ionicons = SafeIonicons;

interface UsageAnalyticsDashboardProps {
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string;
    isRefreshing?: boolean;
    errorMessage?: string | null;
    onPeriodChange: (period: UsageFilterState['period']) => void;
    onMetricChange: (metric: UsageMetric) => void;
    onCostModeChange: (mode: UsageCostMode) => void;
    onFocusChange: (focus: UsageFocus | null) => void;
    onRetry?: () => void;
}

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        paddingBottom: 24,
        paddingTop: 16,
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    sectionBody: {
        paddingBottom: 16,
        gap: 12,
    },
    summaryDeck: {
        gap: 12,
    },
    summaryHeroCard: {
        minHeight: 244,
    },
    summarySupportCard: {
        minHeight: 116,
    },
    filterBody: {
        paddingHorizontal: 16,
        paddingBottom: 16,
        gap: 12,
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    actionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    gridColumn: {
        minWidth: 0,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingHorizontal: 16,
    },
    sectionSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    chartWrap: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    heatmapGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    heatmapSquare: {
        width: 12,
        height: 12,
        borderRadius: 4,
        backgroundColor: theme.colors.groupped.background,
    },
    heatmapSquareActive: {
        backgroundColor: theme.colors.accent.orange,
    },
    leaderRowStack: {
        gap: 8,
    },
    errorCard: {
        marginHorizontal: 16,
        marginBottom: 12,
        padding: 14,
        borderRadius: 18,
        backgroundColor: theme.colors.surface,
        gap: 10,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    errorText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
    retryButton: {
        alignSelf: 'flex-start',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.status.error,
    },
    retryText: {
        color: theme.colors.surface,
        fontSize: 13,
        fontWeight: '700',
    },
    emptyCard: {
        marginHorizontal: 16,
        padding: 18,
        borderRadius: 18,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
        gap: 8,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text,
    },
    emptySubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    refreshBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    refreshText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    sectionMiniLabel: {
        fontSize: 11,
        color: theme.colors.groupped.sectionTitle,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
    },
}));

function dimensionLabel(dimension: UsageDimension): string {
    switch (dimension) {
        case 'provider':
            return t('settingsProviders.title');
        case 'model':
            return t('settingsProviders.models');
        case 'session':
            return t('settings.sessions');
        case 'project':
            return t('tabs.projects');
        case 'workspace':
            return t('settings.workspaces');
        case 'backendMode':
            return t('usage.summary.engine');
        case 'source':
            return t('usage.source');
    }
}

function formatTokens(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return value.toLocaleString();
}

function formatCost(value: number, currency: string): string {
    return formatUsageCurrency(value, currency, {
        minimumFractionDigits: value > 0 && value < 10 ? 2 : 0,
        maximumFractionDigits: 4,
    });
}

function formatCount(value: number): string {
    return value.toLocaleString();
}

function resolveCostModeLabel(mode: UsageCostMode): string {
    if (mode === 'reported') return t('usage.reported');
    if (mode === 'estimated') return t('usage.estimated');
    return t('usage.auto');
}

function renderActivityHeatmap(calendarDays: UsageAnalyticsActivityViewModel['calendarDays']) {
    const peak = Math.max(...calendarDays.map((day) => day.eventCount), 1);
    return (
        <View style={styles.heatmapGrid}>
            {calendarDays.slice(-14).map((day) => (
                <View
                    key={day.date}
                    style={[
                        styles.heatmapSquare,
                        day.eventCount > 0 ? styles.heatmapSquareActive : null,
                        day.eventCount > 0 ? { opacity: Math.min(1, 0.35 + (day.eventCount / peak) * 0.65) } : null,
                    ]}
                />
            ))}
        </View>
    );
}

function renderLeaderRows(rows: readonly UsageAnalyticsLeaderRow[]) {
    const maxValue = Math.max(...rows.map((row) => row.eventCount), 1);
    return (
        <View style={styles.leaderRowStack}>
            {rows.slice(0, 3).map((row) => (
                <UsageBar
                    key={row.key}
                    label={row.label}
                    value={row.eventCount}
                    maxValue={maxValue}
                    showPercentage={false}
                    height={6}
                />
            ))}
        </View>
    );
}

function summarizeLeaders(rows: readonly UsageAnalyticsLeaderRow[]): string {
    if (rows.length === 0) {
        return t('usage.noData');
    }
    return `${rows[0].label} · ${formatCount(rows[0].eventCount)} ${t('usage.events')}`;
}

function renderBreakdownSection(
    title: string,
    rows: UsageBreakdownRow[],
    metric: UsageMetric,
    focus: UsageFocus | null,
    onFocusChange: (focus: UsageFocus | null) => void,
    getColorForDimension: (dimension: UsageBreakdownRow['dimension']) => string,
): React.ReactElement | null {
    if (rows.length === 0) {
        return null;
    }

    const maxValue = Math.max(...rows.map((row) => metric === 'tokens' ? row.totalTokens : row.totalCost), 1);

    return (
        <CardSection title={title}>
            <PanelCard padding="md">
                <View style={{ gap: 10 }}>
                    {rows.slice(0, 5).map((row) => {
                        const selected = focus?.dimension === row.dimension && focus.key === row.key;
                        return (
                            <UsageBar
                                key={`${row.dimension}:${row.key}`}
                                testID={`usage-breakdown-row-${row.dimension}-${row.key}`}
                                label={row.label}
                                value={metric === 'tokens' ? row.totalTokens : row.totalCost}
                                maxValue={maxValue}
                                color={getColorForDimension(row.dimension)}
                                active={selected}
                                showPercentage={false}
                                onPress={row.dimension === 'bucket' ? undefined : () => {
                                    if (row.dimension === 'bucket') {
                                        return;
                                    }
                                    onFocusChange({
                                        dimension: row.dimension,
                                        key: row.key,
                                        label: row.label,
                                    });
                                }}
                            />
                        );
                    })}
                </View>
            </PanelCard>
        </CardSection>
    );
}

function renderInsightSection(
    period: UsageFilterState['period'],
    insights: UsageAnalyticsInsightsViewModel,
): React.ReactElement {
    return (
        <CardSection title={t('usage.insights')} testID="usage-insights-section">
            <CardGrid
                columns={4}
                collapseBelow="medium"
                columnGap={12}
                rowGap={12}
            >
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-insight-current-streak"
                        label={t('usage.summary.currentStreak')}
                        value={`${insights.currentStreakDays}d`}
                        subtitle={buildUsageCurrentStreakSubtitle(period, insights.activeDays)}
                    />
                </CardGridColumn>
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-insight-active-days"
                        label={t('usage.activeDays')}
                        value={formatCount(insights.activeDays)}
                        subtitle={t('usage.summary.thisWeekSubtitle')}
                    />
                </CardGridColumn>
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-insight-models-tried"
                        label={t('usage.modelsTried')}
                        value={formatCount(insights.modelsTried)}
                        subtitle={insights.favoriteModel ? insights.favoriteModel.label : t('usage.noData')}
                    />
                </CardGridColumn>
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-insight-favorite-model-changes"
                        label={t('usage.favoriteModelChanges')}
                        value={formatCount(insights.favoriteModelChangeCount)}
                        subtitle={insights.favoriteModel ? insights.favoriteModel.label : t('usage.noData')}
                    />
                </CardGridColumn>
            </CardGrid>
        </CardSection>
    );
}

function renderActivitySection(
    activity: UsageAnalyticsActivityViewModel,
    insights: UsageAnalyticsInsightsViewModel,
): React.ReactElement | null {
    if (activity.calendarDays.length === 0 && activity.weekdayHourBuckets.length === 0) {
        return null;
    }

    const busiestBucket = [...activity.weekdayHourBuckets].sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;

    return (
        <CardSection title={t('usage.activity')} testID="usage-activity-section">
            <CardGrid
                columns={2}
                collapseBelow="medium"
                columnGap={12}
                rowGap={12}
            >
                <CardGridColumn span={2} style={styles.gridColumn}>
                    <PanelCard>
                        <UsageActivityPoster activity={activity} insights={insights} />
                    </PanelCard>
                </CardGridColumn>
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-activity-calendar"
                        label={t('usage.activeDays')}
                        value={formatCount(insights.activeDays)}
                        subtitle={t('usage.activityCalendarSubtitle')}
                        visual={renderActivityHeatmap(activity.calendarDays)}
                    />
                </CardGridColumn>
                <CardGridColumn style={styles.gridColumn}>
                    <MetricCard
                        testID="usage-activity-rhythm"
                        label={t('usage.busiestWindow')}
                        value={busiestBucket ? formatUsageWeekdayHourLabel(busiestBucket.weekday, busiestBucket.hour) : t('usage.noData')}
                        subtitle={insights.busiestHour?.label ?? t('usage.noData')}
                        visual={
                            <View style={styles.leaderRowStack}>
                                {[...activity.weekdayHourBuckets]
                                    .sort((left, right) => right.eventCount - left.eventCount)
                                    .slice(0, 4)
                                    .map((bucket) => (
                                    <UsageBar
                                        key={`${bucket.weekday}:${bucket.hour}`}
                                        label={formatUsageWeekdayHourLabel(bucket.weekday, bucket.hour)}
                                        value={bucket.eventCount}
                                        maxValue={Math.max(...activity.weekdayHourBuckets.map((entry) => entry.eventCount), 1)}
                                        showPercentage={false}
                                        height={6}
                                    />
                                ))}
                            </View>
                        }
                        valueTone="compact"
                    />
                </CardGridColumn>
            </CardGrid>
        </CardSection>
    );
}

function renderLeadersSection(leaders: UsageAnalyticsLeaderSections): React.ReactElement | null {
    const sections: Array<{ key: string; title: string; rows: UsageAnalyticsLeaderRow[] }> = [
        { key: 'providers', title: t('settingsProviders.title'), rows: leaders.providers },
        { key: 'models', title: t('settingsProviders.models'), rows: leaders.models },
        { key: 'sessions', title: t('settings.sessions'), rows: leaders.sessions },
        { key: 'projects', title: t('tabs.projects'), rows: leaders.projects },
        { key: 'workspaces', title: t('settings.workspaces'), rows: leaders.workspaces },
        { key: 'engines', title: t('usage.summary.engine'), rows: leaders.engines },
    ].filter((section) => section.rows.length > 0);

    if (sections.length === 0) {
        return null;
    }

    return (
        <CardSection title={t('usage.leaders')} testID="usage-leaders-section">
            <CardGrid
                columns={2}
                collapseBelow="medium"
                columnGap={12}
                rowGap={12}
            >
                {leaders.models.length > 0 ? (
                    <CardGridColumn span={2} style={styles.gridColumn}>
                        <PanelCard>
                            <UsageRankingBoard rows={leaders.models} />
                        </PanelCard>
                    </CardGridColumn>
                ) : null}
                {sections.filter((section) => section.key !== 'models').map((section) => (
                    <CardGridColumn key={section.key} style={styles.gridColumn}>
                        <MetricCard
                            testID={`usage-leader-${section.key}`}
                            label={section.title}
                            value={section.rows[0]?.label ?? t('usage.noData')}
                            subtitle={summarizeLeaders(section.rows)}
                            visual={renderLeaderRows(section.rows)}
                            valueTone="compact"
                        />
                    </CardGridColumn>
                ))}
            </CardGrid>
        </CardSection>
    );
}

export const UsageAnalyticsDashboard: React.FC<UsageAnalyticsDashboardProps> = ({
    viewModel,
    filters,
    sessionId,
    isRefreshing = false,
    errorMessage,
    onPeriodChange,
    onMetricChange,
    onCostModeChange,
    onFocusChange,
    onRetry,
}) => {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const getColorForDimension = React.useCallback((dimension: UsageBreakdownRow['dimension']) => {
        if (dimension === 'provider') return theme.colors.accent.blue;
        if (dimension === 'model') return theme.colors.accent.green;
        if (dimension === 'session') return theme.colors.accent.orange;
        if (dimension === 'project') return theme.colors.accent.purple;
        if (dimension === 'workspace') return theme.colors.accent.indigo;
        if (dimension === 'backendMode') return theme.colors.accent.orange;
        if (dimension === 'source') return theme.colors.accent.yellow;
        return theme.colors.accent.yellow;
    }, [theme]);
    const hasTrendData = viewModel.trend.length > 0;
    const hasAnyBreakdowns =
        viewModel.breakdowns.providers.length > 0 ||
        viewModel.breakdowns.models.length > 0 ||
        viewModel.breakdowns.sessions.length > 0 ||
        viewModel.breakdowns.projects.length > 0 ||
        viewModel.breakdowns.workspaces.length > 0 ||
        viewModel.breakdowns.backendModes.length > 0 ||
        viewModel.breakdowns.sources.length > 0;
    const focusLabel = viewModel.focus
        ? `${dimensionLabel(viewModel.focus.dimension)} · ${viewModel.focus.label}`
        : null;
    const displayCostMode = viewModel.availableCostModes.includes(filters.costMode)
        ? filters.costMode
        : 'auto';
    const summaryColumns = width >= 1180 ? 4 : width >= 720 ? 2 : 1;

    return (
        <ScrollView style={styles.screen}>
            <View style={styles.content}>
                {errorMessage ? (
                    <View style={styles.errorCard}>
                        <View style={styles.errorRow}>
                            <Ionicons name="alert-circle-outline" size={20} color={theme.colors.status.error} />
                            <Text style={styles.errorText}>{errorMessage}</Text>
                        </View>
                        {typeof onRetry === 'function' ? (
                            <Pressable style={styles.retryButton} onPress={onRetry}>
                                <Text style={styles.retryText}>{t('common.retry')}</Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}

                <CardSection>
                    <PanelCard padding="lg">
                        <View style={styles.filterBody}>
                            <View style={styles.chipRow}>
                                {USAGE_PERIODS.map((period) => (
                                    <UsageToggleChip
                                        key={period}
                                        testID={`usage-period-${period}`}
                                        label={t(getUsagePeriodDefinition(period).translationKey)}
                                        selected={filters.period === period}
                                        onPress={() => onPeriodChange(period)}
                                    />
                                ))}
                            </View>
                            <View style={styles.chipRow}>
                                <UsageToggleChip
                                    testID="usage-metric-tokens"
                                    label={t('usage.tokens')}
                                    selected={filters.metric === 'tokens'}
                                    accentColor={theme.colors.accent.blue}
                                    onPress={() => onMetricChange('tokens')}
                                />
                                <UsageToggleChip
                                    testID="usage-metric-cost"
                                    label={t('usage.cost')}
                                    selected={filters.metric === 'cost'}
                                    accentColor={theme.colors.accent.orange}
                                    onPress={() => onMetricChange('cost')}
                                />
                                {focusLabel ? (
                                    <UsageToggleChip
                                        testID="usage-focus-clear"
                                        label={`${focusLabel}`}
                                        selected
                                        accentColor={theme.colors.accent.indigo}
                                        onPress={() => onFocusChange(null)}
                                    />
                                ) : null}
                            </View>
                            <View style={styles.chipRow}>
                                <Text style={styles.sectionMiniLabel}>{t('usage.costMode')}</Text>
                            </View>
                            <View style={styles.chipRow}>
                                <UsageToggleChip
                                    testID="usage-costmode-auto"
                                    label={t('usage.auto')}
                                    selected={displayCostMode === 'auto'}
                                    accentColor={theme.colors.accent.blue}
                                    onPress={() => onCostModeChange('auto')}
                                />
                                {viewModel.availableCostModes.includes('reported') ? (
                                    <UsageToggleChip
                                        testID="usage-costmode-reported"
                                        label={t('usage.reported')}
                                        selected={displayCostMode === 'reported'}
                                        accentColor={theme.colors.accent.orange}
                                        onPress={() => onCostModeChange('reported')}
                                    />
                                ) : null}
                                {viewModel.availableCostModes.includes('estimated') ? (
                                    <UsageToggleChip
                                        testID="usage-costmode-estimated"
                                        label={t('usage.estimated')}
                                        selected={displayCostMode === 'estimated'}
                                        accentColor={theme.colors.accent.green}
                                        onPress={() => onCostModeChange('estimated')}
                                    />
                                ) : null}
                            </View>
                            <View style={styles.actionRow}>
                                <UsageExportActions
                                    viewModel={viewModel}
                                    filters={{ ...filters, costMode: displayCostMode }}
                                    sessionId={sessionId}
                                />
                            </View>
                            {isRefreshing ? (
                                <View style={styles.refreshBadge}>
                                    <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                                    <Text style={styles.refreshText}>{t('common.loading')}</Text>
                                </View>
                            ) : null}
                        </View>
                    </PanelCard>
                </CardSection>

                <CardSection title={t('usage.summary.title')}>
                    <CardGrid
                        columns={summaryColumns as 1 | 2 | 3 | 4}
                        collapseBelow="compact"
                        columnGap={12}
                        rowGap={12}
                        style={styles.summaryDeck}
                    >
                        <CardGridColumn
                            span={summaryColumns >= 4 ? 2 : 1}
                            style={styles.gridColumn}
                        >
                            <MetricCard
                                testID="usage-summary-total-card"
                                label={t(getUsagePeriodDefinition(filters.period).translationKey)}
                                value={filters.metric === 'cost'
                                    ? formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)
                                    : formatTokens(viewModel.overview.totalTokens)}
                                subtitle={filters.metric === 'cost'
                                    ? `${formatTokens(viewModel.overview.totalTokens)} ${t('usage.tokens')} · ${resolveCostModeLabel(displayCostMode)}`
                                    : `${formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)} · ${formatCount(viewModel.insights.activeDays)} ${t('usage.activeDays')} · ${formatCount(viewModel.insights.modelsTried)} ${t('usage.modelsTried')}`}
                                size="hero"
                                style={styles.summaryHeroCard}
                            />
                        </CardGridColumn>
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                label={t('settings.sessions')}
                                value={formatCount(viewModel.insights.sessionsUsed)}
                                subtitle={
                                    viewModel.focus
                                        ? viewModel.focus.label
                                        : buildUsageCurrentStreakSubtitle(filters.period, viewModel.insights.activeDays)
                                }
                                style={styles.summarySupportCard}
                            />
                        </CardGridColumn>
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                label={t('usage.totalCost')}
                                value={formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)}
                                subtitle={resolveCostModeLabel(displayCostMode)}
                                valueTone="compact"
                                style={styles.summarySupportCard}
                            />
                        </CardGridColumn>
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                label={t('usage.modelsTried')}
                                value={formatCount(viewModel.insights.modelsTried)}
                                subtitle={
                                    viewModel.insights.favoriteModel
                                        ? viewModel.insights.favoriteModel.label
                                        : t('usage.noData')
                                }
                                style={styles.summarySupportCard}
                            />
                        </CardGridColumn>
                    </CardGrid>

                    <UsageRecapHighlightsSection
                        viewModel={viewModel}
                        filters={{ ...filters, costMode: displayCostMode }}
                        sessionId={sessionId}
                    />
                </CardSection>

                {renderInsightSection(filters.period, viewModel.insights)}

                <CardSection title={t('usage.usageOverTime')}>
                    <CardGrid
                        columns={4}
                        collapseBelow="medium"
                        columnGap={12}
                        rowGap={12}
                    >
                        <CardGridColumn span={3} style={styles.gridColumn}>
                            <PanelCard padding="lg">
                                <View style={styles.sectionBody}>
                                    <View style={styles.cardHeader}>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.sectionSubtitle}>{t('usage.summary.thisWeekSubtitle')}</Text>
                                        </View>
                                        {isRefreshing ? (
                                            <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                                        ) : null}
                                    </View>
                                    <View style={styles.chipRow}>
                                        <UsageToggleChip
                                            testID="usage-trend-metric-tokens"
                                            label={t('usage.tokens')}
                                            selected={filters.metric === 'tokens'}
                                            accentColor={theme.colors.accent.blue}
                                            onPress={() => onMetricChange('tokens')}
                                        />
                                        <UsageToggleChip
                                            testID="usage-trend-metric-cost"
                                            label={t('usage.cost')}
                                            selected={filters.metric === 'cost'}
                                            accentColor={theme.colors.accent.orange}
                                            onPress={() => onMetricChange('cost')}
                                        />
                                    </View>
                                    <View style={styles.chartWrap}>
                                        {hasTrendData ? (
                                            <UsageVolumeBubbleChart
                                                testID="usage-trend-chart"
                                                points={viewModel.trend}
                                                metric={filters.metric}
                                                height={220}
                                            />
                                        ) : (
                                            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                                                <Text style={styles.sectionSubtitle}>{t('usage.noData')}</Text>
                                            </View>
                                        )}
                                    </View>
                                </View>
                            </PanelCard>
                        </CardGridColumn>
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                label={t('usage.summary.thisWeek')}
                                value={filters.metric === 'cost'
                                    ? formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)
                                    : formatTokens(viewModel.overview.totalTokens)}
                                subtitle={filters.metric === 'cost'
                                    ? resolveCostModeLabel(displayCostMode)
                                    : `${formatCount(viewModel.insights.sessionsUsed)} ${t('settings.sessions')}`}
                                valueTone="compact"
                            />
                        </CardGridColumn>
                    </CardGrid>
                </CardSection>

                {renderActivitySection(viewModel.activity, viewModel.insights)}

                <UsageTimelineSection viewModel={viewModel} />

                {renderLeadersSection(viewModel.leaders)}

                {hasAnyBreakdowns ? (
                    <>
                        {renderBreakdownSection(
                            t('settingsProviders.title'),
                            viewModel.breakdowns.providers,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                        {renderBreakdownSection(
                            t('settingsProviders.models'),
                            viewModel.breakdowns.models,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                        {renderBreakdownSection(
                            t('settings.sessions'),
                            viewModel.breakdowns.sessions,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                        {renderBreakdownSection(
                            t('tabs.projects'),
                            viewModel.breakdowns.projects,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                        {renderBreakdownSection(
                            t('settings.workspaces'),
                            viewModel.breakdowns.workspaces,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                        {renderBreakdownSection(
                            t('usage.summary.engine'),
                            viewModel.breakdowns.backendModes,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                        )}
                    </>
                ) : null}

                {!hasTrendData && !hasAnyBreakdowns ? (
                    <View style={styles.emptyCard}>
                        <Text style={styles.emptyTitle}>{t('usage.noData')}</Text>
                        <Text style={styles.emptySubtitle}>
                            {t('usage.noData')}
                        </Text>
                    </View>
                ) : null}
            </View>
        </ScrollView>
    );
};
