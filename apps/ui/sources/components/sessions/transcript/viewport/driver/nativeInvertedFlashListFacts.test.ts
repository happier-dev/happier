import { describe, expect, it } from 'vitest';

import { createNativeInvertedFlashListFactSource } from './nativeInvertedFlashListFacts';
import {
    fromNativeInvertedCanonicalOffset,
    resolveNativeInvertedBottomCommandOffset,
    resolveNativeInvertedBottomRawOffset,
    toNativeInvertedCanonicalOffset,
} from './nativeInvertedRawScroll';

function factSource(state: {
    offset?: number;
    contentHeight?: number;
    layoutHeight?: number;
    visibleRange?: Readonly<{ startIndex: number; endIndex: number }> | null;
    firstVisibleIndex?: number | null;
    renderedItemCount?: number;
    sourceIndexForRenderedIndex?: (renderedIndex: number) => number | null;
}) {
    return createNativeInvertedFlashListFactSource({
        readRawScrollOffset: () => state.offset,
        readContentHeight: () => state.contentHeight ?? 0,
        readLayoutHeight: () => state.layoutHeight ?? 0,
        readRenderedVisibleRange: () => state.visibleRange,
        readFirstVisibleRenderedIndex: () => state.firstVisibleIndex,
        readRenderedItemCount: () => state.renderedItemCount ?? 0,
        readSourceIndexForRenderedIndex: (renderedIndex) =>
            state.sourceIndexForRenderedIndex?.(renderedIndex) ?? null,
    });
}

describe('createNativeInvertedFlashListFactSource — distanceFromLiveTail (C3 driver fact extraction)', () => {
    // The native fact source is native-only/inverted-only: 0 = pinned at the visual bottom, growing toward
    // older history. Web standard DOM identity is owned outside this native seam.

    it('inverted: raw offset 0 (visual bottom) → distance 0 (pinned)', () => {
        expect(factSource({ offset: 0, contentHeight: 2000, layoutHeight: 500 })
            .getDistanceFromLiveTail()).toBe(0);
    });

    it('inverted: raw offset N (scrolled toward older) → distance N', () => {
        expect(factSource({ offset: 300, contentHeight: 2000, layoutHeight: 500 })
            .getDistanceFromLiveTail()).toBe(300);
    });

    it('returns null when the raw offset is unavailable or non-finite', () => {
        expect(factSource({ offset: undefined, contentHeight: 2000, layoutHeight: 500 }).getDistanceFromLiveTail()).toBeNull();
        expect(factSource({ offset: Number.NaN, contentHeight: 2000, layoutHeight: 500 }).getDistanceFromLiveTail()).toBeNull();
    });

    it('returns null when layout height is zero/unmeasured', () => {
        expect(factSource({ offset: 0, contentHeight: 2000, layoutHeight: 0 }).getDistanceFromLiveTail()).toBeNull();
    });

    it('clamps a past-bottom (rubber-band/overscroll) raw offset to 0, never negative', () => {
        // inverted overscroll past the visual bottom would yield a negative raw offset → distance clamps to 0
        expect(factSource({ offset: -40, contentHeight: 2000, layoutHeight: 500 })
            .getDistanceFromLiveTail()).toBe(0);
    });

    it('override content/layout heights take precedence over the readers (mid content-size change)', () => {
        expect(factSource({ offset: 0, contentHeight: 9999, layoutHeight: 9999 })
            .getDistanceFromLiveTail({ contentHeight: 2000, layoutHeight: 500 })).toBe(0);
    });
});

describe('createNativeInvertedFlashListFactSource — toCanonicalOffset (C3 STEP A read side, native inverted mapping)', () => {
    it('inverted: mirrors the raw offset through the orientation seam (canonical = content - layout - raw)', () => {
        expect(factSource({}).toCanonicalOffset(300, { contentHeight: 2000, layoutHeight: 500 })).toBe(1200);
    });

    it('does not read the raw-offset reader — the raw is supplied by the caller (works even when the list offset is unavailable)', () => {
        expect(factSource({ offset: undefined }).toCanonicalOffset(900, { contentHeight: 2000, layoutHeight: 500 })).toBe(600);
    });

    it('falls back to the reader content/layout heights when no override is supplied', () => {
        expect(factSource({ contentHeight: 2000, layoutHeight: 500 }).toCanonicalOffset(300)).toBe(1200);
    });

    it('override content/layout heights take precedence over the readers', () => {
        expect(factSource({ contentHeight: 9999, layoutHeight: 9999 })
            .toCanonicalOffset(300, { contentHeight: 2000, layoutHeight: 500 })).toBe(1200);
    });
});

describe('createNativeInvertedFlashListFactSource — observedOffset (D9 native observed-offset owner)', () => {
    it('normalizes a raw native observation into canonical offset, live-tail distance, and raw-bottom state', () => {
        expect(factSource({})
            .resolveObservedOffset(300, { contentHeight: 2000, layoutHeight: 500 }))
            .toEqual({
                rawOffsetY: 300,
                canonicalOffsetY: 1200,
                distanceFromLiveTailPx: 300,
                isAtRawLiveTail: false,
            });

        expect(factSource({})
            .resolveObservedOffset(0, { contentHeight: 2000, layoutHeight: 500 }))
            .toEqual({
                rawOffsetY: 0,
                canonicalOffsetY: 1500,
                distanceFromLiveTailPx: 0,
                isAtRawLiveTail: true,
            });
    });

    it('uses override geometry and rejects unmeasured native observations', () => {
        expect(factSource({ contentHeight: 9999, layoutHeight: 9999 })
            .resolveObservedOffset(1, { contentHeight: 2000, layoutHeight: 500 }))
            .toMatchObject({
                canonicalOffsetY: 1499,
                distanceFromLiveTailPx: 1,
                isAtRawLiveTail: true,
            });

        expect(factSource({ contentHeight: 2000, layoutHeight: 0 })
            .resolveObservedOffset(1)).toBeNull();
        expect(factSource({})
            .resolveObservedOffset(Number.NaN, { contentHeight: 2000, layoutHeight: 500 })).toBeNull();
    });
});

