import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
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

    it('lays a flat section on the menu text edge like a carded one, so a popover mixing both keeps one edge', async () => {
        const screen = await renderScreen(
            <FloatingOverlay role="panel" maxHeight={400}>
                <ItemGroup><Item testID="carded-row" title="Include in Voice" showChevron={false} /></ItemGroup>
                <ItemGroup surface="none"><Item testID="flat-row" title="Notification settings" showChevron={false} /></ItemGroup>
            </FloatingOverlay>,
        );
        const carded = flattenStyle(screen.findHostByTestId('carded-row')?.props.style);
        const flat = flattenStyle(screen.findHostByTestId('flat-row')?.props.style);
        expect(flat).toEqual(carded);
    });

    it('stands free content in a flat popover section (a button row) on the menu rows\' text edge', async () => {
        const screen = await renderScreen(
            <FloatingOverlay role="panel" maxHeight={400}>
                <ItemGroup surface="none"><BareSectionContent><SurfaceFreshnessLine testID="free" reason="Ready." /></BareSectionContent></ItemGroup>
            </FloatingOverlay>,
        );
        // The nearest inset around the content: the free content's own, not the section's 4 px rows inset.
        let node = screen.findHostByTestId('free')?.parent ?? null;
        while (node && flattenStyle(node.props?.style).paddingHorizontal === undefined) node = node.parent;
        expect(flattenStyle(node?.props.style).paddingHorizontal).toBe(MENU_ROW_METRICS.paddingHorizontalPx);
    });
});
