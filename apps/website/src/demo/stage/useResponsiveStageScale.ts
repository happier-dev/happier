import { useEffect, useState } from 'react';

/**
 * Computes a uniform scale factor so the cinematic stage's fixed-pixel
 * device positions still fit inside the page's actual viewport.
 *
 * The stage is authored at `intrinsicWidth × intrinsicHeight` (1180×660
 * for the hero). On viewports narrower than that, the inner device
 * positions overflow horizontally because they're absolute-positioned
 * in pixels. Wrapping the stage in `transform: scale(factor)` shrinks
 * the whole composition uniformly without rebuilding the geometry.
 *
 * The wrapper element should also reserve `intrinsicHeight * factor`
 * of vertical space so the page below doesn't collide with the
 * scaled-down stage's box.
 */
export function useResponsiveStageScale(opts: {
    intrinsicWidth: number;
    /** Optional max scale (e.g. 1 to never upscale on very wide screens). */
    maxScale?: number;
    /** Side margin to reserve, in CSS px. */
    horizontalMargin?: number;
}): number {
    const { intrinsicWidth, maxScale = 1, horizontalMargin = 16 } = opts;
    const [scale, setScale] = useState(maxScale);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        function compute() {
            const available = Math.max(
                0,
                window.innerWidth - horizontalMargin * 2,
            );
            const next = Math.min(maxScale, available / intrinsicWidth);
            setScale(Number.isFinite(next) && next > 0 ? next : maxScale);
        }
        compute();
        window.addEventListener('resize', compute);
        window.addEventListener('orientationchange', compute);
        return () => {
            window.removeEventListener('resize', compute);
            window.removeEventListener('orientationchange', compute);
        };
    }, [intrinsicWidth, maxScale, horizontalMargin]);

    return scale;
}
