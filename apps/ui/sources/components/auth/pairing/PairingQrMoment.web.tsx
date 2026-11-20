import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { pairingGlyphCell } from '@happier-dev/brand/planet-moments';

import { GlyphSurface } from '@/components/atmosphere/glyph/GlyphSurface.web';
import { loadMomentFonts, paintMomentCommands, prepareMomentCanvas } from '@/components/atmosphere/momentPaint.web';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { QrMomentScene } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import { usePairingGlyphScene } from './usePairingGlyphScene';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

let markImage: HTMLImageElement | null = null;
export function readPairingQrMomentMark(): HTMLImageElement | null {
    if (markImage || typeof Image === 'undefined') return markImage;
    const source = require('@/assets/images/logo-black.png') as unknown;
    const uri = typeof source === 'string' ? source : ((source as { uri?: string; default?: { uri?: string } | string })?.uri
        ?? ((source as { default?: { uri?: string } | string })?.default as { uri?: string } | undefined)?.uri
        ?? (typeof (source as { default?: unknown })?.default === 'string' ? (source as { default: string }).default : ''));
    markImage = new Image();
    markImage.src = uri;
    return markImage;
}

/** QR vectors and the shared planet keep the same stacking order throughout the fold. */
export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>) {
    const { size, theme, scene, reducedMotion } = props;
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const [fontsSettled, setFontsSettled] = React.useState(false);
    const { layers, motion, sampled } = usePairingGlyphScene(props, dpr, fontsSettled);
    const behind = React.useRef<HTMLCanvasElement>(null);
    const ahead = React.useRef<HTMLCanvasElement>(null);
    const previous = React.useRef<HTMLCanvasElement>(null);
    const snapshot = React.useRef<{ canvas: HTMLCanvasElement; scene: QrMomentScene } | null>(null);
    React.useEffect(() => {
        let active = true;
        const settle = () => { if (active) setFontsSettled(true); };
        void loadMomentFonts().then(settle, settle);
        return () => { active = false; };
    }, []);
    React.useLayoutEffect(() => {
        const canvases = [behind.current, ahead.current, previous.current];
        return () => { for (const canvas of canvases) releaseCanvasBackingStore(canvas); };
    }, []);
    React.useEffect(() => () => {
        releaseCanvasBackingStore(snapshot.current?.canvas);
        snapshot.current = null;
    }, [dpr, reducedMotion, size]);
    const onWebPaint = React.useCallback((pixels: HTMLCanvasElement | null) => {
        const frame = sampled.current?.frame;
        const background = behind.current;
        const foreground = ahead.current;
        if (!frame || !background || !foreground) return;
        const env = { w: size, h: size, dpr, mark: readPairingQrMomentMark() };
        const back = prepareMomentCanvas(background, size, size, dpr);
        if (back) paintMomentCommands(back, frame.behind, env);
        const front = prepareMomentCanvas(foreground, size, size, dpr);
        if (front) paintMomentCommands(front, frame.ahead, env);
        if (pixels) pixels.style.opacity = String(frame.planet?.opacity ?? 0);
        if (!reducedMotion || !previous.current) return;
        const held = snapshot.current;
        if (held && held.scene !== scene) {
            const overlay = previous.current;
            const fade = prepareMomentCanvas(overlay, size, size, dpr);
            if (fade) {
                fade.setTransform(1, 0, 0, 1, 0, 0);
                fade.drawImage(held.canvas, 0, 0);
                overlay.style.transition = 'none';
                overlay.style.opacity = '1';
                void overlay.offsetWidth;
                overlay.style.transition = `opacity ${motionTokens.atmosphere.reducedCrossFadeMs}ms ease-out`;
                overlay.style.opacity = '0';
            }
        }
        // A WebGL frame can be copied only in its paint turn. Retain pixels only for reduced-motion fades.
        const saved = held?.canvas ?? document.createElement('canvas');
        snapshot.current = { canvas: saved, scene };
        const ctx = prepareMomentCanvas(saved, size, size, dpr);
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(background, 0, 0);
        if (pixels && frame.planet) {
            ctx.globalAlpha = frame.planet.opacity;
            ctx.drawImage(pixels, 0, 0);
            ctx.globalAlpha = 1;
        }
        ctx.drawImage(foreground, 0, 0);
    }, [dpr, reducedMotion, sampled, scene, size]);
    const canvasStyle: React.CSSProperties = { position: 'absolute', inset: 0, width: size, height: size };
    return <View pointerEvents="none" style={{ width: size, height: size }}>
        <canvas ref={behind} aria-hidden style={canvasStyle} />
        <GlyphSurface width={size} height={size} scene={layers} motion={motion} theme={theme} cell={pairingGlyphCell}
            style={StyleSheet.absoluteFillObject} onWebPaint={onWebPaint} />
        <canvas ref={ahead} aria-hidden style={canvasStyle} />
        <canvas ref={previous} aria-hidden style={{ ...canvasStyle, opacity: 0 }} />
    </View>;
});
