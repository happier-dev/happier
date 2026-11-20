import * as React from 'react';
import { createPlanetScene, type PlanetScene, type PlanetSceneOptions } from '@happier-dev/brand/planet';

import { planetCanvasFonts } from '@/components/atmosphere/glyph/glyphAtlas.web';
import { paintPlanetDots } from '@/components/atmosphere/planetCanvasPaintDots.web';
import { snapCanvasBox, useCanvasBackingStoreRelease } from '@/components/ui/media/canvasBackingStore';
import { getMonoFont } from '@/constants/Typography';

/** Static artwork for the public SceneArt style, fullness and digits choices. */
export function SceneArtAuthoredPlanet({ options }: Readonly<{ options: PlanetSceneOptions }>) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const box = snapCanvasBox(options.view.w, options.view.h, dpr);
    const scene = React.useMemo(() => createPlanetScene({ ...options, dpr }), [dpr, options]);
    useCanvasBackingStoreRelease(ref, box.pixelWidth, box.pixelHeight);

    React.useLayoutEffect(() => {
        let active = true;
        async function draw() {
            const fonts = planetCanvasFonts();
            if (scene.cells.length) {
                const faces = [`12px ${fonts.regular}`, `600 12px ${fonts.semiBold}`];
                if (!faces.every(face => document.fonts.check(face))) await Promise.all(faces.map(face => document.fonts.load(face)));
            }
            const context = active ? ref.current?.getContext('2d') : null;
            if (!context) return;
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            paintSceneArtPlanet(context, scene, fonts);
        }
        void draw().catch(() => undefined);
        return () => { active = false; };
    }, [box.pixelHeight, box.pixelWidth, dpr, scene]);

    return <canvas ref={ref} width={box.pixelWidth} height={box.pixelHeight} aria-hidden
        style={{ width: box.width, height: box.height, pointerEvents: 'none', display: 'block', fontFamily: getMonoFont() }} />;
}

function paintSceneArtPlanet(context: CanvasRenderingContext2D, scene: PlanetScene, fonts: { regular: string; semiBold: string }) {
    const cells = (over: boolean) => {
        context.textAlign = 'center'; context.textBaseline = 'middle';
        for (const cell of scene.cells) {
            if (cell.over !== over) continue;
            context.font = `${over ? (cell.cut ? 700 : 600) : 400} ${cell.fs.toFixed(2)}px ${over ? fonts.semiBold : fonts.regular}`;
            context.globalCompositeOperation = over && !cell.cut ? 'source-atop' : 'source-over';
            context.fillStyle = `rgba(${cell.rgb.map(v => Math.round(v)).join(',')},${over ? Math.min(1, cell.a * (cell.cut ? 1.6 : 3.2)) : cell.a})`;
            context.fillText(cell.ch, cell.x, cell.y);
        }
        context.globalCompositeOperation = 'source-over';
    };
    paintPlanetDots(context, scene.body);
    cells(true);
    paintPlanetDots(context, scene.haze);
    cells(false);
}
