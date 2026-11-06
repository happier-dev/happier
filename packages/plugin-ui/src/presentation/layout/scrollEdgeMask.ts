import type { HappierPortableStyle } from '../portableTypes.js';

export type ScrollEdgeVisibility = Readonly<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>;

type WebMaskStyle = HappierPortableStyle & Readonly<{
    maskImage: string;
    WebkitMaskImage: string;
}>;

type ResolveVerticalScrollEdgeMaskStyleOptions = Readonly<{
    fadeSize?: number;
}>;

export type ResolveHorizontalScrollEdgeMaskStyleOptions = ResolveVerticalScrollEdgeMaskStyleOptions & Readonly<{
    /** Clear up to `clearUntilPx`, solid from `solidFromPx`: the leading edge ends between two chips. */
    startClip?: Readonly<{ clearUntilPx: number; solidFromPx: number }>;
    /** Solid up to `solidUntilPx`, clear from `clearFromPx`: the trailing edge ends between two chips. */
    endClip?: Readonly<{ solidUntilPx: number; clearFromPx: number }>;
}>;

const DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE = 18;

export function resolveVerticalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveVerticalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    return resolveScrollEdgeMask('to bottom', visibility.top, visibility.bottom, options.fadeSize);
}

/** A mask stop measured from the leading edge, or (`fromEnd`) back from the trailing edge. */
export type ScrollEdgeMaskStop = number | Readonly<{ fromEnd: number }>;

/**
 * Where a horizontal rail's mask ramps from clear to solid at each scrolled edge: one geometry for the
 * web mask and the native mask, so both platforms show the same chips whole.
 */
export type HorizontalScrollEdgeMaskRamps = Readonly<{
    start: Readonly<{ clear: ScrollEdgeMaskStop; solid: ScrollEdgeMaskStop }> | null;
    end: Readonly<{ solid: ScrollEdgeMaskStop; clear: ScrollEdgeMaskStop }> | null;
}>;

export function resolveHorizontalScrollEdgeMaskRamps(
    visibility: ScrollEdgeVisibility,
    options: ResolveHorizontalScrollEdgeMaskStyleOptions = {},
): HorizontalScrollEdgeMaskRamps | null {
    if (!visibility.left && !visibility.right) return null;
    const fadeSize = Math.max(0, options.fadeSize ?? DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE);
    const startClip = visibility.left ? options.startClip : undefined;
    const endClip = visibility.right ? options.endClip : undefined;
    return {
        start: startClip
            ? { clear: startClip.clearUntilPx, solid: startClip.solidFromPx }
            : visibility.left ? { clear: 0, solid: fadeSize } : null,
        end: endClip
            ? { solid: endClip.solidUntilPx, clear: endClip.clearFromPx }
            : visibility.right ? { solid: { fromEnd: fadeSize }, clear: { fromEnd: 0 } } : null,
    };
}

/** A ramp stop in pixels from the leading edge of a rail `width` wide. */
export function resolveScrollEdgeMaskStopPx(stop: ScrollEdgeMaskStop, width: number): number {
    return typeof stop === 'number' ? stop : width - stop.fromEnd;
}

function cssStop(stop: ScrollEdgeMaskStop): string {
    if (typeof stop === 'number') return `${stop}px`;
    return stop.fromEnd === 0 ? '100%' : `calc(100% - ${stop.fromEnd}px)`;
}

/**
 * The same edge mask for a horizontal rail (a composer chip row). It fades the content itself, so it
 * reads on a translucent (glass) surface where a painted fade has no colour to paint. A rail of
 * discrete chips can instead end a visible edge between two chips (`startClip`/`endClip`), so the
 * chips it shows are whole.
 */
export function resolveHorizontalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveHorizontalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    const ramps = resolveHorizontalScrollEdgeMaskRamps(visibility, options);
    return resolveHorizontalScrollEdgeMaskRampsStyle(ramps);
}

export function resolveHorizontalScrollEdgeMaskRampsStyle(ramps: HorizontalScrollEdgeMaskRamps | null): WebMaskStyle | null {
    if (!ramps) return null;
    const start = ramps.start ? `transparent ${cssStop(ramps.start.clear)}, black ${cssStop(ramps.start.solid)}` : 'black 0px, black 0px';
    const end = ramps.end ? `black ${cssStop(ramps.end.solid)}, transparent ${cssStop(ramps.end.clear)}` : 'black 100%, black 100%';
    const maskImage = `linear-gradient(to right, ${start}, ${end})`;
    return { maskImage, WebkitMaskImage: maskImage };
}

function resolveScrollEdgeMask(
    direction: 'to bottom' | 'to right',
    startVisible: boolean,
    endVisible: boolean,
    fadeSizeInput: number | undefined,
): WebMaskStyle | null {
    if (!startVisible && !endVisible) {
        return null;
    }

    const fadeSize = Math.max(0, fadeSizeInput ?? DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE);
    const startFrom = startVisible ? 'transparent 0px' : 'black 0px';
    const startTo = startVisible ? `black ${fadeSize}px` : 'black 0px';
    const endFrom = endVisible ? `black calc(100% - ${fadeSize}px)` : 'black 100%';
    const endTo = endVisible ? 'transparent 100%' : 'black 100%';
    const maskImage = `linear-gradient(${direction}, ${startFrom}, ${startTo}, ${endFrom}, ${endTo})`;

    return {
        maskImage,
        WebkitMaskImage: maskImage,
    };
}
