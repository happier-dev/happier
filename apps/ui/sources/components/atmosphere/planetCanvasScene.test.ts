import { describe, expect, it } from 'vitest';
import { createPlanetDots, createPlanetScene } from '@happier-dev/brand/planet';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';

describe('planet drawing input', () => {
    it('preserves every lab scene dot and digit at the device pixel ratio', () => {
        const resolvePlanetCanvasScene = createPlanetCanvasSceneCache();
        const options = { R: 120, cx: 160, cy: 90, view: { w: 390, h: 260 }, theme: 'light', field: { overStyle: 'ink' } } as const;
        const props = { options, width: 390, height: 260 };
        expect(resolvePlanetCanvasScene(props, 2)).toEqual(createPlanetScene({ ...options, dpr: 2 }));
        expect(resolvePlanetCanvasScene(props, 2)).toBe(resolvePlanetCanvasScene(props, 2));
        expect(resolvePlanetCanvasScene({ ...props, options: { ...options } }, 2)).toBe(resolvePlanetCanvasScene(props, 2));
    });
    it('preserves the SceneArt mark lattice, radius and ink calibration', () => {
        const resolvePlanetCanvasScene = createPlanetCanvasSceneCache();
        const mark = { size: 90, rows: 28, theme: 'dark', radiusScale: 1.38, opacityScale: 0.42 } as const;
        const dots = createPlanetDots(mark);
        const scene = resolvePlanetCanvasScene({ mark, width: 90, height: 90 }, 1);
        expect([...scene.body, ...scene.haze].map(d => ({ x: d.x, y: d.y, r: d.r, rgb: d.rgb, opacity: d.opacity })))
            .toEqual(dots.map(d => ({ x: d.x, y: d.y, r: d.radius * 1.38, rgb: d.rgb, opacity: d.opacity * 0.42 })));
    });
    it('snaps fractional boxes to whole device pixels without stretching their backing store', () => {
        expect(snapCanvasBox(390.37, 260.61, 2)).toEqual({ width: 390, height: 260.5, pixelWidth: 780, pixelHeight: 521, dpr: 2 });
    });
});
