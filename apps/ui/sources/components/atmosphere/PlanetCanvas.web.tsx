import * as React from 'react';
import { StyleSheet } from 'react-native';
import { getMonoFont, getHappierFontFamily, themeFontFamilyVariableName } from '@/constants/Typography';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';
import { paintPlanetScene } from './planetCanvasPaint.web';
import { orderedFade } from '@happier-dev/brand/atmosphere';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { usePlanetDigits } from './usePlanetDigits';

// Canvas text does not resolve CSS var() itself, so read the typography owner's variable.
export function planetCanvasFonts() {
    const family = (weight: 'regular' | 'semiBold') => {
        const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(themeFontFamilyVariableName('mono', weight)).trim();
        return value || `"${getHappierFontFamily('mono', weight)}", "IBM Plex Mono", ui-monospace, monospace`;
    };
    return { regular: family('regular'), semiBold: family('semiBold') };
}

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    return <PlanetDigits {...props} />;
});

/** Keep body/emboss/haze on a drawing layer; only restore and retype the glyph rows per tick. */
function PlanetDigits(input: PlanetCanvasProps) {
    const props = usePlanetDigits(input);
    const ref = React.useRef<HTMLCanvasElement>(null);
    const ready = React.useRef(props.onReady); ready.current = props.onReady;
    const failed = React.useRef(props.onError); failed.current = props.onError;
    const dpr = props.options?.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolveScene = React.useMemo(createPlanetCanvasSceneCache, []);
    const body = resolveScene(props, dpr, 'body');
    const digits = resolveScene(props, dpr, 'digits');
    const underlay = React.useRef<Promise<HTMLCanvasElement | null>>(Promise.resolve(null));
    const fadeFrom = props.fade?.from, fadeTo = props.fade?.to;
    const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
    const ink = props.mark?.ink ?? props.ink;
    const fadeRows = React.useCallback((context: CanvasRenderingContext2D, from: number, to: number) => {
        if (fadeFrom === undefined || fadeTo === undefined) return;
        const top = Math.max(from, 0, Math.floor(fadeFrom * dpr));
        if (top >= to) return;
        context.setTransform(1, 0, 0, 1, 0, 0);
        const image = context.getImageData(0, top, box.pixelWidth, to - top);
        const store = new Uint8ClampedArray(box.pixelWidth * box.pixelHeight * 4);
        store.set(image.data, top * box.pixelWidth * 4);
        orderedFade(store, box.pixelWidth, box.pixelHeight, fadeFrom, fadeTo, dpr);
        image.data.set(store.subarray(top * box.pixelWidth * 4, to * box.pixelWidth * 4));
        context.putImageData(image, 0, top);
    }, [box.pixelHeight, box.pixelWidth, dpr, fadeFrom, fadeTo]);
    React.useLayoutEffect(() => {
        let cancelled = false;
        underlay.current = (async () => {
            const fonts = planetCanvasFonts();
            // Loaded faces need no wait, so a moment's redraw (the ripple's gain) lands in its own frame.
            const faces = [`12px ${fonts.regular}`, `600 12px ${fonts.semiBold}`];
            if ((body.cells.length || digits.cells.length) && !faces.every(face => document.fonts.check(face))) await Promise.all(faces.map(face => document.fonts.load(face)));
            if (cancelled) return null;
            const layer = document.createElement('canvas');
            layer.width = box.pixelWidth; layer.height = box.pixelHeight;
            const layerContext = layer.getContext('2d');
            const context = ref.current?.getContext('2d');
            if (!context || !layerContext) return null;
            layerContext.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
            paintPlanetScene(layerContext, body, fonts, ink);
            context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
            context.drawImage(layer, 0, 0);
            fadeRows(context, 0, box.pixelHeight);
            return layer;
        })();
        return () => { cancelled = true; };
        // Digits do not affect the static drawing or its font faces.
    }, [body, box.pixelHeight, box.pixelWidth, dpr, fadeRows, ink, scale]);
    React.useLayoutEffect(() => {
        let cancelled = false;
        const draw = async () => {
            const layer = await underlay.current;
            if (cancelled || !layer) return;
            const context = ref.current?.getContext('2d');
            if (!context) return;
            const fonts = planetCanvasFonts();
            context.textAlign = 'center'; context.textBaseline = 'middle';
            let top = box.pixelHeight, bottom = 0;
            for (const cell of digits.cells) {
                context.font = `400 ${cell.fs.toFixed(2)}px ${fonts.regular}`;
                // Restore every possible glyph's bounds so a shorter replacement leaves no old ink.
                const metrics = context.measureText('0123456789');
                top = Math.min(top, Math.floor((cell.y - metrics.actualBoundingBoxAscent) * dpr * scale) - 1);
                bottom = Math.max(bottom, Math.ceil((cell.y + metrics.actualBoundingBoxDescent) * dpr * scale) + 1);
            }
            top = Math.max(0, top); bottom = Math.min(box.pixelHeight, bottom);
            if (bottom > top) {
                context.setTransform(1, 0, 0, 1, 0, 0);
                context.clearRect(0, top, box.pixelWidth, bottom - top);
                context.drawImage(layer, 0, top, box.pixelWidth, bottom - top, 0, top, box.pixelWidth, bottom - top);
                context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
                paintPlanetScene(context, digits, fonts);
                fadeRows(context, top, bottom);
            }
            ready.current?.();
        };
        void draw().catch(error => failed.current?.(error instanceof Error ? error : new Error(String(error))));
        return () => { cancelled = true; };
    }, [body, digits, box.pixelHeight, box.pixelWidth, dpr, fadeRows, ink, scale]);
    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'data-testid': props.testID, 'aria-hidden': true,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block', fontFamily: getMonoFont() },
    });
}
