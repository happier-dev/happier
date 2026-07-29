import {
    orientTranscriptListItems,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import type { TranscriptLiveTailAnchorReason } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import { resolveTranscriptTargetWindowHostFacts } from './useTranscriptTargetWindowHostAdapter';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
} from './transcriptTargetWindowTypes';

type RenderWindowSegmentableItem = TranscriptTargetWindowDisplayItem & {
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
    turn?: {
        userMessageId?: string | null;
        content: readonly (
            | { kind: 'message'; messageId: string }
            | { kind: 'tool_calls'; toolMessageIds: readonly string[] }
            | { kind: string }
        )[];
    };
};

export type TranscriptRendererDataTarget =
    | Readonly<{
        kind: 'data';
        index: number;
        itemId: string;
    }>
    | Readonly<{
        kind: 'outside-data';
        fallbackIndex: number | null;
        itemId: string;
        reason: 'projection-window' | 'renderer-edge';
        targetSeq: number | null;
    }>;

export type TranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem> = Readonly<{
    canonicalWindowedItems: readonly TItem[];
    displayItems: readonly TItem[];
    indexMap: Readonly<{
        displayIndexToSourceIndex: (displayIndex: number) => number | null;
        renderedToDisplayIndex: (renderedIndex: number) => number | null;
        renderedToSourceIndex: (renderedIndex: number) => number | null;
        renderedToWindowContentIndex: (renderedIndex: number) => number | null;
        resolveRendererTargetForDisplayIndex: (displayIndex: number) => TranscriptRendererDataTarget | null;
        resolveRendererTargetForItemId: (itemId: string) => TranscriptRendererDataTarget | null;
        sourceIndexToDisplayIndex: (sourceIndex: number) => number | null;
        sourceIndexToRenderedIndex: (sourceIndex: number) => number | null;
        windowContentItemCount: number;
    }>;
    listData: readonly TItem[];
    liveTailAnchor: Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    targetWindow: ReturnType<typeof resolveTranscriptTargetWindowHostFacts<TItem>>;
}>;

