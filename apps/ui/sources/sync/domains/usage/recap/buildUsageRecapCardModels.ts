import { t } from '@/text';
import { resolveUsageCalendarDateStart, resolveUsageBucketBounds } from '@happier-dev/protocol';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type {
    UsageAnalyticsSummaryViewModel,
    UsageAnalyticsViewModel,
    UsageFilterState,
    UsageSummaryActivityPoint,
} from '@/sync/api/account/usageAnalytics';
import { formatUsageWeekdayHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';

import { buildUsageCurrentStreakSubtitle } from './buildUsageCurrentStreakSubtitle';
import { resolveUsageCostModeLabel } from '../resolveUsageCostModeLabel';
import { formatUsageCalendarPeriod } from '../usageCalendarPresentation';

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
        kind: 'rankBars';
        rows: readonly Readonly<{
            label: string;
            value: number;
        }>[];
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
        return formatUsageCost(viewModel.overview.totalCost, currency);
    }

    return formatTokenCount(viewModel.overview.totalTokens);
}

function buildPeriodUsageSubtitle(viewModel: UsageAnalyticsViewModel, filters: UsageFilterState): string {
    const currency = viewModel.costPresentation.currency || 'USD';

    if (filters.metric === 'cost') {
        return `${formatTokenCount(viewModel.overview.totalTokens)} ${t('usage.tokens')}`;
    }

    const costModeLabel = resolveUsageCostModeLabel({
        availableCostModes: viewModel.availableCostModes,
        mode: viewModel.costPresentation.mode,
    });

    return `${formatUsageCost(viewModel.overview.totalCost, currency)} · ${costModeLabel}`;
}

function buildRecentActivity(viewModel: UsageAnalyticsViewModel, timeZoneOffsetMinutes: number): UsageSummaryActivityPoint[] {
    // The legacy matrix shape uses tokens/cost slots for event-count intensity only,
    // not accounting amounts; card/story consumers render the count without a money/token unit.
    return viewModel.activity.calendarDays.slice(-14).map((day) => ({
        timestamp: resolveUsageCalendarDateStart(day.date, timeZoneOffsetMinutes),
        active: day.eventCount > 0,
        tokens: day.eventCount,
        cost: day.eventCount,
    }));
}

function buildRhythmRows(viewModel: UsageAnalyticsViewModel): Array<{ label: string; value: number }> {
    return [...viewModel.activity.weekdayHourBuckets]
        .sort((left, right) => right.eventCount - left.eventCount)
        .slice(0, 3)
        .map((bucket) => ({
            label: formatUsageWeekdayHourLabel(bucket.weekday, bucket.hour),
            value: bucket.eventCount,
        }));
}

function buildSummaryViewModel(viewModel: UsageAnalyticsViewModel, timeZoneOffsetMinutes: number): UsageAnalyticsSummaryViewModel {
    const recentActivity = buildRecentActivity(viewModel, timeZoneOffsetMinutes);
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
    if (isKnownUsageLabel(viewModel.leaders.agents[0]?.label)) {
        return viewModel.leaders.agents[0].label;
    }
    return t('usage.noData.title');
}

export function buildUsageRecapCardModels(input: Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    /** Admitted query wins over the legacy preset used only by report-based callers. */
    query?: UsageQuery;
    timeZoneOffsetMinutes?: number;
    /** Display callers omit this; selected-field share previews supply it explicitly. */
    shareFields?: Readonly<{ names: boolean; dollars: boolean }>;
}>): UsageRecapCardModel[] {
    const { viewModel } = input;
    const filters = input.shareFields?.dollars === false ? { ...input.filters, metric: 'tokens' as const } : input.filters;
    const offset = input.timeZoneOffsetMinutes ?? input.query?.timeZoneOffsetMinutes ?? viewModel.timeZoneOffsetMinutes ?? 0;
    const summary = buildSummaryViewModel(viewModel, offset);
    if (!summary.hasData) {
        return [];
    }

    const topModel = summary.topModel;
    const topEngineLabel = resolveTopEngineLabel(viewModel, summary);
    const modelShare = topModel && viewModel.overview.totalTokens > 0
        ? topModel.totalTokens / viewModel.overview.totalTokens
        : 0;
    const selectedPeriod = input.query ? formatUsageCalendarPeriod({ ...input.query.period, timeZoneOffsetMinutes: offset }) : resolvePeriodLabel(filters.period);
    const rangeDayCount = input.query
        ? input.query.period.startMs !== undefined && input.query.period.endMs !== undefined
            ? Math.floor((resolveUsageBucketBounds('day', input.query.period.endMs - 1, offset).bucketStartMs
                - resolveUsageBucketBounds('day', input.query.period.startMs, offset).bucketStartMs) / 86_400_000) + 1
            : Number.POSITIVE_INFINITY
        : resolveRangeDayCount(filters.period);
    const activityRatio = summary.activeDays > 0
        // An unbounded period ("All time") has no day count; its observed calendar is the span.
        ? summary.activeDays / (Number.isFinite(rangeDayCount)
            ? rangeDayCount
            : Math.max(viewModel.activity.calendarDays.length, summary.activeDays))
        : 0;
    const rhythmRows = buildRhythmRows(viewModel);

    return [
        {
            id: 'streak',
            testID: 'usage-recap-streak-card',
            shareTestID: 'usage-recap-share-streak',
            label: t('usage.summary.currentStreak'),
            value: `${summary.currentStreakDays}d`,
            subtitle: input.query
                ? t('usage.summary.currentStreakSubtitleForPeriod', { count: summary.activeDays, period: selectedPeriod })
                : buildUsageCurrentStreakSubtitle(filters.period, summary.activeDays),
            valueTone: 'numeric',
            accentTone: 'orange',
            visual: {
                kind: 'activityMatrix',
                activity: summary.recentActivity,
                squareCount: 14,
                rowSize: 7,
            },
        },
        {
            id: 'usage',
            testID: 'usage-recap-usage-card',
            shareTestID: 'usage-recap-share-usage',
            label: selectedPeriod,
            value: formatPeriodUsageValue(viewModel, filters),
            subtitle: input.shareFields?.dollars === false ? t('usage.tokens') : buildPeriodUsageSubtitle(viewModel, filters),
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
            value: input.shareFields?.names === false ? '—' : topModel?.label ?? '—',
            subtitle: topModel
                ? `${formatTokenCount(viewModel.insights.favoriteModelChangeCount)} ${t('usage.favoriteModelChanges')}${input.shareFields?.names === false ? '' : ` · ${topEngineLabel}`}`
                : t('usage.noData.title'),
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
            subtitle: viewModel.insights.busiestHour?.label ?? t('usage.noData.title'),
            valueTone: 'compact',
            accentTone: 'green',
            visual: {
                kind: 'rankBars',
                rows: rhythmRows,
            },
        },
    ];
}
