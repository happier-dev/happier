import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { FloatingOverlay } from './FloatingOverlay';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View' }));

afterEach(() => standardCleanup());

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return typeof style === 'object' && style !== null ? style as Record<string, unknown> : {};
}

describe('FloatingOverlay content on its sheet', () => {
    it('draws a freshness line inside a popover or panel as one plain line, not a ruled strip boxed in the floating surface', async () => {
        const screen = await renderScreen(
            <FloatingOverlay role="panel" maxHeight={400}>
                <SurfaceFreshnessLine testID="line" reason="Some items may be missing." />
            </FloatingOverlay>,
        );
        const style = flattenStyle(screen.findHostByTestId('line')?.props.style);
        expect(style.backgroundColor).toBe('transparent');
        expect(style.borderTopWidth ?? 0).toBe(0);
        expect(style.borderBottomWidth ?? 0).toBe(0);
    });
});
