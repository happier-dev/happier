/**
 * Pure geometry for the model-mix stacked-share area chart (B-1). Maps a
 * `UsageModelMix` (per-bucket normalized shares, largest series first) to one
 * smooth CLOSED SVG fill path per series, stacked bottom-up so the whole stack
 * fills the box (100%-stacked). Kept separate from the component so the mapping
 * is unit-testable and the component stays declarative.
 *
 * Smoothing uses a Catmull-Rom → cubic-Bézier conversion with a low tension so
 * the bands read as fluid ribbons (the user disliked dot plots); a flat or
 * single-bucket series degrades to straight segments rather than throwing.
 */

import type { UsageModelMix } from '@/sync/api/account/usageAnalytics';

export interface StackedAreaBand {
    key: string;
    /** Ramp index (0 = largest series → full accent). */
    rampIndex: number;
    /** Closed SVG fill path (`M … C … L … C … Z`). */
    path: string;
}

export interface StackedAreaOptions {
    width: number;
    height: number;
    /** Vertical inset so the topmost band never clips at the top edge. */
    inset?: number;
    /** 0 = straight segments, 1 = full Catmull-Rom curvature. Default 0.85. */
    smoothing?: number;
}

interface Point {
    x: number;
    y: number;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Smooth open polyline through `points` as a Bézier chain starting at the first
 * point (the caller emits the leading `M`/`L`). Straight fallback when there are
 * fewer than three points or smoothing is off.
 */
function smoothSegments(points: readonly Point[], smoothing: number): string {
    if (points.length < 2) {
        return '';
    }
    if (points.length < 3 || smoothing <= 0) {
        return points.slice(1).map((p) => `L${round(p.x)} ${round(p.y)}`).join(' ');
    }
    const segments: string[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i - 1] ?? points[i]!;
        const p1 = points[i]!;
        const p2 = points[i + 1]!;
        const p3 = points[i + 2] ?? p2;
        const c1x = p1.x + ((p2.x - p0.x) / 6) * smoothing;
        const c1y = p1.y + ((p2.y - p0.y) / 6) * smoothing;
        const c2x = p2.x - ((p3.x - p1.x) / 6) * smoothing;
        const c2y = p2.y - ((p3.y - p1.y) / 6) * smoothing;
        segments.push(`C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2.x)} ${round(p2.y)}`);
    }
    return segments.join(' ');
}

/**
 * One closed fill path per series. Series are stacked bottom-up in `keys` order
 * (largest first sits at the bottom). Each band spans from the cumulative share
 * BELOW it (lower edge) to the cumulative share INCLUDING it (upper edge). A
 * share of 1 maps to the top of the box (y = inset); 0 maps to the baseline.
 */
export function buildStackedAreaBands(mix: UsageModelMix, options: StackedAreaOptions): StackedAreaBand[] {
    const { width, height } = options;
    const inset = options.inset ?? 1;
    const smoothing = options.smoothing ?? 0.85;
    const usableHeight = Math.max(0, height - inset * 2);
    const buckets = mix.buckets;
    const seriesCount = mix.keys.length;
    if (seriesCount === 0 || buckets.length === 0 || width <= 0 || usableHeight <= 0) {
        return [];
    }

    const stepX = buckets.length === 1 ? 0 : width / (buckets.length - 1);
    const xAt = (index: number): number => (buckets.length === 1 ? width / 2 : index * stepX);
    // Share (0..1) → y, higher share = higher on screen (smaller y).
    const yAt = (cumulativeShare: number): number => inset + (1 - cumulativeShare) * usableHeight;

    // Precompute cumulative shares below each series index, per bucket.
    const cumulativeBelow: number[][] = buckets.map((b) => {
        const out = new Array<number>(seriesCount + 1).fill(0);
        for (let s = 0; s < seriesCount; s += 1) {
            out[s + 1] = out[s]! + (b.shares[s] ?? 0);
        }
        return out;
    });

    const bands: StackedAreaBand[] = [];
    for (let s = 0; s < seriesCount; s += 1) {
        const upper: Point[] = buckets.map((_, i) => ({ x: xAt(i), y: yAt(cumulativeBelow[i]![s + 1]!) }));
        const lower: Point[] = buckets.map((_, i) => ({ x: xAt(i), y: yAt(cumulativeBelow[i]![s]!) }));
        const lowerReversed = [...lower].reverse();

        const topStart = upper[0]!;
        const upperCurve = smoothSegments(upper, smoothing);
        const bottomStart = lowerReversed[0]!;
        const lowerCurve = smoothSegments(lowerReversed, smoothing);
        const path = [
            `M${round(topStart.x)} ${round(topStart.y)}`,
            upperCurve,
            `L${round(bottomStart.x)} ${round(bottomStart.y)}`,
            lowerCurve,
            'Z',
        ].filter((segment) => segment.length > 0).join(' ');

        bands.push({ key: mix.keys[s]!.key, rampIndex: s, path });
    }
    return bands;
}
