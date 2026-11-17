import { describe, expect, it } from 'vitest';

import { petSpriteLayout } from './petSpriteGeometry';

describe('petSpriteLayout', () => {
    it('preserves v2 atlas proportions and samples the second look row at the cell scale', () => {
        const layout = petSpriteLayout({ cellWidth: 192, cellHeight: 208, scale: 0.5, dpr: 2, spriteVersionNumber: 2 });
        expect(layout.atlasWidth).toBe(768);
        expect(layout.atlasHeight).toBe(1144);
        expect(layout.offset({ row: 10, frame: 7 })).toEqual({ x: -672, y: -1040 });
    });
});
