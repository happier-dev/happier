import type {
    UsageAnalyticsBreakdownDimension,
    UsageAnalyticsBreakdownEntry,
    UsageAnalyticsBreakdowns,
    UsageAnalyticsQueryResponse,
    UsageAnalyticsSeriesBucket,
    UsageAnalyticsTotals as ProtocolUsageAnalyticsTotals,
} from '@happier-dev/protocol';

import type { UsageDataPoint, UsageTotals } from './apiUsage';
import { calculateTotals, getRecordTotal } from './apiUsage';
import { formatUsageDimensionLabel } from './formatUsageDimensionLabel';
import { formatUsageWeekdayHourLabel } from './formatUsageRhythmLabel';
import type { UsagePeriod } from './usagePeriods';

export type UsageMetric = 'tokens' | 'cost';
export type UsageCostMode = 'auto' | 'reported' | 'estimated';

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
    tokens: number;
    cost: number;
    reportCount: number;
}

export interface UsageBreakdownRow {
    dimension: UsageDimension | 'bucket' | 'week';
    key: string;
    label: string;
    totalTokens: number;
    totalCost: number;
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
    currentStreakDays: number;
    activeDays: number;
    longestStreakDays: number;
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
    totalTokens: number;
    totalCost: number;
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
    totalTokens: number;
    /** Effective (auto) cost for the period, independent of the metric toggle. */
    effectiveUsd: number;
    currency: string;
    sessions: number;
    events: number;
    /** Total chat messages across the period (messageStats fold-back, B-2). */
    messages: number;
    longestStreakDays: number;
}

/**
 * Cache-savings figure for the insights strip.
 *
 * `cacheSavingsUsd` is producer-computed from its provider pricing table and
 * summed by the server; the UI never derives pricing from token counts.
 */
export interface UsageCacheSavingsViewModel {
    cachedReadTokens: number;
    cacheSavingsUsd: number | null;
}

export interface UsageContextTokenMix {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
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
    sparkline: number[];
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
    tokens: number;
    /** Share of the total token mix (0–100); 0 when there is no volume. */
    pct: number;
}

/** Ordered 100%-stacked token mix for the Band 5 composition strip. */
export interface UsageComposition {
    segments: UsageCompositionSegment[];
    total: number;
}

/** Per-leader token sparklines keyed by leader id, for the Band 5 leader rows. */
export interface UsageLeaderTrends {
    models: Record<string, number[]>;
    engines: Record<string, number[]>;
    /** Keyed by `agentId` — the same key space as the agents breakdown rows. */
    agents: Record<string, number[]>;
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
    sharePct: number;
    /** Per-row token sparkline (empty for dimensions without a timeline). */
    trend: number[];
    /** The single leader row (the true max) carries the accent; others stay neutral. */
    isLeader: boolean;
}

export interface UsagePivotView {
    dimension: UsagePivotDimension;
    rows: UsagePivotRow[];
    /** Total tokens across every row of the dimension (share denominator). */
    total: number;
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
    cachedReadTokens: number;
    inputTokens: number;
    /** effectiveUsd / totalTokens × 1e6, or null without tokens and cost. */
    costPerMtokUsd: number | null;
    currency: string;
}

export interface UsageAnalyticsViewModel {
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
    costPresentation: NonNullable<UsageAnalyticsQueryResponse['costPresentation']>;
    filteredUsageCount: number;
    focus: UsageFocus | null;
}

export interface UsageSummaryActivityPoint {
    timestamp: number;
    active: boolean;
    tokens: number;
    cost: number;
}

export interface UsageAnalyticsSummaryViewModel {
    activeDays: number;
    currentStreakDays: number;
    totalTokens: number;
    totalCost: number;
    currency: string;
    weekTokens: number;
    weekCost: number;
    topModel: UsageBreakdownRow | null;
    topEngine: UsageBreakdownRow | null;
    busiestWindowLabel: string | null;
    recentActivity: UsageSummaryActivityPoint[];
    hasData: boolean;
}

export type UsageAnalyticsSource = UsageDataPoint[] | UsageAnalyticsQueryResponse;

