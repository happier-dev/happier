import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen } from '@/dev/testkit';

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

describe('ChartTooltip', () => {
    it('opens on press and renders the tooltip payload', async () => {
        const { ChartTooltip } = await import('./ChartTooltip');

        const screen = await renderScreen(
            <ChartTooltip
                testID="usage-chart-tooltip"
                title="gpt-5.4"
                subtitle="Apr 12"
                value="261.0M tokens"
                accentColor="#007AFF"
            >
                <React.Fragment>
                    <View testID="usage-chart-tooltip-child" />
                </React.Fragment>
            </ChartTooltip>,
        );

        const trigger = screen.findByTestId('usage-chart-tooltip-trigger');
        act(() => {
            pressTestInstance(trigger, 'usage-chart-tooltip-trigger');
        });

        const popover = screen.findByType('Popover' as never);
        expect(popover.props.open).toBe(true);
        expect(screen.getTextContent()).toContain('gpt-5.4');
        expect(screen.getTextContent()).toContain('Apr 12');
        expect(screen.getTextContent()).toContain('261.0M tokens');
    });

    it('press while hovered keeps the tooltip open — mouse hover opens it, the click must not toggle it away (D-R4-3)', async () => {
        const { ChartTooltip } = await import('./ChartTooltip');

        const screen = await renderScreen(
            <ChartTooltip
                testID="usage-chart-tooltip"
                title="2 PM"
                value="96 events"
                accentColor="#007AFF"
            >
                <React.Fragment>
                    <View testID="usage-chart-tooltip-child" />
                </React.Fragment>
            </ChartTooltip>,
        );

        const trigger = screen.findByTestId('usage-chart-tooltip-trigger');
        // A real mouse press is always preceded by hover-in.
        act(() => {
            trigger?.props?.onHoverIn?.();
        });
        expect(screen.findByType('Popover' as never).props.open).toBe(true);

        act(() => {
            pressTestInstance(trigger, 'usage-chart-tooltip-trigger');
        });
        expect(screen.findByType('Popover' as never).props.open).toBe(true);

        // Without hover (touch), press still toggles: close…
        act(() => {
            trigger?.props?.onHoverOut?.();
        });
        expect(screen.findByType('Popover' as never).props.open).toBe(false);
        act(() => {
            pressTestInstance(trigger, 'usage-chart-tooltip-trigger');
        });
        expect(screen.findByType('Popover' as never).props.open).toBe(true);
        act(() => {
            pressTestInstance(trigger, 'usage-chart-tooltip-trigger');
        });
        expect(screen.findByType('Popover' as never).props.open).toBe(false);
    });

    it('opens on hover and closes on hover out on web', async () => {
        const { ChartTooltip } = await import('./ChartTooltip');

        const screen = await renderScreen(
            <ChartTooltip
                testID="usage-chart-tooltip"
                title="OpenAI Codex App Server"
                subtitle="Apr"
                value="92 events"
                accentColor="#34C759"
            >
                <React.Fragment>
                    <View testID="usage-chart-tooltip-child" />
                </React.Fragment>
            </ChartTooltip>,
        );

        const trigger = screen.findByTestId('usage-chart-tooltip-trigger');
        act(() => {
            trigger?.props?.onHoverIn?.();
        });

        expect(screen.findByType('Popover' as never).props.open).toBe(true);

        act(() => {
            trigger?.props?.onHoverOut?.();
        });

        expect(screen.findByType('Popover' as never).props.open).toBe(false);
    });
});
