import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { ChartTooltip } from '@/components/ui/charts';
import { renderScreen } from '@/dev/testkit';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import type { UsageAnalyticsTimelineBucket } from '@/sync/api/account/usageAnalytics';

import { formatUsageCost } from '@/utils/format/usageNumbers';
import { UsageJourneyChart } from './UsageJourneyChart';

const timeline: UsageAnalyticsTimelineBucket[] = Array.from({ length: 10 }, (_, index) => ({
    bucketStartMs: 1_710_000_000_000 + index * 86_400_000,
    bucketEndMs: 1_710_086_400_000 + index * 86_400_000,
    leaders: [
        {
            key: 'gpt-5.4',
            label: 'gpt-5.4',
            eventCount: 4,
            totalTokens: (index + 1) * 500_000,
            totalCost: (index + 1) * 4,
        },
        {
            key: 'claude-3.7-sonnet',
            label: 'claude-3.7-sonnet',
            eventCount: 2,
            totalTokens: (10 - index) * 120_000,
            totalCost: (10 - index) * 1.2,
        },
    ],
}));

describe('UsageJourneyChart', () => {
    it('starts at the latest buckets and shows horizontal scroll affordances for long timelines', async () => {
        const screen = await renderScreen(
            <UsageJourneyChart
                timeline={timeline}
                metric="tokens"
                testID="usage-journey-chart"
            />,
        );

        const scrollView = screen.findByType('ScrollView' as never);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.contentOffset).toBeUndefined();
        expect(screen.findByType(ScrollEdgeFades as never)).toBeTruthy();
        expect(screen.findByType(ScrollEdgeIndicators as never)).toBeTruthy();
        expect(screen.findAllByTestId('usage-journey-point-trigger').length).toBeGreaterThan(0);
    });

    it('formats cost tooltips using the active currency', async () => {
        const screen = await renderScreen(
            <UsageJourneyChart
                timeline={timeline}
                metric="cost"
                currency="EUR"
                testID="usage-journey-chart"
            />,
        );

        const tooltips = screen.findAllByType(ChartTooltip as never) as unknown as Array<{ props: { value: string } }>;
        expect(tooltips[0]?.props.value).toBe(formatUsageCost(timeline[0]?.leaders[0]?.totalCost ?? 0, 'EUR'));
    });
});
