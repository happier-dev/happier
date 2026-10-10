import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type {
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
} from '@happier-dev/protocol';
import { resolveUsageCalendarInstant } from '@happier-dev/protocol';
import { buildUsageFocusFilters } from './usageFocusFilters';
export { buildUsageFocusFilters } from './usageFocusFilters';
import {
    getUsagePeriodDefinition,
    resolveUsagePeriodStartTimeSeconds,
    type UsageLegacyPeriodGranularity,
    type UsagePeriod,
    type UsagePeriodGranularity,
} from './usagePeriods';

export interface UsageDataPoint {
    timestamp: number;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    reportCount: number;
    providerId?: string | null;
    modelId?: string | null;
    sessionId?: string | null;
    projectKey?: string | null;
    workspaceKey?: string | null;
    machineId?: string | null;
    backendMode?: string | null;
    source?: string | null;
    contextWindowTokens?: number | null;
    contextUsedTokens?: number | null;
}

export interface UsageQueryParams {
    sessionId?: string;
    startTime?: number; // Unix timestamp in seconds
    endTime?: number;   // Unix timestamp in seconds
    groupBy?: UsagePeriodGranularity;
    timeZoneOffsetMinutes?: number;
    costMode?: 'auto' | 'reported' | 'estimated';
    focus?: {
        dimension: string;
        key: string;
    } | null;
}

export type UsageResponse = UsageAnalyticsQueryResponse | UsageDataPoint[];

export interface UsageTotals {
    totalTokens: number;
    totalCost: number;
    tokenBreakdown: Record<string, number>;
    costBreakdown: Record<string, number>;
    reportCount: number;
    eventCount: number;
    activeDays: number;
    tokensByModel: Record<string, number>;
    costByModel: Record<string, number>;
    costSource: 'reportedUsd' | 'estimatedUsd' | 'legacy';
}

function isTotalKey(key: string): boolean {
    return key === 'total' || key.endsWith('Total') || key.endsWith('_total');
}

export function sumRecordValues(record: Record<string, number>): number {
    let total = 0;
    for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || isTotalKey(key)) {
            continue;
        }
        total += value;
    }
    return total;
}

export function getRecordTotal(record: Record<string, number>): number {
    const explicit = record.total;
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
        return explicit;
    }
    return sumRecordValues(record);
}

/**
 * Query usage data from the server
 */
export async function queryUsage(
    credentials: AuthCredentials,
    params: UsageQueryParams = {},
    options?: Readonly<{ request?: ServerFetch; signal?: AbortSignal; analyticsRequest?: UsageAnalyticsQueryRequest }>,
): Promise<UsageResponse> {
    const read = async () => {
        options?.signal?.throwIfAborted();
        const request: UsageAnalyticsQueryRequest = options?.analyticsRequest ?? {
            dateRange: typeof params.startTime === 'number' || typeof params.endTime === 'number'
                ? {
                    startMs: typeof params.startTime === 'number' ? params.startTime * 1000 : undefined,
                    endMs: typeof params.endTime === 'number' ? params.endTime * 1000 : undefined,
                }
                : undefined,
            granularity: params.groupBy === 'hour'
                ? 'hour'
                : params.groupBy === 'month'
                    ? 'month'
                    : 'day',
            timeZoneOffsetMinutes: params.timeZoneOffsetMinutes ?? 0,
            costMode: params.costMode ?? 'auto',
            includeInsights: true,
            includeActivity: true,
            includeLeaders: true,
            includeModelTimeline: true,
            includeMessageStats: true,
            activityResolution: 'both',
            breakdowns: [
                'agent',
                'model',
                'session',
                'project',
                'workspace',
                'backendMode',
                'source',
            ],
            filters: {
                ...(params.sessionId ? { sessionIds: [params.sessionId] } : {}),
                ...buildUsageFocusFilters(params.focus),
            },
            includeSeries: true,
            topLimit: 20,
        };

        const response = await (options?.request ?? serverFetch)('/v2/usage/query', {
            method: 'POST',
            signal: options?.signal,
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        }, { includeAuth: false });

        if (!response.ok) {
            let message = 'Failed to query usage';
            try {
                const error = await response.json();
                if (error?.error) message = error.error;
            } catch {
                // ignore
            }

            if (response.status === 404 && !options?.analyticsRequest && !params.focus && message !== 'Session not found') {
                return await queryLegacyUsage(credentials, params);
            }
            if (response.status === 404 && params.sessionId) {
                throw new HappyError('Session not found', false, { status: 404, kind: 'config' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                const authorityRefused = response.status === 401 || response.status === 403;
                throw new HappyError(message, false, { status: response.status, kind: authorityRefused ? 'auth' : 'config',
                    ...(options?.analyticsRequest && authorityRefused ? { code: 'denied' } : {}) });
            }
            throw new Error(`Failed to query usage: ${response.status}`);
        }

        const data: unknown = await response.json();
        options?.signal?.throwIfAborted();
        return options?.analyticsRequest ? UsageAnalyticsQueryResponseSchema.parse(data) : data as UsageResponse;
    };
    // Rich Resource reads use their existing lifecycle's failure/retry owner.
    // Legacy callers retain their established backoff and route translation.
    return options?.analyticsRequest ? await read() : await backoff(read);
}

/** The same captured HTTP transport with the complete canonical query clauses. */
export async function queryUsageAnalytics(
    credentials: AuthCredentials,
    request: UsageAnalyticsQueryRequest,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>,
): Promise<UsageAnalyticsQueryResponse> {
    return UsageAnalyticsQueryResponseSchema.parse(await queryUsage(credentials, {}, { ...options, analyticsRequest: request }));
}

async function queryLegacyUsage(
    credentials: AuthCredentials,
    params: UsageQueryParams,
): Promise<UsageDataPoint[]> {
    const legacyGroupBy: UsageLegacyPeriodGranularity = params.groupBy === 'hour' ? 'hour' : 'day';
    const response = await serverFetch('/v1/usage/query', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sessionId: params.sessionId ?? null,
            startTime: params.startTime ?? null,
            endTime: params.endTime ?? null,
            groupBy: legacyGroupBy,
        }),
    }, { includeAuth: false });

    if (!response.ok) {
        if (response.status === 404 && params.sessionId) {
            throw new HappyError('Session not found', false, { status: 404, kind: 'config' });
        }

        let message = 'Failed to query usage';
        try {
            const error = await response.json();
            if (error?.error) message = error.error;
        } catch {
            // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config' });
    }

    const data = await response.json() as {
        usage?: Array<{
            timestamp: number;
            tokens: Record<string, number>;
            cost: Record<string, number>;
            reportCount: number;
        }>;
    };

    return (data.usage ?? []).map((entry) => ({
        timestamp: entry.timestamp,
        tokens: entry.tokens,
        cost: entry.cost,
        reportCount: entry.reportCount,
    }));
}

