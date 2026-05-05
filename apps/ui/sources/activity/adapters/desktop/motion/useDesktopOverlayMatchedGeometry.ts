export type DesktopOverlayGeometryPoint = Readonly<{
    x: number;
    y: number;
    scale: number;
}>;

export type DesktopOverlayMatchedGeometryStyle = Readonly<{
    transform: readonly [
        Readonly<{ translateX: number }>,
        Readonly<{ translateY: number }>,
        Readonly<{ scale: number }>,
    ];
}>;

function clampProgress(progress: number): number {
    if (!Number.isFinite(progress)) return 0;
    return Math.min(1, Math.max(0, progress));
}

function interpolateNumber(from: number, to: number, progress: number): number {
    return from + (to - from) * progress;
}

export function resolveDesktopOverlayMatchedGeometryStyle(params: Readonly<{
    progress: number;
    reducedMotion?: boolean;
    collapsed: DesktopOverlayGeometryPoint;
    expanded: DesktopOverlayGeometryPoint;
}>): DesktopOverlayMatchedGeometryStyle {
    const progress = params.reducedMotion === true ? 1 : clampProgress(params.progress);

    return {
        transform: [
            { translateX: interpolateNumber(params.collapsed.x, params.expanded.x, progress) },
            { translateY: interpolateNumber(params.collapsed.y, params.expanded.y, progress) },
            { scale: interpolateNumber(params.collapsed.scale, params.expanded.scale, progress) },
        ],
    };
}
