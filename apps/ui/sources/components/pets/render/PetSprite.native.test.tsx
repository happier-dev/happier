import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@shopify/react-native-skia', async () =>
    (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
);

const { PetSprite } = await import('./PetSprite.native');

describe('PetSprite (native)', () => {
    it('draws a face box from the opaque bounds with smooth sampling, greyed only when asked', async () => {
        const frame = { row: 7, frame: 1, cellWidth: 192, cellHeight: 208, state: 'running' as const };
        const bounds = { x: 5, y: 5, width: 182, height: 198 };
        const screen = await renderScreen(
            <PetSprite testID="face" frame={frame} spriteVersionNumber={2} spritesheetSource="milo.webp" fit={{ box: 32, bounds }} monochrome />,
        );
        expect(screen.findByTestId('face')?.props.style).toEqual(expect.objectContaining({ width: 32, height: 32 }));
        const canvas = screen.root.findByType('Canvas' as never);
        const clip = Object.assign({}, ...[canvas.props.style].flat());
        expect(clip.height).toBeCloseTo(32);
        expect(clip.width).toBeCloseTo(182 * (32 / 198));
        const image = screen.root.findByType('SkiaImage' as never);
        expect(image.props.sampling).toEqual({ filter: 'linear', mipmap: 'linear' });
        expect(image.props.height).toBeCloseTo(2288 * (32 / 198));
        expect(screen.root.findAllByType('ColorMatrix' as never)).toHaveLength(1);
    });
});