export function resolveTranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    createWindowGapItem: (gap: TranscriptWindowGapDescriptor) => TItem;
    isSeqLoaded?: (seq: number) => boolean;
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
    items: readonly TItem[];
    listOrientation: TranscriptListOrientation;
    resolveSeq?: (item: TItem) => number | null | undefined;
    resolveLiveTailAnchor?: (items: readonly TItem[]) => Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    sessionId: string;
    tailContiguousFloorSeq?: number | null;
    targetWindowState: TranscriptTargetWindowState;
}>): TranscriptRenderWindowProjection<TItem> {
    const targetWindow = resolveTranscriptTargetWindowHostFacts({
        items: params.items,
        isSeqLoaded: params.isSeqLoaded,
        isSeqRangeLoaded: params.isSeqRangeLoaded,
        resolveSeq: params.resolveSeq,
        tailContiguousFloorSeq: params.tailContiguousFloorSeq ?? null,
        windowState: params.targetWindowState,
    });
    const canonicalWindowedItems = [
        ...(targetWindow.gaps.older ? [params.createWindowGapItem(targetWindow.gaps.older)] : []),
        ...targetWindow.items,
        ...(targetWindow.gaps.newer ? [params.createWindowGapItem(targetWindow.gaps.newer)] : []),
    ];
    const displayItems = orientTranscriptListItems(canonicalWindowedItems, params.listOrientation);
    const liveTailAnchor = params.resolveLiveTailAnchor?.(canonicalWindowedItems) ?? null;

    // Legend owns one chronological recycler data projection: the rendered list IS the
    // display projection (the FlashList-era hot/cold carve is gone).
    const listData = displayItems;
    const sourceIndexById = buildSourceIndexById(params.items);
    const displaySourceIndices = displayItems.map((item) => sourceIndexById.get(item.id) ?? null);
    const renderedSourceIndices = listData.map((item) => sourceIndexById.get(item.id) ?? null);
    const windowContentIndexById = new Map<string, number>();
    targetWindow.items.forEach((item, index) => {
        if (!windowContentIndexById.has(item.id)) windowContentIndexById.set(item.id, index);
    });
    const renderedWindowContentIndices = listData.map((item) => windowContentIndexById.get(item.id) ?? null);
    const sourceToDisplayIndex = new Map<number, number>();
    displaySourceIndices.forEach((sourceIndex, displayIndex) => {
        if (sourceIndex !== null && !sourceToDisplayIndex.has(sourceIndex)) {
            sourceToDisplayIndex.set(sourceIndex, displayIndex);
        }
    });
    const sourceToRenderedIndex = new Map<number, number>();
    renderedSourceIndices.forEach((sourceIndex, renderedIndex) => {
        if (sourceIndex !== null && !sourceToRenderedIndex.has(sourceIndex)) {
            sourceToRenderedIndex.set(sourceIndex, renderedIndex);
        }
    });
    const renderedIndexById = new Map<string, number>();
    listData.forEach((item, renderedIndex) => {
        if (!renderedIndexById.has(item.id)) renderedIndexById.set(item.id, renderedIndex);
    });
    const sourceItemById = new Map<string, TItem>();
    for (const item of params.items) {
        if (!sourceItemById.has(item.id)) sourceItemById.set(item.id, item);
    }
    const displayItemIds = new Set(displayItems.map((item) => item.id));
    const outsideDataFallbackIndex = listData.length <= 0
        ? null
        : params.listOrientation === 'inverted'
            ? 0
            : listData.length - 1;
    const resolveRendererTargetForItemId = (itemId: string): TranscriptRendererDataTarget | null => {
        const sourceItem = sourceItemById.get(itemId);
        // Synthetic projection rows own geometry only. They are never eligible
        // as restore, anchor, or navigation targets.
        if (!sourceItem) return null;
        const renderedIndex = renderedIndexById.get(itemId);
        if (renderedIndex !== undefined) {
            return { kind: 'data', index: renderedIndex, itemId };
        }
        const rawTargetSeq = params.resolveSeq ? params.resolveSeq(sourceItem) : sourceItem.seq;
        const targetSeq = typeof rawTargetSeq === 'number' && Number.isFinite(rawTargetSeq) && rawTargetSeq >= 0
            ? Math.trunc(rawTargetSeq)
            : null;
        return {
            kind: 'outside-data',
            fallbackIndex: outsideDataFallbackIndex,
            itemId,
            reason: displayItemIds.has(itemId) ? 'renderer-edge' : 'projection-window',
            targetSeq,
        };
    };

    return {
        canonicalWindowedItems,
        displayItems,
        indexMap: {
            displayIndexToSourceIndex: (displayIndex) => readIndex(displaySourceIndices, displayIndex),
            renderedToDisplayIndex: (renderedIndex) => {
                const sourceIndex = readIndex(renderedSourceIndices, renderedIndex);
                return sourceIndex === null ? null : sourceToDisplayIndex.get(sourceIndex) ?? null;
            },
            renderedToSourceIndex: (renderedIndex) => readIndex(renderedSourceIndices, renderedIndex),
            renderedToWindowContentIndex: (renderedIndex) => readIndex(renderedWindowContentIndices, renderedIndex),
            resolveRendererTargetForDisplayIndex: (displayIndex) => {
                const normalized = Number.isInteger(displayIndex) ? displayIndex : -1;
                const item = normalized >= 0 ? displayItems[normalized] : undefined;
                return item ? resolveRendererTargetForItemId(item.id) : null;
            },
            resolveRendererTargetForItemId,
            sourceIndexToDisplayIndex: (sourceIndex) => sourceToDisplayIndex.get(sourceIndex) ?? null,
            sourceIndexToRenderedIndex: (sourceIndex) => sourceToRenderedIndex.get(sourceIndex) ?? null,
            windowContentItemCount: targetWindow.items.length,
        },
        listData,
        liveTailAnchor,
        targetWindow,
    };
}

function buildSourceIndexById<TItem extends { id: string }>(items: readonly TItem[]): Map<string, number> {
    const byId = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item && !byId.has(item.id)) byId.set(item.id, index);
    }
    return byId;
}

function readIndex(indices: readonly (number | null)[], index: number): number | null {
    const normalized = Number.isInteger(index) ? index : -1;
    if (normalized < 0 || normalized >= indices.length) return null;
    return indices[normalized] ?? null;
}