const USAGE_SUMMARY_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_SUMMARY_DAY_MS = 24 * 60 * 60 * 1000;

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

function resolveDisplayCost(cost: ProtocolUsageAnalyticsTotals['cost']): number {
    if (cost.effectiveUsd !== undefined) {
        return cost.effectiveUsd;
    }
    if ((cost.invoiceUsd ?? 0) > 0) {
        return cost.invoiceUsd ?? 0;
    }
    return cost.reportedUsd > 0 ? cost.reportedUsd : cost.estimatedUsd;
}

function resolveCostForMode(
    cost: ProtocolUsageAnalyticsTotals['cost'],
    mode: UsageCostMode,
): number {
    if (mode === 'reported') {
        return cost.reportedUsd;
    }
    if (mode === 'estimated') {
        return cost.estimatedUsd;
    }
    return resolveDisplayCost(cost);
}

function resolveAnalyticsCost(
    cost: ProtocolUsageAnalyticsTotals['cost'],
    modeOrPresentation?: UsageCostMode | NonNullable<UsageAnalyticsViewModel['costPresentation']> | null,
): number {
    if (typeof modeOrPresentation === 'string') {
        return resolveCostForMode(cost, modeOrPresentation);
    }
    if (modeOrPresentation) {
        return resolveCostForMode(cost, modeOrPresentation.mode);
    }
    return resolveDisplayCost(cost);
}

function resolveCostSource(cost: ProtocolUsageAnalyticsTotals['cost'], mode: UsageCostMode): NonNullable<UsageAnalyticsViewModel['costPresentation']>['source'] {
    if (mode === 'reported') return cost.reportedUsd > 0 ? 'provider_reported' : 'none';
    if (mode === 'estimated') return cost.estimatedUsd > 0 ? 'pricing_estimate' : 'none';
    if ((cost.invoiceUsd ?? 0) > 0) return 'invoice';
    if (cost.reportedUsd > 0) return 'provider_reported_api_equivalent';
    if (cost.estimatedUsd > 0) return 'pricing_estimate';
    return 'none';
}

function resolveAvailableCostModes(cost: ProtocolUsageAnalyticsTotals['cost'], legacyOnly = false): UsageCostMode[] {
    const modes: UsageCostMode[] = ['auto'];

    if (legacyOnly) {
        return modes;
    }

    if (cost.reportedUsd > 0) {
        modes.push('reported');
    }
    if (cost.estimatedUsd > 0) {
        modes.push('estimated');
    }

    return modes;
}

