import { t } from '@/text';
import type {
    UsageAnalyticsSummaryViewModel,
    UsageAnalyticsViewModel,
    UsageFilterState,
    UsageSummaryActivityPoint,
} from '@/sync/api/account/usageAnalytics';
import { formatUsageWeekdayHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';

import { formatUsageCurrency } from './formatUsageCurrency';
import { buildUsageCurrentStreakSubtitle } from './buildUsageCurrentStreakSubtitle';
import { resolveUsageCostModeLabel } from './resolveUsageCostModeLabel';

export type UsageRecapCardId = 'streak' | 'usage' | 'model' | 'rhythm';
export type UsageRecapCardValueTone = 'numeric' | 'compact';
export type UsageRecapCardAccentTone = 'orange' | 'blue' | 'purple' | 'green';

export type UsageRecapCardVisualModel =
    | Readonly<{
        kind: 'activityMatrix';
        activity: readonly UsageSummaryActivityPoint[];
        squareCount: number;
        rowSize: number;
    }>
    | Readonly<{
        kind: 'progress';
        ratio: number;
    }>
    | Readonly<{
        kind: 'sparkBars';
        activity: readonly UsageSummaryActivityPoint[];
    }>;

export type UsageRecapCardModel = Readonly<{
    id: UsageRecapCardId;
    testID: string;
    shareTestID: string;
    label: string;
    value: string;
    subtitle: string;
    valueTone: UsageRecapCardValueTone;
    accentTone: UsageRecapCardAccentTone;
    visual: UsageRecapCardVisualModel;
}>;

function formatTokens(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return value.toLocaleString();
}

function resolvePeriodLabel(period: UsageFilterState['period']): string {
    return t(getUsagePeriodDefinition(period).translationKey);
}

function resolveRangeDayCount(period: UsageFilterState['period']): number {
    return getUsagePeriodDefinition(period).rangeDayCount;
}

function isKnownUsageLabel(label: string | null | undefined): label is string {
    const normalized = label?.trim().toLowerCase();
    return normalized != null && normalized.length > 0 && normalized !== 'unknown';
}

function formatPeriodUsageValue(viewModel: UsageAnalyticsViewModel, filters: UsageFilterState): string {
    const currency = viewModel.costPresentation.currency || 'USD';

    if (filters.metric === 'cost') {
        return formatUsageCurrency(viewModel.overview.totalCost, currency, {
            minimumFractionDigits: viewModel.overview.totalCost >= 100 ? 0 : viewModel.overview.totalCost >= 10 ? 1 : 2,
            maximumFractionDigits: viewModel.overview.totalCost >= 100 ? 0 : viewModel.overview.totalCost >= 10 ? 1 : 2,
        });
    }

    return formatTokens(viewModel.overview.totalTokens);
}

function buildPeriodUsageSubtitle(viewModel: UsageAnalyticsViewModel, filters: UsageFilterState): string {
    const currency = viewModel.costPresentation.currency || 'USD';

    if (filters.metric === 'cost') {
        return `${formatTokens(viewModel.overview.totalTokens)} ${t('usage.tokens').toLowerCase()}`;
    }

    const costModeLabel = resolveUsageCostModeLabel({
        availableCostModes: viewModel.availableCostModes,
        mode: viewModel.costPresentation.mode,
    });

    return `${formatUsageCurrency(viewModel.overview.totalCost, currency, {
        minimumFractionDigits: viewModel.overview.totalCost >= 100 ? 0 : viewModel.overview.totalCost >= 10 ? 1 : 2,
        maximumFractionDigits: viewModel.overview.totalCost >= 100 ? 0 : viewModel.overview.totalCost >= 10 ? 1 : 2,
    })} · ${costModeLabel}`;
}

function buildRecentActivity(viewModel: UsageAnalyticsViewModel): UsageSummaryActivityPoint[] {
    return viewModel.activity.calendarDays.slice(-14).map((day, index) => ({
        timestamp: Date.parse(`${day.date}T00:00:00.000Z`) || index,
        active: day.eventCount > 0,
        tokens: day.eventCount,
        cost: day.eventCount,
    }));
}

function buildRhythmActivity(viewModel: UsageAnalyticsViewModel): UsageSummaryActivityPoint[] {
    return [...viewModel.activity.weekdayHourBuckets]
        .sort((left, right) => right.eventCount - left.eventCount)
        .slice(0, 6)
        .map((bucket, index) => ({
            timestamp: index,
            active: bucket.eventCount > 0,
            tokens: bucket.eventCount,
            cost: bucket.eventCount,
        }));
}

function buildSummaryViewModel(viewModel: UsageAnalyticsViewModel): UsageAnalyticsSummaryViewModel {
    const recentActivity = buildRecentActivity(viewModel);
    const topModel = viewModel.breakdowns.models[0] ?? null;
    const topEngine = viewModel.breakdowns.backendModes[0] ?? null;
    const busiestBucket = [...viewModel.activity.weekdayHourBuckets]
        .sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;

    return {
        activeDays: viewModel.insights.activeDays,
        currentStreakDays: viewModel.insights.currentStreakDays,
        totalTokens: viewModel.overview.totalTokens,
        totalCost: viewModel.overview.totalCost,
        currency: viewModel.costPresentation.currency || 'USD',
        weekTokens: viewModel.overview.totalTokens,
        weekCost: viewModel.overview.totalCost,
        topModel,
        topEngine,
        busiestWindowLabel: busiestBucket ? formatUsageWeekdayHourLabel(busiestBucket.weekday, busiestBucket.hour) : null,
        recentActivity,
        hasData: viewModel.overview.totalTokens > 0 || viewModel.overview.totalCost > 0,
    };
}

function resolveTopEngineLabel(viewModel: UsageAnalyticsViewModel, summary: UsageAnalyticsSummaryViewModel): string {
    if (isKnownUsageLabel(viewModel.leaders.engines[0]?.label)) {
        return viewModel.leaders.engines[0].label;
    }
    if (isKnownUsageLabel(summary.topEngine?.label)) {
        return summary.topEngine.label;
    }
    if (isKnownUsageLabel(viewModel.leaders.providers[0]?.label)) {
        return viewModel.leaders.providers[0].label;
    }
    return t('usage.noData');
}

export function buildUsageRecapCardModels(input: Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
}>): UsageRecapCardModel[] {
    const { viewModel, filters } = input;
    const summary = buildSummaryViewModel(viewModel);
    if (!summary.hasData) {
        return [];
    }

    const topModel = summary.topModel;
    const topEngineLabel = resolveTopEngineLabel(viewModel, summary);
    const modelShare = topModel && viewModel.overview.totalTokens > 0
        ? topModel.totalTokens / viewModel.overview.totalTokens
        : 0;
    const activityRatio = summary.activeDays > 0
        ? summary.activeDays / resolveRangeDayCount(filters.period)
        : 0;
    const rhythmActivity = buildRhythmActivity(viewModel);

    return [
        {
            id: 'streak',
            testID: 'usage-recap-streak-card',
            shareTestID: 'usage-recap-share-streak',
            label: t('usage.summary.currentStreak'),
            value: `${summary.currentStreakDays}d`,
            subtitle: buildUsageCurrentStreakSubtitle(filters.period, summary.activeDays),
            valueTone: 'numeric',
            accentTone: 'orange',
            visual: {
                kind: 'activityMatrix',
                activity: summary.recentActivity,
                squareCount: 12,
                rowSize: 6,
            },
        },
        {
            id: 'usage',
            testID: 'usage-recap-usage-card',
            shareTestID: 'usage-recap-share-usage',
            label: resolvePeriodLabel(filters.period),
            value: formatPeriodUsageValue(viewModel, filters),
            subtitle: buildPeriodUsageSubtitle(viewModel, filters),
            valueTone: 'numeric',
            accentTone: 'blue',
            visual: {
                kind: 'progress',
                ratio: activityRatio,
            },
        },
        {
            id: 'model',
            testID: 'usage-recap-model-card',
            shareTestID: 'usage-recap-share-model',
            label: t('usage.summary.topModel'),
            value: topModel?.label ?? '—',
            subtitle: topModel
                ? `${formatTokens(viewModel.insights.favoriteModelChangeCount)} ${t('usage.favoriteModelChanges').toLowerCase()} · ${topEngineLabel}`
                : t('usage.noData'),
            valueTone: 'compact',
            accentTone: 'purple',
            visual: {
                kind: 'progress',
                ratio: modelShare,
            },
        },
        {
            id: 'rhythm',
            testID: 'usage-recap-rhythm-card',
            shareTestID: 'usage-recap-share-rhythm',
            label: t('usage.busiestWindow'),
            value: summary.busiestWindowLabel ?? '—',
            subtitle: viewModel.insights.busiestHour?.label ?? t('usage.noData'),
            valueTone: 'compact',
            accentTone: 'green',
            visual: {
                kind: 'sparkBars',
                activity: rhythmActivity,
            },
        },
    ];
}
