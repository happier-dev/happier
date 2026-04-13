import { describe, expect, it } from 'vitest';

import type { UsageAnalyticsTimelineBucket } from '@/sync/api/account/usageAnalytics';

import { buildUsageJourneyChartModel } from './buildUsageJourneyChartModel';

const timeline: UsageAnalyticsTimelineBucket[] = [
    {
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        leaders: [
            { key: 'model-a', label: 'Model A', eventCount: 1, totalTokens: 900, totalCost: 9 },
            { key: 'model-b', label: 'Model B', eventCount: 1, totalTokens: 700, totalCost: 7 },
            { key: 'model-c', label: 'Model C', eventCount: 1, totalTokens: 500, totalCost: 5 },
            { key: 'model-d', label: 'Model D', eventCount: 1, totalTokens: 300, totalCost: 3 },
            { key: 'model-e', label: 'Model E', eventCount: 1, totalTokens: 200, totalCost: 2 },
            { key: 'model-f', label: 'Model F', eventCount: 1, totalTokens: 100, totalCost: 1 },
            { key: 'model-g', label: 'Model G', eventCount: 1, totalTokens: 50, totalCost: 0.5 },
        ],
    },
    {
        bucketStartMs: 1_700_086_400_000,
        bucketEndMs: 1_700_172_800_000,
        leaders: [
            { key: 'model-a', label: 'Model A', eventCount: 1, totalTokens: 1_200, totalCost: 12 },
            { key: 'model-b', label: 'Model B', eventCount: 1, totalTokens: 650, totalCost: 6.5 },
            { key: 'model-c', label: 'Model C', eventCount: 1, totalTokens: 400, totalCost: 4 },
            { key: 'model-d', label: 'Model D', eventCount: 1, totalTokens: 350, totalCost: 3.5 },
            { key: 'model-e', label: 'Model E', eventCount: 1, totalTokens: 280, totalCost: 2.8 },
            { key: 'model-f', label: 'Model F', eventCount: 1, totalTokens: 180, totalCost: 1.8 },
            { key: 'model-g', label: 'Model G', eventCount: 1, totalTokens: 20, totalCost: 0.2 },
        ],
    },
];

describe('buildUsageJourneyChartModel', () => {
    it('keeps the top six leaders instead of truncating to three', () => {
        const model = buildUsageJourneyChartModel({
            timeline,
            metric: 'tokens',
        });

        expect(model.series).toHaveLength(6);
        expect(model.latestLeaders.map((leader) => leader.label)).toEqual([
            'Model A',
            'Model B',
            'Model C',
            'Model D',
            'Model E',
            'Model F',
        ]);
    });

    it('positions higher-usage leaders above lower-usage leaders on the vertical axis', () => {
        const model = buildUsageJourneyChartModel({
            timeline,
            metric: 'tokens',
        });

        const modelAPoint = model.series.find((series) => series.label === 'Model A')?.points[0];
        const modelFPoint = model.series.find((series) => series.label === 'Model F')?.points[0];

        expect(modelAPoint).toBeDefined();
        expect(modelFPoint).toBeDefined();
        expect((modelAPoint?.y ?? 0)).toBeLessThan(modelFPoint?.y ?? 0);
    });

    it('switches the plotted values when the metric changes to cost', () => {
        const model = buildUsageJourneyChartModel({
            timeline,
            metric: 'cost',
        });

        expect(model.series[0]?.points[1]?.value).toBe(12);
        expect(model.series[5]?.points[1]?.value).toBe(1.8);
    });

    it('merges duplicate timeline labels into a single rendered series', () => {
        const model = buildUsageJourneyChartModel({
            timeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        { key: 'codex-app-server', label: 'Codex App Server', eventCount: 2, totalTokens: 500, totalCost: 5 },
                        { key: 'openai-codex-app-server', label: 'Codex App Server', eventCount: 3, totalTokens: 700, totalCost: 7 },
                    ],
                },
                {
                    bucketStartMs: 1_700_086_400_000,
                    bucketEndMs: 1_700_172_800_000,
                    leaders: [
                        { key: 'codex-app-server', label: 'Codex App Server', eventCount: 1, totalTokens: 200, totalCost: 2 },
                    ],
                },
            ],
            metric: 'tokens',
        });

        expect(model.series).toHaveLength(1);
        expect(model.series[0]?.label).toBe('Codex App Server');
        expect(model.latestLeaders.map((leader) => leader.label)).toEqual(['Codex App Server']);
    });

    it('applies a horizontal offset to plotted points when the chart reserves left padding', () => {
        const model = buildUsageJourneyChartModel({
            timeline,
            metric: 'tokens',
            usableWidth: 200,
            xOffset: 18,
        });

        expect(model.series[0]?.points[0]?.x).toBe(18);
        expect(model.series[0]?.points[1]?.x).toBe(218);
    });
});
