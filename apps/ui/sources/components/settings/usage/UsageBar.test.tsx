import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { UsageBar } from './UsageBar';

describe('UsageBar', () => {
    it('anchors tooltip interactions to the filled bar instead of the full row container', async () => {
        const screen = await renderScreen(
            <UsageBar
                testID="usage-bar"
                label="Sat · 8 AM"
                value={94}
                maxValue={100}
                tooltipTitle="Sat · 8 AM"
                tooltipValue="94"
            />,
        );

        expect(screen.findByTestId('usage-bar-anchor')).toBeTruthy();
        expect(screen.findByTestId('usage-bar-trigger')).toBeTruthy();
        expect(screen.findByTestId('usage-bar')).toBeTruthy();
    });
});
