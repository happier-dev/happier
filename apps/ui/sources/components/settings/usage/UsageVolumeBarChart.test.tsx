import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

import { formatUsageCurrency } from './formatUsageCurrency';
import { UsageVolumeBarChart } from './UsageVolumeBarChart';

describe('UsageVolumeBarChart', () => {
    it('starts at the latest buckets and renders horizontal scroll affordances when the chart overflows', async () => {
        const points = Array.from({ length: 12 }, (_, index) => ({
            timestamp: 1_710_000_000 + index * 86_400,
            tokens: (index + 1) * 1_000_000,
            cost: (index + 1) * 10,
            reportCount: 1,
        }));

        const screen = await renderScreen(
            <UsageVolumeBarChart
                points={points}
                metric="tokens"
                testID="usage-volume-chart"
            />,
        );

        const scrollView = screen.findByType('ScrollView' as never);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.contentOffset).toBeUndefined();
        expect(screen.findByType(ScrollEdgeFades as never)).toBeTruthy();
        expect(screen.findByType(ScrollEdgeIndicators as never)).toBeTruthy();
        expect(screen.findAllByTestId('usage-volume-point-trigger')).toHaveLength(points.length);
        expect(screen.findByTestId('usage-volume-point-anchor-0')).toBeTruthy();
    });

    it('labels cost totals correctly and formats them using the active currency', async () => {
        const points = [
            {
                timestamp: 1_710_000_000,
                tokens: 100,
                cost: 12.5,
                reportCount: 1,
            },
            {
                timestamp: 1_710_086_400,
                tokens: 50,
                cost: 0.5,
                reportCount: 1,
            },
        ];

        const screen = await renderScreen(
            <UsageVolumeBarChart
                points={points}
                metric="cost"
                currency="EUR"
                testID="usage-volume-chart"
            />,
        );

        expect(screen.getTextContent().toLowerCase()).toContain('total cost');
        expect(screen.getTextContent().toLowerCase()).not.toContain('total tokens');
        expect(screen.getTextContent()).toContain(formatUsageCurrency(13, 'EUR'));
        expect(screen.getTextContent()).not.toContain('$');
    });
});
