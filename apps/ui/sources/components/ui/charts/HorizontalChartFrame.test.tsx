import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
});
