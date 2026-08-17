import React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ConnectedServiceQuotaSummaryCardSection } from '@/components/settings/connectedServices/ConnectedServiceQuotaSummaryCardSection';
import type { ConnectedServiceQuotaSummaryCard } from '@/components/settings/connectedServices/buildConnectedServiceQuotaSummaryCards';
import { t } from '@/text';
import type {
    UsageAnalyticsViewModel,
    UsageCostMode,
    UsageFilterState,
    UsageFocus,
    UsageMetric,
    UsagePivotDimension,
} from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import {
    ActivitySection,
    ContextSection,
    EfficiencySection,
    FiltersSection,
    HeroSection,
    InsightsSection,
    ModelMixSection,
    PivotSection,
    RecapSection,
    TrendSection,
    UsageEmptyState,
    UsageErrorCard,
} from './sections';
import { Band, DashboardSurface } from './sections/DashboardSurface';
import { CompositionStrip } from './charts/CompositionStrip';
import { dimensionLabel } from './sections/shared';
import { useUsageSessionResolvers } from './sections/useUsageSessionResolvers';

interface UsageAnalyticsDashboardProps {
    viewModel: UsageAnalyticsViewModel;
    connectedServiceQuotaCards?: ReadonlyArray<ConnectedServiceQuotaSummaryCard>;
    connectedServiceQuotasRefreshing?: boolean;
    showConnectedServiceQuotaSectionWhenEmpty?: boolean;
    filters: UsageFilterState;
    sessionId?: string;
    isRefreshing?: boolean;
    /** Bottom padding for the full-page route so the floating nav clears the footer (D-R2-10). Modal passes 0. */
    contentBottomInset?: number;
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
    // Sticky command bar (D-R3-5): a direct ScrollView child pinned via
    // stickyHeaderIndices. Opaque canvas + hairline so bands slide beneath it.
    commandBar: {
        backgroundColor: theme.colors.background.canvas,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
        zIndex: 10,
    },
    commandBarInner: {
        alignSelf: 'center',
        width: '100%',
        paddingTop: 8,
        paddingBottom: 4,
    },
    content: {
        paddingBottom: 28,
        paddingTop: 12,
        gap: 12,
        alignSelf: 'center',
        width: '100%',
    },
    // C-2: gap between the composition strip and the pivot control so the
    // wrapped token-mix legend never overlaps the pivot's segmented tab bar.
    whatBandContent: {
        gap: 20,
    },
}));

