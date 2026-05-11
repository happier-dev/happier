import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { CardGrid, CardGridColumn, CardMasonry, CardMasonryItem, CardSection, MetricCard, PanelCard } from '@/components/ui/cards';
import { ConnectedServiceQuotaSummaryCardSection } from '@/components/settings/connectedServices/ConnectedServiceQuotaSummaryCardSection';
import type { ConnectedServiceQuotaSummaryCard } from '@/components/settings/connectedServices/buildConnectedServiceQuotaSummaryCards';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
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
import { UsageVolumeBarChart } from './UsageVolumeBarChart';
import { buildUsageCurrentStreakSubtitle } from './buildUsageCurrentStreakSubtitle';
import { formatUsageCurrency } from './formatUsageCurrency';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { useSessionListRenderablesById } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
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
    connectedServiceQuotaCards?: ReadonlyArray<ConnectedServiceQuotaSummaryCard>;
    connectedServiceQuotasRefreshing?: boolean;
    showConnectedServiceQuotaSectionWhenEmpty?: boolean;
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
        backgroundColor: theme.colors.background.canvas,
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
    summaryCard: {
        minHeight: 152,
    },
    filterBody: {
        position: 'relative',
        paddingHorizontal: 16,
        paddingBottom: 16,
        gap: 12,
    },
    refreshOverlay: {
        position: 'absolute',
        top: 16,
        right: 16,
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    filterRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'flex-start',
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
        color: theme.colors.text.secondary,
        marginTop: 2,
    },
    chartWrap: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    leaderRowStack: {
        gap: 8,
    },
    errorCard: {
        marginHorizontal: 16,
        marginBottom: 12,
        padding: 14,
        borderRadius: 18,
        backgroundColor: theme.colors.surface.base,
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
        color: theme.colors.text.primary,
    },
    retryButton: {
        alignSelf: 'flex-start',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.status.error,
    },
    retryText: {
        color: theme.colors.surface.base,
        fontSize: 13,
        fontWeight: '700',
    },
    emptyCard: {
        marginHorizontal: 16,
        padding: 18,
        borderRadius: 18,
        backgroundColor: theme.colors.surface.base,
        alignItems: 'center',
        gap: 8,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    emptySubtitle: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    sectionMiniLabel: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
    },
    activitySummaryCard: {
        minHeight: 168,
    },
    activitySupportGrid: {
        gap: 12,
    },
    activityRhythmCard: {
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    activityRhythmHeader: {
        gap: 4,
    },
    activityRhythmTitle: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        letterSpacing: -0.5,
        color: theme.colors.text.primary,
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
        maximumFractionDigits: value >= 100 ? 0 : 2,
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
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string,
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
                        const displayLabel = resolveDisplayLabel(row.dimension, row.label, row.key);
                        return (
                            <UsageBar
                                key={`${row.dimension}:${row.key}`}
                                testID={`usage-breakdown-row-${row.dimension}-${row.key}`}
                                label={displayLabel}
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
                                        label: displayLabel,
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
                        testID="usage-insight-sessions"
                        label={t('settings.sessions')}
                        value={formatCount(insights.sessionsUsed)}
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
    period: UsageFilterState['period'],
    viewportWidth: number,
): React.ReactElement | null {
    if (activity.calendarDays.length === 0 && activity.weekdayHourBuckets.length === 0) {
        return null;
    }

    const busiestBucket = [...activity.weekdayHourBuckets].sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;
    const rhythmColumns = viewportWidth >= 1100 ? 4 : viewportWidth >= 760 ? 2 : 1;
    const rhythmMaxValue = Math.max(...activity.weekdayHourBuckets.map((entry) => entry.eventCount), 1);

    return (
        <CardSection title={t('usage.activity')} testID="usage-activity-section">
            <View style={styles.sectionBody}>
                <PanelCard testID="usage-activity-poster-card">
                    <UsageActivityPoster activity={activity} period={period} />
                </PanelCard>
                <PanelCard testID="usage-activity-rhythm">
                    <View style={styles.activityRhythmCard}>
                        <View style={styles.activityRhythmHeader}>
                            <Text style={styles.sectionMiniLabel}>{t('usage.busiestWindow')}</Text>
                            <Text style={styles.activityRhythmTitle}>
                                {busiestBucket ? formatUsageWeekdayHourLabel(busiestBucket.weekday, busiestBucket.hour) : t('usage.noData')}
                            </Text>
                            <Text style={styles.sectionSubtitle}>{insights.busiestHour?.label ?? t('usage.noData')}</Text>
                        </View>
                        <CardGrid columns={rhythmColumns as 1 | 2 | 4} collapseBelow="compact" columnGap={12} rowGap={12} style={styles.activitySupportGrid}>
                            {[...activity.weekdayHourBuckets]
                                .sort((left, right) => right.eventCount - left.eventCount)
                                .slice(0, 4)
                                .map((bucket) => (
                                    <CardGridColumn key={`${bucket.weekday}:${bucket.hour}`}>
                                        <UsageBar
                                            label={formatUsageWeekdayHourLabel(bucket.weekday, bucket.hour)}
                                            value={bucket.eventCount}
                                            maxValue={rhythmMaxValue}
                                            showPercentage={false}
                                            height={6}
                                            tooltipTitle={formatUsageWeekdayHourLabel(bucket.weekday, bucket.hour)}
                                            tooltipValue={bucket.eventCount.toLocaleString()}
                                        />
                                    </CardGridColumn>
                                ))}
                        </CardGrid>
                    </View>
                </PanelCard>
            </View>
        </CardSection>
    );
}

function renderLeadersSection(
    leaders: UsageAnalyticsLeaderSections,
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string,
): React.ReactElement | null {
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
            <CardMasonry columns={3} collapseBelow="medium" columnGap={12} rowGap={12}>
                {leaders.models.length > 0 ? (
                    <CardMasonryItem key="leader-models" height="hero" style={styles.gridColumn}>
                        <PanelCard testID="usage-leader-models" style={{ minHeight: 320 }}>
                            <UsageRankingBoard rows={leaders.models} />
                        </PanelCard>
                    </CardMasonryItem>
                ) : null}
                {sections.filter((section) => section.key !== 'models').map((section) => (
                    <CardMasonryItem key={section.key} height="standard" style={styles.gridColumn}>
                        {(() => {
                            const dimension = section.key === 'engines'
                                ? 'backendMode'
                                : section.key.slice(0, -1) as UsageBreakdownRow['dimension'];
                            const normalizedRows = section.rows.map((row) => ({
                                ...row,
                                label: resolveDisplayLabel(dimension, row.label, row.key),
                            }));

                            return (
                        <MetricCard
                            testID={`usage-leader-${section.key}`}
                            label={section.title}
                            value={normalizedRows[0]?.label ?? t('usage.noData')}
                            subtitle={summarizeLeaders(normalizedRows)}
                            visual={renderLeaderRows(normalizedRows)}
                            valueTone="compact"
                        />
                            );
                        })()}
                    </CardMasonryItem>
                ))}
            </CardMasonry>
        </CardSection>
    );
}

