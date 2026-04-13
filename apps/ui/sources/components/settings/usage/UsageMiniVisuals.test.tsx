import * as React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    if (!flattened || typeof flattened !== 'object') return {};
    return flattened as Record<string, unknown>;
}

describe('UsageProgressMeter', () => {
    it('does not render a minimum fill width when the ratio is zero', async () => {
        const { UsageProgressMeter } = await import('./UsageMiniVisuals');

        const screen = await renderScreen(
            <UsageProgressMeter ratio={0} color="#123456" />,
        );

        const views = screen.findAllByType('View' as never);
        const fill = views.at(-1);
        const style = flattenStyleProp(fill?.props?.style);

        expect(style.width).toBe('0%');
    });
});

describe('UsageActivitySquareMatrix', () => {
    it('spreads positive activity across multiple heatmap tones even when one outlier dominates', async () => {
        const { UsageActivitySquareMatrix } = await import('./UsageMiniVisuals');

        const screen = await renderScreen(
            <UsageActivitySquareMatrix
                color="#ff8800"
                activity={[
                    { timestamp: 1, active: true, tokens: 1, cost: 0 },
                    { timestamp: 2, active: true, tokens: 2, cost: 0 },
                    { timestamp: 3, active: true, tokens: 3, cost: 0 },
                    { timestamp: 4, active: true, tokens: 4, cost: 0 },
                    { timestamp: 5, active: true, tokens: 5, cost: 0 },
                    { timestamp: 6, active: true, tokens: 6, cost: 0 },
                    { timestamp: 7, active: true, tokens: 1_000, cost: 0 },
                ]}
            />,
        );

        const views = screen.findAllByType('View' as never);
        const squareColors = views
            .map((view) => flattenStyleProp(view.props?.style).backgroundColor)
            .filter((value): value is string => typeof value === 'string');

        expect(new Set(squareColors).size).toBeGreaterThanOrEqual(3);
    });
});
