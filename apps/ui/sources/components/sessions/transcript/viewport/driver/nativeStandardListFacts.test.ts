import { describe, expect, it } from 'vitest';

import { createNativeStandardListFactSource } from './nativeStandardListFacts';

function factSource(state: {
    offset?: number;
    contentHeight?: number;
    layoutHeight?: number;
    visibleRange?: Readonly<{ startIndex: number; endIndex: number }> | null;
    firstVisibleIndex?: number | null;
    renderedItemCount?: number;
    sourceIndexForRenderedIndex?: (renderedIndex: number) => number | null;
}) {
    return createNativeStandardListFactSource({
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

describe('createNativeStandardListFactSource', () => {
    it('standard: raw max offset is visual bottom and reads as distance 0', () => {
        expect(factSource({ offset: 1500, contentHeight: 2000, layoutHeight: 500 })
            .getDistanceFromLiveTail()).toBe(0);
    });

    it('standard: raw offset 0 is the oldest edge and reads as full distance from bottom', () => {
        expect(factSource({ offset: 0, contentHeight: 2000, layoutHeight: 500 })
            .getDistanceFromLiveTail()).toBe(1500);
    });

    it('normalizes standard raw observations without inverted mirroring', () => {
        expect(factSource({})
            .resolveObservedOffset(1500, { contentHeight: 2000, layoutHeight: 500 }))
            .toEqual({
                rawOffsetY: 1500,
                canonicalOffsetY: 1500,
                distanceFromLiveTailPx: 0,
                isAtRawLiveTail: true,
            });
    });

    it('maps standard rendered visible ranges and edges directly', () => {
        const source = factSource({
            renderedItemCount: 10,
            visibleRange: { startIndex: 2, endIndex: 4 },
        });

        expect(source.getVisibleSourceRange()).toEqual({
            firstSourceIndex: 2,
            lastSourceIndex: 4,
        });
        expect(source.resolveReachedEdge('start')).toBe('older');
        expect(source.resolveReachedEdge('end')).toBe('newer');
    });
});
