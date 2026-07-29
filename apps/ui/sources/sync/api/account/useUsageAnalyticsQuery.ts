import * as React from 'react';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { UsageCostMode, UsageFocus } from './usageAnalytics';
import type { UsagePeriod } from './usagePeriods';
import { getUsageForPeriod, type UsageResponse } from './apiUsage';

const USAGE_ANALYTICS_QUERY_TTL_MS = 60_000;

export type UsageAnalyticsQueryFilters = Readonly<{
    credentials: AuthCredentials | null;
    enabled: boolean;
    period: UsagePeriod;
    sessionId?: string;
    focus?: UsageFocus | null;
    costMode?: UsageCostMode;
    reloadToken?: number;
}>;

type CacheEntry = {
    response: UsageResponse | null;
    expiresAtMs: number;
    promise: Promise<UsageResponse> | null;
};

type UsageAnalyticsQueryResult = Readonly<{
    data: UsageResponse | null;
    isLoading: boolean;
    error: unknown;
}>;

const responseCache = new Map<string, CacheEntry>();

function serializeFilters(filters: UsageAnalyticsQueryFilters): string | null {
    if (!filters.credentials || !filters.enabled) return null;
    return JSON.stringify({
        token: filters.credentials.token,
        period: filters.period,
        sessionId: filters.sessionId ?? null,
        focus: filters.focus
            ? {
                  dimension: filters.focus.dimension,
                  key: filters.focus.key,
              }
            : null,
        costMode: filters.costMode ?? 'auto',
    });
}

function readFreshResponse(cacheKey: string, nowMs: number): UsageResponse | null {
    const entry = responseCache.get(cacheKey);
    if (!entry?.response || entry.expiresAtMs <= nowMs) return null;
    return entry.response;
}

function loadResponse(
    cacheKey: string,
    filters: UsageAnalyticsQueryFilters & Readonly<{ credentials: AuthCredentials }>,
): Promise<UsageResponse> {
    const nowMs = Date.now();
    const cached = readFreshResponse(cacheKey, nowMs);
    if (cached) return Promise.resolve(cached);

    const existing = responseCache.get(cacheKey);
    if (existing?.promise) return existing.promise;

    const promise = getUsageForPeriod(
        filters.credentials,
        filters.period,
        filters.sessionId,
        filters.focus,
        filters.costMode ?? 'auto',
    ).then((response) => {
        responseCache.set(cacheKey, {
            response,
            expiresAtMs: Date.now() + USAGE_ANALYTICS_QUERY_TTL_MS,
            promise: null,
        });
        return response;
    }).catch((error) => {
        responseCache.delete(cacheKey);
        throw error;
    });

    responseCache.set(cacheKey, {
        response: null,
        expiresAtMs: 0,
        promise,
    });
    return promise;
}

export function invalidateUsageAnalyticsQueryCache(): void {
    responseCache.clear();
}

export function useUsageAnalyticsQuery(
    filters: UsageAnalyticsQueryFilters,
): UsageAnalyticsQueryResult {
    const cacheKey = React.useMemo(
        () => serializeFilters(filters),
        [
            filters.costMode,
            filters.credentials,
            filters.enabled,
            filters.focus?.dimension,
            filters.focus?.key,
            filters.period,
            filters.sessionId,
        ],
    );
    const [result, setResult] = React.useState<UsageAnalyticsQueryResult>(() => ({
        data: cacheKey ? readFreshResponse(cacheKey, Date.now()) : null,
        isLoading: cacheKey != null,
        error: null,
    }));
    const previousReloadTokenRef = React.useRef(filters.reloadToken ?? 0);

    React.useEffect(() => {
        let cancelled = false;
        const reloadToken = filters.reloadToken ?? 0;

        if (!cacheKey || !filters.credentials || !filters.enabled) {
            previousReloadTokenRef.current = reloadToken;
            setResult({ data: null, isLoading: false, error: null });
            return () => {
                cancelled = true;
            };
        }

        if (previousReloadTokenRef.current !== reloadToken) {
            responseCache.delete(cacheKey);
        }
        previousReloadTokenRef.current = reloadToken;

        const cached = readFreshResponse(cacheKey, Date.now());
        if (cached) {
            setResult({ data: cached, isLoading: false, error: null });
            return () => {
                cancelled = true;
            };
        }

        setResult((current) => ({ data: current.data, isLoading: true, error: null }));
        void loadResponse(cacheKey, { ...filters, credentials: filters.credentials }).then((data) => {
            if (!cancelled) setResult({ data, isLoading: false, error: null });
        }).catch((error: unknown) => {
            if (!cancelled) setResult({ data: null, isLoading: false, error });
        });

        return () => {
            cancelled = true;
        };
    }, [cacheKey, filters.credentials, filters.enabled, filters.reloadToken]);

    return result;
}
