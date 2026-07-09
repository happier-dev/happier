import { describe, expect, it } from 'vitest';

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type { TranscriptTargetWindowState } from './transcriptTargetWindowTypes';

type TestItem = Readonly<{
    id: string;
    kind: 'message';
    messageId: string;
    seq: number;
}>;

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

function item(seq: number): TestItem {
    return {
        id: `row-${seq}`,
        kind: 'message',
        messageId: `msg-${seq}`,
        seq,
    };
}

function project(overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {}) {
    return resolveTranscriptRenderWindowProjection<TestItem>({
        activeThinkingMessageId: null,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set(),
        items: [1, 2, 3, 4, 5, 6].map(item),
        listOrientation: 'standard' satisfies TranscriptListOrientation,
        liveTailAnchorMessageId: null,
        platformOS: 'web',
        sessionId: 'session-1',
        targetWindowState: inactiveWindow,
        transcriptNativeHotTailItemCount: 0,
        transcriptWebHotTailItemCount: 0,
        ...overrides,
    });
}

describe('resolveTranscriptRenderWindowProjection', () => {
    it('composes entry slice, target window, orientation, and hot/cold carve into one projection', () => {
        const projection = project({
            entrySliceWindow: { anchorRowId: 'row-2', sessionId: 'session-1' },
            listOrientation: 'inverted',
            liveTailAnchorMessageId: 'msg-2',
            platformOS: 'ios',
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 2,
                windowId: 'window-2',
                windowMaxSeq: 2,
                windowMinSeq: 1,
            },
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.entrySlice.withheldCount).toBe(4);
        expect(projection.targetWindow.display?.items.map((entry) => entry.id)).toEqual(['row-1', 'row-2']);
        expect(projection.displayItems.map((entry) => entry.id)).toEqual(['row-2', 'row-1']);
        expect(projection.listData.map((entry) => entry.id)).toEqual(['row-1']);
        expect(projection.hotCold.hotItemsCanonical.map((entry) => entry.id)).toEqual(['row-2']);
        expect(projection.nativeHotTailResetRequired).toBe(false);
        expect(projection.indexMap.renderedToSourceIndex(0)).toBe(0);
        expect(projection.indexMap.renderedToDisplayIndex(0)).toBe(1);
        expect(projection.indexMap.sourceIndexToDisplayIndex(0)).toBe(1);
        expect(projection.indexMap.sourceIndexToRenderedIndex(1)).toBeNull();
        expect(projection.indexMap.hotEdgeSourceIndices).toEqual([1]);
    });

    it('reports native hot-tail reset as owner state instead of requiring render-phase ref mutation', () => {
        const projection = project({
            listOrientation: 'inverted',
            platformOS: 'ios',
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.hotCold.active).toBe(false);
        expect(projection.nativeHotTailResetRequired).toBe(true);
        expect(projection.listData.map((entry) => entry.id)).toEqual(['row-6', 'row-5', 'row-4', 'row-3', 'row-2', 'row-1']);
    });

    it('exposes native edge-slot rows as rendered content outside the recycler for blank classification', () => {
        const projection = project({
            listOrientation: 'inverted',
            liveTailAnchorMessageId: 'msg-5',
            platformOS: 'ios',
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.hotCold.nativeEdgeSlotItems.map((entry) => entry.id)).toEqual(['row-5', 'row-6']);
        expect(projection.indexMap.hasRenderedContentOutsideRecycler).toBe(true);
        expect(projection.indexMap.hotEdgeSourceIndices).toEqual([4, 5]);
    });
});
