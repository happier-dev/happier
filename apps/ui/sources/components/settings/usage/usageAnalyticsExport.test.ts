import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';

import {
    buildUsageAnalyticsExportPayload,
    buildUsagePivotCsv,
    buildUsageRecapCardSummaryText,
} from './usageAnalyticsExport';

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    }],
    breakdowns: {
        agent: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        model: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2, tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 }, cost: { reportedUsd: 11, estimatedUsd: 7, invoiceUsd: 0, currency: 'USD' } }],
        session: [{ key: 'session-a', label: 'Session A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, invoiceUsd: 0, currency: 'USD' } }],
        project: [{ key: 'project-a', label: 'Project A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, invoiceUsd: 0, currency: 'USD' } }],
        workspace: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        backendMode: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        source: [{ key: 'claude_sdk', label: 'Claude SDK', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
    },
    insights: {
        activeDays: 2,
        longestStreakDays: 2,
        sessionsUsed: 2,
        messagesUsed: 12,
        modelsTried: 2,
        favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
        favoriteModelChangeCount: 3,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-25', label: 'Thu' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: '2024-04-24', eventCount: 1 },
            { date: '2024-04-25', eventCount: 2 },
        ],
        weekdayHourBuckets: [
            { weekday: 4, hour: 13, eventCount: 2 },
            { weekday: 5, hour: 14, eventCount: 1 },
        ],
    },
    leaders: {
        agents: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3 }],
        models: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2 }],
        sessions: [{ key: 'session-a', label: 'Session A', eventCount: 2 }],
        projects: [{ key: 'project-a', label: 'Project A', eventCount: 2 }],
        workspaces: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3 }],
        engines: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3 }],
    },
    modelTimeline: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        leaders: [{
            key: 'claude-3.7-sonnet',
            label: 'Claude 3.7 Sonnet',
            eventCount: 2,
            tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 },
            cost: { reportedUsd: 11, estimatedUsd: 7, invoiceUsd: 0, currency: 'USD' },
        }],
    }],
    engineTimeline: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        leaders: [{
            key: 'claude:remote',
            label: 'Claude Remote',
            eventCount: 3,
            tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
            cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' },
        }],
    }],
    messageStats: {
        sessionCount: 2,
        messageCount: 12,
    },
    costPresentation: {
        mode: 'reported',
        effectiveUsd: 12,
        currency: 'USD',
        source: 'provider_reported',
    },
};