describe('nativeInvertedRawScroll', () => {
    it('owns native inverted raw/canonical offset conversion and bottom raw targets', () => {
        const geometry = { contentHeight: 1000, layoutHeight: 400 };

        expect(toNativeInvertedCanonicalOffset({ rawOffsetY: 0, ...geometry })).toBe(600);
        expect(toNativeInvertedCanonicalOffset({ rawOffsetY: 600, ...geometry })).toBe(0);
        expect(toNativeInvertedCanonicalOffset({ rawOffsetY: -25, ...geometry })).toBe(625);
        expect(fromNativeInvertedCanonicalOffset({ canonicalOffsetY: 600, ...geometry })).toBe(0);
        expect(fromNativeInvertedCanonicalOffset({ canonicalOffsetY: 0, ...geometry })).toBe(600);
        expect(resolveNativeInvertedBottomRawOffset()).toBe(0);
        expect(resolveNativeInvertedBottomCommandOffset()).toBe(0);
    });
});

describe('createNativeInvertedFlashListFactSource — contentMetrics (C3c geometry fact)', () => {
    it('preserves measured content/layout geometry and scrollability without reading raw offsets', () => {
        expect(factSource({
            contentHeight: 2000.8,
            layoutHeight: 500.2,
            offset: undefined,
        }).getContentMetrics()).toEqual({
            contentHeight: 2000.8,
            layoutHeight: 500.2,
            scrollable: true,
        });
    });

    it('returns non-scrollable geometry when content fits inside the viewport', () => {
        expect(factSource({
            contentHeight: 480,
            layoutHeight: 500,
        }).getContentMetrics()).toEqual({
            contentHeight: 480,
            layoutHeight: 500,
            scrollable: false,
        });
    });

    it('returns null when measured layout geometry is unavailable', () => {
        expect(factSource({
            contentHeight: 2000,
            layoutHeight: 0,
        }).getContentMetrics()).toBeNull();
        expect(factSource({
            contentHeight: Number.NaN,
            layoutHeight: 500,
        }).getContentMetrics()).toBeNull();
    });

    it('override content/layout heights take precedence over the readers', () => {
        expect(factSource({
            contentHeight: 9999,
            layoutHeight: 9999,
        }).getContentMetrics({ contentHeight: 1200.9, layoutHeight: 400.4 })).toEqual({
            contentHeight: 1200.9,
            layoutHeight: 400.4,
            scrollable: true,
        });
    });
});

describe('createNativeInvertedFlashListFactSource — visibleSourceRange (C3c visible range fact)', () => {
    it('inverted: maps rendered newest-first indices to canonical oldest-first source indices', () => {
        expect(factSource({
            renderedItemCount: 10,
            visibleRange: { startIndex: 0, endIndex: 2 },
        }).getVisibleSourceRange()).toEqual({
            firstSourceIndex: 7,
            lastSourceIndex: 9,
        });
    });

    it('falls back to the first visible rendered index when computeVisibleIndices is unavailable', () => {
        expect(factSource({
            firstVisibleIndex: 3,
            renderedItemCount: 10,
            visibleRange: null,
        }).getVisibleSourceRange()).toEqual({
            firstSourceIndex: 6,
            lastSourceIndex: 6,
        });
    });

    it('returns null for unavailable, non-finite, or reversed rendered ranges', () => {
        expect(factSource({ renderedItemCount: 10 }).getVisibleSourceRange()).toBeNull();
        expect(factSource({
            renderedItemCount: 10,
            visibleRange: { startIndex: Number.NaN, endIndex: 2 },
        }).getVisibleSourceRange()).toBeNull();
        expect(factSource({
            renderedItemCount: 10,
            visibleRange: { startIndex: 4, endIndex: 2 },
        }).getVisibleSourceRange()).toBeNull();
    });

    it('prefers an explicit rendered-to-source remap for hot/cold or source-id slices', () => {
        const sourceIndexForRenderedIndex = (renderedIndex: number): number | null => {
            if (renderedIndex === 0) return 42;
            if (renderedIndex === 1) return 45;
            return null;
        };
        expect(factSource({
            renderedItemCount: 2,
            sourceIndexForRenderedIndex,
            visibleRange: { startIndex: 0, endIndex: 1 },
        }).getVisibleSourceRange()).toEqual({
            firstSourceIndex: 42,
            lastSourceIndex: 45,
        });
    });
});

describe('createNativeInvertedFlashListFactSource — reachedEdge (C3c pagination edge fact)', () => {
    it('inverted: rendered start is newer, rendered end is older', () => {
        const source = factSource({});

        expect(source.resolveReachedEdge('start')).toBe('newer');
        expect(source.resolveReachedEdge('end')).toBe('older');
    });
});
