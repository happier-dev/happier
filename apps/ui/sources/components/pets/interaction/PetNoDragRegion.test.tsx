import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import {
    PetNoDragRegion,
    PetNoDragRegionProvider,
    type PetNoDragRegionRect,
    pointIntersectsPetNoDragRegions,
    usePetNoDragRegions,
} from './PetNoDragRegion';

function NoDragProbe(props: Readonly<{
    onRegionsChange: (regions: readonly PetNoDragRegionRect[]) => void;
}>): React.ReactElement {
    const regions = usePetNoDragRegions();

    props.onRegionsChange(regions);

    return <View testID="pet-no-drag-probe" />;
}

describe('PetNoDragRegion', () => {
    it('registers measured native no-drag regions through context', async () => {
        let observedRegions: readonly PetNoDragRegionRect[] = [];
        const screen = await renderScreen(
            <PetNoDragRegionProvider>
                <PetNoDragRegion testID="pet-tray-action-no-drag">
                    <NoDragProbe onRegionsChange={(regions) => {
                        observedRegions = regions;
                    }} />
                </PetNoDragRegion>
            </PetNoDragRegionProvider>,
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

        expect(pointIntersectsPetNoDragRegions({ x: 24, y: 32 }, regions)).toBe(true);
        expect(pointIntersectsPetNoDragRegions({ x: 103, y: 67 }, regions)).toBe(true);
        expect(pointIntersectsPetNoDragRegions({ x: 104.1, y: 67 }, regions)).toBe(false);
        expect(pointIntersectsPetNoDragRegions({ x: 60, y: 80 }, regions)).toBe(false);
    });
});