describe('usageAnalyticsExport', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('includes recap card payloads in the analytics export payload', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const payload = buildUsageAnalyticsExportPayload({
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            sessionId: 'session-a',
        });

        expect(payload.recapCards).toHaveLength(4);
        expect(payload.recapCards.map((card) => card.id)).toEqual(['streak', 'usage', 'model', 'rhythm']);
        expect(payload.recapCards[2]).toEqual(expect.objectContaining({
            label: 'Go-to model',
            value: 'Claude 3.7 Sonnet',
        }));
    });

    it('carries the active pivot dimension table in the JSON payload and as CSV (E-5)', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const input = {
            viewModel,
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' } as const,
            sessionId: 'session-a',
            pivotDimension: 'session' as const,
        };

        const payload = buildUsageAnalyticsExportPayload(input);
        expect(payload.pivotTable?.dimension).toBe('session');
        expect(payload.pivotTable?.rows[0]).toEqual(expect.objectContaining({
            rank: 1,
            key: 'session-a',
            tokens: 65,
            events: 2,
        }));

        const csv = buildUsagePivotCsv(input);
        const [header, firstRow] = csv.trim().split('\n');
        expect(header).toBe('rank,key,name,tokens,cost,events,share_pct');
        expect(firstRow).toContain('session-a');
        expect(firstRow).toContain('65');
        // Default dimension when none is passed is models.
        expect(buildUsageAnalyticsExportPayload({ ...input, pivotDimension: undefined }).pivotTable?.dimension).toBe('model');
    });

    it('uses the provider leader label in exported recap text when engine labels are unknown', () => {
        const viewModel = buildUsageAnalyticsViewModel({
            ...response,
            breakdowns: {
                ...response.breakdowns,
                backendMode: [{
                    key: 'unknown',
                    label: 'unknown',
                    eventCount: 3,
                    tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
                    cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' },
                }],
            },
            leaders: {
                ...response.leaders,
                engines: [{ key: 'unknown', label: 'unknown', eventCount: 3 }],
                agents: [{ key: 'opencode', label: 'opencode', eventCount: 3 }],
            },
        }, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const summaryText = buildUsageRecapCardSummaryText({
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            sessionId: 'session-a',
            cardId: 'model',
        });

        expect(summaryText).toContain('Go-to model');
        expect(summaryText).toContain('opencode');
        expect(summaryText).not.toContain('unknown');
    });

    it('formats the year period label in exported recap summaries', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: 'year',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const summaryText = buildUsageRecapCardSummaryText({
            viewModel,
            filters: {
                period: 'year',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            sessionId: 'session-a',
            cardId: 'usage',
        });

        expect(summaryText).toContain('Last year');
    });

    it('shares native summaries using a cache File instead of deprecated top-level writes', async () => {
        const write = vi.fn();
        const deleteFile = vi.fn();
        const shareAsync = vi.fn(async () => undefined);

        class File {
            readonly uri: string;

            constructor(parent: { uri: string } | string, name: string) {
                const parentUri = typeof parent === 'string' ? parent : parent.uri;
                this.uri = `${parentUri.replace(/\/+$/, '')}/${name}`;
            }

            write = write;
            delete = deleteFile;
        }

        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));
        vi.doMock('expo-file-system', () => ({
            Paths: { cache: { uri: 'file:///cache/' } },
            File,
            writeAsStringAsync: vi.fn(() => {
                throw new Error('deprecated writeAsStringAsync must not be used');
            }),
            deleteAsync: vi.fn(() => {
                throw new Error('deprecated deleteAsync must not be used');
            }),
        }));
        vi.doMock('expo-sharing', () => ({
            isAvailableAsync: vi.fn(async () => true),
            shareAsync,
        }));

        const { shareUsageAnalyticsSummary } = await import('./usageAnalyticsExport');
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const shared = await shareUsageAnalyticsSummary({
            viewModel,
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' },
            sessionId: 'session-a',
        });

        expect(shared).toBe(true);
        expect(write).toHaveBeenCalledWith(expect.stringContaining('session-a'));
        expect(shareAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/usage-summary-.*\.txt$/));
        expect(deleteFile).toHaveBeenCalledTimes(1);
    });

    it('exports native JSON using a cache File instead of deprecated top-level writes', async () => {
        const write = vi.fn();
        const deleteFile = vi.fn();
        const shareAsync = vi.fn(async () => undefined);

        class File {
            readonly uri: string;

            constructor(parent: { uri: string } | string, name: string) {
                const parentUri = typeof parent === 'string' ? parent : parent.uri;
                this.uri = `${parentUri.replace(/\/+$/, '')}/${name}`;
            }

            write = write;
            delete = deleteFile;
        }

        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));
        vi.doMock('expo-file-system', () => ({
            Paths: { cache: { uri: 'file:///cache/' } },
            File,
            writeAsStringAsync: vi.fn(() => {
                throw new Error('deprecated writeAsStringAsync must not be used');
            }),
            deleteAsync: vi.fn(() => {
                throw new Error('deprecated deleteAsync must not be used');
            }),
        }));
        vi.doMock('expo-sharing', () => ({
            isAvailableAsync: vi.fn(async () => true),
            shareAsync,
        }));

        const { exportUsageAnalyticsJson } = await import('./usageAnalyticsExport');
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const exported = await exportUsageAnalyticsJson({
            viewModel,
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' },
            sessionId: 'session-a',
        });

        expect(exported).toBe(true);
        expect(write).toHaveBeenCalledWith(expect.stringContaining('"sessionId": "session-a"'));
        expect(shareAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/usage-.*\.json$/));
        expect(deleteFile).toHaveBeenCalledTimes(1);
    });
});
