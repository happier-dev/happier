import { createPlanetDots, createPlanetScene, gainPlanetScene, PLANET_SCENE_RENDERER, type PlanetScene } from '@happier-dev/brand/planet';
import type { PlanetCanvasProps } from './planetCanvas.types';

/**
 * A mounted canvas retains its current value-keyed scene, not every slider position. A moment's gain
 * (the ripple's brightening) only re-colours the sampled scene, so the scene at rest is kept and
 * re-gained each frame rather than sampled again.
 */
export function createPlanetCanvasSceneCache() {
    let key: string | PlanetScene | undefined;
    let clock: string | undefined;
    let scene: PlanetScene | undefined;
    let body: PlanetScene;
    let digits: PlanetScene;
    return (props: PlanetCanvasProps, dpr: number, layer?: 'body' | 'digits'): PlanetScene => {
        const gain = props.options?.gain ?? 1;
        const input = props.options ? { ...props.options, gain: undefined, time: undefined, rate: undefined } : props.mark;
        const nextKey = props.scene ?? JSON.stringify([input, dpr]);
        const nextClock = JSON.stringify([props.options?.time, props.options?.rate]);
        if (key !== nextKey || !scene) {
            scene = props.scene ?? (props.options ? createPlanetScene({ ...props.options, gain: undefined, dpr }) : {
                body: createPlanetDots(props.mark).map((dot, index) => ({
                    x: dot.x, y: dot.y, r: dot.radius * (props.mark.radiusScale ?? 1), rgb: dot.rgb,
                    opacity: dot.opacity * (props.mark.opacityScale ?? 1), i: index, j: 0,
                })),
                haze: [], cells: [],
            });
            body = { body: scene.body, haze: scene.haze, cells: scene.cells.filter(cell => cell.over) };
            digits = { body: [], haze: [], cells: scene.cells.filter(cell => !cell.over) };
            key = nextKey;
        } else if (clock !== nextClock && props.options) {
            // The Brand field owns glyph time; its dot sampler never sees a clock-only change.
            const resolved = PLANET_SCENE_RENDERER.resolve(props.options, dpr, props.options.view);
            const cells = PLANET_SCENE_RENDERER.fieldCells(resolved).map(({ col, ...cell }) => ({ ...cell, rgb: col }));
            scene = { ...scene, cells };
            digits = { body: [], haze: [], cells: cells.filter(cell => !cell.over) };
        }
        clock = nextClock;
        return layer === 'digits' ? digits : gainPlanetScene(layer === 'body' ? body : scene, gain);
    };
}

/** Port of MO.ctxOf: an exact whole-device-pixel box avoids a resampled seam. */
export function snapCanvasBox(width: number, height: number, dpr: number) {
    const w = Math.floor(width * dpr + 1e-3) / dpr;
    const h = Math.floor(height * dpr + 1e-3) / dpr;
    return { width: w, height: h, pixelWidth: Math.round(w * dpr), pixelHeight: Math.round(h * dpr), dpr };
}
