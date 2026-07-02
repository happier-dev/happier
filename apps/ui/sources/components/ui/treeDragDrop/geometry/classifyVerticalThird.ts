import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';

export type VerticalThird = 'top' | 'middle' | 'bottom';

/** Default share of the row height given to the centered "middle" band. */
export const DEFAULT_VERTICAL_NEST_RATIO = 1 / 3;

/**
 * Classifies a pointer into the top / middle / bottom band of a row.
 *
 * `nestRatio` is the fraction of the row height occupied by the centered
 * "middle" band; the two reorder edges split the remainder evenly. It defaults
 * to `1 / 3` (strict thirds). Callers widen it for rows that accept nesting so
 * the middle (nest) target stays forgiving on short rows — see
 * `resolveTreeInstruction`. The ratio is clamped into `[0, 1]` so out-of-range
 * inputs stay deterministic.
 */
export function classifyVerticalThird(
    bounds: WindowBounds,
    pointer: WindowPointer,
    nestRatio: number = DEFAULT_VERTICAL_NEST_RATIO,
): VerticalThird {
    const clampedNestRatio = Math.min(1, Math.max(0, nestRatio));
    const edgeRatio = (1 - clampedNestRatio) / 2;
    const topBoundary = bounds.y + bounds.height * edgeRatio;
    const bottomBoundary = bounds.y + bounds.height * (edgeRatio + clampedNestRatio);
    if (pointer.y < topBoundary) return 'top';
    if (pointer.y >= bottomBoundary) return 'bottom';
    return 'middle';
}
