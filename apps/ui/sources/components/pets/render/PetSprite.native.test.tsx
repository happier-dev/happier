import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

describe('PetSprite.native', () => {
    it('renders atlas frames through Skia with nearest-neighbor sampling', async () => {
        const { PetSprite } = await import('./PetSprite.native');

        const screen = await renderScreen(
            <PetSprite
                testID="native-pet-companion-sprite"
                frame={{ row: 4, frame: 2, cellWidth: 192, cellHeight: 208, state: 'jumping' }}
                spritesheetSource="blink-spritesheet.webp"
                scale={0.5}
            />,
        );

        expect(screen.findByTestId('native-pet-companion-sprite')?.props['data-pet-state']).toBe('jumping');
        const canvas = screen.root.findAllByType('Canvas')[0];
        expect(canvas?.props.style).toEqual(expect.objectContaining({ width: 96, height: 104 }));

        const image = screen.root.findAllByType('SkiaImage')[0];
        expect(image?.props.image).toBe('skia-image:blink-spritesheet.webp');
        expect(image?.props.sampling).toEqual({ filter: 'nearest', mipmap: 'nearest' });
        expect(image?.props.x).toBe(-192);
        expect(image?.props.y).toBe(-416);
    });
});
