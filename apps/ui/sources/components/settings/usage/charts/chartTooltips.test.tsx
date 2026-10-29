import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageSignatureAccent } from '../usageAccent';
import { createUsageHourRhythmSeries, usageSeriesTooltip } from '../usageSeriesPresentation';
import { UsageEfficiencyWidget } from '../widgets/UsageEfficiencyWidget';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';
import { formatTokenCountLong } from '@/utils/format/usageNumbers';
import { t } from '@/text';

/**
 * D-R4-3: ONE tooltip owner (`components/ui/charts/ChartTooltip`) wired across
 * every usage chart — heatmap cells (grid + day strip), hour-rhythm bars,
 * weekday bars, and composition segments — showing the exact values on
 * hover/press. Only native viewport/measurement and frame scheduling are replaced;
 * ChartTooltip, Popover, portal lifetime and overlay interaction owners remain real.
 * These tests pin that every chart uses the shared owner and that
 * opening a trigger reveals the exact value payload.
 */

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: 1000, height: 800, scale: 1, fontScale: 1 }),
    }));

let restoreFrameBoundary: (() => void) | undefined;
beforeEach(() => { restoreFrameBoundary = withPopoverWebGlobals(); });
afterEach(() => { standardCleanup(); restoreFrameBoundary?.(); });

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);

function renderChart(element: React.ReactElement) {
    return renderScreen(<OverlayPortalProvider>{element}<OverlayPortalHost /></OverlayPortalProvider>, {
        createNodeMock: () => ({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(200, 200, 120, 32),
        }),
    });
}

async function expectRenderedTooltipValue(screen: Awaited<ReturnType<typeof renderScreen>>, value: string) {
    await act(async () => { await flushHookEffects({ cycles: 1, turns: 6, frames: 1 }); });
    const overlays = screen.findAllByType(FloatingOverlay);
    expect(overlays).toHaveLength(1);
    // Accessibility labels can repeat the correct datum even when the painted value is wrong.
    const painted = overlays[0]!.findAll(node => typeof node.type === 'string')
        .flatMap(node => node.children.filter(child => typeof child === 'string'));
    // Match a painted text child, not a substring of another count such as 142.
    expect(painted).toContain(value);
}

