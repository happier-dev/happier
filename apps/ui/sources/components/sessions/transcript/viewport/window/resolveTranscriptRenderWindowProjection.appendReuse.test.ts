import { describe, expect, it } from 'vitest';

import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
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
    return { id: `row-${seq}`, kind: 'message', messageId: `msg-${seq}`, seq };
}

function gapItem(gap: TranscriptWindowGapDescriptor): TestItem {
    return { ...gap, kind: 'transcript-window-gap' };
}

function project(
    overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {},
) {
    return resolveTranscriptRenderWindowProjection<TestItem>({
        activeThinkingMessageId: null,
        createWindowGapItem: gapItem,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set(),
        items: [1, 2, 3].map(item),
        liveTailAnchorMessageId: null,
        listOrientation: 'standard' satisfies TranscriptListOrientation,
        platformOS: 'web',
        rendererKind: 'legendList',
        sessionId: 'session-1',
        targetWindowState: inactiveWindow,
        transcriptNativeHotTailItemCount: 0,
        transcriptWebHotTailItemCount: 0,
        ...overrides,
    });
}

/** Field-by-field comparison of two projections built for the same input. */
function expectProjectionsEqual(
    fast: ReturnType<typeof project>,
    fresh: ReturnType<typeof project>,
) {
    expect([...fast.displayItems.map((entry) => entry.id)]).toEqual([...fresh.displayItems.map((entry) => entry.id)]);
    expect([...fast.listData.map((entry) => entry.id)]).toEqual([...fresh.listData.map((entry) => entry.id)]);
    expect([...fast.canonicalWindowedItems.map((entry) => entry.id)]).toEqual([...fresh.canonicalWindowedItems.map((entry) => entry.id)]);
    expect(fast.entrySlice.bounds).toEqual(fresh.entrySlice.bounds);
    expect(fast.entrySlice.withheldCount).toBe(fresh.entrySlice.withheldCount);
    expect(fast.hotCold.active).toBe(fresh.hotCold.active);
    expect(fast.hotCold.coldCount).toBe(fresh.hotCold.coldCount);
    expect(fast.hotCold.splitIndex).toBe(fresh.hotCold.splitIndex);
    expect(fast.nativeHotTailResetRequired).toBe(fresh.nativeHotTailResetRequired);
    expect(fast.indexMap.windowContentItemCount).toBe(fresh.indexMap.windowContentItemCount);
    const count = fast.listData.length;
    for (let index = 0; index < count; index += 1) {
        expect(fast.indexMap.displayIndexToSourceIndex(index)).toBe(fresh.indexMap.displayIndexToSourceIndex(index));
        expect(fast.indexMap.renderedToSourceIndex(index)).toBe(fresh.indexMap.renderedToSourceIndex(index));
        expect(fast.indexMap.renderedToDisplayIndex(index)).toBe(fresh.indexMap.renderedToDisplayIndex(index));
        expect(fast.indexMap.renderedToWindowContentIndex(index)).toBe(fresh.indexMap.renderedToWindowContentIndex(index));
    }
    for (let sourceIndex = 0; sourceIndex < fast.canonicalWindowedItems.length; sourceIndex += 1) {
        expect(fast.indexMap.sourceIndexToDisplayIndex(sourceIndex)).toBe(fresh.indexMap.sourceIndexToDisplayIndex(sourceIndex));
        expect(fast.indexMap.sourceIndexToRenderedIndex(sourceIndex)).toBe(fresh.indexMap.sourceIndexToRenderedIndex(sourceIndex));
    }
    for (const entry of fast.canonicalWindowedItems) {
        expect(fast.indexMap.resolveRendererTargetForItemId(entry.id)).toEqual(fresh.indexMap.resolveRendererTargetForItemId(entry.id));
    }
}

describe('resolveTranscriptRenderWindowProjection append-only reuse', () => {
    it('reuses the previous projection for append-only inserts on web legend lists and produces identical output', () => {
        const baseItems = [1, 2, 3].map(item);
        const first = project({ items: baseItems });
        expect(first.reusedAppendOnlyBaseline).toBe(false);

        const appended = [...baseItems, item(4), item(5)];
        const fast = project({ items: appended, previousProjection: first });
        expect(fast.reusedAppendOnlyBaseline).toBe(true);

        const fresh = project({ items: appended });
        expectProjectionsEqual(fast, fresh);

        // Appended rows resolve through the index maps like any other row.
        expect(fast.indexMap.resolveRendererTargetForItemId('row-5')).toEqual({ kind: 'data', index: 4, itemId: 'row-5' });
        expect(fast.indexMap.sourceIndexToDisplayIndex(4)).toBe(4);
    });

    it('falls back to a full rebuild when the previous items are not a strict prefix', () => {
        const first = project({ items: [1, 2, 3].map(item) });
        // Middle replacement: not append-only.
        const edited = [item(1), { ...item(2), id: 'row-2-edited', messageId: 'msg-2-edited' }, item(3), item(4)];
        const rebuilt = project({ items: edited, previousProjection: first });
        expect(rebuilt.reusedAppendOnlyBaseline).toBe(false);
        expectProjectionsEqual(rebuilt, project({ items: edited }));
    });

    it('falls back while a target window is active or a tail boundary is present', () => {
        const first = project({ items: [1, 2, 3].map(item) });

        const windowed = project({
            items: [1, 2, 3, 4].map(item),
            previousProjection: first,
            targetWindowState: { ...inactiveWindow, isWindowMode: true, windowId: 'w', targetSeq: 2 },
        });
        expect(windowed.reusedAppendOnlyBaseline).toBe(false);

        const bounded = project({
            items: [1, 2, 3, 4].map(item),
            previousProjection: first,
            tailContiguousBoundary: { kind: 'seq', seq: 2 },
        });
        expect(bounded.reusedAppendOnlyBaseline).toBe(false);
    });

    it('preserves first-wins duplicate-id semantics for appended duplicates', () => {
        const first = project({ items: [1, 2, 3].map(item) });
        const duplicate = { ...item(1) } as TestItem;
        const fast = project({ items: [item(1), item(2), item(3), duplicate, item(4)], previousProjection: first });
        const fresh = project({ items: [item(1), item(2), item(3), duplicate, item(4)] });
        expectProjectionsEqual(fast, fresh);
    });
});
