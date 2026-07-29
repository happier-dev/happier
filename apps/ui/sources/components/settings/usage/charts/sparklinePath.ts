/**
 * Pure geometry for the mini sparklines (hero 40×14, per-leader 48×12). Maps a
 * token series to an SVG polyline path string that `DrawnLinePath` can draw in.
 * Kept separate from the component so the mapping is unit-testable and shared.
 */

export interface SparklinePathOptions {
    width: number;
    height: number;
    /** Vertical padding so the stroke never clips at the top/bottom edge. */
    inset?: number;
}

/**
 * Builds an SVG path (`M … L …`) for the series across the given box. A flat or
 * single-point series renders a centered horizontal line. Returns an empty
 * string for an empty series so the caller can skip rendering.
 */
export function buildSparklinePath(values: readonly number[], options: SparklinePathOptions): string {
    if (values.length === 0) {
        return '';
    }
    const inset = options.inset ?? 1.5;
    const usableHeight = Math.max(0, options.height - inset * 2);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const midY = inset + usableHeight / 2;

    if (values.length === 1 || span <= 0) {
        return `M0 ${round(midY)} L${round(options.width)} ${round(midY)}`;
    }

    const stepX = options.width / (values.length - 1);
    const points = values.map((value, index) => {
        const x = index * stepX;
        // Higher value → higher on screen → smaller y.
        const y = inset + (1 - (value - min) / span) * usableHeight;
        return `${round(x)} ${round(y)}`;
    });
    return `M${points[0]} L${points.slice(1).join(' L')}`;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
