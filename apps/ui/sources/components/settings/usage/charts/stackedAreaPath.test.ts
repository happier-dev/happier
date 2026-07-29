import { describe, expect, it } from 'vitest';

import { buildStackedAreaBands } from './stackedAreaPath';
import type { UsageModelMix } from '@/sync/api/account/usageAnalytics';

function mix(shares: number[][]): UsageModelMix {
    const keys = (shares[0] ?? []).map((_, i) => ({ key: `k${i}`, label: `K${i}`, totalTokens: 1 }));
    return {
        keys,
        buckets: shares.map((s, i) => ({ startMs: i, endMs: i + 1, total: 1, shares: s })),
        total: keys.length,
        hasData: shares.length >= 2,
    };
}

describe('buildStackedAreaBands', () => {
    it('emits one closed fill path per series', () => {
        const bands = buildStackedAreaBands(mix([[0.6, 0.4], [0.5, 0.5], [0.7, 0.3]]), { width: 100, height: 60 });
        expect(bands).toHaveLength(2);
        for (const band of bands) {
            expect(band.path.startsWith('M')).toBe(true);
            expect(band.path.endsWith('Z')).toBe(true);
        }
        expect(bands.map((b) => b.rampIndex)).toEqual([0, 1]);
    });

    it('stacks the largest series at the bottom of the box (higher y) and fills to the top', () => {
        // Single full-share series → its band spans the whole usable height.
        const bands = buildStackedAreaBands(mix([[1], [1]]), { width: 100, height: 100, inset: 0 });
        expect(bands).toHaveLength(1);
        // Top edge at y≈0 (share 1), bottom edge at y≈100 (share 0).
        expect(bands[0]!.path).toContain('M0 0');
        expect(bands[0]!.path).toContain('L100 100');
    });

    it('degrades to straight segments for a two-bucket series without throwing', () => {
        const bands = buildStackedAreaBands(mix([[1], [1]]), { width: 50, height: 40, smoothing: 0.85 });
        expect(bands[0]!.path).toContain('L');
        expect(bands[0]!.path).not.toContain('C'); // <3 points → no curves
    });

    it('returns nothing for a degenerate box or empty mix', () => {
        expect(buildStackedAreaBands(mix([[1], [1]]), { width: 0, height: 40 })).toEqual([]);
        expect(buildStackedAreaBands({ keys: [], buckets: [], total: 0, hasData: false }, { width: 100, height: 40 })).toEqual([]);
    });
});
