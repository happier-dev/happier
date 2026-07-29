import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';

import { HorizontalChartFrame } from './HorizontalChartFrame';

describe('HorizontalChartFrame', () => {
    it('does not keep a controlled contentOffset on the ScrollView after mount', async () => {
        const screen = await renderScreen(
            <HorizontalChartFrame contentWidth={900}>
                <View style={{ width: 900, height: 120 }} />
            </HorizontalChartFrame>,
        );

        const scrollView = screen.findByType('ScrollView' as never);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.contentOffset).toBeUndefined();
    });

    it('mounts the floating scroll-edge chevrons by default', async () => {
        const screen = await renderScreen(
            <HorizontalChartFrame contentWidth={2000}>
                <View style={{ width: 2000, height: 120 }} />
            </HorizontalChartFrame>,
        );
        expect(screen.findAllByType(ScrollEdgeIndicators as never).length).toBeGreaterThan(0);
    });

    it('omits the chevrons when showEdgeIndicators is false (D-R4-2)', async () => {
        const screen = await renderScreen(
            <HorizontalChartFrame contentWidth={2000} showEdgeIndicators={false}>
                <View style={{ width: 2000, height: 120 }} />
            </HorizontalChartFrame>,
        );
        expect(screen.findAllByType(ScrollEdgeIndicators as never)).toHaveLength(0);
    });

    it('insets the edge fades below a label axis so the fade covers CELLS only (C-3)', async () => {
        // The heatmap month-label axis must never be dimmed by the cell fade;
        // the frame offsets the left/right fades' top by edgeFadeInsetTop.
        const screen = await renderScreen(
            <HorizontalChartFrame contentWidth={5000} columnStride={14} edgeFadeInsetTop={22} showEdgeIndicators={false}>
                <View style={{ width: 5000, height: 120 }} />
            </HorizontalChartFrame>,
        );
        const fades = screen.findByType(ScrollEdgeFades as never);
        expect(fades.props.leftStyle).toEqual({ top: 22 });
        expect(fades.props.rightStyle).toEqual({ top: 22 });
    });
});
