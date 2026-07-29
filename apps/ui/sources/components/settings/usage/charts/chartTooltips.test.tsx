import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen } from '@/dev/testkit';

/**
 * D-R4-3: ONE tooltip owner (`components/ui/charts/ChartTooltip`) wired across
 * every usage chart — heatmap cells (grid + day strip), hour-rhythm bars,
 * weekday bars, and composition segments — showing the exact values on
 * hover/press. The Popover seam is mocked (its own dom tests cover the real
 * portal); these tests pin that every chart MOUNTS the shared owner and that
 * opening a trigger reveals the exact value payload.
 */

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children?: React.ReactNode | ((params: { maxHeight: number; maxWidth: number }) => React.ReactNode) }) => {
        const React = require('react');
        return React.createElement(
            'Popover',
            props,
            typeof props.children === 'function'
                ? props.children({ maxHeight: 200, maxWidth: 320 })
                : props.children,
        );
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        const React = require('react');
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);

describe('usage chart tooltips (one ChartTooltip owner across all charts)', () => {
    it('heatmap year grid: in-range cells carry tooltip triggers; pressing one shows the exact day value', async () => {
        const { UsageContributionHeatmap } = await import('../UsageContributionHeatmap');
        const screen = await renderScreen(
            <UsageContributionHeatmap
                testID="heatmap"
                calendarDays={[{ date: '2026-07-10', eventCount: 42 }]}
                mode="daily"
                nowMs={NOW}
            />,
        );

        const triggers = screen.findAllByTestId('usage-heatmap-cell-trigger');
        expect(triggers.length).toBeGreaterThan(0);

        // Press the trigger for the active day (last week column contains Jul 10).
        act(() => {
            pressTestInstance(triggers[triggers.length - 3]!, 'usage-heatmap-cell-trigger');
        });
        const openPopovers = screen
            .findAllByType('Popover' as never)
            .filter((popover) => (popover.props as { open?: boolean }).open === true);
        expect(openPopovers).toHaveLength(1);
        expect(screen.getTextContent()).toContain('42');
    });

    it('heatmap day strip: every day cell carries a tooltip trigger with the exact value', async () => {
        const { UsageContributionHeatmap } = await import('../UsageContributionHeatmap');
        const screen = await renderScreen(
            <UsageContributionHeatmap
                testID="heatmap"
                calendarDays={[{ date: '2026-07-12', eventCount: 7 }]}
                mode="daily"
                days={7}
                nowMs={NOW}
            />,
        );

        const triggers = screen.findAllByTestId('usage-heatmap-cell-trigger');
        expect(triggers).toHaveLength(7);
        act(() => {
            pressTestInstance(triggers[6]!, 'usage-heatmap-cell-trigger');
        });
        expect(screen.getTextContent()).toContain('7');
    });

    it('hour rhythm: all 24 bars carry tooltip triggers; pressing the busiest shows its exact count', async () => {
        const { HourRhythmChart } = await import('./HourRhythmChart');
        const hours = Array.from({ length: 24 }, (_value, hour) => ({ hour, eventCount: hour === 14 ? 96 : 0 }));
        const screen = await renderScreen(
            <HourRhythmChart rhythm={{ hours, busiestHour: 14, peakCount: 96, total: 96 }} testID="rhythm" />,
        );

        const triggers = screen.findAllByTestId('usage-rhythm-hour-trigger');
        expect(triggers).toHaveLength(24);
        act(() => {
            pressTestInstance(triggers[14]!, 'usage-rhythm-hour-trigger');
        });
        expect(screen.getTextContent()).toContain('96');
    });

    it('punch card: every 7×24 cell carries a tooltip trigger; pressing the hottest shows its exact count', async () => {
        const { PunchCard } = await import('./PunchCard');
        const cells = Array.from({ length: 7 }, (_value, weekday) =>
            Array.from({ length: 24 }, (_hourValue, hour) => (weekday === 3 && hour === 14 ? 31 : 0)));
        const screen = await renderScreen(
            <PunchCard
                punchCard={{ cells, peak: 31, busiest: { weekday: 3, hour: 14, eventCount: 31 }, total: 31 }}
                testID="punch"
            />,
        );

        const triggers = screen.findAllByTestId('usage-punchcard-cell-trigger');
        expect(triggers).toHaveLength(7 * 24);
        // The busiest cell is at flattened index weekday*24 + hour = 3*24 + 14 = 86.
        act(() => {
            pressTestInstance(triggers[86]!, 'usage-punchcard-cell-trigger');
        });
        expect(screen.getTextContent()).toContain('31');
    });

    it('composition strip: each present segment carries a tooltip trigger with the exact token count', async () => {
        const { CompositionStrip } = await import('./CompositionStrip');
        const screen = await renderScreen(
            <CompositionStrip
                composition={{
                    segments: [
                        { key: 'input', tokens: 123_456, pct: 60 },
                        { key: 'output', tokens: 82_304, pct: 40 },
                        { key: 'cacheRead', tokens: 0, pct: 0 },
                        { key: 'cacheWrite', tokens: 0, pct: 0 },
                        { key: 'reasoning', tokens: 0, pct: 0 },
                    ],
                    total: 205_760,
                }}
                testID="composition"
            />,
        );

        const triggers = screen.findAllByTestId('usage-composition-segment-trigger');
        expect(triggers).toHaveLength(2);
        act(() => {
            pressTestInstance(triggers[0]!, 'usage-composition-segment-trigger');
        });
        expect(screen.getTextContent()).toContain('123,456');
    });
});
