import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildUsageAnalyticsViewModel, type UsageFilterState } from '@/sync/api/account/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

import { buildRecapStorySlides } from './buildRecapStorySlides';
import { RecapStorySurface } from './RecapStorySurface';

const filters: UsageFilterState = {
    period: '30days',
    metric: 'tokens',
    focus: null,
    costMode: 'auto',
};

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 6,
        tokens: { input: 900, output: 300, reasoning: 100, cacheRead: 250, cacheWrite: 40, total: 1590 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            eventCount: 6,
            tokens: { input: 900, output: 300, reasoning: 100, cacheRead: 250, cacheWrite: 40, total: 1590 },
            cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
        },
    ],
    breakdowns: {
        model: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 6, tokens: { input: 900, output: 300, reasoning: 100, cacheRead: 250, cacheWrite: 40, total: 1590 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        backendMode: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 6, tokens: { input: 900, output: 300, reasoning: 100, cacheRead: 250, cacheWrite: 40, total: 1590 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
    },
    insights: {
        activeDays: 3,
        longestStreakDays: 3,
        sessionsUsed: 4,
        messagesUsed: 20,
        modelsTried: 1,
        favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
        favoriteModelChangeCount: 0,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-25', label: 'Thu' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: '2024-04-24', eventCount: 2 },
            { date: '2024-04-25', eventCount: 4 },
        ],
        weekdayHourBuckets: [
            { weekday: 4, hour: 13, eventCount: 4 },
            { weekday: 5, hour: 14, eventCount: 2 },
        ],
    },
    leaders: {
        agents: [{ key: 'anthropic', label: 'Anthropic', eventCount: 6 }],
        models: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 6 }],
        sessions: [],
        projects: [],
        workspaces: [],
        engines: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 6 }],
    },
    messageStats: { sessionCount: 4, messageCount: 20 },
    costPresentation: { mode: 'auto', effectiveUsd: 12, currency: 'USD', source: 'provider_reported' },
};

describe('recap story mode (L6 T4)', () => {
    it('builds the five-slide story in IA order when cache savings exist', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        const slides = buildRecapStorySlides({
            viewModel,
            filters,
            cacheSavings: viewModel.cacheSavings,
        });

        expect(slides.map((slide) => slide.id)).toEqual(['usage', 'streak', 'model', 'cache', 'rhythm']);
        expect(slides.find((slide) => slide.id === 'cache')?.value).toBe('250');
    });

    it('omits the cache slide when the period had no cached reads', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        const slides = buildRecapStorySlides({ viewModel, filters, cacheSavings: null });

        expect(slides.map((slide) => slide.id)).toEqual(['usage', 'streak', 'model', 'rhythm']);
    });

    it('advances on the forward tap zone and dismisses past the last slide', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        const onDismiss = vi.fn();

        const screen = await renderScreen(React.createElement(RecapStorySurface, {
            viewModel,
            filters,
            cacheSavings: viewModel.cacheSavings,
            onDismiss,
        }));

        expect(screen.findByTestId('usage-recap-story-slide-usage')).toBeTruthy();
        expect(screen.findByTestId('usage-recap-story-share')).toBeTruthy();

        await screen.pressByTestIdAsync('usage-recap-story-forward');
        expect(screen.findByTestId('usage-recap-story-slide-streak')).toBeTruthy();

        await screen.pressByTestIdAsync('usage-recap-story-back');
        expect(screen.findByTestId('usage-recap-story-slide-usage')).toBeTruthy();

        // Walk to the end: usage → streak → model → cache → rhythm → dismiss.
        await screen.pressByTestIdAsync('usage-recap-story-forward');
        await screen.pressByTestIdAsync('usage-recap-story-forward');
        await screen.pressByTestIdAsync('usage-recap-story-forward');
        await screen.pressByTestIdAsync('usage-recap-story-forward');
        expect(onDismiss).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('usage-recap-story-forward');
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('closes from the explicit close control', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        const onDismiss = vi.fn();

        const screen = await renderScreen(React.createElement(RecapStorySurface, {
            viewModel,
            filters,
            cacheSavings: viewModel.cacheSavings,
            onDismiss,
        }));

        screen.pressByTestId('usage-recap-story-close');
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});
