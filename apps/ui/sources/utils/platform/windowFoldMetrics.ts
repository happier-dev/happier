export type WindowFoldRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type WindowFoldMetrics = Readonly<{
    width: number;
    height: number;
    hasFoldDivision: boolean;
    divisions: readonly WindowFoldRect[];
    verticalBarEdge: 'leading' | 'trailing' | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Native rectangles and window dimensions use window points, independent of safe-area insets. */
export function normalizeWindowFoldMetrics(
    value: unknown,
    previous: WindowFoldMetrics | null = null,
): WindowFoldMetrics | null {
    if (!isRecord(value)) return null;
    const { width, height } = value;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0 || !Array.isArray(value.divisions)) {
        return null;
    }
    const verticalBarEdge = value.verticalBarEdge === 'leading' || value.verticalBarEdge === 'trailing'
        ? value.verticalBarEdge
        : null;

    const divisions: WindowFoldRect[] = [];
    for (const rect of value.divisions) {
        if (!isRecord(rect)) return null;
        const { x, y, width: rectWidth, height: rectHeight } = rect;
        if (
            !isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(rectWidth) || !isFiniteNumber(rectHeight)
            || x < 0 || y < 0 || rectWidth < 0 || rectHeight < 0
            || (rectWidth === 0 && rectHeight === 0)
            || x + rectWidth > width || y + rectHeight > height
        ) return null;
        divisions.push({ x, y, width: rectWidth, height: rectHeight });
    }

    if (
        previous?.width === width && previous.height === height && previous.divisions.length === divisions.length
        && previous.verticalBarEdge === verticalBarEdge
        && divisions.every((rect, index) => {
            const last = previous.divisions[index];
            return rect.x === last.x && rect.y === last.y && rect.width === last.width && rect.height === last.height;
        })
    ) return previous;

    return { width, height, hasFoldDivision: divisions.length > 0, divisions, verticalBarEdge };
}
