import { t } from '@/text';
import { resolveUsageCalendarDateStart, resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
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
import { usageCostKindPhrase } from '../resolveUsageCostModeLabel';
import { formatUsageCalendarPeriod } from '../usageCalendarPresentation';
import { usageAgentTitle, usageDimensionLabel } from '../usageLabels';

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
    visual: UsageRecapCardVisualModel | null;
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
    if (filters.metric === 'cost') {
        return formatUsageRecapCost(viewModel);
    }

    return formatTokenCount(viewModel.hero.totalTokens);
}

function formatUsageRecapCost(viewModel: UsageAnalyticsViewModel): string {
    if (viewModel.pageCost) {
        // The amount decides known or unknown; an amount with no basis is an empty population's measured zero.
        return viewModel.pageCost.amountUsd === null
            ? t('common.unavailable')
            : formatUsageCost(viewModel.pageCost.amountUsd, viewModel.pageCost.selection?.currency ?? viewModel.costPresentation.currency);
    }
    // Legacy report views retain their witnessed presentation; 'none' is never a priced zero.
    return viewModel.costPresentation.source === 'none' ? t('common.unavailable')
        : formatUsageCost(viewModel.costPresentation.effectiveUsd, viewModel.costPresentation.currency);
}

function buildPeriodUsageSubtitle(viewModel: UsageAnalyticsViewModel, filters: UsageFilterState): string {
    const tokensQualifier = viewModel.hero.totalTokensFromParts ? t('usage.board.page.tokensFromParts') : null;
    if (filters.metric === 'cost') {
        return [`${formatTokenCount(viewModel.hero.totalTokens)} ${t('usage.tokens')}`, tokensQualifier].filter(Boolean).join(' · ');
    }

    // Under a token total, missing money says what is missing ("Cost not priced"), never a bare "Unavailable".
    if (viewModel.pageCost ? viewModel.pageCost.amountUsd === null : viewModel.costPresentation.source === 'none')
        return [t('usage.board.recap.costNotPriced'), tokensQualifier].filter(Boolean).join(' · ');
    const amount = formatUsageRecapCost(viewModel);
    const kind = viewModel.pageCost ? viewModel.pageCost.selection?.kind : viewModel.costPresentation.source;
    return [kind ? `${amount} · ${usageCostKindPhrase(kind)}` : amount, tokensQualifier].filter(Boolean).join(' · ');
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
        totalTokens: viewModel.hero.totalTokens,
        totalCost: viewModel.overview.totalCost,
        currency: viewModel.costPresentation.currency || 'USD',
        weekTokens: viewModel.hero.totalTokens,
        weekCost: viewModel.overview.totalCost,
        topModel,
        topEngine,
        busiestWindowLabel: busiestBucket ? formatUsageWeekdayHourLabel(busiestBucket.weekday, busiestBucket.hour) : null,
        recentActivity,
        hasData: viewModel.overview.reportCount > 0,
    };
}

function resolveTopEngineLabel(viewModel: UsageAnalyticsViewModel, summary: UsageAnalyticsSummaryViewModel): string {
    if (isKnownUsageLabel(viewModel.leaders.engines[0]?.label)) {
        const engine = viewModel.leaders.engines[0];
        return usageDimensionLabel('backendMode', engine.key, engine.label);
    }
    if (isKnownUsageLabel(summary.topEngine?.label)) {
        return usageDimensionLabel('backendMode', summary.topEngine.key, summary.topEngine.label);
    }
    if (isKnownUsageLabel(viewModel.leaders.agents[0]?.label)) {
        const agent = viewModel.leaders.agents[0];
        return usageAgentTitle(agent.key, agent.label);
    }
    return t('common.unavailable');
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

    // The favorite is a named model; the ranking's leading row can instead be unattributed usage.
    const topModel = [viewModel.insights.favoriteModel, ...viewModel.leaders.models, summary.topModel]
        .find(model => model && isKnownUsageLabel(model.key)) ?? null;
    const modelBreakdown = viewModel.breakdowns.models.find(row => row.key === topModel?.key);
    const topEngineLabel = resolveTopEngineLabel(viewModel, summary);
    const modelShare = modelBreakdown && modelBreakdown.totalTokens !== null && viewModel.overview.totalTokens !== null && viewModel.overview.totalTokens > 0
        ? modelBreakdown.totalTokens / viewModel.overview.totalTokens
        : null;
    const selectedPeriod = input.query ? formatUsageCalendarPeriod({ ...input.query.period, timeZoneOffsetMinutes: offset }) : resolvePeriodLabel(filters.period);
    const rangeDayCount = input.query
        ? input.query.period.startMs !== undefined && input.query.period.endMs !== undefined
            ? Math.floor((resolveUsageBucketBounds('day', input.query.period.endMs - 1, offset).bucketStartMs
                - resolveUsageBucketBounds('day', input.query.period.startMs, offset).bucketStartMs) / 86_400_000) + 1
            : Number.POSITIVE_INFINITY
        : resolveRangeDayCount(filters.period);
    const activityRatio = summary.activeDays !== null && summary.activeDays > 0
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
            value: summary.currentStreakDays === null ? '—' : `${summary.currentStreakDays}d`,
            subtitle: summary.activeDays === null ? t('common.unavailable') : input.query
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
            subtitle: input.shareFields?.dollars === false
                ? [t('usage.tokens'), viewModel.hero.totalTokensFromParts ? t('usage.board.page.tokensFromParts') : null].filter(Boolean).join(' · ')
                : buildPeriodUsageSubtitle(viewModel, filters),
            valueTone: 'numeric',
            accentTone: 'blue',
            visual: summary.activeDays === null ? null : {
                kind: 'progress',
                ratio: activityRatio,
            },
        },
        {
            id: 'model',
            testID: 'usage-recap-model-card',
            shareTestID: 'usage-recap-share-model',
            label: t('usage.summary.topModel'),
            value: input.shareFields?.names === false ? '—' : topModel ? usageDimensionLabel('model', topModel.key, topModel.label) : t('usage.board.page.unattributed'),
            subtitle: topModel
                ? `${formatTokenCount(viewModel.insights.favoriteModelChangeCount)} ${t('usage.modelSwitches')}${input.shareFields?.names === false ? '' : ` · ${topEngineLabel}`}`
                : t('common.unavailable'),
            valueTone: 'compact',
            accentTone: 'purple',
            visual: modelShare === null ? null : {
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
            subtitle: rhythmRows[0] ? `${formatTokenCount(rhythmRows[0].value)} ${t('usage.events')}` : t('common.unavailable'),
            valueTone: 'compact',
            accentTone: 'green',
            visual: {
                kind: 'rankBars',
                rows: rhythmRows,
            },
        },
    ];
}
