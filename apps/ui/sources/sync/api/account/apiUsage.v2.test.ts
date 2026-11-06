import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiUsage v2 analytics query', () => {
    it('queries All personal usage without inventing an epoch start', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
        const reads: unknown[] = [];
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/v2/usage/query')) reads.push(JSON.parse(String(init?.body)));
            return Response.json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        });
        const { getUsageForPeriod } = await import('./apiUsage');
        await getUsageForPeriod(credentials, 'all');
        expect(reads).toHaveLength(1);
        const request = UsageAnalyticsQueryRequestSchema.parse(reads[0]);
        expect(request.dateRange?.endMs).toEqual(expect.any(Number));
        expect(request.dateRange).not.toHaveProperty('startMs');
    });

    it('admits analytics once at HTTP and still refuses malformed responses', async () => {
        const { queryUsageAnalytics } = await import('./apiUsage');
        const { UsageAnalyticsQueryResponseSchema } = await import('@happier-dev/protocol/usage/usageAnalyticsContracts');
        const parse = vi.spyOn(UsageAnalyticsQueryResponseSchema, 'parse');
        const response = { v: 1, totals: { eventCount: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
        expect(await queryUsageAnalytics(credentials, UsageAnalyticsQueryRequestSchema.parse({}), {
            request: async () => Response.json(response),
        })).toMatchObject(response);
        expect(parse.mock.calls.length).toBe(1);
        await expect(queryUsageAnalytics(credentials, UsageAnalyticsQueryRequestSchema.parse({}), {
            request: async () => Response.json({ ...response, totals: { ...response.totals, eventCount: -1 } }),
        })).rejects.toThrow();
    });

    it('classifies richer HTTP authority refusal for the canonical Resource lifecycle', async () => {
        const { queryUsageAnalytics } = await import('./apiUsage');
        await expect(queryUsageAnalytics(credentials, UsageAnalyticsQueryRequestSchema.parse({}), {
            request: async () => Response.json({ error: 'forbidden' }, { status: 403 }),
        })).rejects.toMatchObject({ code: 'denied', kind: 'auth', status: 403 });
    });

    it('refuses unsupported filter clauses rather than returning unfiltered HTTP facts', async () => {
        const { queryUsage } = await import('./apiUsage');
        await expect(queryUsage(credentials, { focus: { dimension: 'unsupported', key: 'private' } }, {
            request: async () => Response.json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } }),
        })).rejects.toMatchObject({ code: 'usage_filter_unsupported' });
    });

    it('refuses unavailable focused reads instead of projecting an unfiltered legacy report', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'tab' });
        vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input).includes('/v2/usage/query')
            ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ usage: [] }));
        const { queryUsage } = await import('./apiUsage');
        await expect(queryUsage(credentials, { focus: { dimension: 'machine', key: 'private' } }))
            .rejects.toMatchObject({ status: 404 });
    });

    it('queries the v2 analytics endpoint with structured date range and breakdowns', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });

        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
            v: 1,
            totals: {
                eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { getUsageForPeriod } = await import('./apiUsage');
        const result = await getUsageForPeriod(credentials, '7days');
        expect(result).toMatchObject({ v: 1, totals: { eventCount: 0, tokens: { total: 0 } } });

        const usageCalls = fetchMock.mock.calls;
        const usageCall = usageCalls.find(([url]) => String(url).includes('/usage/query'));
        expect(usageCall).toBeDefined();
        if (!usageCall) {
            throw new Error('usage query call missing');
        }
        const [url, options] = usageCall;
        expect(String(url)).toContain('/v2/usage/query');

        const body = JSON.parse(String(options?.body));
        expect(UsageAnalyticsQueryRequestSchema.safeParse(body).success).toBe(true);
        expect(body).toMatchObject({
            granularity: 'day',
            timeZoneOffsetMinutes: new Date().getTimezoneOffset() === 0 ? 0 : -new Date().getTimezoneOffset(),
            includeSeries: true,
            includeInsights: true,
            includeActivity: true,
            includeLeaders: true,
            includeModelTimeline: true,
            includeMessageStats: true,
            activityResolution: 'both',
            costMode: 'auto',
        });
        expect(body).toHaveProperty('dateRange');
        expect(body).toHaveProperty('breakdowns');
        expect(body.breakdowns).toEqual(expect.arrayContaining(['agent', 'model', 'backendMode', 'source']));
        expect(body).not.toHaveProperty('startTime');
        expect(body).not.toHaveProperty('endTime');
        expect(body).not.toHaveProperty('groupBy');
    });

    it('falls back to the legacy v1 usage query when the v2 analytics endpoint is unavailable', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/v2/usage/query')) {
                return Response.json({ error: 'not found' }, { status: 404 });
            }
            return Response.json({
                usage: [
                    {
                        timestamp: 1_700_000_000,
                        tokens: { total: 15, input: 10, output: 5 },
                        cost: { total: 1.25 },
                        reportCount: 1,
                    },
                ],
                groupBy: 'day',
                totalReports: 1,
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { getUsageForPeriod } = await import('./apiUsage');
        const response = await getUsageForPeriod(credentials, '7days');

        expect(Array.isArray(response)).toBe(true);
        expect(response).toMatchObject([
            {
                timestamp: 1_700_000_000,
                tokens: { total: 15, input: 10, output: 5 },
                cost: { total: 1.25 },
                reportCount: 1,
            },
        ]);

        const urls = fetchMock.mock.calls.map(([url]) => String(url));
        expect(urls.some((url) => url.includes('/v2/usage/query'))).toBe(true);
        expect(urls.some((url) => url.includes('/v1/usage/query'))).toBe(true);
    });

    it('uses a year-long date range with month granularity for the year filter and downgrades legacy fallback grouping to day', async () => {
        vi.stubEnv('TZ', 'UTC');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });

        vi.spyOn(Date, 'now').mockReturnValue(1_735_689_600_000);

        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/v2/usage/query')) {
                return Response.json({ error: 'not found' }, { status: 404 });
            }
            return Response.json({
                usage: [],
                groupBy: 'day',
                totalReports: 0,
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { getUsageForPeriod } = await import('./apiUsage');
        expect(await getUsageForPeriod(credentials, 'year')).toEqual([]);

        const usageCalls = fetchMock.mock.calls;
        const v2Call = usageCalls.find(([url]) => String(url).includes('/v2/usage/query'));
        expect(v2Call).toBeDefined();
        if (!v2Call) {
            throw new Error('v2 usage query call missing');
        }

        const [, v2Options] = v2Call;
        const v2Body = JSON.parse(String(v2Options?.body));
        expect(v2Body).toMatchObject({
            granularity: 'month',
        });
        expect(v2Body.dateRange).toEqual({
            // The canonical relative year includes today among its 365 calendar dates.
            startMs: Date.UTC(2024, 0, 3),
            endMs: Date.UTC(2025, 0, 1),
        });

        const v1Call = usageCalls.find(([url]) => String(url).includes('/v1/usage/query'));
        expect(v1Call).toBeDefined();
        if (!v1Call) {
            throw new Error('v1 usage query call missing');
        }

        const [, v1Options] = v1Call;
        const v1Body = JSON.parse(String(v1Options?.body));
        expect(v1Body).toMatchObject({
            groupBy: 'day',
            startTime: Date.UTC(2024, 0, 3) / 1000,
            endTime: Date.UTC(2025, 0, 1) / 1000,
        });
    });
});
