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
