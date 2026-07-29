import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiUsage v2 analytics query', () => {
    it('queries the v2 analytics endpoint with structured date range and breakdowns', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                v: 1,
                totals: {
                    eventCount: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
                },
            }),
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getUsageForPeriod } = await import('./apiUsage');
        await getUsageForPeriod(credentials, '7days');

        const usageCalls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
        const usageCall = usageCalls.find(([url]) => String(url).includes('/usage/query'));
        expect(usageCall).toBeDefined();
        if (!usageCall) {
            throw new Error('usage query call missing');
        }
        const [url, options] = usageCall;
        expect(String(url)).toContain('/v2/usage/query');

        const body = JSON.parse(String(options?.body));
        expect(body).toMatchObject({
            granularity: 'day',
            timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
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
        expect(body.breakdowns).toEqual(expect.arrayContaining(['provider', 'model', 'backendMode', 'source']));
        expect(body).not.toHaveProperty('startTime');
        expect(body).not.toHaveProperty('endTime');
        expect(body).not.toHaveProperty('groupBy');
    });

    it('falls back to the legacy v1 usage query when the v2 analytics endpoint is unavailable', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/v2/usage/query')) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: 'not found' }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
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
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

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

        const urls = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>).map(([url]) => String(url));
        expect(urls.some((url) => url.includes('/v2/usage/query'))).toBe(true);
        expect(urls.some((url) => url.includes('/v1/usage/query'))).toBe(true);
    });

    it('uses a year-long date range with month granularity for the year filter and downgrades legacy fallback grouping to day', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));

        vi.spyOn(Date, 'now').mockReturnValue(1_735_689_600_000);

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/v2/usage/query')) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: 'not found' }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    usage: [],
                    groupBy: 'day',
                    totalReports: 0,
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getUsageForPeriod } = await import('./apiUsage');
        await getUsageForPeriod(credentials, 'year');

        const usageCalls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
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
            startMs: 1_704_153_600_000,
            endMs: 1_735_689_600_000,
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
            startTime: 1_704_153_600,
            endTime: 1_735_689_600,
        });
    });
});
