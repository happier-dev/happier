export type ViewportClass = 'compact' | 'medium' | 'expanded' | 'wide';

export const VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX = Object.freeze({
    tabletMin: 600,
    expandedMin: 840,
    wideMin: 1200,
});

export const CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS = Object.freeze({
    compact: 800,
    medium: 960,
    expanded: 1200,
    wide: 1400,
} satisfies Record<ViewportClass, number>);

export function resolveViewportMinEdgePx(params: Readonly<{ width: number; height: number }>): number {
    const width = Number(params.width);
    const height = Number(params.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
    return Math.min(Math.abs(width), Math.abs(height));
}

export function resolveViewportClass(params: Readonly<{ width: number; height: number }>): ViewportClass {
    const minEdge = resolveViewportMinEdgePx(params);
    if (minEdge >= VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.wideMin) return 'wide';
    if (minEdge >= VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.expandedMin) return 'expanded';
    if (minEdge >= VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin) return 'medium';
    return 'compact';
}