export const UsageAnalyticsDashboard: React.FC<UsageAnalyticsDashboardProps> = ({
    viewModel,
    connectedServiceQuotaCards = [],
    connectedServiceQuotasRefreshing = false,
    showConnectedServiceQuotaSectionWhenEmpty = false,
    filters,
    sessionId,
    isRefreshing = false,
    contentBottomInset = 0,
    errorMessage,
    onPeriodChange,
    onMetricChange,
    onCostModeChange,
    onFocusChange,
    onRetry,
}) => {
    const [pivotDimension, setPivotDimension] = React.useState<UsagePivotDimension>('model');
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const { openSession, resolveDisplayLabel } = useUsageSessionResolvers();

    const hasTrendData = viewModel.trend.length > 0;
    const hasActivity = viewModel.activity.calendarDays.length > 0
        || viewModel.activity.weekdayHourBuckets.length > 0;
    const hasComposition = viewModel.composition.total > 0;
    const { models, agents, sessions, projects, workspaces, sources } = viewModel.breakdowns;
    const hasPivot = [models, agents, sessions, projects, workspaces, sources].some((rows) => rows.length > 0);
    const hasModelMix = viewModel.modelMix.hasData || viewModel.engineMix.hasData;
    const hasEfficiency = viewModel.efficiency.cacheHitRatePct !== null || viewModel.efficiency.costPerMtokUsd !== null;
    const hasContext = Boolean(sessionId && viewModel.context);
    const isEmpty = !hasTrendData && !hasActivity && !hasComposition && !hasPivot;

    const focusLabel = viewModel.focus
        ? `${dimensionLabel(viewModel.focus.dimension)} · ${viewModel.focus.label}`
        : null;
    const displayCostMode = viewModel.availableCostModes.includes(filters.costMode)
        ? filters.costMode
        : 'auto';
    const periodLabel = t(getUsagePeriodDefinition(filters.period).translationKey);

    return (
        <ScrollView style={styles.screen} stickyHeaderIndices={[0]} testID="usage-dashboard-scroll">
            <View style={styles.commandBar} testID="usage-command-bar">
                <View style={[styles.commandBarInner, contentMaxWidthStyle]}>
                    <FiltersSection
                        viewModel={viewModel}
                        filters={filters}
                        displayCostMode={displayCostMode}
                        focusLabel={focusLabel}
                        sessionId={sessionId}
                        isRefreshing={isRefreshing}
                        onPeriodChange={onPeriodChange}
                        onMetricChange={onMetricChange}
                        onCostModeChange={onCostModeChange}
                        onFocusChange={onFocusChange}
                    />
                </View>
            </View>
            <View style={[styles.content, contentMaxWidthStyle, contentBottomInset > 0 ? { paddingBottom: 28 + contentBottomInset } : null]}>
                {errorMessage ? (
                    <UsageErrorCard message={errorMessage} onRetry={onRetry} />
                ) : null}

                {isEmpty ? (
                    <UsageEmptyState />
                ) : (
                    <DashboardSurface testID="usage-dashboard-surface">
                        <Band first index={0} entranceId="usage-hero" subtitle={periodLabel} testID="usage-band-hero">
                            <HeroSection hero={viewModel.hero} heroTrend={viewModel.heroTrend} />
                        </Band>

                        {hasActivity ? (
                            <Band index={1} entranceId="usage-when" title={t('usage.whenYouWork')} subtitle={periodLabel} testID="usage-band-when">
                                <ActivitySection
                                    activity={viewModel.activity}
                                    hourRhythm={viewModel.hourRhythm}
                                    punchCard={viewModel.punchCard}
                                    period={filters.period}
                                />
                            </Band>
                        ) : null}

                        {hasTrendData ? (
                            <Band index={2} entranceId="usage-flow" title={t('usage.usageOverTime')} testID="usage-band-flow">
                                <TrendSection
                                    viewModel={viewModel}
                                    filters={filters}
                                    isRefreshing={isRefreshing}
                                    onMetricChange={onMetricChange}
                                />
                            </Band>
                        ) : null}

                        {hasModelMix ? (
                            <Band index={3} entranceId="usage-model-mix" title={t('usage.modelMix.title')} testID="usage-band-model-mix">
                                <ModelMixSection modelMix={viewModel.modelMix} engineMix={viewModel.engineMix} />
                            </Band>
                        ) : null}

                        {(hasComposition || hasPivot) ? (
                            // whatBandContent gap keeps the composition legend clear of
                            // the pivot's segmented control (C-2 — no legend/tab overlap).
                            <Band index={4} entranceId="usage-what" title={t('usage.context.tokenMixTitle')} testID="usage-band-what" contentStyle={styles.whatBandContent}>
                                {hasComposition ? (
                                    <CompositionStrip composition={viewModel.composition} testID="usage-composition-strip" />
                                ) : null}
                                {hasPivot ? (
                                    <PivotSection
                                        breakdowns={viewModel.breakdowns}
                                        leaderTrends={viewModel.leaderTrends}
                                        dimension={pivotDimension}
                                        currency={viewModel.costPresentation.currency}
                                        onDimensionChange={setPivotDimension}
                                        resolveDisplayLabel={resolveDisplayLabel}
                                        onFocusChange={onFocusChange}
                                        onOpenSession={openSession}
                                    />
                                ) : null}
                            </Band>
                        ) : null}

                        <Band index={5} entranceId="usage-efficiency" title={t('usage.insights')} testID="usage-band-efficiency">
                            {hasEfficiency ? (
                                <EfficiencySection efficiency={viewModel.efficiency} />
                            ) : null}
                            <InsightsSection
                                period={filters.period}
                                insights={viewModel.insights}
                                cacheSavings={viewModel.cacheSavings}
                            />
                            {hasContext && viewModel.context ? (
                                <ContextSection context={viewModel.context} />
                            ) : null}
                        </Band>

                        <Band index={6} entranceId="usage-recap" testID="usage-band-recap">
                            <RecapSection
                                viewModel={viewModel}
                                filters={filters}
                                displayCostMode={displayCostMode}
                                sessionId={sessionId}
                                pivotDimension={pivotDimension}
                            />
                        </Band>
                    </DashboardSurface>
                )}

                <ConnectedServiceQuotaSummaryCardSection
                    title={t('connectedServices.title')}
                    cards={connectedServiceQuotaCards}
                    isRefreshing={connectedServiceQuotasRefreshing}
                    showWhenEmpty={showConnectedServiceQuotaSectionWhenEmpty}
                    testID="usage-connected-services-quotas-section"
                />
            </View>
        </ScrollView>
    );
};
