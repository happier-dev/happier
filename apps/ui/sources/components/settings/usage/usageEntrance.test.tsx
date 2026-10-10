import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type {
    UsageSummaryActivityPoint,
    UsageTrendPoint,
} from '@/sync/api/account/usageAnalytics';
import { EntranceView, resetPlayedEntrancesForTests, useEntrancesEnabled } from './usageEntrance';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageVolumeSeries, useUsageSeriesMotion } from './usageSeriesPresentation';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';
import { usageActivityGridPresentation, useUsageActivityGridTooltip } from './usageGridPresentation';

/**
 * R-L6 F1 — "no replay on revisit" must hold for the INNER entrance animations,
 * not only the EntranceView wrapper. The single guard source is EntranceView's
 * played-once state, exposed to descendants via `useEntrancesEnabled()`; the
 * kit-consuming components render their final state immediately when the
 * surrounding section's entrance already played this session.
 */

type StyleRecord = Record<string, unknown>;

function ReplayActivity() {
    const renderCell = useUsageActivityGridTooltip('#2BACCC', 7);
    return <Heatmap theme={projectPluginUiTheme(lightTheme)} {...usageActivityGridPresentation(activityPoints, '#2BACCC', lightTheme.colors.background.canvas)} renderCell={renderCell} testID="replay-matrix" />;
}

function ReplaySeries() {
    const motion = useUsageSeriesMotion(trendPoints.length);
    return <StackedSeriesChart theme={projectPluginUiTheme(lightTheme)} label="Tokens"
        series={usageVolumeSeries(trendPoints, 'tokens', 'Tokens', lightTheme.colors.text.link)}
        {...motion} variant="bar" size="full" testID="replay-volume" />;
}

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

    it('shared series bars render at final height on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-trend">
                <ReplaySeries />
            </EntranceView>
        );

        await renderScreen(element);
        const revisit = await renderScreen(element);

        const anchor = revisit.findByTestId('replay-volume-bar-0-0');
        expect(anchor).toBeTruthy();
        const style = flattenStyle(anchor?.props.style);
        // Static branch: plain height, no bottom-anchored scaleY machinery.
        expect(style.transformOrigin).toBeUndefined();
        expect(style.transform).toBeUndefined();
        // The platform Animated SDK may retain its value node while morphing is enabled.
        const height = style.height;
        const resolvedHeight = typeof height === 'number' ? height
            : height && typeof height === 'object' && '__getValue' in height && typeof height.__getValue === 'function'
                ? height.__getValue() : null;
        expect(resolvedHeight).toBe(150);
    });

    it('activity heatmap cells are fully visible with no ripple on a revisit remount', async () => {
        const element = (
            <EntranceView entranceId="replay-activity">
                <ReplayActivity />
            </EntranceView>
        );

        await renderScreen(element);
        const revisit = await renderScreen(element);

        const cell = revisit.findAllHostsByTestId('usage-activity-square')[0];
        expect(cell).toBeTruthy();
        let node: typeof cell | null = cell ?? null;
        while (node && String(node.type) !== 'Animated.View') node = node.parent as typeof cell | null;
        expect(node).toBeTruthy();
        expect(flattenStyle(node?.props.style).opacity).toBe(1);
    });
});
