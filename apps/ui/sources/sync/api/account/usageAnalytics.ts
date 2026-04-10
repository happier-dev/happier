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

export type UsageMetric = 'tokens' | 'cost';
export type UsageCostMode = 'auto' | 'reported' | 'estimated';

export type UsageDimension =
    | 'provider'
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
    period: 'today' | '7days' | '30days';
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
    dimension: UsageDimension | 'bucket';
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
    providers: UsageBreakdownRow[];
    models: UsageBreakdownRow[];
    sessions: UsageBreakdownRow[];
    projects: UsageBreakdownRow[];
    workspaces: UsageBreakdownRow[];
    backendModes: UsageBreakdownRow[];
    sources: UsageBreakdownRow[];
    buckets: UsageBreakdownRow[];
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

export interface UsageAnalyticsLeaderSections {
    providers: UsageAnalyticsLeaderRow[];
    models: UsageAnalyticsLeaderRow[];
    sessions: UsageAnalyticsLeaderRow[];
    projects: UsageAnalyticsLeaderRow[];
    workspaces: UsageAnalyticsLeaderRow[];
    engines: UsageAnalyticsLeaderRow[];
}

export interface UsageAnalyticsViewModel {
    overview: UsageTotals;
    trend: UsageTrendPoint[];
    breakdowns: UsageBreakdownSections;
    insights: UsageAnalyticsInsightsViewModel;
    activity: UsageAnalyticsActivityViewModel;
    leaders: UsageAnalyticsLeaderSections;
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

const dimensionKeys: Record<UsageDimension, keyof UsageDataPoint> = {
    provider: 'providerId',
    model: 'modelId',
    session: 'sessionId',
    project: 'projectKey',
    workspace: 'workspaceKey',
    backendMode: 'backendMode',
    source: 'source',
};

function resolveDisplayCost(cost: ProtocolUsageAnalyticsTotals['cost']): number {
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
    if (cost.reportedUsd > 0) return 'provider_reported_api_equivalent';
    if (cost.estimatedUsd > 0) return 'pricing_estimate';
    return 'none';
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

function countActiveBuckets(series: readonly UsageAnalyticsSeriesBucket[]): number {
    let activeDays = 0;
    for (const bucket of series) {
        if (bucket.tokens.total > 0 || resolveDisplayCost(bucket.cost) > 0) {
            activeDays += 1;
        }
    }
    return activeDays;
}

function countTrailingActiveBuckets(series: readonly UsageAnalyticsSeriesBucket[]): number {
    let streak = 0;
    for (let index = series.length - 1; index >= 0; index -= 1) {
        const bucket = series[index];
        if (bucket.tokens.total > 0 || resolveDisplayCost(bucket.cost) > 0) {
            streak += 1;
        } else {
            break;
        }
    }
    return streak;
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
            label: groupKey,
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
        label: entry.label ?? entry.key,
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

function buildInsightsFromResponse(response: UsageAnalyticsQueryResponse, activity: UsageAnalyticsActivityViewModel): UsageAnalyticsInsightsViewModel {
    const insights = response.insights ?? null;
    const series = [...(response.series ?? [])].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    const sessionsUsed = response.messageStats?.sessionCount ?? response.breakdowns?.session?.length ?? 0;
    const messagesUsed = response.messageStats?.messageCount ?? response.totals.eventCount;
    const modelsTried = response.breakdowns?.model?.length ?? 0;
    const currentStreakDays = countTrailingActiveBuckets(series);

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
    const mapRows = (entries: readonly { key: string; label?: string; eventCount: number }[] | undefined): UsageAnalyticsLeaderRow[] =>
        (entries ?? []).map((entry) => ({
            key: entry.key,
            label: entry.label ?? entry.key,
            eventCount: entry.eventCount,
        }));

    return {
        providers: mapRows(response.leaders?.providers),
        models: mapRows(response.leaders?.models),
        sessions: mapRows(response.leaders?.sessions),
        projects: mapRows(response.leaders?.projects),
        workspaces: mapRows(response.leaders?.workspaces),
        engines: mapRows(response.leaders?.engines),
    };
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
): UsageBreakdownSections {
    return {
        providers: buildResponseRows(breakdowns?.provider, 'provider', costMode),
        models: buildResponseRows(breakdowns?.model, 'model', costMode),
        sessions: buildResponseRows(breakdowns?.session, 'session', costMode),
        projects: buildResponseRows(breakdowns?.project, 'project', costMode),
        workspaces: buildResponseRows(breakdowns?.workspace, 'workspace', costMode),
        backendModes: buildResponseRows(breakdowns?.backendMode, 'backendMode', costMode),
        sources: buildResponseRows(breakdowns?.source, 'source', costMode),
        buckets: buildResponseBuckets(totals, costMode),
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
    const activeDays = countActiveBuckets(series);
    const currentStreakDays = countTrailingActiveBuckets(series);
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
    const weekBuckets = series.slice(-7);

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
                label: topEngineLeader.label ?? topEngineLeader.key,
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
        busiestWindowLabel: response.insights?.busiestDay?.label && response.insights?.busiestHour?.label
            ? `${response.insights.busiestDay.label} · ${response.insights.busiestHour.label}`
            : response.insights?.busiestHour?.label ?? null,
        recentActivity,
        hasData: response.totals.eventCount > 0 || series.length > 0,
    };
}

function buildSummaryFromLegacyUsage(usage: UsageDataPoint[]): UsageAnalyticsSummaryViewModel {
    const totals = calculateTotals(usage);
    const series = buildLegacyTrend(usage);
    const recentActivity = series.slice(-14).map((point) => ({
        timestamp: point.timestamp,
        active: point.tokens > 0 || point.cost > 0,
        tokens: point.tokens,
        cost: point.cost,
    }));
    const weekPoints = series.slice(-7);

    return {
        activeDays: totals.activeDays,
        currentStreakDays: countTrailingActiveBuckets(
            series.map((point) => ({
                bucketStartMs: point.timestamp * 1000,
                bucketEndMs: point.timestamp * 1000,
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
            })),
        ),
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
    const sortedUsage = [...usage].sort((left, right) => left.timestamp - right.timestamp);
    const currentStreakDays = countTrailingActiveBuckets(
        sortedUsage.map((point) => ({
            bucketStartMs: point.timestamp * 1000,
            bucketEndMs: point.timestamp * 1000,
            eventCount: Number.isFinite(point.reportCount) ? point.reportCount : 0,
            tokens: {
                input: getRecordTotal(point.tokens),
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: getRecordTotal(point.tokens),
            },
            cost: {
                reportedUsd: getRecordTotal(point.cost),
                estimatedUsd: getRecordTotal(point.cost),
                currency: 'USD',
            },
        })),
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
        providers: group('provider'),
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

export function buildUsageAnalyticsViewModel(
    source: UsageAnalyticsSource,
    filters: UsageFilterState,
): UsageAnalyticsViewModel {
    if (isUsageAnalyticsQueryResponse(source)) {
        const costPresentation = source.costPresentation ?? createCostPresentation(source.totals.cost, filters.costMode);
        const activity = buildActivityFromResponse(source);
        const leaders = buildLeadersFromResponse(source);
        const insights = buildInsightsFromResponse(source, activity);
        const overview = buildTotalsFromResponse(source.totals, source.series, filters.costMode);
        return {
            overview,
            trend: buildTrendFromResponse(source.series, filters.costMode),
            breakdowns: buildBreakdownsFromResponse(source.breakdowns, source.totals, filters.costMode),
            insights,
            activity,
            leaders,
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
    const costPresentation = createCostPresentation({
        reportedUsd: totals.totalCost,
        estimatedUsd: totals.totalCost,
        currency: 'USD',
    }, filters.costMode);

    return {
        overview: {
            ...totals,
            eventCount: totals.reportCount,
            costSource: totals.totalCost > 0 ? 'legacy' : 'legacy',
        },
        trend: buildLegacyTrend(filteredUsage),
        insights,
        activity,
        leaders,
        costPresentation,
        breakdowns: {
            providers: buildLegacyRowsForDimension(filteredUsage, 'provider'),
            models: buildLegacyRowsForDimension(filteredUsage, 'model'),
            sessions: buildLegacyRowsForDimension(filteredUsage, 'session'),
            projects: buildLegacyRowsForDimension(filteredUsage, 'project'),
            workspaces: buildLegacyRowsForDimension(filteredUsage, 'workspace'),
            backendModes: buildLegacyRowsForDimension(filteredUsage, 'backendMode'),
            sources: buildLegacyRowsForDimension(filteredUsage, 'source'),
            buckets: buildLegacyBucketRows(totals),
        },
        filteredUsageCount: filteredUsage.length,
        focus: filters.focus,
    };
}