export const UsageAnalyticsDashboard: React.FC<UsageAnalyticsDashboardProps> = ({
    viewModel,
    connectedServiceQuotaCards = [],
    connectedServiceQuotasRefreshing = false,
    showConnectedServiceQuotaSectionWhenEmpty = false,
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
    const viewportWidth = Math.max(width - 32, 0);
    const sessionListRenderablesById = useSessionListRenderablesById();
    const resolveDisplayLabel = React.useCallback((
        dimension: UsageBreakdownRow['dimension'],
        label: string,
        key: string,
    ): string => {
        if (dimension !== 'session') {
            return label;
        }

        const renderable = sessionListRenderablesById[key];
        return renderable ? getSessionName(renderable) : label;
    }, [sessionListRenderablesById]);
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
        viewModel.breakdowns.backendModes.length > 0;
    const focusLabel = viewModel.focus
        ? `${dimensionLabel(viewModel.focus.dimension)} · ${viewModel.focus.label}`
        : null;
    const displayCostMode = viewModel.availableCostModes.includes(filters.costMode)
        ? filters.costMode
        : 'auto';
    const summaryColumns = width >= 1080 ? 4 : width >= 720 ? 2 : 1;
    const [periodMenuOpen, setPeriodMenuOpen] = React.useState(false);
    const [metricMenuOpen, setMetricMenuOpen] = React.useState(false);
    const [costModeMenuOpen, setCostModeMenuOpen] = React.useState(false);

    const periodItems = React.useMemo(() => USAGE_PERIODS.map((period) => ({
        id: period,
        title: t(getUsagePeriodDefinition(period).translationKey),
    })), []);
    const metricItems = React.useMemo(() => ([
        { id: 'tokens', title: t('usage.tokens') },
        { id: 'cost', title: t('usage.cost') },
    ]), []);
    const costModeItems = React.useMemo(() => {
        const items = [{ id: 'auto', title: t('usage.auto') }];
        if (viewModel.availableCostModes.includes('reported')) {
            items.push({ id: 'reported', title: t('usage.reported') });
        }
        if (viewModel.availableCostModes.includes('estimated')) {
            items.push({ id: 'estimated', title: t('usage.estimated') });
        }
        return items;
    }, [viewModel.availableCostModes]);

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
                            <View style={styles.filterRow}>
                                <DropdownMenu
                                    open={periodMenuOpen}
                                    onOpenChange={setPeriodMenuOpen}
                                    items={periodItems}
                                    selectedId={filters.period}
                                    onSelect={(itemId) => onPeriodChange(itemId as UsageFilterState['period'])}
                                    itemTrigger={{
                                        title: t(getUsagePeriodDefinition(filters.period).translationKey),
                                        showSelectedDetail: false,
                                        showSelectedSubtitle: false,
                                        itemProps: {
                                            testID: 'usage-filter-period',
                                            density: 'compact',
                                        },
                                    }}
                                />
                                <DropdownMenu
                                    open={metricMenuOpen}
                                    onOpenChange={setMetricMenuOpen}
                                    items={metricItems}
                                    selectedId={filters.metric}
                                    onSelect={(itemId) => onMetricChange(itemId as UsageMetric)}
                                    itemTrigger={{
                                        title: filters.metric === 'cost' ? t('usage.cost') : t('usage.tokens'),
                                        showSelectedDetail: false,
                                        showSelectedSubtitle: false,
                                        itemProps: {
                                            testID: 'usage-filter-metric',
                                            density: 'compact',
                                        },
                                    }}
                                />
                                <DropdownMenu
                                    open={costModeMenuOpen}
                                    onOpenChange={setCostModeMenuOpen}
                                    items={costModeItems}
                                    selectedId={displayCostMode}
                                    onSelect={(itemId) => onCostModeChange(itemId as UsageCostMode)}
                                    itemTrigger={{
                                        title: resolveCostModeLabel(displayCostMode),
                                        showSelectedDetail: false,
                                        showSelectedSubtitle: false,
                                        itemProps: {
                                            testID: 'usage-filter-cost-mode',
                                            density: 'compact',
                                        },
                                    }}
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
                            <View style={styles.actionRow}>
                                <UsageExportActions
                                    viewModel={viewModel}
                                    filters={{ ...filters, costMode: displayCostMode }}
                                    sessionId={sessionId}
                                />
                            </View>
                            {isRefreshing ? (
                                <View
                                    testID="usage-refresh-overlay"
                                    pointerEvents="none"
                                    style={styles.refreshOverlay}
                                >
                                    <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                                </View>
                            ) : null}
                        </View>
                    </PanelCard>
                </CardSection>

                <ConnectedServiceQuotaSummaryCardSection
                    title={t('connectedServices.title')}
                    cards={connectedServiceQuotaCards}
                    isRefreshing={connectedServiceQuotasRefreshing}
                    showWhenEmpty={showConnectedServiceQuotaSectionWhenEmpty}
                    testID="usage-connected-services-quotas-section"
                />

                <CardSection title={t('usage.summary.title')}>
                    <UsageRecapHighlightsSection
                        viewModel={viewModel}
                        filters={{ ...filters, costMode: displayCostMode }}
                        sessionId={sessionId}
                    />

                    <CardGrid
                        columns={summaryColumns as 1 | 2 | 4}
                        collapseBelow="compact"
                        columnGap={12}
                        rowGap={12}
                        style={styles.summaryDeck}
                    >
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                testID="usage-summary-total-card"
                                label={t(getUsagePeriodDefinition(filters.period).translationKey)}
                                value={filters.metric === 'cost'
                                    ? formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)
                                    : formatTokens(viewModel.overview.totalTokens)}
                                subtitle={filters.metric === 'cost'
                                    ? `${formatTokens(viewModel.overview.totalTokens)} ${t('usage.tokens')} · ${resolveCostModeLabel(displayCostMode)}`
                                    : `${formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)} · ${formatCount(viewModel.insights.activeDays)} ${t('usage.activeDays')} · ${formatCount(viewModel.insights.modelsTried)} ${t('usage.modelsTried')}`}
                                style={styles.summaryCard}
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
                                style={styles.summaryCard}
                            />
                        </CardGridColumn>
                        <CardGridColumn style={styles.gridColumn}>
                            <MetricCard
                                label={t('usage.totalCost')}
                                value={formatCost(viewModel.overview.totalCost, viewModel.costPresentation.currency)}
                                subtitle={resolveCostModeLabel(displayCostMode)}
                                valueTone="compact"
                                style={styles.summaryCard}
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
                                style={styles.summaryCard}
                            />
                        </CardGridColumn>
                    </CardGrid>
                </CardSection>

                {renderInsightSection(filters.period, viewModel.insights)}

                <CardSection title={t('usage.usageOverTime')}>
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
                                    <UsageVolumeBarChart
                                        testID="usage-trend-chart"
                                        points={viewModel.trend}
                                        metric={filters.metric}
                                        currency={viewModel.costPresentation.currency}
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
                </CardSection>

                {renderActivitySection(viewModel.activity, viewModel.insights, filters.period, viewportWidth)}

                <UsageTimelineSection viewModel={viewModel} metric={filters.metric} />

                {renderLeadersSection(viewModel.leaders, resolveDisplayLabel)}

                {hasAnyBreakdowns ? (
                    <>
                        {renderBreakdownSection(
                            t('settingsProviders.title'),
                            viewModel.breakdowns.providers,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                        {renderBreakdownSection(
                            t('settingsProviders.models'),
                            viewModel.breakdowns.models,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                        {renderBreakdownSection(
                            t('settings.sessions'),
                            viewModel.breakdowns.sessions,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                        {renderBreakdownSection(
                            t('tabs.projects'),
                            viewModel.breakdowns.projects,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                        {renderBreakdownSection(
                            t('settings.workspaces'),
                            viewModel.breakdowns.workspaces,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                        {renderBreakdownSection(
                            t('usage.summary.engine'),
                            viewModel.breakdowns.backendModes,
                            filters.metric,
                            viewModel.focus,
                            onFocusChange,
                            getColorForDimension,
                            resolveDisplayLabel,
                        )}
                    </>
                ) : null}

                {!hasTrendData && !hasAnyBreakdowns ? (
                    <View testID="usage-empty-state" style={styles.emptyCard}>
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
