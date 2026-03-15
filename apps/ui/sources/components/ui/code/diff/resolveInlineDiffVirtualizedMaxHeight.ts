export function resolveInlineDiffVirtualizedMaxHeight(windowHeight: number): number {
    const safeHeight = Number.isFinite(windowHeight) ? windowHeight : 0;
    return Math.max(240, Math.min(720, Math.floor(safeHeight * 0.55)));
}
