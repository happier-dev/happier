import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type {
    UsageAnalyticsInsightsViewModel,
    UsageHeroViewModel,
} from '@/sync/api/account/usageAnalytics';
import { HeroSection } from './HeroSection';
import { InsightsSection } from './InsightsSection';
import { resetPlayedEntrancesForTests } from './EntranceView';

const hero: UsageHeroViewModel = {
    totalTokens: 1_540_000,
    effectiveUsd: 12.5,
    currency: 'USD',
    sessions: 7,
    events: 42,
    messages: 20,
    longestStreakDays: 5,
};

const insights: UsageAnalyticsInsightsViewModel = {
    currentStreakDays: 3,
    activeDays: 4,
    longestStreakDays: 5,
    sessionsUsed: 7,
    messagesUsed: 20,
    modelsTried: 2,
    favoriteModel: { key: 'claude', label: 'Claude 3.7 Sonnet' },
    favoriteModelChangeCount: 1,
    busiestMonth: null,
    busiestDay: null,
    busiestHour: { key: '13', label: '1 PM' },
};

describe('usage sections (L6 T3)', () => {
    afterEach(() => {
        resetPlayedEntrancesForTests();
    });

    it('renders the hero total via the shared formatter plus every stat cell', async () => {
        const screen = await renderScreen(
            React.createElement(HeroSection, {
                hero,
                heroTrend: { sparkline: [10, 10, 30, 30], delta: { deltaPct: 50, direction: 'up' } },
            }),
        );

        expect(screen.findByTestId('usage-hero-total')?.props.accessibilityLabel).toBe('1.5M');
        expect(screen.findByTestId('usage-hero-delta')).toBeTruthy();
        expect(screen.findByTestId('usage-hero-stat-cost')).toBeTruthy();
        expect(screen.findByTestId('usage-hero-stat-sessions')).toBeTruthy();
        expect(screen.findByTestId('usage-hero-stat-events')).toBeTruthy();
        expect(screen.findByTestId('usage-hero-stat-streak')).toBeTruthy();
        expect(screen.getTextContent()).toContain('$12.50');
    });

    it('shows the cache-savings chip only when caching occurred', async () => {
        const withCache = await renderScreen(
            React.createElement(InsightsSection, {
                period: '30days',
                insights,
                cacheSavings: { cachedReadTokens: 25_000, cacheSavingsUsd: null },
            }),
        );
        expect(withCache.findByTestId('usage-insight-cache-savings')).toBeTruthy();
        expect(withCache.findByTestId('usage-insight-streak')).toBeTruthy();
        expect(withCache.findByTestId('usage-insight-busiest')).toBeTruthy();
        expect(withCache.getTextContent()).toContain('25k');

        resetPlayedEntrancesForTests();

        const withoutCache = await renderScreen(
            React.createElement(InsightsSection, {
                period: '30days',
                insights,
                cacheSavings: null,
            }),
        );
        expect(withoutCache.findAllByTestId('usage-insight-cache-savings')).toHaveLength(0);
        expect(withoutCache.findByTestId('usage-insight-streak')).toBeTruthy();
    });

    it('renders the model-mix band with a lens toggle when both mixes have data (B-1)', async () => {
        const { ModelMixSection } = await import('./ModelMixSection');
        const mix = (keys: string[]) => ({
            keys: keys.map((k, i) => ({ key: k, label: k.toUpperCase(), totalTokens: (keys.length - i) * 100 })),
            buckets: [
                { startMs: 0, endMs: 1, total: 100, shares: keys.map((_, i) => (i === 0 ? 1 : 0)) },
                { startMs: 1, endMs: 2, total: 100, shares: keys.map((_, i) => (i === 0 ? 0.5 : 0.5 / (keys.length - 1))) },
            ],
            total: keys.reduce((s, _k, i) => s + (keys.length - i) * 100, 0),
            hasData: true,
        });
        const screen = await renderScreen(
            React.createElement(ModelMixSection, { modelMix: mix(['a', 'b']), engineMix: mix(['x', 'y']) }),
        );
        expect(screen.findByTestId('usage-model-mix-section')).toBeTruthy();
        expect(screen.findByTestId('usage-model-mix-chart')).toBeTruthy();
        // Both lenses present → the Models/Engines toggle renders.
        expect(screen.findByTestId('usage-model-mix-lens:models')).toBeTruthy();
        expect(screen.findByTestId('usage-model-mix-lens:engines')).toBeTruthy();
    });

    it('renders the model-mix empty state when neither lens has data (B-1)', async () => {
        const { ModelMixSection } = await import('./ModelMixSection');
        const empty = { keys: [], buckets: [], total: 0, hasData: false };
        const screen = await renderScreen(
            React.createElement(ModelMixSection, { modelMix: empty, engineMix: empty }),
        );
        expect(screen.findByTestId('usage-model-mix-section')).toBeTruthy();
        expect(screen.findAllByTestId('usage-model-mix-lens:models')).toHaveLength(0);
    });

    it('exposes a button role and label on pressable usage bars (F-UI-14)', async () => {
        const { UsageBar } = await import('../UsageBar');
        const onPress = (() => {}) as () => void;
        const screen = await renderScreen(
            React.createElement(UsageBar, {
                label: 'Claude 3.7 Sonnet',
                value: 120,
                maxValue: 200,
                testID: 'a11y-usage-bar',
                onPress,
            }),
        );

        const bar = screen.findByTestId('a11y-usage-bar');
        expect(bar?.props.accessibilityRole).toBe('button');
        expect(String(bar?.props.accessibilityLabel ?? '')).toContain('Claude 3.7 Sonnet');
    });

    it('renders the session context section with gauge, utilization, and token mix', async () => {
        const { ContextSection } = await import('./ContextSection');
        const screen = await renderScreen(
            React.createElement(ContextSection, {
                context: {
                    usedTokens: 40_000,
                    windowTokens: 200_000,
                    usedPct: 20,
                    tokenMix: { input: 900, output: 300, reasoning: 100, cacheRead: 250, cacheWrite: 40 },
                },
            }),
        );

        expect(screen.findByTestId('usage-context-section')).toBeTruthy();
        expect(screen.findByTestId('usage-context-utilization')).toBeTruthy();
        expect(screen.findByTestId('usage-context-token-mix')).toBeTruthy();
        expect(screen.getTextContent()).toContain('20%');
    });

    it('renders the token mix only when the context window is unknown', async () => {
        const { ContextSection } = await import('./ContextSection');
        const screen = await renderScreen(
            React.createElement(ContextSection, {
                context: {
                    usedTokens: null,
                    windowTokens: null,
                    usedPct: null,
                    tokenMix: { input: 900, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                },
            }),
        );

        expect(screen.findAllByTestId('usage-context-utilization')).toHaveLength(0);
        expect(screen.findByTestId('usage-context-token-mix')).toBeTruthy();
    });
});
