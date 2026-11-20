import { describe, expect, it } from 'vitest';
import { createPlanetDots } from '@happier-dev/brand/planet';
import { createPlanetCanvasDotsCache } from './planetCanvasDots';

describe('planet mark drawing input', () => {
    it('preserves the SceneArt mark lattice, radius and ink calibration', () => {
        const resolve = createPlanetCanvasDotsCache();
        const mark = { size: 90, rows: 28, theme: 'dark', radiusScale: 1.38, opacityScale: 0.42 } as const;
        const dots = createPlanetDots(mark);
        const artwork = resolve(mark);
        expect(artwork).toEqual(dots.map(d => ({ x: d.x, y: d.y, r: d.radius * 1.38, rgb: d.rgb, opacity: d.opacity * 0.42 })));
        expect(resolve({ ...mark })).toBe(artwork);
    });
});
