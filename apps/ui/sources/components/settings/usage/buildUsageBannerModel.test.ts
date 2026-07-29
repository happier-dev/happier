import { describe, expect, it } from 'vitest';

import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { buildUsageBannerModel, computeCalendarStreaks } from './buildUsageBannerModel';

const DAY = 86_400_000;
const NOW = Date.UTC(2024, 3, 24, 12, 0, 0);

function iso(offsetDays: number): string {
    return new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);
}

describe('computeCalendarStreaks', () => {
    it('returns zero streaks for no active days', () => {
        expect(computeCalendarStreaks([], NOW)).toEqual({ currentStreakDays: 0, longestStreakDays: 0 });
    });

    it('counts the current streak anchored to today', () => {
        const streaks = computeCalendarStreaks(
            [{ date: iso(0), eventCount: 1 }, { date: iso(1), eventCount: 2 }, { date: iso(2), eventCount: 1 }],
            NOW,
        );
        expect(streaks.currentStreakDays).toBe(3);
        expect(streaks.longestStreakDays).toBe(3);
    });

    it('keeps the current streak alive when today is not yet active but yesterday is', () => {
        const streaks = computeCalendarStreaks(
            [{ date: iso(1), eventCount: 1 }, { date: iso(2), eventCount: 1 }],
            NOW,
        );
        expect(streaks.currentStreakDays).toBe(2);
    });

    it('breaks the current streak on a gap but keeps the longest run', () => {
        const streaks = computeCalendarStreaks(
            [
                { date: iso(0), eventCount: 1 },
                { date: iso(5), eventCount: 1 },
                { date: iso(6), eventCount: 1 },
                { date: iso(7), eventCount: 1 },
            ],
            NOW,
        );
        expect(streaks.currentStreakDays).toBe(1);
        expect(streaks.longestStreakDays).toBe(3);
    });
});

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 5,
        tokens: { input: 900, output: 300, reasoning: 10, cacheRead: 50, cacheWrite: 0, total: 1260 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        { bucketStartMs: NOW - 40 * DAY, bucketEndMs: NOW - 40 * DAY + DAY, eventCount: 2, tokens: { input: 200, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 260 }, cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' } },
        { bucketStartMs: NOW - 10 * DAY, bucketEndMs: NOW - 10 * DAY + DAY, eventCount: 3, tokens: { input: 700, output: 240, reasoning: 10, cacheRead: 50, cacheWrite: 0, total: 1000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } },
    ],
    breakdowns: {
        model: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 3, tokens: { input: 700, output: 240, reasoning: 10, cacheRead: 50, cacheWrite: 0, total: 1000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } }],
    },
    insights: {
        activeDays: 4,
        longestStreakDays: 6,
        sessionsUsed: 3,
        messagesUsed: 5,
        modelsTried: 2,
        favoriteModel: { key: 'claude-fable-5', label: 'claude-fable-5' },
        favoriteModelChangeCount: 1,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-24', label: 'Wed' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: iso(0), eventCount: 2 },
            { date: iso(1), eventCount: 3 },
        ],
        weekdayHourBuckets: [{ weekday: 3, hour: 13, eventCount: 5 }],
    },
    leaders: {
        models: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 3 }],
    },
    messageStats: { sessionCount: 3, messageCount: 5 },
};

describe('buildUsageBannerModel', () => {
    const viewModel = buildUsageAnalyticsViewModel(response, { period: 'year', metric: 'tokens', focus: null, costMode: 'auto' });
    const model = buildUsageBannerModel(viewModel, NOW);

    it('reads lifetime tokens and sessions from the single view-model owner', () => {
        expect(model.lifetimeTokens).toBe(1260);
        expect(model.sessions).toBe(3);
        expect(model.hasData).toBe(true);
    });

    it('derives the peak bucket from the largest trend point', () => {
        expect(model.peakBucketTokens).toBe(1000);
    });

    it('recomputes day-resolution current streak and honours the longest streak', () => {
        expect(model.currentStreakDays).toBe(2);
        expect(model.longestStreakDays).toBe(6);
    });

    it('surfaces the go-to model and most-used models with event counts', () => {
        expect(model.favoriteModelLabel).toBe('claude-fable-5');
        expect(model.mostUsed[0]).toEqual({ key: 'claude-fable-5', label: 'claude-fable-5', events: 3 });
    });
});
