import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import {
    CompanionNoDragRegion,
    CompanionNoDragRegionProvider,
    type CompanionNoDragRegionRect,
    pointIntersectsCompanionNoDragRegions,
    useCompanionNoDragRegions,
} from './CompanionNoDragRegion';

function NoDragProbe(props: Readonly<{
    onRegionsChange: (regions: readonly CompanionNoDragRegionRect[]) => void;
}>): React.ReactElement {
    const regions = useCompanionNoDragRegions();

    props.onRegionsChange(regions);

    return <View testID="pet-no-drag-probe" />;
}

describe('CompanionNoDragRegion', () => {
    it('registers measured native no-drag regions through context', async () => {
        let observedRegions: readonly CompanionNoDragRegionRect[] = [];
        const screen = await renderScreen(
            <CompanionNoDragRegionProvider>
                <CompanionNoDragRegion testID="pet-tray-action-no-drag">
                    <NoDragProbe onRegionsChange={(regions) => {
                        observedRegions = regions;
                    }} />
                </CompanionNoDragRegion>
            </CompanionNoDragRegionProvider>,
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('pet-tray-action-no-drag'), 'onLayout', {
                nativeEvent: {
                    layout: { x: 24, y: 32, width: 80, height: 36 },
                },
            });
        });

        expect(screen.findByTestId('pet-no-drag-probe')).toBeTruthy();
        expect(observedRegions).toHaveLength(1);
        expect(observedRegions[0]).toEqual(expect.objectContaining({
            x: 24,
            y: 32,
            width: 80,
            height: 36,
        }));
    });

    it('detects whether a touch point is inside a registered no-drag region', () => {
        const regions = [{ id: 'menu', x: 24, y: 32, width: 80, height: 36 }] as const;

        expect(pointIntersectsCompanionNoDragRegions({ x: 24, y: 32 }, regions)).toBe(true);
        expect(pointIntersectsCompanionNoDragRegions({ x: 103, y: 67 }, regions)).toBe(true);
        expect(pointIntersectsCompanionNoDragRegions({ x: 104.1, y: 67 }, regions)).toBe(false);
        expect(pointIntersectsCompanionNoDragRegions({ x: 60, y: 80 }, regions)).toBe(false);
    });
});
