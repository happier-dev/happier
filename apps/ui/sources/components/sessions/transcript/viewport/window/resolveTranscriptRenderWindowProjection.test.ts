import { describe, expect, it } from 'vitest';

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import {
    resolveItemsToNewerEdge,
    resolveItemsToOlderEdge,
} from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import { createNativeStandardListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeStandardListFacts';
import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type {
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
    TranscriptWindowGapItem,
} from './transcriptTargetWindowTypes';

type TestMessageItem = Readonly<{
    id: string;
    kind: 'message';
    messageId: string;
    seq: number;
}>;
type TestItem = TestMessageItem | TranscriptWindowGapItem;

const inactiveWindow: TranscriptTargetWindowState = {
    activatedAtMs: null,
    hasMoreNewer: null,
    hasMoreOlder: null,
    isWindowMode: false,
    newerCursor: null,
    olderCursor: null,
    targetSeq: null,
    windowId: null,
    windowMaxSeq: null,
    windowMinSeq: null,
};

function item(seq: number): TestMessageItem {
    return {
        id: `row-${seq}`,
        kind: 'message',
        messageId: `msg-${seq}`,
        seq,
    };
}

function gapItem(gap: TranscriptWindowGapDescriptor): TranscriptWindowGapItem {
    return { ...gap, kind: 'transcript-window-gap' };
}

function project(overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {}) {
    return resolveTranscriptRenderWindowProjection<TestItem>({
        createWindowGapItem: gapItem,
        items: [1, 2, 3, 4, 5, 6].map(item),
        listOrientation: 'standard' satisfies TranscriptListOrientation,
        sessionId: 'session-1',
        targetWindowState: inactiveWindow,
        ...overrides,
    });
}

describe('resolveTranscriptRenderWindowProjection', () => {
    it('keeps every row in one chronological renderer data projection', () => {
        const projection = project();

        expect(projection.listData.map((entry) => entry.id)).toEqual([
            'row-1',
            'row-2',
            'row-3',
            'row-4',
            'row-5',
            'row-6',
        ]);
        expect(projection.listData).toBe(projection.displayItems);
        expect(projection.indexMap.resolveRendererTargetForDisplayIndex(4)).toEqual({
            kind: 'data',
            index: 4,
            itemId: 'row-5',
        });
    });

    it('keeps loaded identities outside an active target window as materializable renderer targets', () => {
        const projection = project({
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 5,
                windowId: 'window-5',
                windowMaxSeq: 6,
                windowMinSeq: 5,
            },
        });

        expect(projection.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-5:older',
            'row-5',
            'row-6',
        ]);
        expect(projection.indexMap.renderedToWindowContentIndex(0)).toBeNull();
        expect(projection.indexMap.renderedToWindowContentIndex(1)).toBe(0);
        expect(projection.indexMap.resolveRendererTargetForItemId(
            'transcript-window-gap:window-5:older',
        )).toBeNull();
        expect(projection.indexMap.resolveRendererTargetForItemId('row-2')).toEqual({
            fallbackIndex: 2,
            itemId: 'row-2',
            kind: 'outside-data',
            reason: 'projection-window',
            targetSeq: 2,
        });
    });

    it('composes bidirectional gap rows with projection-relative native edge distances in both orientations', () => {
        const standardProjection = project({
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 3,
                windowId: 'window-3',
                windowMaxSeq: 4,
                windowMinSeq: 2,
            },
        });
        expect(standardProjection.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-3:older',
            'row-2',
            'row-3',
            'row-4',
            'transcript-window-gap:window-3:newer',
        ]);
        expect(standardProjection.listData.map((_entry, index) => (
            standardProjection.indexMap.renderedToWindowContentIndex(index)
        ))).toEqual([null, 0, 1, 2, null]);
        expect(standardProjection.indexMap.windowContentItemCount).toBe(3);

        const standardVisibleRange = {
            current: { startIndex: 0, endIndex: 1 },
        };
        const standardFacts = createNativeStandardListFactSource({
            readContentHeight: () => 1_000,
            readLayoutHeight: () => 400,
            readRawScrollOffset: () => 0,
            readRenderedItemCount: () => standardProjection.listData.length,
            readRenderedVisibleRange: () => standardVisibleRange.current,
            readSourceIndexForRenderedIndex: standardProjection.indexMap.renderedToWindowContentIndex,
        });
        const standardOlderRange = standardFacts.getVisibleSourceRange();
        expect(standardOlderRange).toEqual({ firstSourceIndex: 0, lastSourceIndex: 0 });
        expect(resolveItemsToOlderEdge(
            standardOlderRange,
            standardProjection.indexMap.windowContentItemCount,
        )).toBe(0);
        standardVisibleRange.current = { startIndex: 3, endIndex: 4 };
        const standardNewerRange = standardFacts.getVisibleSourceRange();
        expect(standardNewerRange).toEqual({ firstSourceIndex: 2, lastSourceIndex: 2 });
        expect(resolveItemsToNewerEdge(
            standardNewerRange,
            standardProjection.indexMap.windowContentItemCount,
        )).toBe(0);

        const invertedProjection = project({
            listOrientation: 'inverted',
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 3,
                windowId: 'window-3',
                windowMaxSeq: 4,
                windowMinSeq: 2,
            },
        });
        expect(invertedProjection.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-3:newer',
            'row-4',
            'row-3',
            'row-2',
            'transcript-window-gap:window-3:older',
        ]);
        expect(invertedProjection.listData.map((_entry, index) => (
            invertedProjection.indexMap.renderedToWindowContentIndex(index)
        ))).toEqual([null, 2, 1, 0, null]);
        expect(invertedProjection.indexMap.windowContentItemCount).toBe(3);

        const invertedVisibleRange = {
            current: { startIndex: 3, endIndex: 4 },
        };
        const invertedFacts = createNativeStandardListFactSource({
            readContentHeight: () => 1_000,
            readLayoutHeight: () => 400,
            readRawScrollOffset: () => 0,
            readRenderedItemCount: () => invertedProjection.listData.length,
            readRenderedVisibleRange: () => invertedVisibleRange.current,
            readSourceIndexForRenderedIndex: invertedProjection.indexMap.renderedToWindowContentIndex,
        });
        const invertedOlderRange = invertedFacts.getVisibleSourceRange();
        expect(invertedOlderRange).toEqual({ firstSourceIndex: 0, lastSourceIndex: 0 });
        expect(resolveItemsToOlderEdge(
            invertedOlderRange,
            invertedProjection.indexMap.windowContentItemCount,
        )).toBe(0);
        invertedVisibleRange.current = { startIndex: 0, endIndex: 1 };
        const invertedNewerRange = invertedFacts.getVisibleSourceRange();
        expect(invertedNewerRange).toEqual({ firstSourceIndex: 2, lastSourceIndex: 2 });
        expect(resolveItemsToNewerEdge(
            invertedNewerRange,
            invertedProjection.indexMap.windowContentItemCount,
        )).toBe(0);
    });
});
