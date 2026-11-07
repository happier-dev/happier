import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';

import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import { ProviderUsageRing } from './ProviderUsageRing';
import { computeConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { connectedServiceQuotaGaugeFormatter } from './connectedServiceQuotaGaugeFormatter';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

function render(element: React.ReactElement) {
    let tree: ReturnType<typeof create> | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('ProviderUsageRing did not mount');
    return tree as ReturnType<typeof create>;
}

describe('ProviderUsageRing', () => {
    it('keeps both limits visible as concentric remaining-first rings, including an exhausted limit', async () => {
        const gauge = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: {
                v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1_000, staleAfterMs: 60_000,
                planLabel: null, accountLabel: null, meters: [
                    { meterId: 'five_hour', label: '5-hour', used: 100, limit: 100, unit: 'count', utilizationPct: null,
                        resetsAt: null, status: 'ok', details: { limitCategory: 'usage_limit' } },
                    { meterId: 'weekly', label: 'Weekly', used: 30, limit: 100, unit: 'count', utilizationPct: null,
                        resetsAt: null, status: 'ok', details: { limitCategory: 'usage_limit' } },
                ],
            },
            windowModes: ['session', 'weekly'], windowMode: 'most_constrained', nowMs: 2_000,
            formatter: connectedServiceQuotaGaugeFormatter,
        });
        if (!gauge || gauge.usageRings.length !== 2) throw new Error('Expected two measured limits');
        const screen = await renderScreen(<ProviderUsageRing gauge={gauge} testID="rail-usage" />);
        const arcs = screen.findAll((node) => String(node.type) === 'Circle' && typeof node.props.strokeDashoffset === 'number');
        expect(arcs).toHaveLength(2);
        expect(arcs[0].props.r).toBeGreaterThan(arcs[1].props.r);
        expect(arcs[0].props.cx).toBe(arcs[1].props.cx);
        expect(arcs[0].props.cy).toBe(arcs[1].props.cy);
        // Outer ring is the longer (weekly) period, the inner ring the shorter (5-hour) one, separated by one pixel.
        expect(arcs[0].props.r - arcs[1].props.r - arcs[0].props.strokeWidth).toBe(1);
        expect(arcs[0].props.strokeDashoffset / (2 * Math.PI * arcs[0].props.r)).toBeCloseTo(0.30);
        expect(arcs[1].props.strokeDashoffset / (2 * Math.PI * arcs[1].props.r)).toBeCloseTo(1);
        expect(arcs[0].props.stroke).not.toBe(arcs[1].props.stroke);
        const circles = screen.findAll((node) => String(node.type) === 'Circle');
        // At zero the unfilled outline must retain the exhausted colour too.
        expect(circles[2].props.stroke).toBe(arcs[1].props.stroke);
        const images = screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'image');
        expect(images).toHaveLength(1);
        expect(images[0].props.accessibilityLabel).toContain('5-hour');
        expect(images[0].props.accessibilityLabel).toContain('Weekly');
        expect(screen.getTextContent()).toContain('0');
    });
    it('shows an empty number-less ring when the row has no usage gauge', () => {
        const tree = render(<ProviderUsageRing gauge={null} testID="rail-usage" />);
        expect(tree.root.findAllByProps({ testID: 'rail-usage' }).length).toBeGreaterThan(0);
        expect(tree.root.findAll((node) => typeof node.props.children === 'string' && node.props.children.length > 0)).toHaveLength(0);
    });

    it('shows the remaining percentage when the row has a gauge', () => {
        const gauge = {
            usedPct: 13,
            ringValueLabel: '87',
            badgeLabel: '87% left',
            usageRings: [{ meterId: 'primary', label: 'Primary', usedPct: 13, ringValueLabel: '87', valueLabel: '87% left', tone: 'ok' }],
        } as unknown as ConnectedServiceQuotaGaugeViewModel;
        const tree = render(<ProviderUsageRing gauge={gauge} testID="rail-usage" />);
        expect(tree.root.findAll((node) => node.props.children === '87').length).toBeGreaterThan(0);
    });
});