describe('usage chart tooltips (one ChartTooltip owner across all charts)', () => {
    it('heatmap year grid: in-range cells carry tooltip triggers; pressing one shows the exact day value', async () => {
        const { Heatmap } = await import('@happier-dev/plugin-ui/presentation');
        const { usageHeatmapPresentation, usageGridTooltip, usageGridFrame } = await import('../usageGridPresentation');
        const accent = usageSignatureAccent(lightTheme);
        const screen = await renderChart(
            <Heatmap
                testID="heatmap"
                theme={projectPluginUiTheme(lightTheme)}
                {...usageHeatmapPresentation({ calendarDays: [{ date: '2026-07-10', eventCount: 42 }], mode: 'daily', nowMs: NOW,
                    accentColor: accent, emptyColor: lightTheme.colors.surface.inset })}
                renderCell={usageGridTooltip(accent, 'usage-heatmap-cell-trigger')}
                renderFrame={usageGridFrame}
            />,
        );

        const triggers = screen.findAllHostsByTestId('usage-heatmap-cell-trigger');
        expect(triggers.length).toBeGreaterThan(0);
        expect(screen.findAllByType(FloatingOverlay)).toHaveLength(0);

        // Press the trigger for the active day (last week column contains Jul 10).
        act(() => {
            pressTestInstance(triggers[triggers.length - 3]!, 'usage-heatmap-cell-trigger');
        });
        await expectRenderedTooltipValue(screen, `${formatHappierDataValue(42)} ${t('usage.events')}`);
    });

    it('heatmap day strip: every day cell carries a tooltip trigger with the exact value', async () => {
        const { Heatmap } = await import('@happier-dev/plugin-ui/presentation');
        const { usageHeatmapPresentation, usageGridTooltip } = await import('../usageGridPresentation');
        const accent = usageSignatureAccent(lightTheme);
        const screen = await renderChart(
            <Heatmap
                testID="heatmap"
                theme={projectPluginUiTheme(lightTheme)}
                {...usageHeatmapPresentation({ calendarDays: [{ date: '2026-07-12', eventCount: 7 }], mode: 'daily', days: 7, nowMs: NOW,
                    accentColor: accent, emptyColor: lightTheme.colors.surface.inset })}
                renderCell={usageGridTooltip(accent, 'usage-heatmap-cell-trigger')}
            />,
        );

        const triggers = screen.findAllHostsByTestId('usage-heatmap-cell-trigger');
        expect(triggers).toHaveLength(7);
        act(() => {
            pressTestInstance(triggers[6]!, 'usage-heatmap-cell-trigger');
        });
        await expectRenderedTooltipValue(screen, `${formatHappierDataValue(7)} ${t('usage.events')}`);
    });

    it('hour rhythm: all 24 bars carry tooltip triggers; pressing the busiest shows its exact count', async () => {
        const { StackedSeriesChart } = await import('@happier-dev/plugin-ui/presentation');
        const hours = Array.from({ length: 24 }, (_value, hour) => ({ hour, eventCount: hour === 14 ? 96 : 0 }));
        const accent = usageSignatureAccent(lightTheme);
        const screen = await renderChart(
            <StackedSeriesChart theme={projectPluginUiTheme(lightTheme)} label="Rhythm" variant="bar" size="tile" viewportHeight={52}
                series={createUsageHourRhythmSeries({ hours, busiestHour: 14, peakCount: 96, total: 96 }, accent)}
                renderBucket={usageSeriesTooltip(accent, 'usage-rhythm-hour-trigger')} testID="rhythm" />,
        );

        const triggers = screen.findAllHostsByTestId('usage-rhythm-hour-trigger');
        expect(triggers).toHaveLength(24);
        act(() => {
            pressTestInstance(triggers[14]!, 'usage-rhythm-hour-trigger');
        });
        await expectRenderedTooltipValue(screen, `${t('usage.events')} · ${formatTokenCountLong(96)}`);
    });

    it('punch card: every 7×24 cell carries a tooltip trigger; pressing the hottest shows its exact count', async () => {
        const { DotGrid } = await import('@happier-dev/plugin-ui/presentation');
        const { usageDotGridPresentation, usageGridTooltip } = await import('../usageGridPresentation');
        const accent = usageSignatureAccent(lightTheme);
        const cells = Array.from({ length: 7 }, (_value, weekday) =>
            Array.from({ length: 24 }, (_hourValue, hour) => (weekday === 3 && hour === 14 ? 31 : 0)));
        const screen = await renderChart(
            <DotGrid
                appearance="cells"
                theme={projectPluginUiTheme(lightTheme)}
                {...usageDotGridPresentation({ cells, peak: 31, busiest: { weekday: 3, hour: 14, eventCount: 31 }, total: 31 },
                    accent, lightTheme.colors.border.default)}
                renderCell={usageGridTooltip(accent, 'usage-punchcard-cell-trigger')}
                testID="punch"
            />,
        );

        const triggers = screen.findAllHostsByTestId('usage-punchcard-cell-trigger');
        expect(triggers).toHaveLength(7 * 24);
        // The renderer reorders weekdays for its calendar; address the witnessed cell by identity.
        const hottest = triggers.find(trigger => {
            const label = String(trigger.props.accessibilityLabel ?? '');
            return label.includes('Wednesday') && label.includes(' · 2 PM:');
        });
        expect(hottest).toBeDefined();
        act(() => {
            pressTestInstance(hottest!, 'usage-punchcard-cell-trigger');
        });
        await expectRenderedTooltipValue(screen, `${formatHappierDataValue(31)} ${t('usage.events')}`);
    });

    it('composition strip: each present segment carries a tooltip trigger with the exact token count', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, metric: 'tokens' });
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: {
            eventCount: 1,
            tokens: { input: 123_456, output: 82_304, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 205_760 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
        const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
        const screen = await renderChart(
            <UsageEfficiencyWidget id="usage_efficiency" query={query} slice={slice} model={model} serverId="home" testID="composition" />,
        );

        const triggers = screen.findAllHostsByTestId('usage-efficiency-mix-trigger');
        expect(triggers).toHaveLength(2);
        act(() => {
            pressTestInstance(triggers[0]!, 'usage-efficiency-mix-trigger');
        });
        await expectRenderedTooltipValue(screen, '123,456');
    });
});