/**
 * Helper function to get usage for a specific time period
 */
export async function getUsageForPeriod(
    credentials: AuthCredentials,
    period: UsagePeriod,
    sessionId?: string,
    focus?: UsageQueryParams['focus'],
    costMode: UsageQueryParams['costMode'] = 'auto',
): Promise<UsageResponse> {
    const nowMs = Date.now();
    const timeZoneOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
    const definition = getUsagePeriodDefinition(period);
    const startTime = resolveUsagePeriodStartTimeSeconds(period, nowMs, timeZoneOffsetMinutes);
    const endTime = Math.floor(nowMs / 1000);

    return queryUsage(credentials, {
        sessionId,
        startTime,
        endTime,
        groupBy: definition.granularity,
        timeZoneOffsetMinutes,
        focus,
        costMode,
    });
}

/**
 * Calculate total tokens and cost from usage data
 */
export function calculateTotals(usage: UsageDataPoint[], timeZoneOffsetMinutes?: number): {
    totalTokens: number;
    totalCost: number;
    tokensByModel: Record<string, number>;
    costByModel: Record<string, number>;
    tokenBreakdown: Record<string, number>;
    costBreakdown: Record<string, number>;
    reportCount: number;
    activeDays: number;
} {
    const result = {
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>,
        tokenBreakdown: {} as Record<string, number>,
        costBreakdown: {} as Record<string, number>,
        reportCount: 0,
        activeDays: 0,
    };
    const activeDayKeys = new Set<string>();
    
    for (const dataPoint of usage) {
        result.totalTokens += getRecordTotal(dataPoint.tokens);
        result.totalCost += getRecordTotal(dataPoint.cost);
        result.reportCount += Number.isFinite(dataPoint.reportCount) ? dataPoint.reportCount : 0;

        const timestampMs = dataPoint.timestamp * 1000;
        if (Number.isFinite(timestampMs)) {
            // Omitted offset is the incumbent native-local Team/default contract.
            const offset = timeZoneOffsetMinutes ?? -new Date(timestampMs).getTimezoneOffset();
            activeDayKeys.add(resolveUsageCalendarInstant(timestampMs, offset).date);
        }

        for (const [bucket, tokens] of Object.entries(dataPoint.tokens)) {
            if (typeof tokens === 'number' && Number.isFinite(tokens) && !isTotalKey(bucket)) {
                result.tokensByModel[bucket] = (result.tokensByModel[bucket] || 0) + tokens;
                result.tokenBreakdown[bucket] = (result.tokenBreakdown[bucket] || 0) + tokens;
            }
        }

        for (const [bucket, cost] of Object.entries(dataPoint.cost)) {
            if (typeof cost === 'number' && Number.isFinite(cost) && !isTotalKey(bucket)) {
                result.costByModel[bucket] = (result.costByModel[bucket] || 0) + cost;
                result.costBreakdown[bucket] = (result.costBreakdown[bucket] || 0) + cost;
            }
        }
    }

    result.activeDays = activeDayKeys.size;
    return result;
}