function resolveEffectiveCost(cost: ProtocolUsageAnalyticsTotals['cost'], mode: UsageCostMode): number {
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
        effectiveUsd: cost.reportedUsd > 0 ? cost.reportedUsd : cost.estimatedUsd,
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

function countActiveBuckets(series: readonly UsageAnalyticsSeriesBucket[]): number {
    let activeDays = 0;
    for (const bucket of series) {
        if (bucket.tokens.total > 0 || resolveDisplayCost(bucket.cost) > 0) {
            activeDays += 1;
        }
    }
    return activeDays;
}

function isActiveSeriesBucket(bucket: UsageAnalyticsSeriesBucket): boolean {
    return bucket.tokens.total > 0 || resolveDisplayCost(bucket.cost) > 0;
}

function isSeriesBucketWithinWindow(
    bucket: UsageAnalyticsSeriesBucket,
    windowStartMs: number,
    windowEndMs: number,
): boolean {
    return bucket.bucketEndMs > windowStartMs && bucket.bucketStartMs <= windowEndMs;
}

function countCurrentStreakThroughNow(
    series: readonly UsageAnalyticsSeriesBucket[],
    nowMs: number,
): number {
    const activeBuckets = series
        .filter(isActiveSeriesBucket)
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    const latestBucket = activeBuckets[activeBuckets.length - 1];
    if (!latestBucket || !isSeriesBucketWithinWindow(latestBucket, nowMs - USAGE_SUMMARY_DAY_MS, nowMs)) {
        return 0;
    }

    let streak = 0;
    let nextBucketStartMs: number | null = null;
    for (let index = activeBuckets.length - 1; index >= 0; index -= 1) {
        const bucket = activeBuckets[index];
        if (nextBucketStartMs !== null && nextBucketStartMs - bucket.bucketEndMs > 1) {
            break;
        }
        streak += 1;
        nextBucketStartMs = bucket.bucketStartMs;
    }
    return streak;
}

function mapLegacyTrendToSeriesBuckets(series: readonly UsageTrendPoint[]): UsageAnalyticsSeriesBucket[] {
    return series.map((point) => ({
        bucketStartMs: point.timestamp * 1000,
        bucketEndMs: (point.timestamp * 1000) + USAGE_SUMMARY_DAY_MS,
        eventCount: point.reportCount,
        tokens: {
            input: point.tokens,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: point.tokens,
        },
        cost: {
            reportedUsd: point.cost,
            estimatedUsd: point.cost,
            currency: 'USD',
        },
    }));
}

function sortBreakdownRows(rows: UsageBreakdownRow[]): UsageBreakdownRow[] {
    return [...rows].sort((left, right) => {
        if (right.totalTokens !== left.totalTokens) {
            return right.totalTokens - left.totalTokens;
        }
        if (right.totalCost !== left.totalCost) {
            return right.totalCost - left.totalCost;
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

        const tokenTotal = getRecordTotal(dataPoint.tokens);
        const costTotal = getRecordTotal(dataPoint.cost);
        const current = grouped.get(groupKey);

        if (current) {
            current.totalTokens += tokenTotal;
            current.totalCost += costTotal;
            current.reportCount += Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0;
            current.firstSeenAt = Math.min(current.firstSeenAt, dataPoint.timestamp);
            current.lastSeenAt = Math.max(current.lastSeenAt, dataPoint.timestamp);
            current.contextWindowTokens = Math.max(
                current.contextWindowTokens ?? 0,
                dataPoint.contextWindowTokens ?? 0,
            ) || null;
            current.contextUsedTokens = Math.max(
                current.contextUsedTokens ?? 0,
                dataPoint.contextUsedTokens ?? 0,
            ) || null;
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
        totalTokens: totals.tokenBreakdown[key] ?? 0,
        totalCost: totals.costBreakdown[key] ?? 0,
        reportCount: 0,
        firstSeenAt: 0,
        lastSeenAt: 0,
        contextWindowTokens: null,
        contextUsedTokens: null,
    })).sort((left, right) => {
        if (right.totalTokens !== left.totalTokens) {
            return right.totalTokens - left.totalTokens;
        }
        if (right.totalCost !== left.totalCost) {
            return right.totalCost - left.totalCost;
        }
        return left.label.localeCompare(right.label);
    });
}

function buildLegacyTrend(usage: UsageDataPoint[]): UsageTrendPoint[] {
    return [...usage]
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((dataPoint) => ({
            timestamp: dataPoint.timestamp,
            tokens: getRecordTotal(dataPoint.tokens),
            cost: getRecordTotal(dataPoint.cost),
            reportCount: Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0,
        }));
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
        totalTokens: entry.tokens.total,
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
            totalTokens: tokens.total,
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

function buildInsightsFromResponse(response: UsageAnalyticsQueryResponse, activity: UsageAnalyticsActivityViewModel): UsageAnalyticsInsightsViewModel {
    const insights = response.insights ?? null;
    const series = [...(response.series ?? [])].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    const sessionsUsed = resolveSessionsUsed(response);
    const messagesUsed = response.messageStats?.messageCount ?? response.totals.eventCount;
    const modelsTried = response.breakdowns?.model?.length ?? 0;
    const currentStreakDays = countCurrentStreakThroughNow(series, Date.now());

    if (insights) {
        return {
            currentStreakDays,
            activeDays: insights.activeDays,
            longestStreakDays: insights.longestStreakDays,
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
        activeDays: activity.calendarDays.filter((day) => day.eventCount > 0).length,
        longestStreakDays: 0,
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
    const tokens = entry.tokens ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    };
    const cost = entry.cost ?? {
        reportedUsd: 0,
        estimatedUsd: 0,
        currency: 'USD',
    };

    return {
        key: entry.key,
        label: dimension
            ? formatUsageDimensionLabel(dimension, entry.key, entry.label ?? entry.key)
            : entry.label ?? entry.key,
        eventCount: entry.eventCount,
        totalTokens: tokens.total,
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
    series: readonly UsageAnalyticsSeriesBucket[] | undefined,
    costMode: UsageCostMode,
): UsageTotals {
    const activeDays = countActiveBuckets(series ?? []);
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
                : totals.cost.reportedUsd > 0
                    ? 'reportedUsd'
                    : 'estimatedUsd',
    };
}

function buildBreakdownsFromResponse(
    breakdowns: UsageAnalyticsBreakdowns | undefined,
    totals: ProtocolUsageAnalyticsTotals,
    costMode: UsageCostMode,
    trend: readonly UsageTrendPoint[],
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
        weeks: buildUsageWeeksBreakdown(trend),
    };
}

function buildTrendFromResponse(
    series: readonly UsageAnalyticsSeriesBucket[] | undefined,
    costMode: UsageCostMode,
): UsageTrendPoint[] {
    return [...(series ?? [])]
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
        .map((bucket) => ({
            timestamp: Math.floor(bucket.bucketStartMs / 1000),
            tokens: bucket.tokens.total,
            cost: resolveAnalyticsCost(bucket.cost, costMode),
            reportCount: bucket.eventCount,
        }));
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

function buildSummaryFromResponse(response: UsageAnalyticsQueryResponse): UsageAnalyticsSummaryViewModel {
    const series = [...(response.series ?? [])].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    const nowMs = Date.now();
    const recentWindowStartMs = nowMs - USAGE_SUMMARY_RECENT_WINDOW_MS;
    const activeDays = countActiveBuckets(series);
    const currentStreakDays = countCurrentStreakThroughNow(series, nowMs);
    const costPresentation = response.costPresentation ?? null;
    const costMode = costPresentation?.mode ?? 'auto';
    const topEngineLeader = response.leaders?.engines?.[0] ?? null;
    const matchingEngineBreakdown = topEngineLeader
        ? response.breakdowns?.backendMode?.find((entry) => entry.key === topEngineLeader.key) ?? null
        : null;
    const recentActivity = series.slice(-14).map((bucket) => ({
        timestamp: Math.floor(bucket.bucketStartMs / 1000),
        active: bucket.tokens.total > 0 || resolveAnalyticsCost(bucket.cost, costPresentation) > 0,
        tokens: bucket.tokens.total,
        cost: resolveAnalyticsCost(bucket.cost, costPresentation),
    }));
    const weekBuckets = series.filter((bucket) => isSeriesBucketWithinWindow(bucket, recentWindowStartMs, nowMs));
    const busiestBucket = [...(response.activity?.weekdayHourBuckets ?? [])]
        .sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;

    return {
        activeDays,
        currentStreakDays,
        totalTokens: response.totals.tokens.total,
        totalCost: resolveAnalyticsCost(response.totals.cost, costPresentation),
        currency: response.totals.cost.currency,
        weekTokens: weekBuckets.reduce((sum, bucket) => sum + bucket.tokens.total, 0),
        weekCost: weekBuckets.reduce((sum, bucket) => sum + resolveAnalyticsCost(bucket.cost, costPresentation), 0),
        topModel: response.breakdowns?.model?.[0] ? mapBreakdownEntry(response.breakdowns.model[0], 'model', costMode) : null,
        topEngine: topEngineLeader
            ? {
                dimension: 'backendMode',
                key: topEngineLeader.key,
                label: formatUsageDimensionLabel('backendMode', topEngineLeader.key, topEngineLeader.label ?? topEngineLeader.key),
                totalTokens: matchingEngineBreakdown?.tokens.total ?? 0,
                totalCost: matchingEngineBreakdown ? resolveAnalyticsCost(matchingEngineBreakdown.cost, costMode) : 0,
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

function buildSummaryFromLegacyUsage(usage: UsageDataPoint[]): UsageAnalyticsSummaryViewModel {
    const totals = calculateTotals(usage);
    const series = buildLegacyTrend(usage);
    const seriesBuckets = mapLegacyTrendToSeriesBuckets(series);
    const recentWindowStartSeconds = Math.floor((Date.now() - USAGE_SUMMARY_RECENT_WINDOW_MS) / 1000);
    const recentActivity = series.slice(-14).map((point) => ({
        timestamp: point.timestamp,
        active: point.tokens > 0 || point.cost > 0,
        tokens: point.tokens,
        cost: point.cost,
    }));
    const weekPoints = series.filter((point) => point.timestamp >= recentWindowStartSeconds);

    return {
        activeDays: totals.activeDays,
        currentStreakDays: countCurrentStreakThroughNow(seriesBuckets, Date.now()),
        totalTokens: totals.totalTokens,
        totalCost: totals.totalCost,
        currency: 'USD',
        weekTokens: weekPoints.reduce((sum, point) => sum + point.tokens, 0),
        weekCost: weekPoints.reduce((sum, point) => sum + point.cost, 0),
        topModel: null,
        topEngine: null,
        busiestWindowLabel: null,
        recentActivity,
        hasData: usage.length > 0,
    };
}

function buildActivityFromLegacyUsage(usage: UsageDataPoint[]): UsageAnalyticsActivityViewModel {
    const calendarDays = usage.map((point) => ({
        date: new Date(point.timestamp * 1000).toISOString().slice(0, 10),
        eventCount: Number.isFinite(point.reportCount) ? point.reportCount : 0,
    }));

    return {
        calendarDays,
        weekdayHourBuckets: [],
    };
}

function buildInsightsFromLegacyUsage(usage: UsageDataPoint[], activity: UsageAnalyticsActivityViewModel): UsageAnalyticsInsightsViewModel {
    const activeDays = activity.calendarDays.filter((day) => day.eventCount > 0).length;
    const favoriteModel = usage.find((point) => typeof point.modelId === 'string' && point.modelId.trim().length > 0)?.modelId ?? null;
    const currentStreakDays = countCurrentStreakThroughNow(
        mapLegacyTrendToSeriesBuckets(buildLegacyTrend(usage)),
        Date.now(),
    );

    return {
        currentStreakDays,
        activeDays,
        longestStreakDays: activeDays,
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
): UsageAnalyticsSummaryViewModel {
    if (isUsageAnalyticsQueryResponse(source)) {
        return buildSummaryFromResponse(source);
    }
    return buildSummaryFromLegacyUsage(source);
}

export function buildUsageHeroViewModel(
    overview: UsageTotals,
    insights: UsageAnalyticsInsightsViewModel,
    costPresentation: NonNullable<UsageAnalyticsViewModel['costPresentation']>,
): UsageHeroViewModel {
    return {
        totalTokens: overview.totalTokens,
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
    const cachedReadTokens = overview.tokenBreakdown.cacheRead ?? 0;
    const usd = typeof cacheSavingsUsd === 'number' && Number.isFinite(cacheSavingsUsd) && cacheSavingsUsd > 0
        ? cacheSavingsUsd
        : null;
    if (!(cachedReadTokens > 0) && usd === null) {
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
    if (half < 1) {
        return { deltaPct: null, direction: 'flat' };
    }
    const sum = (points: readonly UsageTrendPoint[]): number =>
        points.reduce((total, point) => total + Math.max(0, point.tokens), 0);
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
    const total = USAGE_COMPOSITION_ORDER.reduce((sum, key) => sum + (mix[key] ?? 0), 0);
    const segments: UsageCompositionSegment[] = USAGE_COMPOSITION_ORDER.map((key) => {
        const tokens = mix[key] ?? 0;
        return { key, tokens, pct: total > 0 ? (tokens / total) * 100 : 0 };
    });
    return { segments, total };
}

/** Per-bucket token series for a single leader across a timeline (Band 5). */
export function buildUsageLeaderTrend(
    timeline: readonly UsageAnalyticsTimelineBucket[],
    key: string,
): number[] {
    return timeline.map((bucket) => {
        const leader = bucket.leaders.find((entry) => entry.key === key);
        return leader ? leader.totalTokens : 0;
    });
}

export function buildUsageLeaderTrends(
    timeline: readonly UsageAnalyticsTimelineBucket[],
): Record<string, number[]> {
    const keys = new Set<string>();
    for (const bucket of timeline) {
        for (const leader of bucket.leaders) {
            keys.add(leader.key);
        }
    }
    const trends: Record<string, number[]> = {};
    for (const key of keys) {
        trends[key] = buildUsageLeaderTrend(timeline, key);
    }
    return trends;
}

/** Recover the `agentId` from an engine-timeline key (`agentId` | `agentId:backendMode`). */
function agentIdFromEngineKey(key: string): string {
    const separator = key.indexOf(':');
    return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Per-AGENT token sparklines for the Band 5 "Agents" leader rows (D-R2-8). The
 * server exposes a model timeline (keyed by `modelId`) and an engine timeline
 * (keyed by `agentId` or `agentId:backendMode`) but no agent-grain timeline, so
 * the agent rows — keyed by `agentId` — previously borrowed the engine trends
 * and never matched a key (flat/missing sparkline). This re-aggregates the
 * engine timeline back to the agent grain, summing every `agentId[:backendMode]`
 * entry per bucket under its `agentId`, so the trend key space matches the rows.
 */
export function buildUsageAgentTrends(
    engineTimeline: readonly UsageAnalyticsTimelineBucket[],
): Record<string, number[]> {
    const agentIds = new Set<string>();
    for (const bucket of engineTimeline) {
        for (const leader of bucket.leaders) {
            agentIds.add(agentIdFromEngineKey(leader.key));
        }
    }
    const trends: Record<string, number[]> = {};
    for (const agentId of agentIds) {
        trends[agentId] = engineTimeline.map((bucket) =>
            bucket.leaders.reduce(
                (sum, leader) => (agentIdFromEngineKey(leader.key) === agentId ? sum + leader.totalTokens : sum),
                0,
            ),
        );
    }
    return trends;
}

/**
 * Per-week ranked rows from the period series (B-3). Groups trend buckets into
 * UTC Sunday-anchored weeks (matching the heatmap grid's week boundaries),
 * summing tokens · cost · events, and returns them NEWEST-FIRST so the lens
 * reads as a chronological ledger rather than a token leaderboard. The label is
 * the week's start date; `key` is the ISO week-start (stable, export-friendly).
 */
export function buildUsageWeeksBreakdown(trend: readonly UsageTrendPoint[]): UsageBreakdownRow[] {
    const DAY_SECONDS = 24 * 60 * 60;
    const WEEK_SECONDS = 7 * DAY_SECONDS;
    const byWeekStart = new Map<number, UsageBreakdownRow>();
    for (const point of trend) {
        const dayStartSeconds = Math.floor(point.timestamp / DAY_SECONDS) * DAY_SECONDS;
        const weekday = new Date(dayStartSeconds * 1000).getUTCDay();
        const weekStartSeconds = dayStartSeconds - weekday * DAY_SECONDS;
        const key = new Date(weekStartSeconds * 1000).toISOString().slice(0, 10);
        const existing = byWeekStart.get(weekStartSeconds);
        if (existing) {
            existing.totalTokens += point.tokens;
            existing.totalCost += point.cost;
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
            lastSeenAt: weekStartSeconds + WEEK_SECONDS,
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
): Record<string, number[]> | null {
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
        : [...source].sort((left, right) => right.totalTokens - left.totalTokens);
    const total = ranked.reduce((sum, row) => sum + row.totalTokens, 0);
    // The accent marks the single busiest row (true max), even when the order
    // is chronological rather than ranked.
    const leaderKey = ranked.reduce<{ key: string | null; tokens: number }>(
        (best, row) => (row.totalTokens > best.tokens ? { key: row.key, tokens: row.totalTokens } : best),
        { key: null, tokens: -1 },
    ).key;
    const hasTrend = trends !== null && ranked.some((row) => (trends[row.key]?.length ?? 0) > 1);
    const rows: UsagePivotRow[] = ranked.map((row) => ({
        row,
        sharePct: total > 0 ? (row.totalTokens / total) * 100 : 0,
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
    totalTokens: number;
}

export interface UsageModelMixBucket {
    startMs: number;
    endMs: number;
    total: number;
    /**
     * Share (0..1) per series key, aligned index-for-index with `keys`. Sums to
     * ~1 in a non-empty bucket; all-zero for an empty bucket (renders as a gap in
     * the 100%-stacked area, never a fabricated flat band).
     */
    shares: number[];
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
    total: number;
    /** Enough shape to draw an area: ≥2 buckets, ≥1 key, and some volume. */
    hasData: boolean;
}

const USAGE_MODEL_MIX_DEFAULT_MAX_SERIES = 5;

export function buildUsageModelMix(
    timeline: readonly UsageAnalyticsTimelineBucket[],
    maxSeries: number = USAGE_MODEL_MIX_DEFAULT_MAX_SERIES,
): UsageModelMix {
    // 1) Rank keys by total tokens across the whole timeline.
    const totalsByKey = new Map<string, { label: string; tokens: number }>();
    for (const bucket of timeline) {
        for (const leader of bucket.leaders) {
            const existing = totalsByKey.get(leader.key);
            if (existing) {
                existing.tokens += leader.totalTokens;
            } else {
                totalsByKey.set(leader.key, { label: leader.label, tokens: leader.totalTokens });
            }
        }
    }
    const ranked = [...totalsByKey.entries()]
        .map(([key, value]) => ({ key, label: value.label, totalTokens: value.tokens }))
        .sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));

    const grandTotal = ranked.reduce((sum, entry) => sum + entry.totalTokens, 0);
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
            totalTokens: tailEntries.reduce((sum, entry) => sum + entry.totalTokens, 0),
        });
    }

    // 2) Normalize each bucket into per-key shares (largest first; tail → other).
    const buckets: UsageModelMixBucket[] = timeline.map((bucket) => {
        const tokensByKey = new Map<string, number>();
        let bucketTotal = 0;
        for (const leader of bucket.leaders) {
            tokensByKey.set(leader.key, (tokensByKey.get(leader.key) ?? 0) + leader.totalTokens);
            bucketTotal += leader.totalTokens;
        }
        const shares = keys.map((seriesKey) => {
            if (bucketTotal <= 0) {
                return 0;
            }
            if (seriesKey.key === USAGE_MODEL_MIX_OTHER_KEY) {
                let otherTokens = 0;
                for (const [key, tokens] of tokensByKey) {
                    if (!topKeys.has(key)) {
                        otherTokens += tokens;
                    }
                }
                return otherTokens / bucketTotal;
            }
            return (tokensByKey.get(seriesKey.key) ?? 0) / bucketTotal;
        });
        return { startMs: bucket.bucketStartMs, endMs: bucket.bucketEndMs, total: bucketTotal, shares };
    });

    const nonEmptyBuckets = buckets.filter((bucket) => bucket.total > 0).length;
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
    const inputTokens = overview.tokenBreakdown.input ?? 0;
    const cachedReadTokens = overview.tokenBreakdown.cacheRead ?? 0;
    const cacheBasis = inputTokens + cachedReadTokens;
    const cacheHitRatePct = cacheBasis > 0 ? (cachedReadTokens / cacheBasis) * 100 : null;
    const totalTokens = overview.totalTokens;
    const effectiveUsd = costPresentation.effectiveUsd;
    const costPerMtokUsd = totalTokens > 0 && effectiveUsd > 0
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
        input: breakdown.input ?? 0,
        output: breakdown.output ?? 0,
        reasoning: breakdown.reasoning ?? 0,
        cacheRead: breakdown.cacheRead ?? 0,
        cacheWrite: breakdown.cacheWrite ?? 0,
    };
}

export function buildUsageContextViewModel(
    overview: UsageTotals,
    usedTokens: number | null,
    windowTokens: number | null,
): UsageContextViewModel | null {
    const tokenMix = buildContextTokenMix(overview);
    const hasContext = usedTokens !== null || windowTokens !== null;
    const hasTokenMix = tokenMix.input > 0 || tokenMix.output > 0 || tokenMix.reasoning > 0
        || tokenMix.cacheRead > 0 || tokenMix.cacheWrite > 0;
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

export function buildUsageAnalyticsViewModel(
    source: UsageAnalyticsSource,
    filters: UsageFilterState,
): UsageAnalyticsViewModel {
    if (isUsageAnalyticsQueryResponse(source)) {
        const costPresentation = resolveResponseCostPresentation(source, filters.costMode);
        const activity = buildActivityFromResponse(source);
        const leaders = buildLeadersFromResponse(source);
        const insights = buildInsightsFromResponse(source, activity);
        const overview = buildTotalsFromResponse(source.totals, source.series, filters.costMode);
        const availableCostModes = resolveAvailableCostModes(source.totals.cost);
        const trend = buildTrendFromResponse(source.series, filters.costMode);
        const modelTimeline = buildTimelineFromResponse(source.modelTimeline, costPresentation);
        const engineTimeline = buildTimelineFromResponse(source.engineTimeline, costPresentation, 'backendMode');
        return {
            overview,
            hero: buildUsageHeroViewModel(overview, insights, costPresentation),
            heroTrend: buildUsageHeroTrend(trend),
            hourRhythm: buildUsageHourRhythm(activity),
            punchCard: buildUsagePunchCard(activity),
            composition: buildUsageComposition(overview),
            modelMix: buildUsageModelMix(modelTimeline),
            engineMix: buildUsageModelMix(engineTimeline),
            leaderTrends: {
                models: buildUsageLeaderTrends(modelTimeline),
                engines: buildUsageLeaderTrends(engineTimeline),
                agents: buildUsageAgentTrends(engineTimeline),
            },
            efficiency: buildUsageEfficiency(overview, costPresentation),
            cacheSavings: buildUsageCacheSavings(overview, source.insights?.cacheSavingsUsd),
            context: buildUsageContextViewModel(
                overview,
                source.totals.context?.usedTokens ?? null,
                source.totals.context?.windowTokens ?? null,
            ),
            trend,
            breakdowns: buildBreakdownsFromResponse(source.breakdowns, source.totals, filters.costMode, trend),
            insights,
            activity,
            leaders,
            modelTimeline,
            engineTimeline,
            availableCostModes,
            costPresentation,
            filteredUsageCount: source.totals.eventCount,
            focus: filters.focus,
        };
    }

    const filteredUsage = source.filter((dataPoint) => matchesFocus(dataPoint, filters.focus));
    const totals = calculateTotals(filteredUsage);
    const activity = buildActivityFromLegacyUsage(filteredUsage);
    const insights = buildInsightsFromLegacyUsage(filteredUsage, activity);
    const leaders = buildLeadersFromLegacyUsage(filteredUsage);
    const costPresentation = createLegacyCostPresentation({
        reportedUsd: totals.totalCost,
        estimatedUsd: totals.totalCost,
        currency: 'USD',
    });
    const legacyOverview: UsageTotals = {
        ...totals,
        eventCount: totals.reportCount,
        costSource: 'legacy',
    };
    const legacyContextUsed = resolveLegacyContextExtent(filteredUsage, 'contextUsedTokens');
    const legacyContextWindow = resolveLegacyContextExtent(filteredUsage, 'contextWindowTokens');
    const legacyTrend = buildLegacyTrend(filteredUsage);

    return {
        overview: legacyOverview,
        hero: buildUsageHeroViewModel(legacyOverview, insights, costPresentation),
        heroTrend: buildUsageHeroTrend(legacyTrend),
        hourRhythm: buildUsageHourRhythm(activity),
        punchCard: buildUsagePunchCard(activity),
        composition: buildUsageComposition(legacyOverview),
        modelMix: buildUsageModelMix([]),
        engineMix: buildUsageModelMix([]),
        leaderTrends: { models: {}, engines: {}, agents: {} },
        efficiency: buildUsageEfficiency(legacyOverview, costPresentation),
        cacheSavings: buildUsageCacheSavings(legacyOverview),
        context: buildUsageContextViewModel(legacyOverview, legacyContextUsed, legacyContextWindow),
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
            weeks: buildUsageWeeksBreakdown(legacyTrend),
        },
        filteredUsageCount: filteredUsage.length,
        focus: filters.focus,
    };
}
