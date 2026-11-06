import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { findAllHostTestInstances } from '@/dev/testkit/render/renderScreen';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageSignatureAccent } from '../usageAccent';
import { createUsageHourRhythmSeries, usageSeriesTooltip } from '../usageSeriesPresentation';
import { UsageEfficiencyWidget } from '../widgets/UsageEfficiencyWidget';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { Popover } from '@/components/ui/popover';
import { formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';
import { formatTokenCountLong } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { ChartMark, ChartDatum, HappierDataRows } from '@happier-dev/plugin-ui/presentation';
import { UsageChartInteractions } from '../usageChartInteractions';
import { ChartTooltip } from '@/components/ui/charts';
import { UsagePlanetPortrait, UsageRunLength, UsageSteeringTide } from '@happier-dev/plugin-ui/presentation';
import { usageAgentTooltipFixtures } from './usageAgentTooltipFixtures';
import { usageSpecializedTooltipFixtures } from './usageSpecializedTooltipFixtures';
import { usageInlineTooltipFixtures } from './usageInlineTooltipFixtures';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';

const markTheme = projectPluginUiTheme(lightTheme);
const markBase = { theme: markTheme, paint: { accent: usageSignatureAccent(lightTheme), paper: lightTheme.colors.surface.base, dark: false }, width: 800,
    label: 'Measured work', testID: 'work', agents: [{ id: 'claude', name: 'Claude Code', color: usageSignatureAccent(lightTheme) }] };
const markValues = { show: 'Show values', hide: 'Hide values' };
const popoverMarks = [
    ...usageAgentTooltipFixtures,
    ...usageSpecializedTooltipFixtures,
    ...usageInlineTooltipFixtures,
    { name: 'run duration dot', value: '37,123 ms', body: <UsageRunLength {...markBase} model={{ rows: [{ agentId: 'claude', durationsMs: [37123], medianMs: 37123, p90Ms: 37123, samples: 1 }], openCount: null, croppedCount: null }}
        labels={{ duration: (ms) => `${Math.round(ms / 1000)}s`, unknownAgent: 'Unknown', detail: (ms, n) => `${ms} · ${n}`, ticks: { minute: '1m', tenMinutes: '10m', hour: '1h', fourHours: '4h' }, caption: '',
            values: { ...markValues, agentColumn: 'Agent', medianColumn: 'Median', p90Column: 'p90', samplesColumn: 'Samples', formatCount: String } }} /> },
    { name: 'steering tide hour', value: '7', body: <UsageSteeringTide {...markBase} model={{ night: null, rows: [{ agentId: 'claude', steersByHour: [7], phoneAnswersByHour: [3], steers: 7, busyMs: 3600000, perBusyHour: 7, phoneAnswers: 3 }] }}
        labels={{ clock: String, unknownAgent: 'Unknown', perBusyHourHeader: 'Per busy hour', fromPhoneHeader: 'From phone', perBusyHourUnit: 'per hour', answers: 'Answers', rate: String, detail: String, count: String, caption: '' }} /> },
    { name: 'planet portrait', value: 'Light: 4 / 30 · Halo: 7 · Trail: 3', body: <UsagePlanetPortrait {...markBase} model={{ activeDays: { active: 4, of: 30 }, peakParallel: 7, streak: { current: 3, best: 12 } }}
        labels={{ rows: { light: 'Light', halo: 'Halo', trail: 'Trail' }, activeDays: (active, of) => `${active} / ${of}`, peak: String, streak: String, notShared: 'Not shared', lightNote: 'Active days', lightRest: '', haloNote: 'Peak parallel', haloRest: '', trailNote: String, trailRest: '' }} /> },
];

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
    it.each([1, 168])('mounts only the mark targets for %i closed chart values', async (count) => {
        // The weekday/hour matrix has 7 × 24 independently accessible marks.
        const screen = await renderChart(<UsageChartInteractions>
            {Array.from({ length: count }, (_, index) => <ChartMark key={index} testID={`mount-mark-${index}`}
                bounds={{ x: index, y: 0, width: 1, height: 1 }} datum={{ label: `Hour ${index}`, value: String(index) }} />)}
        </UsageChartInteractions>);
        const hosts = findAllHostTestInstances(screen, node => node.type === 'View');
        expect(hosts.length).toBeLessThanOrEqual(count * 2 + 1);
        expect(screen.findAll(node => typeof node.type === 'function' && node.type.name === 'AnchoredPopover')).toHaveLength(0);
        const trigger = screen.findAllHostsByTestId(`mount-mark-${count - 1}`)[0]!;
        expect(trigger.props.accessibilityLabel).toBe(`Hour ${count - 1}: ${count - 1}`);
        await act(async () => { trigger.props.onFocus(); });
        await expectRenderedTooltipValue(screen, String(count - 1));
    });

    it.each(['onHoverIn', 'onFocus', 'onPress'] as const)('reveals a row amount through %s without activating its sibling navigation', async (event) => {
        const navigate = vi.fn();
        const screen = await renderChart(<UsageChartInteractions>
            <HappierDataRows theme={markTheme} testID="work-amount" columns={[{ label: 'Session' }, { label: 'Cost', proportion: true }]}
                rows={[[ 'Audit', '$1.23 reported' ]]} rowDatums={[{ label: 'Audit', value: 'USD 1.23456', subtitle: 'Reported' }]}
                renderIdentity={(_row, visual) => <Pressable testID="work-navigation" onPress={navigate}>{visual}</Pressable>} />
        </UsageChartInteractions>);
        const tooltip = screen.findAllByType(ChartTooltip).find(node => node.props.value === 'USD 1.23456');
        expect(tooltip).toBeDefined();
        const trigger = tooltip!.findAll(node => typeof node.type === 'string' && typeof node.props[event] === 'function')[0]!;
        await act(async () => { trigger.props[event](); });
        await expectRenderedTooltipValue(screen, 'USD 1.23456');
        expect(navigate).not.toHaveBeenCalled();
        const identity = screen.findAllHostsByTestId('work-navigation')[0]!;
        await act(async () => { identity.props.onPress(); });
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('keeps the value open when touch gives the target focus before its press', async () => {
        const screen = await renderChart(<UsageChartInteractions><ChartDatum testID="touch-focus" datum={{ label: 'Count', value: '1,234' }}>1.2k</ChartDatum></UsageChartInteractions>);
        const trigger = screen.findAllHostsByTestId('touch-focus')[0]!;
        await act(async () => { trigger.props.onFocus(); });
        await act(async () => { trigger.props.onPress(); });
        expect(screen.findAllByType(Popover)[0]!.props.open).toBe(true);
        await expectRenderedTooltipValue(screen, '1,234');
        await act(async () => { trigger.props.onPress(); });
        expect(screen.findAllByType(Popover)[0]!.props.open).toBe(false);
    });

    it.each([false, true])('gives an explicit outer datum one popover instead of nesting an automatic metric target (control slot: %s)', async (controlSlot) => {
        const visual = <ChartDatum testID="inner" datum={{ label: 'Cost', value: '$0.00004' }}>$0.00</ChartDatum>;
        const screen = await renderChart(<UsageChartInteractions>
            <ChartDatum testID="outer" datum={{ label: 'Cost and tokens', value: '$0.00004 · 1,234 tokens' }}
                renderTrigger={controlSlot ? interaction => <Pressable testID="outer" onFocus={() => interaction.onFocusChange(true)}>{visual}</Pressable> : undefined}>
                {visual}
            </ChartDatum>
        </UsageChartInteractions>);
        expect(screen.findAllByType(ChartTooltip)).toHaveLength(1);
        const trigger = screen.findAllHostsByTestId('outer')[0]!;
        await act(async () => { trigger.props.onFocus(); });
        await expectRenderedTooltipValue(screen, '$0.00004 · 1,234 tokens');
    });

    it('consumes a datum press before the enclosing navigation row can handle it', async () => {
        const screen = await renderChart(<UsageChartInteractions><ChartDatum testID="inside-row" datum={{ label: 'Amount', value: '1,234' }}>1.2k</ChartDatum></UsageChartInteractions>);
        const stopPropagation = vi.fn();
        const trigger = screen.findAllHostsByTestId('inside-row')[0]!;
        await act(async () => { trigger.props.onPress({ stopPropagation }); });
        expect(stopPropagation).toHaveBeenCalledOnce();
        await expectRenderedTooltipValue(screen, '1,234');
    });

    describe.each(popoverMarks)('$name', ({ body, value }) => {
        it.each(['onHoverIn', 'onFocus', 'onPress'] as const)('opens the real popover with its exact datum through %s', async (event) => {
            const screen = await renderChart(<UsageChartInteractions>{body}</UsageChartInteractions>);
            const tooltip = screen.findAllByType(ChartTooltip).find(node => node.props.value === value);
            expect(tooltip, `Missing datum ${value}`).toBeDefined();
            const trigger = tooltip!.findAll(node => typeof node.type === 'string' && typeof node.props[event] === 'function')[0];
            expect(trigger).toBeDefined();
            await act(async () => { trigger!.props[event](); });
            await expectRenderedTooltipValue(screen, value);
        });
    });
    it.each(['onHoverIn', 'onFocus', 'onPress'] as const)('shared mark target reveals the exact value through %s', async (event) => {
        const screen = await renderChart(<UsageChartInteractions>
            <ChartMark testID="datum-mark" bounds={{ x: 12, y: 8, width: 24, height: 24 }} datum={{ label: 'Observed turns', value: '4,186,010' }} />
        </UsageChartInteractions>);
        const trigger = screen.findAllHostsByTestId('datum-mark')[0];
        expect(trigger).toBeDefined();
        await act(async () => { trigger!.props[event](); });
        await expectRenderedTooltipValue(screen, '4,186,010');
    });

    it('inline datum retains exact fractional precision behind its visible compact value', async () => {
        const screen = await renderChart(<UsageChartInteractions>
            <ChartDatum testID="datum-inline" datum={{ label: 'Measured share', value: '12.34567%' }}><React.Fragment>12%</React.Fragment></ChartDatum>
        </UsageChartInteractions>);
        const trigger = screen.findAllHostsByTestId('datum-inline')[0];
        expect(trigger).toBeDefined();
        await act(async () => { trigger!.props.onFocus(); });
        await expectRenderedTooltipValue(screen, '12.34567%');
    });

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

    it.each(['onHoverIn', 'onFocus', 'onPress'] as const)('compact Efficiency waffle reveals the segment exact value through %s', async (event) => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, metric: 'tokens' });
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: {
            eventCount: 1,
            tokens: { input: 123_456, output: 82_304, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 205_760 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
        const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
        const screen = await renderChart(<WidgetPresentationProvider value={{ size: 'small',
            footprint: { columns: 2, columnSpan: 1, rowSpan: 1, height: 'compact', width: 'compact' }, geometry: { width: 300, height: 200 } }}>
            <UsageEfficiencyWidget id="usage_efficiency" query={query} slice={slice} model={model} serverId="home" testID="waffle" />
        </WidgetPresentationProvider>);
        const triggers = screen.findAllHostsByTestId('usage-efficiency-mix-trigger');
        expect(triggers).toHaveLength(50);
        expect(new Set(screen.findAllByType(ChartTooltip)
            .filter(node => node.props.triggerTestID === 'usage-efficiency-mix-trigger').map(node => node.props.value)))
            .toEqual(new Set(['123,456', '82,304']));
        await act(async () => { triggers[0]!.props[event](); });
        await expectRenderedTooltipValue(screen, '123,456');
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
