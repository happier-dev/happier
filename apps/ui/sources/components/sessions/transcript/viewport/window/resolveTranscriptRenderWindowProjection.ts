import {
    orientTranscriptListItems,
    resolveEntrySliceSourceBounds,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import type { TranscriptLiveTailAnchorReason } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import { resolveTranscriptTargetWindowHostFacts } from './useTranscriptTargetWindowHostAdapter';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowState,
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

export type TranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem> = Readonly<{
    canonicalWindowedItems: readonly TItem[];
    displayItems: readonly TItem[];
    entrySlice: Readonly<{
        bounds: Readonly<{ start: number; end: number }> | null;
        items: readonly TItem[];
        withheldCount: number;
    }>;
    hotCold: Readonly<{
        active: boolean;
        coldCount: number;
        coldItems: readonly TItem[];
        hotCount: number;
        hotItems: readonly TItem[];
        hotItemsCanonical: readonly TItem[];
        nativeEdgeSlotItems: readonly TItem[];
        splitIndex: number;
        webFooterItems: readonly TItem[];
    }>;
    indexMap: Readonly<{
        displayIndexToSourceIndex: (displayIndex: number) => number | null;
        hasRenderedContentOutsideRecycler: boolean;
        hotEdgeSourceIndices: readonly number[];
        renderedToDisplayIndex: (renderedIndex: number) => number | null;
        renderedToSourceIndex: (renderedIndex: number) => number | null;
        sourceIndexToDisplayIndex: (sourceIndex: number) => number | null;
        sourceIndexToRenderedIndex: (sourceIndex: number) => number | null;
    }>;
    listData: readonly TItem[];
    liveTailAnchor: Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    nativeHotTailResetRequired: boolean;
    targetWindow: ReturnType<typeof resolveTranscriptTargetWindowHostFacts<TItem>>;
}>;

export function resolveTranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    activeThinkingMessageId: string | null;
    entrySliceWindow: Readonly<{ anchorRowId: string; sessionId: string }> | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    isSeqLoaded?: (seq: number) => boolean;
    items: readonly TItem[];
    listOrientation: TranscriptListOrientation;
    liveTailAnchorMessageId?: string | null;
    platformOS: string;
    resolveSeq?: (item: TItem) => number | null | undefined;
    resolveLiveTailAnchor?: (items: readonly TItem[]) => Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    sessionId: string;
    targetWindowState: TranscriptTargetWindowState;
    transcriptNativeHotTailItemCount: number;
    transcriptWebHotTailItemCount: number;
}>): TranscriptRenderWindowProjection<TItem> {
    const entrySliceBounds = resolveActiveEntrySliceBounds({
        entrySliceWindow: params.entrySliceWindow,
        items: params.items,
        orientation: params.listOrientation,
        platformOS: params.platformOS,
        sessionId: params.sessionId,
    });
    const entrySliceItems = entrySliceBounds
        ? params.items.slice(entrySliceBounds.start, entrySliceBounds.end)
        : params.items;
    const entrySliceWithheldCount = entrySliceBounds
        ? params.items.length - (entrySliceBounds.end - entrySliceBounds.start)
        : 0;

    const targetWindow = resolveTranscriptTargetWindowHostFacts({
        items: entrySliceItems,
        isSeqLoaded: params.isSeqLoaded,
        resolveSeq: params.resolveSeq,
        windowState: params.targetWindowState,
    });
    const canonicalWindowedItems = targetWindow.items;
    const displayItems = orientTranscriptListItems(canonicalWindowedItems, params.listOrientation);
    const liveTailAnchor = params.resolveLiveTailAnchor?.(canonicalWindowedItems) ?? null;
    const liveTailAnchorMessageId = liveTailAnchor?.messageId ?? params.liveTailAnchorMessageId ?? null;

    const platformIsWeb = params.platformOS === 'web';
    const hotTailItemCount = platformIsWeb
        ? params.transcriptWebHotTailItemCount
        : params.transcriptNativeHotTailItemCount;
    const hotColdEnabled = platformIsWeb || hotTailItemCount > 0;
    const rawSegments = buildTranscriptHotColdSegments({
        activeThinkingMessageId: params.activeThinkingMessageId,
        enabled: hotColdEnabled,
        expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
        hotTailItemCount: hotTailItemCount > 0 ? hotTailItemCount : 1,
        items: canonicalWindowedItems,
        liveTailAnchorMessageId,
        liveTailOnly: !platformIsWeb,
        maxHotTailItems: platformIsWeb ? undefined : (hotTailItemCount > 0 ? hotTailItemCount : 1),
    });
    const coldItems = orientTranscriptListItems(rawSegments.coldItems, params.listOrientation);
    const hotItems = orientTranscriptListItems(rawSegments.hotItems, params.listOrientation);
    const hotColdActive = rawSegments.hotItems.length > 0;
    const listData = hotColdActive ? coldItems : displayItems;
    const sourceIndexById = buildSourceIndexById(params.items);
    const displaySourceIndices = displayItems.map((item) => sourceIndexById.get(item.id) ?? null);
    const renderedSourceIndices = listData.map((item) => sourceIndexById.get(item.id) ?? null);
    const hotEdgeSourceIndices = !platformIsWeb && hotColdActive
        ? rawSegments.hotItems
            .map((item) => sourceIndexById.get(item.id) ?? null)
            .filter((index): index is number => index !== null)
        : [];
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

    return {
        canonicalWindowedItems,
        displayItems,
        entrySlice: {
            bounds: entrySliceBounds,
            items: entrySliceItems,
            withheldCount: entrySliceWithheldCount,
        },
        hotCold: {
            active: hotColdActive,
            coldCount: rawSegments.coldItems.length,
            coldItems,
            hotCount: rawSegments.hotItems.length,
            hotItems,
            hotItemsCanonical: rawSegments.hotItems,
            nativeEdgeSlotItems: !platformIsWeb && hotColdActive ? rawSegments.hotItems : [],
            splitIndex: rawSegments.splitIndex,
            webFooterItems: platformIsWeb && hotColdActive ? hotItems : [],
        },
        indexMap: {
            displayIndexToSourceIndex: (displayIndex) => readIndex(displaySourceIndices, displayIndex),
            hasRenderedContentOutsideRecycler: hotEdgeSourceIndices.length > 0,
            hotEdgeSourceIndices,
            renderedToDisplayIndex: (renderedIndex) => {
                const sourceIndex = readIndex(renderedSourceIndices, renderedIndex);
                return sourceIndex === null ? null : sourceToDisplayIndex.get(sourceIndex) ?? null;
            },
            renderedToSourceIndex: (renderedIndex) => readIndex(renderedSourceIndices, renderedIndex),
            sourceIndexToDisplayIndex: (sourceIndex) => sourceToDisplayIndex.get(sourceIndex) ?? null,
            sourceIndexToRenderedIndex: (sourceIndex) => sourceToRenderedIndex.get(sourceIndex) ?? null,
        },
        listData,
        liveTailAnchor,
        nativeHotTailResetRequired: params.platformOS !== 'web' && !hotColdActive,
        targetWindow,
    };
}

function resolveActiveEntrySliceBounds<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    entrySliceWindow: Readonly<{ anchorRowId: string; sessionId: string }> | null;
    items: readonly TItem[];
    orientation: TranscriptListOrientation;
    platformOS: string;
    sessionId: string;
}>): Readonly<{ start: number; end: number }> | null {
    if (params.platformOS === 'web') return null;
    if (!params.entrySliceWindow || params.entrySliceWindow.sessionId !== params.sessionId) return null;
    const anchorSourceIndex = params.items.findIndex((item) => item.id === params.entrySliceWindow?.anchorRowId);
    if (anchorSourceIndex < 0) return null;
    const bounds = resolveEntrySliceSourceBounds({
        anchorSourceIndex,
        count: params.items.length,
        orientation: params.orientation,
    });
    return bounds.end - bounds.start < params.items.length ? bounds : null;
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
