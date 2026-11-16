import * as React from 'react';
import { atmosphereDigitLattice, atmosphereRipple, type AtmosphereGlyphAtlas } from '@happier-dev/brand/atmosphere';
import { backdropGlyphAtlas } from './backdropGlyphAtlas.web';
import { snapCanvasBox } from './planetCanvasScene';
import { useCanvasBackingStoreRelease } from '@/components/ui/media/canvasBackingStore';
import type { AtmosphereRippleHandle, AtmosphereRippleProps, AtmosphereRippleRing } from './atmosphereRipple.types';

export const ATMOSPHERE_RIPPLE_RING = true;

/** The typewriter digits the ring is set in, one atlas per glyph cell size (lab `Atmos.ripple`). */
const RIPPLE_DIGITS = '0123456789';
const atlases = new Map<string, Promise<AtmosphereGlyphAtlas>>();
function rippleGlyphs(cw: number, ch: number, dpr: number): Promise<AtmosphereGlyphAtlas> {
    const key = `${cw}x${ch}@${dpr}`;
    let atlas = atlases.get(key);
    if (!atlas) {
        atlas = backdropGlyphAtlas({ w: cw / dpr, h: ch / dpr, chars: RIPPLE_DIGITS }, dpr);
        atlases.set(key, atlas);
        atlas.catch(() => atlases.delete(key));
    }
    return atlas;
}

/**
 * The session-finished ring: the brand's `atmosphereRipple` on a transparent canvas over the planet,
 * in the planet's box. It is mounted only while a ripple plays and is painted frame by frame by the
 * moment's clock. Decorative: hidden from accessibility and never a target.
 */
export const AtmosphereRipple = React.forwardRef<AtmosphereRippleHandle, AtmosphereRippleProps>(function AtmosphereRipple(props, handle) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const box = snapCanvasBox(props.width, props.height, dpr);
    useCanvasBackingStoreRelease(ref, box.pixelWidth, box.pixelHeight);
    const atlas = React.useRef<AtmosphereGlyphAtlas | null>(null);
    const latest = React.useRef<AtmosphereRippleRing>(null);
    const { theme, page } = props;
    const paint = React.useCallback((ring: AtmosphereRippleRing) => {
        latest.current = ring;
        const context = ref.current?.getContext('2d');
        if (!context) return;
        if (!ring) {
            context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
            return;
        }
        if (!atlas.current) return;
        const frame = atmosphereRipple(ring.progress, {
            w: box.pixelWidth, h: box.pixelHeight, page, theme, glyphs: atlas.current, dpr, x: ring.x, y: ring.y,
        });
        context.putImageData(new ImageData(frame.rgba, frame.w, frame.h), 0, 0);
    }, [box.pixelHeight, box.pixelWidth, dpr, page, theme]);
    React.useEffect(() => {
        let live = true;
        const lattice = atmosphereDigitLattice(box.pixelWidth, box.pixelHeight, dpr);
        void rippleGlyphs(lattice.cw, lattice.ch, dpr).then((glyphs) => {
            if (!live) return;
            atlas.current = glyphs;
            paint(latest.current);
        });
        return () => { live = false; };
    }, [box.pixelHeight, box.pixelWidth, dpr, paint]);
    React.useImperativeHandle(handle, () => ({ paint }), [paint]);
    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'aria-hidden': true,
        style: { position: 'absolute', left: 0, top: 0, width: box.width, height: box.height, pointerEvents: 'none', display: 'block' },
    });
});
