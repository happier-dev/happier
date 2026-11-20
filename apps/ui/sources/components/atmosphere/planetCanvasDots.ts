import { createPlanetDots, type PlanetDotOptions, type PlanetRgb } from '@happier-dev/brand/planet';

export type PlanetMarkDot = Readonly<{ x: number; y: number; r: number; rgb: PlanetRgb; opacity: number }>;
export type PlanetCanvasMark = PlanetDotOptions & Readonly<{ radiusScale?: number; ink?: string; opacityScale?: number }>;

/** Consumers may rebuild equivalent mark options during a render. Retain their sampled lattice. */
export function createPlanetCanvasDotsCache() {
    let key: string | undefined;
    let dots: readonly PlanetMarkDot[] = [];
    return (mark: PlanetCanvasMark): readonly PlanetMarkDot[] => {
        const nextKey = JSON.stringify(mark);
        if (key !== nextKey) {
            dots = createPlanetDots(mark).map((dot) => ({
                x: dot.x,
                y: dot.y,
                r: dot.radius * (mark.radiusScale ?? 1),
                rgb: dot.rgb,
                opacity: dot.opacity * (mark.opacityScale ?? 1),
            }));
            key = nextKey;
        }
        return dots;
    };
}
