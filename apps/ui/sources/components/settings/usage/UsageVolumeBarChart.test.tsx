import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

import { formatUsageCost } from '@/utils/format/usageNumbers';
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

    // D-R3-4 + FINAL micro-fix: the flow chart keeps 3 horizontal hairlines, but
    // the peak value appears exactly ONCE — as the inline annotation above the
    // peak column, NOT also as a right-edge max axis label (peak === max, so
    // labelling both duplicates the same number). Axis keeps only 0 + mid labels.
    it('shows the peak value inline once and omits the duplicate right-edge max label', async () => {
        const points = Array.from({ length: 6 }, (_, index) => ({
            timestamp: 1_710_000_000 + index * 86_400,
            tokens: (index + 1) * 2_000_000,
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

        // All three hairlines stay (anchored baseline + mid + top).
        expect(screen.findByTestId('usage-volume-grid-max')).toBeTruthy();
        expect(screen.findByTestId('usage-volume-grid-mid')).toBeTruthy();
        expect(screen.findByTestId('usage-volume-grid-zero')).toBeTruthy();

        // Only 0 and mid carry a right-edge VALUE label; the max axis label is
        // dropped so it never duplicates the inline peak annotation.
        expect(screen.findByTestId('usage-volume-grid-zero-label')).toBeTruthy();
        expect(screen.findByTestId('usage-volume-grid-mid-label')).toBeTruthy();
        expect(screen.findAllByTestId('usage-volume-grid-max-label')).toHaveLength(0);

        // Max bucket = 12M tokens → mid axis label 6M; the peak (12M) is the
        // inline annotation above the peak column.
        expect(screen.findByTestId('usage-volume-grid-mid-label')?.props.children).toBe('6M');
        expect(screen.findByTestId('usage-volume-peak-annotation')?.props.children).toBe('12M');
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
        expect(screen.getTextContent()).toContain(formatUsageCost(13, 'EUR'));
        expect(screen.getTextContent()).not.toContain('$');
    });
});
