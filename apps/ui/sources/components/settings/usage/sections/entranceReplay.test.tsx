import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type {
    UsageAnalyticsTimelineBucket,
    UsageSummaryActivityPoint,
    UsageTrendPoint,
} from '@/sync/api/account/usageAnalytics';
import { EntranceView, resetPlayedEntrancesForTests, useEntrancesEnabled } from './EntranceView';
import { UsageBar } from '../UsageBar';
import { UsageVolumeBarChart } from '../UsageVolumeBarChart';
import { UsageActivitySquareMatrix } from '../UsageMiniVisuals';
import { UsageJourneyChart } from '../UsageJourneyChart';

/**
 * R-L6 F1 — "no replay on revisit" must hold for the INNER entrance animations,
 * not only the EntranceView wrapper. The single guard source is EntranceView's
 * played-once state, exposed to descendants via `useEntrancesEnabled()`; the
 * kit-consuming components render their final state immediately when the
 * surrounding section's entrance already played this session.
 */

type StyleRecord = Record<string, unknown>;

function flattenStyle(style: unknown): StyleRecord {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle)) as StyleRecord;
    }
    return style && typeof style === 'object' ? (style as StyleRecord) : {};
}

const trendPoints: UsageTrendPoint[] = [
    { timestamp: 1_710_000_000, tokens: 1_000, cost: 1, reportCount: 2 },
    { timestamp: 1_710_086_400, tokens: 500, cost: 0.5, reportCount: 1 },
];

const activityPoints: UsageSummaryActivityPoint[] = Array.from({ length: 6 }, (_, index) => ({
    timestamp: 1_710_000_000_000 + index * 86_400_000,
    active: index % 2 === 0,
    tokens: index * 100,
    cost: index,
}));

const timeline: UsageAnalyticsTimelineBucket[] = Array.from({ length: 3 }, (_, index) => ({
    bucketStartMs: 1_710_000_000_000 + index * 86_400_000,
    bucketEndMs: 1_710_086_400_000 + index * 86_400_000,
    leaders: [
        {
            key: 'gpt-5.4',
            label: 'gpt-5.4',
            eventCount: 2,
            totalTokens: (index + 1) * 100_000,
            totalCost: index + 1,
        },
    ],
}));

describe('no-replay on revisit remount (R-L6 F1)', () => {
    afterEach(() => {
        resetPlayedEntrancesForTests();
    });

    it('EntranceView exposes entrances-enabled true on first mount, false on a revisit remount', async () => {
        const seen: boolean[] = [];
        const Probe: React.FC = () => {
            seen.push(useEntrancesEnabled());
            return null;
        };

        await renderScreen(
            <EntranceView entranceId="replay-probe">
                <Probe />
            </EntranceView>,
        );
        expect(seen.at(-1)).toBe(true);

        await renderScreen(
            <EntranceView entranceId="replay-probe">
                <Probe />
            </EntranceView>,
        );
        expect(seen.at(-1)).toBe(false);

        // Outside any EntranceView (e.g. the settings-home strip) the default
        // stays true — existing per-mount entrances are preserved.
        seen.length = 0;
        await renderScreen(<Probe />);
        expect(seen.at(-1)).toBe(true);
    });

    it('UsageBar renders its final fill width immediately on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-bar">
                <UsageBar
                    label="Claude"
                    value={120}
                    maxValue={200}
                    testID="replay-bar-fill"
                    tooltipTitle="Claude"
                    tooltipValue="120"
                />
            </EntranceView>
        );

        await renderScreen(element); // first visit: entrance plays + is recorded
        const revisit = await renderScreen(element);

        const anchor = revisit.findByTestId('replay-bar-fill-anchor');
        expect(anchor).toBeTruthy();
        // Static final state: width literal 60% (120/200), not the 0% start of a width spring.
        expect(flattenStyle(anchor?.props.style).width).toBe('60%');
    });

    it('UsageVolumeBarChart bars render at final height with no grow-in on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-trend">
                <UsageVolumeBarChart points={trendPoints} metric="tokens" testID="replay-volume" />
            </EntranceView>
        );

        await renderScreen(element);
        const revisit = await renderScreen(element);

        const anchor = revisit.findByTestId('usage-volume-point-anchor-0');
        expect(anchor).toBeTruthy();
        const style = flattenStyle(anchor?.props.style);
        // Static branch: plain height, no bottom-anchored scaleY machinery.
        expect(style.transformOrigin).toBeUndefined();
        expect(style.transform).toBeUndefined();
        expect(typeof style.height).toBe('number');
    });

    it('activity heatmap cells are fully visible with no ripple on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-activity">
                <UsageActivitySquareMatrix activity={activityPoints} color="#2BACCC" interactive={false} />
            </EntranceView>
        );

        await renderScreen(element);
        const revisit = await renderScreen(element);

        const cell = revisit.findByTestId('usage-activity-square-0-0');
        expect(cell).toBeTruthy();
        let node: typeof cell | null = cell;
        while (node && String(node.type) !== 'Animated.View') {
            node = node.parent as typeof cell | null;
        }
        expect(node).toBeTruthy();
        expect(flattenStyle(node?.props.style).opacity).toBe(1);
    });

    it('journey chart series lines are fully visible with no draw-in on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-timeline">
                <UsageJourneyChart timeline={timeline} metric="tokens" testID="replay-journey" />
            </EntranceView>
        );

        await renderScreen(element);
        const revisit = await renderScreen(element);

        const line = revisit.findByTestId('usage-journey-line-gpt-5.4');
        expect(line).toBeTruthy();
        expect(flattenStyle(line?.props.style).opacity).toBe(1);
    });
});
