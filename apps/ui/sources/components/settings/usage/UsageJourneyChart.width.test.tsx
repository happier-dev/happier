import * as React from 'react';
import Svg from 'react-native-svg';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { UsageAnalyticsTimelineBucket } from '@/sync/api/account/usageAnalytics';

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
    ],
}));

describe('UsageJourneyChart width', () => {
    it('keeps moderate timelines visually compact instead of over-expanding bucket spacing', async () => {
        const screen = await renderScreen(
            <UsageJourneyChart
                timeline={timeline}
                metric="tokens"
                testID="usage-journey-chart"
            />,
        );

        // The chart canvas Svg renders first; DrawnLinePath fallbacks may add
        // their own overlay Svgs after it.
        const svg = screen.findAllByType(Svg)[0];
        expect(svg).toBeTruthy();
        expect(Number(svg?.props.width)).toBeLessThan(700);
    });
});
