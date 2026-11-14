import { projectUsagePageCost, resolveEffectiveUsageCostUsd, resolveUsageCostPresentationSource, type UsagePageCostProjection } from '@happier-dev/protocol/usage/usageCostFacts';
import { resolveUsageBucketBounds, resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageDayStreaks } from '@happier-dev/protocol/usage/usageActivitySummary';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import { normalizeLegacyUsageTokens } from '@happier-dev/protocol/usage/legacyUsageTokens';
import { addUsageMeasurements, compareUsageMeasurementsDescending, createEmptyUsageCost, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';
import type { UsageAccountingMetric } from '@happier-dev/protocol/inputs/usageQuery';
import { agentIdFromEngineKey } from '@happier-dev/protocol/usage/usageFilterOptions';
import type {
    UsageAnalyticsBreakdownDimension,
    UsageAnalyticsBreakdownEntry,
    UsageAnalyticsBreakdowns,
    UsageAnalyticsQueryResponse,
    UsageAnalyticsSeriesBucket,
    UsageAnalyticsTotals as ProtocolUsageAnalyticsTotals} from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type {
    UsageCostMode as ProtocolUsageCostMode,
} from '@happier-dev/protocol/usage/usageCostFacts';

import type { UsageDataPoint, UsageTotals } from './apiUsage';
import { calculateTotals, getRecordTotal } from './apiUsage';
import { formatUsageDimensionLabel } from './formatUsageDimensionLabel';
import { formatUsageWeekdayHourLabel } from './formatUsageRhythmLabel';
import type { UsagePeriod } from './usagePeriods';
import { resolveUsageMeasuredTokens } from './usageMeasuredTokens';
export { resolveUsageMeasuredTokens } from './usageMeasuredTokens';

export type UsageMetric = UsageAccountingMetric;
export type UsageCostMode = ProtocolUsageCostMode;

export type UsageDimension =
    | 'agent'
    | 'model'
    | 'session'
    | 'project'
    | 'workspace'
    | 'backendMode'
    | 'source';

export interface UsageFocus {
    dimension: UsageDimension;
    key: string;
    label: string;
}

export interface UsageFilterState {
    period: UsagePeriod;
    metric: UsageMetric;
    costMode: UsageCostMode;
    focus: UsageFocus | null;
}

export interface UsageTrendPoint {
    timestamp: number;
    tokens: number | null;
    /** A measured floor cannot be compared with a reported total. Legacy points report totals. */
    tokensFromParts?: boolean;
    cost: number | null;
    reportCount: number;
}

export interface UsageBreakdownRow {
    dimension: UsageDimension | 'bucket' | 'week';
    key: string;
    label: string;
    totalTokens: number | null;
    totalCost: number | null;
    reportCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
    contextWindowTokens: number | null;
    contextUsedTokens: number | null;
}

export interface UsageBreakdownSections {
    agents: UsageBreakdownRow[];
    models: UsageBreakdownRow[];
    sessions: UsageBreakdownRow[];
    projects: UsageBreakdownRow[];
    workspaces: UsageBreakdownRow[];
    backendModes: UsageBreakdownRow[];
    sources: UsageBreakdownRow[];
    buckets: UsageBreakdownRow[];
    /** Per-week rows (newest first) derived from the period series (B-3). */
    weeks: UsageBreakdownRow[];
}

export interface UsageAnalyticsKeyedLabel {
    key: string;
    label: string;
}

export interface UsageAnalyticsInsightsViewModel {
    currentStreakDays: number | null;
    activeDays: number | null;
    longestStreakDays: number | null;
    sessionsUsed: number;
    messagesUsed: number;
    modelsTried: number;
    favoriteModel: UsageAnalyticsKeyedLabel | null;
    favoriteModelChangeCount: number;
    busiestMonth: UsageAnalyticsKeyedLabel | null;
    busiestDay: UsageAnalyticsKeyedLabel | null;
    busiestHour: UsageAnalyticsKeyedLabel | null;
}

export interface UsageAnalyticsActivityCalendarDay {
    date: string;
    eventCount: number;
}

export interface UsageAnalyticsWeekdayHourBucket {
    weekday: number;
    hour: number;
    eventCount: number;
}

export interface UsageAnalyticsActivityViewModel {
    calendarDays: UsageAnalyticsActivityCalendarDay[];
    weekdayHourBuckets: UsageAnalyticsWeekdayHourBucket[];
}

export interface UsageAnalyticsLeaderRow {
    key: string;
    label: string;
    eventCount: number;
}

export interface UsageAnalyticsTimelineLeaderRow extends UsageAnalyticsLeaderRow {
    totalTokens: number | null;
    totalCost: number | null;
}

export interface UsageAnalyticsTimelineBucket {
    bucketStartMs: number;
    bucketEndMs: number;
    leaders: UsageAnalyticsTimelineLeaderRow[];
}

export interface UsageAnalyticsLeaderSections {
    agents: UsageAnalyticsLeaderRow[];
    models: UsageAnalyticsLeaderRow[];
    sessions: UsageAnalyticsLeaderRow[];
    projects: UsageAnalyticsLeaderRow[];
    workspaces: UsageAnalyticsLeaderRow[];
    engines: UsageAnalyticsLeaderRow[];
}

/**
 * Compact stat row shown beneath the dashboard hero total. Composed entirely
 * from existing view-model pieces so there is no second source of truth — the
 * Hero section reads these instead of re-deriving from raw totals.
 */
export interface UsageHeroViewModel {
    /** The measured token figure, retaining each contribution's total or measured parts. */
    totalTokens: number | null;
    /** True when any contribution used measured parts as a floor. */
    totalTokensFromParts: boolean;
    /** Effective (auto) cost for the period, independent of the metric toggle. */
    effectiveUsd: number | null;
    currency: string;
    sessions: number;
    events: number;
    /** Total chat messages across the period (messageStats fold-back, B-2). */
    messages: number;
    longestStreakDays: number | null;
}

/**
 * Cache-savings figure for the insights strip.
 *
 * `cacheSavingsUsd` is producer-computed from its provider pricing table and
 * summed by the server; the UI never derives pricing from token counts.
 */
export interface UsageCacheSavingsViewModel {
    cachedReadTokens: number | null;
    cacheSavingsUsd: number | null;
}

export interface UsageContextTokenMix {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
}

/**
 * Per-scope context utilisation for the session drilldown (F-UI-3 / F-SRV-3).
 * `usedTokens`/`windowTokens` come from the server-provided latest context
 * snapshot; `tokenMix` is the input/output/reasoning/cache split from totals.
 */
export interface UsageContextViewModel {
    usedTokens: number | null;
    windowTokens: number | null;
    usedPct: number | null;
    tokenMix: UsageContextTokenMix;
}

/** Direction + magnitude of the period-over-period token delta (Band 2 pill). */
export interface UsageTrendDelta {
    /**
     * Percent change of the most recent half of the period versus the prior
     * equal-length half. `null` when the series is too short to split or the
     * prior half carried no volume (an undefined baseline, not a 0% change).
     */
    deltaPct: number | null;
    direction: 'up' | 'down' | 'flat';
}

/** Hero micro-sparkline + delta, both derived from the period series halves. */
export interface UsageHeroTrend {
    /** Per-bucket token totals across the period. */
    sparkline: (number | null)[];
    delta: UsageTrendDelta;
}

/** One hour-of-day column for the Band 3 daily-rhythm chart. */
export interface UsageHourRhythmBar {
    hour: number;
    eventCount: number;
}

export interface UsageHourRhythm {
    /** Always 24 entries, index === hour (0–23). */
    hours: UsageHourRhythmBar[];
    busiestHour: number | null;
    peakCount: number;
    total: number;
}

export type UsageCompositionKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

export interface UsageCompositionSegment {
    key: UsageCompositionKey;
    tokens: number | null;
    /** Share of the total token mix (0–100); 0 when there is no volume. */
    pct: number | null;
}

/** Ordered 100%-stacked token mix for the Band 5 composition strip. */
export interface UsageComposition {
    segments: UsageCompositionSegment[];
    total: number | null;
}

/** Per-leader token sparklines keyed by leader id, for the Band 5 leader rows. */
export interface UsageLeaderTrends {
    models: Record<string, (number | null)[]>;
    engines: Record<string, (number | null)[]>;
    /** Keyed by `agentId` — the same key space as the agents breakdown rows. */
    agents: Record<string, (number | null)[]>;
}

/**
 * Ordered dimensions for the Band 5 "What" pivot (E-1). Only these six are
 * user-pivotable (backendMode/bucket are internal-only). Order === the segmented
 * control order.
 */
export const USAGE_PIVOT_DIMENSIONS = ['model', 'agent', 'session', 'project', 'workspace', 'source', 'week'] as const;
export type UsagePivotDimension = typeof USAGE_PIVOT_DIMENSIONS[number];

/** One ranked pivot row: the breakdown row + its share of the dimension total + optional per-row trend. */
export interface UsagePivotRow {
    row: UsageBreakdownRow;
    /** Share of the dimension's total tokens (0–100). */
    sharePct: number | null;
    /** Per-row token sparkline (empty for dimensions without a timeline). */
    trend: (number | null)[];
    /** The single leader row (the true max) carries the accent; others stay neutral. */
    isLeader: boolean;
}

export interface UsagePivotView {
    dimension: UsagePivotDimension;
    rows: UsagePivotRow[];
    /** Total tokens across every row of the dimension (share denominator). */
    total: number | null;
    /** Whether this dimension carries a per-row trend column at all. */
    hasTrend: boolean;
}

/**
 * "How efficiently" headlines (E-3). Both figures are pure client derivations
 * from data already on screen — the cache-hit rate from the token breakdown, the
 * effective $/Mtok from the presented effective cost. `null` where the basis is
 * missing (no divide-by-zero, no fabricated number).
 */
export interface UsageEfficiencyViewModel {
    /** cacheRead / (input + cacheRead) as a percentage, or null without an input+cache basis. */
    cacheHitRatePct: number | null;
    cachedReadTokens: number | null;
    inputTokens: number | null;
    /** effectiveUsd / totalTokens × 1e6, or null without tokens and cost. */
    costPerMtokUsd: number | null;
    currency: string;
}

export interface UsageAnalyticsViewModel {
    /** Query-backed views retain the canonical selected money facts, including absence. */
    pageCost?: UsagePageCostProjection;
    /** Captured shown-query calendar offset; absent only on unqualified display fixtures. */
    timeZoneOffsetMinutes?: number;
    overview: UsageTotals;
    hero: UsageHeroViewModel;
    heroTrend: UsageHeroTrend;
    hourRhythm: UsageHourRhythm;
    punchCard: UsagePunchCard;
    composition: UsageComposition;
    /** Stacked model-mix over time (B-1); empty for legacy sources. */
    modelMix: UsageModelMix;
    /** Stacked engine-mix over time — the Models⇄Engines lens twin (B-1). */
    engineMix: UsageModelMix;
    /** Stacked mix over time at the Agent grain (every `agentId[:backendMode]` engine under its Agent). */
    agentMix: UsageModelMix;
    leaderTrends: UsageLeaderTrends;
    efficiency: UsageEfficiencyViewModel;
    cacheSavings: UsageCacheSavingsViewModel | null;
    context: UsageContextViewModel | null;
    trend: UsageTrendPoint[];
    breakdowns: UsageBreakdownSections;
    insights: UsageAnalyticsInsightsViewModel;
    activity: UsageAnalyticsActivityViewModel;
    leaders: UsageAnalyticsLeaderSections;
    modelTimeline: UsageAnalyticsTimelineBucket[];
    engineTimeline: UsageAnalyticsTimelineBucket[];
    availableCostModes: UsageCostMode[];
    costPresentation: Omit<NonNullable<UsageAnalyticsQueryResponse['costPresentation']>, 'effectiveUsd'> & { effectiveUsd: number | null };
    filteredUsageCount: number;
    focus: UsageFocus | null;
}

export interface UsageSummaryActivityPoint {
    timestamp: number;
    active: boolean;
    tokens: number | null;
    cost: number | null;
}

export interface UsageAnalyticsSummaryViewModel {
    activeDays: number | null;
    currentStreakDays: number | null;
    totalTokens: number | null;
    totalCost: number | null;
    currency: string;
    weekTokens: number | null;
    weekCost: number | null;
    topModel: UsageBreakdownRow | null;
    topEngine: UsageBreakdownRow | null;
    busiestWindowLabel: string | null;
    recentActivity: UsageSummaryActivityPoint[];
    hasData: boolean;
}

export type UsageAnalyticsSource = UsageDataPoint[] | UsageAnalyticsQueryResponse;

const USAGE_SUMMARY_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const dimensionKeys: Record<UsageDimension, keyof UsageDataPoint> = {
    // Maps to the legacy transport field (aligned with the DB column until R.8).
    agent: 'providerId',
    model: 'modelId',
    session: 'sessionId',
    project: 'projectKey',
    workspace: 'workspaceKey',
    backendMode: 'backendMode',
    source: 'source',
};

/**
 * The one cost a Happier surface shows for a usage total.
 *
 * Exported because Team credential usage answers with the same canonical cost
 * observation and must reach the same number. A second surface picking its own
 * field would make the same events read differently in two places, which is
 * exactly the kind of divergence a shared usage owner exists to prevent.
 */
export function resolveDisplayCost(cost: ProtocolUsageAnalyticsTotals['cost']): number | null {
    return resolveEffectiveUsageCostUsd(cost, 'auto');
}

function resolveCostForMode(
    cost: ProtocolUsageAnalyticsTotals['cost'],
    mode: UsageCostMode,
): number | null {
    return resolveEffectiveUsageCostUsd(cost, mode);
}

export function resolveAnalyticsCost(
    cost: ProtocolUsageAnalyticsTotals['cost'],
    modeOrPresentation?: UsageCostMode | NonNullable<UsageAnalyticsViewModel['costPresentation']> | null,
): number | null {
    if (typeof modeOrPresentation === 'string') {
        return resolveCostForMode(cost, modeOrPresentation);
    }
    if (modeOrPresentation) {
        return resolveCostForMode(cost, modeOrPresentation.mode);
    }
    return resolveDisplayCost(cost);
}

function resolveCostSource(cost: ProtocolUsageAnalyticsTotals['cost'], mode: UsageCostMode): NonNullable<UsageAnalyticsViewModel['costPresentation']>['source'] {
    return resolveUsageCostPresentationSource(cost, mode);
}

/**
 * The cost modes a total can honestly be read in: always the automatic
 * per-event precedence, plus a reported-only or estimate-only view when the
 * total actually carries that component (reported, estimated or API-equivalent). Team credential usage offers the same
 * choices from its own totals.
 */
export function resolveAvailableCostModes(cost: ProtocolUsageAnalyticsTotals['cost'], legacyOnly = false): UsageCostMode[] {
    const modes: UsageCostMode[] = ['auto'];

    if (legacyOnly) {
        return modes;
    }

    if (cost.reportedUsd !== null && cost.reportedUsd > 0) {
        modes.push('reported');
    }
    if (cost.estimatedUsd !== null && cost.estimatedUsd > 0) {
        modes.push('estimated');
    }
    if (cost.apiEquivalentUsd != null && cost.apiEquivalentUsd > 0) {
        modes.push('api_equivalent');
    }

    return modes;
}

function resolveEffectiveCost(cost: ProtocolUsageAnalyticsTotals['cost'], mode: UsageCostMode): number | null {
    return resolveCostForMode(cost, mode);
}

function createCostPresentation(
    cost: ProtocolUsageAnalyticsTotals['cost'],
    mode: UsageCostMode,
): NonNullable<UsageAnalyticsViewModel['costPresentation']> {
    return {
        mode,
        effectiveUsd: resolveEffectiveCost(cost, mode),
        currency: cost.currency,
        source: resolveCostSource(cost, mode),
    };
}

function createLegacyCostPresentation(cost: ProtocolUsageAnalyticsTotals['cost']): NonNullable<UsageAnalyticsViewModel['costPresentation']> {
    return {
        mode: 'auto',
        effectiveUsd: cost.reportedUsd !== null && cost.reportedUsd > 0 ? cost.reportedUsd : cost.estimatedUsd,
        currency: cost.currency,
        source: 'legacy_total_synthesized',
    };
}

function resolveResponseCostPresentation(
    response: UsageAnalyticsQueryResponse,
    requestedMode: UsageCostMode,
): NonNullable<UsageAnalyticsViewModel['costPresentation']> {
    const fallback = createCostPresentation(response.totals.cost, requestedMode);

    if (response.costPresentation && response.costPresentation.mode === requestedMode) {
        return {
            mode: response.costPresentation.mode ?? fallback.mode,
            effectiveUsd: typeof response.costPresentation.effectiveUsd === 'number'
                ? response.costPresentation.effectiveUsd
                : fallback.effectiveUsd,
            currency: response.costPresentation.currency ?? fallback.currency,
            source: response.costPresentation.source ?? fallback.source,
        };
    }
    return fallback;
}

function isSeriesBucketWithinWindow(
    bucket: UsageAnalyticsSeriesBucket,
    windowStartMs: number,
    windowEndMs: number,
): boolean {
    return bucket.bucketEndMs > windowStartMs && bucket.bucketStartMs <= windowEndMs;
}

function sortBreakdownRows(rows: UsageBreakdownRow[]): UsageBreakdownRow[] {
    return [...rows].sort((left, right) => {
        if (right.totalTokens !== left.totalTokens) {
            return compareUsageMeasurementsDescending(left.totalTokens, right.totalTokens);
        }
        if (right.totalCost !== left.totalCost) {
            return compareUsageMeasurementsDescending(left.totalCost, right.totalCost);
        }
        return left.label.localeCompare(right.label);
    });
}

function buildLegacyRowsForDimension(
    usage: UsageDataPoint[],
    dimension: UsageDimension,
): UsageBreakdownRow[] {
    const key = dimensionKeys[dimension];
    const grouped = new Map<string, UsageBreakdownRow>();

    for (const dataPoint of usage) {
        const groupKey = dataPoint[key];
        if (typeof groupKey !== 'string' || groupKey.trim().length === 0) {
            continue;
        }

        const tokenTotal = normalizeLegacyUsageTokens(dataPoint.tokens).total;
        const costTotal = getRecordTotal(dataPoint.cost);
        const current = grouped.get(groupKey);

        if (current) {
            current.totalTokens = addUsageMeasurements(current.totalTokens, tokenTotal);
            current.totalCost = addUsageMeasurements(current.totalCost, costTotal);
            current.reportCount += Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0;
            current.firstSeenAt = Math.min(current.firstSeenAt, dataPoint.timestamp);
            current.lastSeenAt = Math.max(current.lastSeenAt, dataPoint.timestamp);
            if (dataPoint.contextWindowTokens != null) current.contextWindowTokens = current.contextWindowTokens === null
                ? dataPoint.contextWindowTokens : Math.max(current.contextWindowTokens, dataPoint.contextWindowTokens);
            if (dataPoint.contextUsedTokens != null) current.contextUsedTokens = current.contextUsedTokens === null
                ? dataPoint.contextUsedTokens : Math.max(current.contextUsedTokens, dataPoint.contextUsedTokens);
            continue;
        }

        grouped.set(groupKey, {
            dimension,
            key: groupKey,
            label: dimension === 'backendMode' || dimension === 'source'
                ? formatUsageDimensionLabel(dimension, groupKey, groupKey)
                : groupKey,
            totalTokens: tokenTotal,
            totalCost: costTotal,
            reportCount: Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0,
            firstSeenAt: dataPoint.timestamp,
            lastSeenAt: dataPoint.timestamp,
            contextWindowTokens: dataPoint.contextWindowTokens ?? null,
            contextUsedTokens: dataPoint.contextUsedTokens ?? null,
        });
    }

    return sortBreakdownRows([...grouped.values()]);
}

function buildLegacyBucketRows(totals: Pick<UsageTotals, 'tokenBreakdown' | 'costBreakdown'>): UsageBreakdownRow[] {
    const keys = new Set([...Object.keys(totals.tokenBreakdown), ...Object.keys(totals.costBreakdown)]);
    return [...keys].map((key) => ({
        dimension: 'bucket' as const,
        key,
        label: key,
        totalTokens: totals.tokenBreakdown[key] ?? null,
        totalCost: totals.costBreakdown[key] ?? null,
        reportCount: 0,
        firstSeenAt: 0,
        lastSeenAt: 0,
        contextWindowTokens: null,
        contextUsedTokens: null,
    })).sort((left, right) => {
        if (right.totalTokens !== left.totalTokens) {
            return compareUsageMeasurementsDescending(left.totalTokens, right.totalTokens);
        }
        if (right.totalCost !== left.totalCost) {
            return compareUsageMeasurementsDescending(left.totalCost, right.totalCost);
        }
        return left.label.localeCompare(right.label);
    });
}

function buildLegacyTrend(usage: UsageDataPoint[]): UsageTrendPoint[] {
    return [...usage]
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((dataPoint) => ({
            timestamp: dataPoint.timestamp,
            tokens: normalizeLegacyUsageTokens(dataPoint.tokens).total,
            cost: getRecordTotal(dataPoint.cost),
            reportCount: Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0,
        }));
}

function buildLegacyCalendarDays(usage: UsageDataPoint[], timeZoneOffsetMinutes: number) {
    const days = new Map<string, UsageTrendPoint & { date: string }>();
    for (const point of buildLegacyTrend(usage)) {
        const timestampMs = point.timestamp * 1000;
        if (!Number.isFinite(timestampMs)) continue;
        const calendar = resolveUsageCalendarInstant(timestampMs, timeZoneOffsetMinutes);
        const day = days.get(calendar.date) ?? { date: calendar.date, timestamp: calendar.bucketStartMs / 1000,
            tokens: null, cost: null, reportCount: 0 };
        day.tokens = addUsageMeasurements(day.tokens, point.tokens);
        day.cost = addUsageMeasurements(day.cost, point.cost);
        day.reportCount += point.reportCount;
        days.set(calendar.date, day);
    }
    return [...days.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function resolveLegacyDayStreaks(days: ReturnType<typeof buildLegacyCalendarDays>, nowMs: number, timeZoneOffsetMinutes: number) {
    return resolveUsageDayStreaks({ days: days.map(day => ({ date: day.date,
        eventCount: day.reportCount > 0 || day.tokens !== null && day.tokens > 0 || day.cost !== null && day.cost > 0 ? 1 : 0 })),
        referenceMs: nowMs, timeZoneOffsetMinutes, coverage: 'partial' });
}

export function resolveResponseDayStreaks(response: UsageAnalyticsQueryResponse, timeZoneOffsetMinutes: number) {
    const summary = resolveUsageDayStreaks({ days: response.activity?.calendarDays, referenceMs: Date.now(),
        timeZoneOffsetMinutes, range: response.coverage?.range, coverage: response.coverage?.status });
    return { ...summary, activeDays: summary.activeDays ?? response.insights?.activeDays ?? null,
        longestStreakDays: summary.longestStreakDays ?? response.insights?.longestStreakDays ?? null };
}

function mapBreakdownEntry(
    entry: UsageAnalyticsBreakdownEntry,
    dimension: UsageBreakdownRow['dimension'],
    costMode: UsageCostMode,
): UsageBreakdownRow {
    return {
        dimension,
        key: entry.key,
        label: dimension === 'backendMode' || dimension === 'source'
            ? formatUsageDimensionLabel(dimension, entry.key, entry.label ?? entry.key)
            : entry.label ?? entry.key,
        totalTokens: resolveUsageMeasuredTokens(entry.tokens).total,
        totalCost: resolveAnalyticsCost(entry.cost, costMode),
        reportCount: entry.eventCount,
        firstSeenAt: 0,
        lastSeenAt: 0,
        contextWindowTokens: null,
        contextUsedTokens: null,
    };
}

function buildResponseRows(
    entries: readonly UsageAnalyticsBreakdownEntry[] | undefined,
    dimension: UsageBreakdownRow['dimension'],
    costMode: UsageCostMode,
): UsageBreakdownRow[] {
    return sortBreakdownRows((entries ?? []).map((entry) => mapBreakdownEntry(entry, dimension, costMode)));
}

function buildResponseBuckets(totals: ProtocolUsageAnalyticsTotals, costMode: UsageCostMode): UsageBreakdownRow[] {
    const tokens = totals.tokens;
    const cost = totals.cost;

    return sortBreakdownRows([
        {
            dimension: 'bucket',
            key: 'input',
            label: 'input',
            totalTokens: tokens.input,
            totalCost: 0,
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
        {
            dimension: 'bucket',
            key: 'output',
            label: 'output',
            totalTokens: tokens.output,
            totalCost: 0,
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
        {
            dimension: 'bucket',
            key: 'reasoning',
            label: 'reasoning',
            totalTokens: tokens.reasoning,
            totalCost: 0,
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
        {
            dimension: 'bucket',
            key: 'cacheRead',
            label: 'cacheRead',
            totalTokens: tokens.cacheRead,
            totalCost: 0,
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
        {
            dimension: 'bucket',
            key: 'cacheWrite',
            label: 'cacheWrite',
            totalTokens: tokens.cacheWrite,
            totalCost: 0,
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
        {
            dimension: 'bucket',
            key: 'total',
            label: 'total',
            totalTokens: resolveUsageMeasuredTokens(tokens).total,
            totalCost: resolveAnalyticsCost(cost, costMode),
            reportCount: totals.eventCount,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        },
    ]);
}

function mapKeyedLabel(value: { key: string; label: string } | undefined | null): UsageAnalyticsKeyedLabel | null {
    if (!value) {
        return null;
    }
    return { key: value.key, label: value.label };
}

/**
 * Canonical "sessions" count for a usage view (D-R2-6). Reconciles the two
 * server signals so the hero and the settings-home banner never disagree: the
 * message-stats session count (true distinct count, uncapped) and the session
 * breakdown length (sessions that produced USAGE in the window — which can
 * exceed the message count when a session logged usage but no chat messages).
 * Taking the max avoids undercounting usage-only sessions without ever
 * regressing to a top-limit-capped breakdown when the true count is larger.
 */
export function resolveSessionsUsed(response: UsageAnalyticsQueryResponse): number {
    const messageSessions = response.messageStats?.sessionCount ?? 0;
    const usageSessions = response.breakdowns?.session?.length ?? 0;
    return Math.max(messageSessions, usageSessions);
}

function buildInsightsFromResponse(response: UsageAnalyticsQueryResponse, timeZoneOffsetMinutes: number): UsageAnalyticsInsightsViewModel {
    const insights = response.insights ?? null;
    const sessionsUsed = resolveSessionsUsed(response);
    const messagesUsed = response.messageStats?.messageCount ?? response.totals.eventCount;
    const modelsTried = response.breakdowns?.model?.length ?? 0;
    const { activeDays, currentStreakDays, longestStreakDays } = resolveResponseDayStreaks(response, timeZoneOffsetMinutes);

    if (insights) {
        return {
            currentStreakDays,
            activeDays,
            longestStreakDays,
            sessionsUsed,
            messagesUsed,
            modelsTried,
            favoriteModel: mapKeyedLabel(insights.favoriteModel),
            favoriteModelChangeCount: insights.favoriteModelChangeCount,
            busiestMonth: mapKeyedLabel(insights.busiestMonth),
            busiestDay: mapKeyedLabel(insights.busiestDay),
            busiestHour: mapKeyedLabel(insights.busiestHour),
        };
    }

    return {
        currentStreakDays,
        activeDays,
        longestStreakDays,
        sessionsUsed,
        messagesUsed,
        modelsTried,
        favoriteModel: response.breakdowns?.model?.[0]
            ? { key: response.breakdowns.model[0].key, label: response.breakdowns.model[0].label ?? response.breakdowns.model[0].key }
            : null,
        favoriteModelChangeCount: 0,
        busiestMonth: null,
        busiestDay: null,
        busiestHour: null,
    };
}

function buildActivityFromResponse(response: UsageAnalyticsQueryResponse): UsageAnalyticsActivityViewModel {
    return {
        calendarDays: response.activity?.calendarDays ?? [],
        weekdayHourBuckets: response.activity?.weekdayHourBuckets ?? [],
    };
}

function buildLeadersFromResponse(response: UsageAnalyticsQueryResponse): UsageAnalyticsLeaderSections {
    const mapRows = (
        entries: readonly { key: string; label?: string; eventCount: number }[] | undefined,
        dimension?: 'backendMode' | 'source',
    ): UsageAnalyticsLeaderRow[] =>
        (entries ?? []).map((entry) => ({
            key: entry.key,
            label: dimension
                ? formatUsageDimensionLabel(dimension, entry.key, entry.label ?? entry.key)
                : entry.label ?? entry.key,
            eventCount: entry.eventCount,
        }));

    return {
        agents: mapRows(response.leaders?.agents),
        models: mapRows(response.leaders?.models),
        sessions: mapRows(response.leaders?.sessions),
        projects: mapRows(response.leaders?.projects),
        workspaces: mapRows(response.leaders?.workspaces),
        engines: mapRows(response.leaders?.engines, 'backendMode'),
    };
}

function mapTimelineLeaderEntry(
    entry: NonNullable<NonNullable<UsageAnalyticsQueryResponse['modelTimeline']>[number]['leaders']>[number],
    costPresentation: UsageCostMode | NonNullable<UsageAnalyticsViewModel['costPresentation']>,
    dimension?: 'backendMode' | 'source',
): UsageAnalyticsTimelineLeaderRow {
    const tokens = entry.tokens ?? createEmptyUsageTokens();
    const cost = entry.cost ?? createEmptyUsageCost();

    return {
        key: entry.key,
        label: dimension
            ? formatUsageDimensionLabel(dimension, entry.key, entry.label ?? entry.key)
            : entry.label ?? entry.key,
        eventCount: entry.eventCount,
        totalTokens: resolveUsageMeasuredTokens(tokens).total,
        totalCost: resolveAnalyticsCost(cost, costPresentation),
    };
}

function buildTimelineFromResponse(
    entries: UsageAnalyticsQueryResponse['modelTimeline'] | UsageAnalyticsQueryResponse['engineTimeline'] | undefined,
    costPresentation: UsageCostMode | NonNullable<UsageAnalyticsViewModel['costPresentation']>,
    dimension?: 'backendMode' | 'source',
): UsageAnalyticsTimelineBucket[] {
    return (entries ?? []).map((bucket) => ({
        bucketStartMs: bucket.bucketStartMs,
        bucketEndMs: bucket.bucketEndMs,
        leaders: bucket.leaders.map((entry) => mapTimelineLeaderEntry(entry, costPresentation, dimension)),
    }));
}

function buildTotalsFromResponse(
    totals: ProtocolUsageAnalyticsTotals,
    activeDays: number | null,
    costMode: UsageCostMode,
): UsageTotals {
    const totalCost = resolveAnalyticsCost(totals.cost, costMode);

    return {
        totalTokens: totals.tokens.total,
        totalCost,
        tokenBreakdown: {
            input: totals.tokens.input,
            output: totals.tokens.output,
            reasoning: totals.tokens.reasoning,
            cacheRead: totals.tokens.cacheRead,
            cacheWrite: totals.tokens.cacheWrite,
            total: totals.tokens.total,
        },
        costBreakdown: {
            total: totalCost,
        },
        reportCount: totals.eventCount,
        eventCount: totals.eventCount,
        activeDays,
        tokensByModel: {},
        costByModel: {},
        costSource: costMode === 'reported'
            ? 'reportedUsd'
            : costMode === 'estimated'
                ? 'estimatedUsd'
                : totals.cost.reportedUsd !== null && totals.cost.reportedUsd > 0
                    ? 'reportedUsd'
                    : 'estimatedUsd',
    };
}

function buildBreakdownsFromResponse(
    breakdowns: UsageAnalyticsBreakdowns | undefined,
    totals: ProtocolUsageAnalyticsTotals,
    costMode: UsageCostMode,
    trend: readonly UsageTrendPoint[],
    timeZoneOffsetMinutes: number,
): UsageBreakdownSections {
    return {
        agents: buildResponseRows(breakdowns?.agent, 'agent', costMode),
        models: buildResponseRows(breakdowns?.model, 'model', costMode),
        sessions: buildResponseRows(breakdowns?.session, 'session', costMode),
        projects: buildResponseRows(breakdowns?.project, 'project', costMode),
        workspaces: buildResponseRows(breakdowns?.workspace, 'workspace', costMode),
        backendModes: buildResponseRows(breakdowns?.backendMode, 'backendMode', costMode),
        sources: buildResponseRows(breakdowns?.source, 'source', costMode),
        buckets: buildResponseBuckets(totals, costMode),
        weeks: buildUsageWeeksBreakdown(trend, timeZoneOffsetMinutes),
    };
}

function buildTrendFromResponse(
    series: readonly UsageAnalyticsSeriesBucket[] | undefined,
    costMode: UsageCostMode,
): UsageTrendPoint[] {
    return [...(series ?? [])]
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
        .map((bucket) => {
            const tokens = resolveUsageMeasuredTokens(bucket.tokens);
            return {
                timestamp: Math.floor(bucket.bucketStartMs / 1000),
                tokens: tokens.total,
                tokensFromParts: tokens.fromParts,
                cost: resolveAnalyticsCost(bucket.cost, costMode),
                reportCount: bucket.eventCount,
            };
        });
}

function isUsageAnalyticsQueryResponse(source: UsageAnalyticsSource): source is UsageAnalyticsQueryResponse {
    return !Array.isArray(source)
        && typeof source === 'object'
        && source !== null
        && 'v' in source
        && (source as UsageAnalyticsQueryResponse).v === 1
        && 'totals' in source;
}

function matchesFocus(dataPoint: UsageDataPoint, focus: UsageFocus | null): boolean {
    if (!focus) {
        return true;
    }
    return dataPoint[dimensionKeys[focus.dimension]] === focus.key;
}

function buildSummaryFromResponse(response: UsageAnalyticsQueryResponse, timeZoneOffsetMinutes: number): UsageAnalyticsSummaryViewModel {
    const series = [...(response.series ?? [])].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    const nowMs = Date.now();
    const recentWindowStartMs = nowMs - USAGE_SUMMARY_RECENT_WINDOW_MS;
    const { activeDays, currentStreakDays } = resolveResponseDayStreaks(response, timeZoneOffsetMinutes);
    const costPresentation = response.costPresentation ?? null;
    const costMode = costPresentation?.mode ?? 'auto';
    const topEngineLeader = response.leaders?.engines?.[0] ?? null;
    const matchingEngineBreakdown = topEngineLeader
        ? response.breakdowns?.backendMode?.find((entry) => entry.key === topEngineLeader.key) ?? null
        : null;
    const recentActivity = series.slice(-14).map((bucket) => ({
        timestamp: Math.floor(bucket.bucketStartMs / 1000),
        active: bucket.eventCount > 0,
        tokens: resolveUsageMeasuredTokens(bucket.tokens).total,
        cost: resolveAnalyticsCost(bucket.cost, costPresentation),
    }));
    const weekBuckets = series.filter((bucket) => isSeriesBucketWithinWindow(bucket, recentWindowStartMs, nowMs));
    const busiestBucket = [...(response.activity?.weekdayHourBuckets ?? [])]
        .sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;

    return {
        activeDays,
        currentStreakDays,
        totalTokens: resolveUsageMeasuredTokens(response.totals.tokens).total,
        totalCost: resolveAnalyticsCost(response.totals.cost, costPresentation),
        currency: response.totals.cost.currency,
        weekTokens: weekBuckets.reduce<number | null>((sum, bucket) => addUsageMeasurements(sum, resolveUsageMeasuredTokens(bucket.tokens).total), weekBuckets.length === 0 ? 0 : null),
        weekCost: weekBuckets.reduce<number | null>((sum, bucket) => addUsageMeasurements(sum, resolveAnalyticsCost(bucket.cost, costPresentation)), weekBuckets.length === 0 ? 0 : null),
        topModel: response.breakdowns?.model?.[0] ? mapBreakdownEntry(response.breakdowns.model[0], 'model', costMode) : null,
        topEngine: topEngineLeader
            ? {
                dimension: 'backendMode',
                key: topEngineLeader.key,
                label: formatUsageDimensionLabel('backendMode', topEngineLeader.key, topEngineLeader.label ?? topEngineLeader.key),
                totalTokens: matchingEngineBreakdown ? resolveUsageMeasuredTokens(matchingEngineBreakdown.tokens).total : null,
                totalCost: matchingEngineBreakdown ? resolveAnalyticsCost(matchingEngineBreakdown.cost, costMode) : null,
                reportCount: topEngineLeader.eventCount,
                firstSeenAt: 0,
                lastSeenAt: 0,
                contextWindowTokens: null,
                contextUsedTokens: null,
            }
            : response.breakdowns?.backendMode?.[0]
                ? mapBreakdownEntry(response.breakdowns.backendMode[0], 'backendMode', costMode)
            : null,
        busiestWindowLabel: busiestBucket
            ? formatUsageWeekdayHourLabel(busiestBucket.weekday, busiestBucket.hour)
            : response.insights?.busiestHour?.label ?? null,
        recentActivity,
        hasData: response.totals.eventCount > 0 || series.length > 0,
    };
}

function buildSummaryFromLegacyUsage(usage: UsageDataPoint[], timeZoneOffsetMinutes: number): UsageAnalyticsSummaryViewModel {
    const totals = calculateTotals(usage, timeZoneOffsetMinutes);
    const series = buildLegacyTrend(usage);
    const days = buildLegacyCalendarDays(usage, timeZoneOffsetMinutes);
    const nowMs = Date.now();
    const streaks = resolveLegacyDayStreaks(days, nowMs, timeZoneOffsetMinutes);
    const recentWindowStartSeconds = Math.floor((nowMs - USAGE_SUMMARY_RECENT_WINDOW_MS) / 1000);
    const recentActivity = days.slice(-14).map((point) => ({
        timestamp: point.timestamp,
        active: point.reportCount > 0 || point.tokens !== null && point.tokens > 0 || point.cost !== null && point.cost > 0,
        tokens: point.tokens,
        cost: point.cost,
    }));
    const weekPoints = series.filter((point) => point.timestamp >= recentWindowStartSeconds);

    return {
        activeDays: streaks.activeDays,
        currentStreakDays: streaks.currentStreakDays,
        totalTokens: totals.totalTokens,
        totalCost: totals.totalCost,
        currency: 'USD',
        weekTokens: weekPoints.reduce<number | null>((sum, point) => addUsageMeasurements(sum, point.tokens), weekPoints.length === 0 ? 0 : null),
        weekCost: weekPoints.reduce<number | null>((sum, point) => addUsageMeasurements(sum, point.cost), weekPoints.length === 0 ? 0 : null),
        topModel: null,
        topEngine: null,
        busiestWindowLabel: null,
        recentActivity,
        hasData: usage.length > 0,
    };
}

function buildActivityFromLegacyUsage(days: ReturnType<typeof buildLegacyCalendarDays>): UsageAnalyticsActivityViewModel {
    const calendarDays = days.map((point) => ({
        date: point.date,
        eventCount: point.reportCount,
    }));

    return {
        calendarDays,
        weekdayHourBuckets: [],
    };
}

function buildInsightsFromLegacyUsage(usage: UsageDataPoint[], days: ReturnType<typeof buildLegacyCalendarDays>, timeZoneOffsetMinutes: number): UsageAnalyticsInsightsViewModel {
    const streaks = resolveLegacyDayStreaks(days, Date.now(), timeZoneOffsetMinutes);
    const favoriteModel = usage.find((point) => typeof point.modelId === 'string' && point.modelId.trim().length > 0)?.modelId ?? null;
    return {
        ...streaks,
        sessionsUsed: new Set(usage.map((point) => point.sessionId).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)).size,
        messagesUsed: usage.reduce((sum, point) => sum + (Number.isFinite(point.reportCount) ? point.reportCount : 0), 0),
        modelsTried: new Set(usage.map((point) => point.modelId).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)).size,
        favoriteModel: favoriteModel ? { key: favoriteModel, label: favoriteModel } : null,
        favoriteModelChangeCount: 0,
        busiestMonth: null,
        busiestDay: null,
        busiestHour: null,
    };
}

function buildLeadersFromLegacyUsage(usage: UsageDataPoint[]): UsageAnalyticsLeaderSections {
    const group = (dimension: UsageDimension): UsageAnalyticsLeaderRow[] => {
        const key = dimensionKeys[dimension];
        const counts = new Map<string, number>();
        for (const point of usage) {
            const value = point[key];
            if (typeof value !== 'string' || value.trim().length === 0) {
                continue;
            }
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts.entries()]
            .map(([entryKey, eventCount]) => ({ key: entryKey, label: entryKey, eventCount }))
            .sort((left, right) => right.eventCount - left.eventCount || left.label.localeCompare(right.label));
    };

    return {
        agents: group('agent'),
        models: group('model'),
        sessions: group('session'),
        projects: group('project'),
        workspaces: group('workspace'),
        engines: group('backendMode'),
    };
}

export function buildUsageAnalyticsSummaryViewModel(
    source: UsageAnalyticsSource,
    timeZoneOffsetMinutes = 0,
): UsageAnalyticsSummaryViewModel {
    if (isUsageAnalyticsQueryResponse(source)) {
        return buildSummaryFromResponse(source, timeZoneOffsetMinutes);
    }
    return buildSummaryFromLegacyUsage(source, timeZoneOffsetMinutes);
}

export function buildUsageHeroViewModel(
    overview: UsageTotals,
    insights: UsageAnalyticsInsightsViewModel,
    costPresentation: NonNullable<UsageAnalyticsViewModel['costPresentation']>,
): UsageHeroViewModel {
    return {
        totalTokens: overview.totalTokens,
        totalTokensFromParts: false,
        effectiveUsd: costPresentation.effectiveUsd,
        currency: costPresentation.currency,
        sessions: insights.sessionsUsed,
        events: overview.eventCount,
        messages: insights.messagesUsed,
        longestStreakDays: insights.longestStreakDays,
    };
}

export function buildUsageCacheSavings(
    overview: UsageTotals,
    cacheSavingsUsd?: number,
): UsageCacheSavingsViewModel | null {
    const cachedReadTokens = overview.tokenBreakdown.cacheRead ?? null;
    const usd = typeof cacheSavingsUsd === 'number' && Number.isFinite(cacheSavingsUsd) && cacheSavingsUsd > 0
        ? cacheSavingsUsd
        : null;
    if (!(cachedReadTokens !== null && cachedReadTokens > 0) && usd === null) {
        return null;
    }
    return { cachedReadTokens, cacheSavingsUsd: usd };
}

/**
 * Period-over-period token delta from the series halves. Splits the trend into
 * two equal-length halves (dropping the middle bucket when the length is odd)
 * and compares the recent half against the prior one. Pure — no server field
 * required, so it works identically for v2 and legacy sources.
 */
export function buildUsageTrendDelta(trend: readonly UsageTrendPoint[]): UsageTrendDelta {
    const half = Math.floor(trend.length / 2);
    if (half < 1 || trend.some(point => point.tokens === null || point.tokensFromParts)) {
        return { deltaPct: null, direction: 'flat' };
    }
    const sum = (points: readonly UsageTrendPoint[]): number =>
        points.reduce((total, point) => total + Math.max(0, point.tokens!), 0);
    const prior = sum(trend.slice(0, half));
    const recent = sum(trend.slice(trend.length - half));
    if (prior <= 0) {
        return { deltaPct: null, direction: recent > 0 ? 'up' : 'flat' };
    }
    const deltaPct = ((recent - prior) / prior) * 100;
    const direction = deltaPct > 0.5 ? 'up' : deltaPct < -0.5 ? 'down' : 'flat';
    return { deltaPct, direction };
}

export function buildUsageHeroTrend(trend: readonly UsageTrendPoint[]): UsageHeroTrend {
    return {
        sparkline: trend.map((point) => point.tokens),
        delta: buildUsageTrendDelta(trend),
    };
}

/**
 * Collapses the weekday×hour activity grid into a 24-bucket hour-of-day
 * distribution (Band 3). Always returns 24 entries so the chart can render a
 * fixed 24-column baseline even for sparse data.
 */
export function buildUsageHourRhythm(activity: UsageAnalyticsActivityViewModel): UsageHourRhythm {
    const counts = new Array<number>(24).fill(0);
    for (const bucket of activity.weekdayHourBuckets) {
        if (bucket.hour >= 0 && bucket.hour < 24) {
            counts[bucket.hour]! += bucket.eventCount;
        }
    }
    const hours: UsageHourRhythmBar[] = counts.map((eventCount, hour) => ({ hour, eventCount }));
    let busiestHour: number | null = null;
    let peakCount = 0;
    let total = 0;
    for (const bar of hours) {
        total += bar.eventCount;
        if (bar.eventCount > peakCount) {
            peakCount = bar.eventCount;
            busiestHour = bar.hour;
        }
    }
    return { hours, busiestHour: total > 0 ? busiestHour : null, peakCount, total };
}

const USAGE_COMPOSITION_ORDER: readonly UsageCompositionKey[] = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'reasoning',
];

/**
 * Ordered 100%-stacked token mix (Band 5). Segment order matches the accent
 * ramp so consumers colour segment N with `usageSeriesColor(theme, N)`.
 */
export function buildUsageComposition(overview: UsageTotals): UsageComposition {
    const mix = buildContextTokenMix(overview);
    const total = USAGE_COMPOSITION_ORDER.reduce<number | null>((sum, key) => addUsageMeasurements(sum, mix[key]), null);
    const segments: UsageCompositionSegment[] = USAGE_COMPOSITION_ORDER.map((key) => {
        const tokens = mix[key];
        return { key, tokens, pct: tokens === null || total === null ? null : total > 0 ? (tokens / total) * 100 : 0 };
    });
    return { segments, total };
}

/** Per-bucket token series for a single leader across a timeline (Band 5). */
export function buildUsageLeaderTrend(
    timeline: readonly UsageAnalyticsTimelineBucket[],
    key: string,
): (number | null)[] {
    return timeline.map((bucket) => {
        const leader = bucket.leaders.find((entry) => entry.key === key);
        return leader ? leader.totalTokens : null;
    });
}

export function buildUsageLeaderTrends(
    timeline: readonly UsageAnalyticsTimelineBucket[],
): Record<string, (number | null)[]> {
    const keys = new Set<string>();
    for (const bucket of timeline) {
        for (const leader of bucket.leaders) {
            keys.add(leader.key);
        }
    }
    const trends: Record<string, (number | null)[]> = {};
    for (const key of keys) {
        trends[key] = buildUsageLeaderTrend(timeline, key);
    }
    return trends;
}

/** Recover the `agentId` from an engine-timeline key (`agentId` | `agentId:backendMode`). */
export { agentIdFromEngineKey } from '@happier-dev/protocol/usage/usageFilterOptions';

/**
 * Per-AGENT token sparklines for the Band 5 "Agents" leader rows (D-R2-8). The
 * server exposes a model timeline (keyed by `modelId`) and an engine timeline
 * (keyed by `agentId` or `agentId:backendMode`) but no agent-grain timeline, so
 * the agent rows — keyed by `agentId` — previously borrowed the engine trends
 * and never matched a key (flat/missing sparkline). This re-aggregates the
 * engine timeline back to the agent grain, summing every `agentId[:backendMode]`
 * entry per bucket under its `agentId`, so the trend key space matches the rows.
 */
/**
 * The engine timeline at the Agent grain: each bucket's `agentId[:backendMode]` leaders summed under
 * their `agentId`. The Agent's own row label wins over a backend-mode label.
 */
export function buildUsageAgentTimeline(
    engineTimeline: readonly UsageAnalyticsTimelineBucket[],
): UsageAnalyticsTimelineBucket[] {
    return engineTimeline.map((bucket) => {
        const byAgent = new Map<string, UsageAnalyticsTimelineLeaderRow>();
        for (const leader of bucket.leaders) {
            const agentId = agentIdFromEngineKey(leader.key);
            const existing = byAgent.get(agentId);
            if (existing) {
                byAgent.set(agentId, {
                    ...existing,
                    label: leader.key === agentId ? leader.label : existing.label,
                    totalTokens: addUsageMeasurements(existing.totalTokens, leader.totalTokens),
                    totalCost: addUsageMeasurements(existing.totalCost, leader.totalCost),
                });
            } else {
                byAgent.set(agentId, { ...leader, key: agentId });
            }
        }
        return { bucketStartMs: bucket.bucketStartMs, bucketEndMs: bucket.bucketEndMs, leaders: [...byAgent.values()] };
    });
}

export function buildUsageAgentTrends(
    engineTimeline: readonly UsageAnalyticsTimelineBucket[],
): Record<string, (number | null)[]> {
    const agentIds = new Set<string>();
    for (const bucket of engineTimeline) {
        for (const leader of bucket.leaders) {
            agentIds.add(agentIdFromEngineKey(leader.key));
        }
    }
    const trends: Record<string, (number | null)[]> = {};
    for (const agentId of agentIds) {
        trends[agentId] = engineTimeline.map((bucket) =>
            bucket.leaders.filter(leader => agentIdFromEngineKey(leader.key) === agentId)
                .reduce<number | null>((sum, leader) => addUsageMeasurements(sum, leader.totalTokens), null),
        );
    }
    return trends;
}

/**
 * Per-week ranked rows from the period series (B-3). Groups trend buckets into
 * query-offset Monday weeks from the canonical Usage calendar owner,
 * summing tokens · cost · events, and returns them NEWEST-FIRST so the lens
 * reads as a chronological ledger rather than a token leaderboard. The label is
 * the week's start date; `key` is the ISO week-start (stable, export-friendly).
 */
export function buildUsageWeeksBreakdown(trend: readonly UsageTrendPoint[], timeZoneOffsetMinutes = 0): UsageBreakdownRow[] {
    const byWeekStart = new Map<number, UsageBreakdownRow>();
    for (const point of trend) {
        const bounds = resolveUsageBucketBounds('week', point.timestamp * 1000, timeZoneOffsetMinutes);
        const weekStartSeconds = bounds.bucketStartMs / 1000;
        const key = resolveUsageCalendarInstant(bounds.bucketStartMs, timeZoneOffsetMinutes).date;
        const existing = byWeekStart.get(weekStartSeconds);
        if (existing) {
            existing.totalTokens = addUsageMeasurements(existing.totalTokens, point.tokens);
            existing.totalCost = addUsageMeasurements(existing.totalCost, point.cost);
            existing.reportCount += Number.isFinite(point.reportCount) ? point.reportCount : 0;
            continue;
        }
        byWeekStart.set(weekStartSeconds, {
            dimension: 'week',
            key,
            label: key,
            totalTokens: point.tokens,
            totalCost: point.cost,
            reportCount: Number.isFinite(point.reportCount) ? point.reportCount : 0,
            firstSeenAt: weekStartSeconds,
            lastSeenAt: bounds.bucketEndMs / 1000,
            contextWindowTokens: null,
            contextUsedTokens: null,
        });
    }
    return [...byWeekStart.entries()]
        .sort((left, right) => right[0] - left[0])
        .map(([, row]) => row);
}

/** Pick the breakdown rows for a pivot dimension (E-1 / B-3). */
export function selectUsageBreakdownRows(
    breakdowns: UsageBreakdownSections,
    dimension: UsagePivotDimension,
): UsageBreakdownRow[] {
    switch (dimension) {
        case 'model':
            return breakdowns.models;
        case 'agent':
            return breakdowns.agents;
        case 'session':
            return breakdowns.sessions;
        case 'project':
            return breakdowns.projects;
        case 'workspace':
            return breakdowns.workspaces;
        case 'source':
            return breakdowns.sources;
        case 'week':
            return breakdowns.weeks;
    }
}

/**
 * Per-row token trends for a pivot dimension — only the dimensions that carry a
 * server timeline (models via `modelTimeline`, agents via the re-aggregated
 * engine timeline) get sparklines; the rest omit the column cleanly (E-1).
 */
export function selectUsagePivotTrends(
    leaderTrends: UsageLeaderTrends,
    dimension: UsagePivotDimension,
): Record<string, (number | null)[]> | null {
    if (dimension === 'model') {
        return leaderTrends.models;
    }
    if (dimension === 'agent') {
        return leaderTrends.agents;
    }
    return null;
}

/**
 * Ranked pivot view for the Band 5 dimension control (E-1). Rows are sorted by
 * total tokens (desc); the share denominator is the WHOLE dimension total (so a
 * "top 8" slice still shows honest shares), the single true-max row is the
 * leader (accent), and the per-row trend is attached where a timeline exists.
 */
export function buildUsagePivotView(
    breakdowns: UsageBreakdownSections,
    leaderTrends: UsageLeaderTrends,
    dimension: UsagePivotDimension,
): UsagePivotView {
    const source = selectUsageBreakdownRows(breakdowns, dimension);
    const trends = selectUsagePivotTrends(leaderTrends, dimension);
    // Weeks are a chronological ledger (newest first) — preserve that order
    // instead of ranking by tokens; every other dimension is a leaderboard.
    const ranked = dimension === 'week'
        ? [...source]
        : [...source].sort((left, right) => compareUsageMeasurementsDescending(left.totalTokens, right.totalTokens));
    const total = ranked.reduce<number | null>((sum, row) => addUsageMeasurements(sum, row.totalTokens), null);
    // The accent marks the single busiest row (true max), even when the order
    // is chronological rather than ranked.
    const leaderKey = ranked.reduce<{ key: string | null; tokens: number }>(
        (best, row) => (row.totalTokens !== null && row.totalTokens > best.tokens ? { key: row.key, tokens: row.totalTokens } : best),
        { key: null, tokens: -1 },
    ).key;
    const hasTrend = trends !== null && ranked.some((row) => (trends[row.key]?.length ?? 0) > 1);
    const rows: UsagePivotRow[] = ranked.map((row) => ({
        row,
        sharePct: row.totalTokens === null || total === null ? null : total > 0 ? (row.totalTokens / total) * 100 : 0,
        trend: trends?.[row.key] ?? [],
        isLeader: row.key === leaderKey,
    }));
    return { dimension, rows, total, hasTrend };
}

/** Synthetic key for the aggregated tail of a model-mix stack (B-1). */
export const USAGE_MODEL_MIX_OTHER_KEY = '__other__';

export interface UsageModelMixSeriesKey {
    key: string;
    /** Display label; empty for the synthetic "other" tail (the consumer translates). */
    label: string;
    /** Total tokens across the whole timeline (the legend's overall share basis). */
    totalTokens: number | null;
}

export interface UsageModelMixBucket {
    startMs: number;
    endMs: number;
    total: number | null;
    /** Original per-key amounts, before share normalization, aligned with `keys`. */
    tokens: (number | null)[];
    /**
     * Share (0..1) per series key, aligned index-for-index with `keys`. Sums to
     * ~1 in a non-empty bucket; all-zero for an empty bucket (renders as a gap in
     * the 100%-stacked area, never a fabricated flat band).
     */
    shares: (number | null)[];
}

/**
 * Stacked-share model/engine mix over time (B-1). `keys` are the top-N series by
 * total tokens (largest first → ramp index 0), with the remainder folded into a
 * single synthetic "other" tail; `buckets` carry the per-bucket normalized share
 * of each key. Pure — works identically for the model timeline and the engine
 * timeline.
 */
export interface UsageModelMix {
    keys: UsageModelMixSeriesKey[];
    buckets: UsageModelMixBucket[];
    /** Grand total tokens across the timeline (legend share denominator). */
    total: number | null;
    /** Enough shape to draw an area: ≥2 buckets, ≥1 key, and some volume. */
    hasData: boolean;
}

const USAGE_MODEL_MIX_DEFAULT_MAX_SERIES = 5;

export function buildUsageModelMix(
    timeline: readonly UsageAnalyticsTimelineBucket[],
    maxSeries: number = USAGE_MODEL_MIX_DEFAULT_MAX_SERIES,
): UsageModelMix {
    // 1) Rank keys by total tokens across the whole timeline.
    const totalsByKey = new Map<string, { label: string; tokens: number | null }>();
    for (const bucket of timeline) {
        for (const leader of bucket.leaders) {
            const existing = totalsByKey.get(leader.key);
            if (existing) {
                existing.tokens = addUsageMeasurements(existing.tokens, leader.totalTokens);
            } else {
                totalsByKey.set(leader.key, { label: leader.label, tokens: leader.totalTokens });
            }
        }
    }
    const ranked = [...totalsByKey.entries()]
        .map(([key, value]) => ({ key, label: value.label, totalTokens: value.tokens }))
        .sort((left, right) => compareUsageMeasurementsDescending(left.totalTokens, right.totalTokens) || left.key.localeCompare(right.key));

    const grandTotal = ranked.reduce<number | null>((sum, entry) => addUsageMeasurements(sum, entry.totalTokens), null);
    const cap = Math.max(1, maxSeries);
    const topEntries = ranked.slice(0, cap);
    const tailEntries = ranked.slice(cap);
    const topKeys = new Set(topEntries.map((entry) => entry.key));

    const keys: UsageModelMixSeriesKey[] = topEntries.map((entry) => ({
        key: entry.key,
        label: entry.label,
        totalTokens: entry.totalTokens,
    }));
    if (tailEntries.length > 0) {
        keys.push({
            key: USAGE_MODEL_MIX_OTHER_KEY,
            label: '',
            totalTokens: tailEntries.reduce<number | null>((sum, entry) => addUsageMeasurements(sum, entry.totalTokens), null),
        });
    }

    // 2) Normalize each bucket into per-key shares (largest first; tail → other).
    const buckets: UsageModelMixBucket[] = timeline.map((bucket) => {
        const tokensByKey = new Map<string, number | null>();
        let bucketTotal: number | null = null;
        for (const leader of bucket.leaders) {
            tokensByKey.set(leader.key, addUsageMeasurements(tokensByKey.get(leader.key) ?? null, leader.totalTokens));
            bucketTotal = addUsageMeasurements(bucketTotal, leader.totalTokens);
        }
        const tokens = keys.map((seriesKey) => {
            if (seriesKey.key === USAGE_MODEL_MIX_OTHER_KEY) {
                let otherTokens: number | null = null;
                for (const [key, tokens] of tokensByKey) {
                    if (!topKeys.has(key)) {
                        otherTokens = addUsageMeasurements(otherTokens, tokens);
                    }
                }
                return otherTokens;
            }
            return tokensByKey.has(seriesKey.key) ? tokensByKey.get(seriesKey.key)! : null;
        });
        const shares = tokens.map((amount) => bucketTotal === null || amount === null ? null : bucketTotal > 0 ? amount / bucketTotal : 0);
        return { startMs: bucket.bucketStartMs, endMs: bucket.bucketEndMs, total: bucketTotal, tokens, shares };
    });

    const nonEmptyBuckets = buckets.filter((bucket) => bucket.total !== null && bucket.total > 0).length;
    return {
        keys,
        buckets,
        total: grandTotal,
        hasData: keys.length > 0 && buckets.length >= 2 && nonEmptyBuckets >= 1,
    };
}

/** One busiest-cell coordinate for the punch card annotation (E-2). */
export interface UsagePunchCell {
    weekday: number;
    hour: number;
    eventCount: number;
}

/**
 * The full 7×24 weekday×hour grid for the Band 3 punch card (E-2). `cells` is
 * indexed `[weekday][hour]` (weekday 0 = Sunday, hour 0–23); `peak` is the max
 * single-cell count (the alpha denominator); `busiest` is the single hottest
 * cell (null when there is no activity).
 */
export interface UsagePunchCard {
    cells: number[][];
    peak: number;
    busiest: UsagePunchCell | null;
    total: number;
}

export function buildUsagePunchCard(activity: UsageAnalyticsActivityViewModel): UsagePunchCard {
    const cells: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    let peak = 0;
    let total = 0;
    let busiest: UsagePunchCell | null = null;
    for (const bucket of activity.weekdayHourBuckets) {
        if (bucket.weekday < 0 || bucket.weekday > 6 || bucket.hour < 0 || bucket.hour > 23) {
            continue;
        }
        const next = cells[bucket.weekday]![bucket.hour]! + bucket.eventCount;
        cells[bucket.weekday]![bucket.hour] = next;
        total += bucket.eventCount;
        if (next > peak) {
            peak = next;
            busiest = { weekday: bucket.weekday, hour: bucket.hour, eventCount: next };
        }
    }
    return { cells, peak, busiest: total > 0 ? busiest : null, total };
}

/**
 * "How efficiently" headlines (E-3): cache-hit rate and effective $/Mtok. Both
 * are pure client derivations that return `null` when their basis is missing —
 * never a fabricated 0% or $0.
 */
export function buildUsageEfficiency(
    overview: UsageTotals,
    costPresentation: NonNullable<UsageAnalyticsViewModel['costPresentation']>,
): UsageEfficiencyViewModel {
    const inputTokens = overview.tokenBreakdown.input ?? null;
    const cachedReadTokens = overview.tokenBreakdown.cacheRead ?? null;
    const cacheBasis = inputTokens === null || cachedReadTokens === null ? null : inputTokens + cachedReadTokens;
    const cacheHitRatePct = cacheBasis !== null && cacheBasis > 0 && cachedReadTokens !== null ? (cachedReadTokens / cacheBasis) * 100 : null;
    const totalTokens = overview.totalTokens;
    const effectiveUsd = costPresentation.effectiveUsd;
    const costPerMtokUsd = totalTokens !== null && totalTokens > 0 && effectiveUsd !== null && effectiveUsd >= 0
        ? (effectiveUsd / totalTokens) * 1_000_000
        : null;
    return {
        cacheHitRatePct,
        cachedReadTokens,
        inputTokens,
        costPerMtokUsd,
        currency: costPresentation.currency,
    };
}

function resolveContextUsedPct(usedTokens: number | null, windowTokens: number | null): number | null {
    if (usedTokens === null || windowTokens === null || windowTokens <= 0) {
        return null;
    }
    return Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100));
}

function buildContextTokenMix(overview: UsageTotals): UsageContextTokenMix {
    const breakdown = overview.tokenBreakdown;
    return {
        input: breakdown.input ?? null,
        output: breakdown.output ?? null,
        reasoning: breakdown.reasoning ?? null,
        cacheRead: breakdown.cacheRead ?? null,
        cacheWrite: breakdown.cacheWrite ?? null,
    };
}

export function buildUsageContextViewModel(
    overview: UsageTotals,
    usedTokens: number | null,
    windowTokens: number | null,
): UsageContextViewModel | null {
    const tokenMix = buildContextTokenMix(overview);
    const hasContext = usedTokens !== null || windowTokens !== null;
    const hasTokenMix = Object.values(tokenMix).some(value => value !== null && value > 0);
    if (!hasContext && !hasTokenMix) {
        return null;
    }
    return {
        usedTokens,
        windowTokens,
        usedPct: resolveContextUsedPct(usedTokens, windowTokens),
        tokenMix,
    };
}

function resolveLegacyContextExtent(
    dataPoints: readonly UsageDataPoint[],
    field: 'contextUsedTokens' | 'contextWindowTokens',
): number | null {
    let extent: number | null = null;
    for (const dataPoint of dataPoints) {
        const value = dataPoint[field];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            extent = extent === null ? value : Math.max(extent, value);
        }
    }
    return extent;
}

function memoizeViewSection<T>(build: () => T): () => T {
    let cached: { value: T } | undefined;
    return () => {
        cached ??= { value: build() };
        return cached.value;
    };
}

export function buildUsageAnalyticsViewModel(
    source: UsageAnalyticsSource,
    filters: UsageFilterState,
    timeZoneOffsetMinutes = 0,
): UsageAnalyticsViewModel {
    if (isUsageAnalyticsQueryResponse(source)) {
        // Each admitted response has one view per presentation in the body kit. Derive only
        // the sections a body reads; dependent sections share these same results.
        const costPresentation = memoizeViewSection(() => resolveResponseCostPresentation(source, filters.costMode));
        const activity = memoizeViewSection(() => buildActivityFromResponse(source));
        const insights = memoizeViewSection(() => buildInsightsFromResponse(source, timeZoneOffsetMinutes));
        const leaders = memoizeViewSection(() => buildLeadersFromResponse(source));
        const overview = memoizeViewSection(() => buildTotalsFromResponse(source.totals, insights().activeDays, filters.costMode));
        const categoryOverview = memoizeViewSection(() => {
            const categoryTokens = source.tokenCategories ?? resolveUsageTokenCategories(source.totals.tokens, null);
            const displayTotals = { ...source.totals, tokens: categoryTokens ?? {
                ...createEmptyUsageTokens(), total: source.totals.tokens.total,
            } };
            return buildTotalsFromResponse(displayTotals, insights().activeDays, filters.costMode);
        });
        const trend = memoizeViewSection(() => buildTrendFromResponse(source.series, filters.costMode));
        const modelTimeline = memoizeViewSection(() => buildTimelineFromResponse(source.modelTimeline, costPresentation()));
        const engineTimeline = memoizeViewSection(() => buildTimelineFromResponse(source.engineTimeline, costPresentation(), 'backendMode'));
        const pageCost = memoizeViewSection(() => projectUsagePageCost(source, filters.costMode));
        const hero = memoizeViewSection((): UsageHeroViewModel => {
            const tokens = resolveUsageMeasuredTokens(source.totals.tokens);
            return { ...buildUsageHeroViewModel(overview(), insights(), costPresentation()),
                totalTokens: tokens.total, totalTokensFromParts: tokens.fromParts };
        });
        const heroTrend = memoizeViewSection(() => buildUsageHeroTrend(trend()));
        const hourRhythm = memoizeViewSection(() => buildUsageHourRhythm(activity()));
        const punchCard = memoizeViewSection(() => buildUsagePunchCard(activity()));
        const composition = memoizeViewSection(() => buildUsageComposition(categoryOverview()));
        const modelMix = memoizeViewSection(() => buildUsageModelMix(modelTimeline()));
        const engineMix = memoizeViewSection(() => buildUsageModelMix(engineTimeline()));
        const agentMix = memoizeViewSection(() => buildUsageModelMix(buildUsageAgentTimeline(engineTimeline())));
        const leaderTrends = memoizeViewSection(() => ({
            models: buildUsageLeaderTrends(modelTimeline()),
            engines: buildUsageLeaderTrends(engineTimeline()),
            agents: buildUsageAgentTrends(engineTimeline()),
        }));
        const efficiency = memoizeViewSection(() => buildUsageEfficiency(categoryOverview(), costPresentation()));
        const cacheSavings = memoizeViewSection(() => buildUsageCacheSavings(overview(), source.insights?.cacheSavingsUsd));
        const context = memoizeViewSection(() => buildUsageContextViewModel(
            categoryOverview(),
            source.totals.context?.usedTokens ?? null,
            source.totals.context?.windowTokens ?? null,
        ));
        const breakdowns = memoizeViewSection(() => buildBreakdownsFromResponse(
            source.breakdowns, source.totals, filters.costMode, trend(), timeZoneOffsetMinutes,
        ));
        const availableCostModes = memoizeViewSection(() => resolveAvailableCostModes(source.totals.cost));
        return {
            get pageCost() { return pageCost(); },
            timeZoneOffsetMinutes,
            get overview() { return overview(); },
            get hero() { return hero(); },
            get heroTrend() { return heroTrend(); },
            get hourRhythm() { return hourRhythm(); },
            get punchCard() { return punchCard(); },
            get composition() { return composition(); },
            get modelMix() { return modelMix(); },
            get engineMix() { return engineMix(); },
            get agentMix() { return agentMix(); },
            get leaderTrends() { return leaderTrends(); },
            get efficiency() { return efficiency(); },
            get cacheSavings() { return cacheSavings(); },
            get context() { return context(); },
            get trend() { return trend(); },
            get breakdowns() { return breakdowns(); },
            get insights() { return insights(); },
            get activity() { return activity(); },
            get leaders() { return leaders(); },
            get modelTimeline() { return modelTimeline(); },
            get engineTimeline() { return engineTimeline(); },
            get availableCostModes() { return availableCostModes(); },
            get costPresentation() { return costPresentation(); },
            filteredUsageCount: source.totals.eventCount,
            focus: filters.focus,
        };
    }

    const filteredUsage = source.filter((dataPoint) => matchesFocus(dataPoint, filters.focus));
    const totals = calculateTotals(filteredUsage, timeZoneOffsetMinutes);
    const canonicalTokens = filteredUsage.map((point) => normalizeLegacyUsageTokens(point.tokens));
    const canonicalTokenBreakdown = canonicalTokens.reduce<Record<string, number | null>>((sum, tokens) => {
        for (const [key, value] of Object.entries(tokens)) {
            if (key !== 'total') sum[key] = addUsageMeasurements(sum[key] ?? null, value);
        }
        return sum;
    }, {});
    const days = buildLegacyCalendarDays(filteredUsage, timeZoneOffsetMinutes);
    const activity = buildActivityFromLegacyUsage(days);
    const insights = buildInsightsFromLegacyUsage(filteredUsage, days, timeZoneOffsetMinutes);
    const leaders = buildLeadersFromLegacyUsage(filteredUsage);
    const hasLegacyPrice = filteredUsage.length > 0 && totals.totalCost !== null;
    const costPresentation = hasLegacyPrice
        ? createLegacyCostPresentation({ reportedUsd: totals.totalCost, estimatedUsd: totals.totalCost, currency: 'USD' })
        : createCostPresentation(createEmptyUsageCost(), 'auto');
    const legacyOverview: UsageTotals = {
        ...totals,
        tokenBreakdown: canonicalTokenBreakdown,
        activeDays: insights.activeDays,
        eventCount: totals.reportCount,
        costSource: 'legacy',
    };
    const legacyCategoryOverview: UsageTotals = {
        ...legacyOverview,
        tokenBreakdown: createEmptyUsageTokens(),
    };
    const legacyContextUsed = resolveLegacyContextExtent(filteredUsage, 'contextUsedTokens');
    const legacyContextWindow = resolveLegacyContextExtent(filteredUsage, 'contextWindowTokens');
    const legacyTrend = buildLegacyTrend(filteredUsage);

    return {
        timeZoneOffsetMinutes,
        overview: legacyOverview,
        hero: buildUsageHeroViewModel(legacyOverview, insights, costPresentation),
        heroTrend: buildUsageHeroTrend(legacyTrend),
        hourRhythm: buildUsageHourRhythm(activity),
        punchCard: buildUsagePunchCard(activity),
        composition: buildUsageComposition(legacyCategoryOverview),
        modelMix: buildUsageModelMix([]),
        engineMix: buildUsageModelMix([]),
        agentMix: buildUsageModelMix([]),
        leaderTrends: { models: {}, engines: {}, agents: {} },
        efficiency: buildUsageEfficiency(legacyCategoryOverview, costPresentation),
        cacheSavings: buildUsageCacheSavings(legacyOverview),
        context: buildUsageContextViewModel(legacyCategoryOverview, legacyContextUsed, legacyContextWindow),
        trend: legacyTrend,
        insights,
        activity,
        leaders,
        modelTimeline: [],
        engineTimeline: [],
        availableCostModes: resolveAvailableCostModes({
            reportedUsd: totals.totalCost,
            estimatedUsd: totals.totalCost,
            currency: 'USD',
        }, true),
        costPresentation,
        breakdowns: {
            agents: buildLegacyRowsForDimension(filteredUsage, 'agent'),
            models: buildLegacyRowsForDimension(filteredUsage, 'model'),
            sessions: buildLegacyRowsForDimension(filteredUsage, 'session'),
            projects: buildLegacyRowsForDimension(filteredUsage, 'project'),
            workspaces: buildLegacyRowsForDimension(filteredUsage, 'workspace'),
            backendModes: buildLegacyRowsForDimension(filteredUsage, 'backendMode'),
            sources: buildLegacyRowsForDimension(filteredUsage, 'source'),
            buckets: buildLegacyBucketRows(totals),
            weeks: buildUsageWeeksBreakdown(legacyTrend, timeZoneOffsetMinutes),
        },
        filteredUsageCount: filteredUsage.length,
        focus: filters.focus,
    };
}
