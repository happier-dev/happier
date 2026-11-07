import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/popover', async importOriginal => ({
    ...(await importOriginal<typeof import('@/components/ui/popover')>()),
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

// Transform the real command-owner graph during collection rather than the first interaction's timeout.
const { ChartTooltip } = await import('./ChartTooltip');

describe('ChartTooltip', () => {
    it('reports selected semantic values through the host overlay trigger on touch and keyboard focus', async () => {
        let selected = false;
        const screen = await renderScreen(<ChartTooltip testID="exact" title="Monday" value="North 0.00004, South unknown" accentColor="#007AFF"
            accessibilityLabel="Monday: North 0.00004, South unknown" onSelect={() => { selected = true; }}><View /></ChartTooltip>);
        const trigger = screen.findByTestId('exact-trigger');
        expect(trigger?.props.accessibilityLabel).toBe('Monday: North 0.00004, South unknown');
        act(() => pressTestInstance(trigger, 'exact-trigger'));
        expect(selected).toBe(true);
        selected = false;
        act(() => trigger?.props.onFocus?.());
        expect(selected).toBe(true);
    });
    it('opens on press and renders the tooltip payload', async () => {
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

});
