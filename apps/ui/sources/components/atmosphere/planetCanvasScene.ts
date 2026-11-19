import { createPlanetDots, createPlanetScene, type PlanetScene } from '@happier-dev/brand/planet';
import type { PlanetCanvasProps } from './planetCanvas.types';

/** A mounted mark retains the scene for its current inputs. */
export function createPlanetCanvasSceneCache() {
    let key: string | PlanetScene | undefined;
    let scene: PlanetScene | undefined;
    return (props: PlanetCanvasProps, dpr: number): PlanetScene => {
        const nextKey = props.scene ?? JSON.stringify([props.options ?? props.mark, dpr]);
        if (key !== nextKey || !scene) {
            scene = props.scene ?? (props.options ? createPlanetScene({ ...props.options, dpr }) : {
                body: createPlanetDots(props.mark).map((dot, index) => ({
                    x: dot.x, y: dot.y, r: dot.radius * (props.mark.radiusScale ?? 1), rgb: dot.rgb,
                    opacity: dot.opacity * (props.mark.opacityScale ?? 1), i: index, j: 0,
                })),
                haze: [], cells: [],
            });
            key = nextKey;
        }
        return scene;
    };
}

/** Port of MO.ctxOf: an exact whole-device-pixel box avoids a resampled seam. */
export function snapCanvasBox(width: number, height: number, dpr: number) {
    const w = Math.floor(width * dpr + 1e-3) / dpr;
    const h = Math.floor(height * dpr + 1e-3) / dpr;
    return { width: w, height: h, pixelWidth: Math.round(w * dpr), pixelHeight: Math.round(h * dpr), dpr };
}
