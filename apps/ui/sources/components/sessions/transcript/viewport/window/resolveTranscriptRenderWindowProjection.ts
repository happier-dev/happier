import {
    orientTranscriptListItems,
    resolveEntrySliceSourceBounds,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import type { SessionMessagesTailBoundary } from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
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
        renderedToWindowContentIndex: (renderedIndex: number) => number | null;
        resolveRendererTargetForDisplayIndex: (displayIndex: number) => TranscriptRendererDataTarget | null;
        resolveRendererTargetForItemId: (itemId: string) => TranscriptRendererDataTarget | null;
        sourceIndexToDisplayIndex: (sourceIndex: number) => number | null;
        sourceIndexToRenderedIndex: (sourceIndex: number) => number | null;
        windowContentItemCount: number;
    }>;
    listData: readonly TItem[];
    liveTailAnchor: Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    nativeHotTailResetRequired: boolean;
    /** Diagnostic: true when this projection was derived from `previousProjection` by append-only extension instead of a full rebuild. */
    reusedAppendOnlyBaseline: boolean;
    targetWindow: ReturnType<typeof resolveTranscriptTargetWindowHostFacts<TItem>>;
}>;

/**
 * Internal, projection-keyed structures a later append-only call can extend instead of
 * rebuilding every full-transcript index. Web standard-order Legend lists keep
 * `displayItems === canonicalWindowedItems === listData` and one source order, so every index
 * below is a pure append of the previous call's entries.
 */
type AppendReuseInternals<TItem extends RenderWindowSegmentableItem> = Readonly<{
    items: readonly TItem[];
    listOrientation: TranscriptListOrientation;
    platformOS: string;
    rendererKind: 'flashList' | 'legendList';
    hadGaps: boolean;
    hadTailBoundary: boolean;
    displaySourceIndices: readonly (number | null)[];
    renderedIndexById: Map<string, number>;
    sourceIndexById: Map<string, number>;
    sourceItemById: Map<string, TItem>;
    sourceToDisplayIndex: Map<number, number>;
    sourceToRenderedIndex: Map<number, number>;
    displayItemIds: Set<string>;
}>;

const appendReuseByProjection = new WeakMap<object, AppendReuseInternals<never>>();

function registerAppendReuseInternals<TItem extends RenderWindowSegmentableItem>(
    projection: TranscriptRenderWindowProjection<TItem>,
    internals: AppendReuseInternals<TItem>,
): void {
    appendReuseByProjection.set(projection, internals as AppendReuseInternals<never>);
}

/** Whether `items` still carries every entry of `previousItems` at the same index (append-only). */
function isStrictPrefixByReference<TItem>(previousItems: readonly TItem[], items: readonly TItem[]): boolean {
    if (items.length < previousItems.length) return false;
    for (let index = 0; index < previousItems.length; index += 1) {
        if (items[index] !== previousItems[index]) return false;
    }
    return true;
}

export function resolveTranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    activeThinkingMessageId: string | null;
    createWindowGapItem: (gap: TranscriptWindowGapDescriptor) => TItem;
    entrySliceWindow: Readonly<{ anchorRowId: string; sessionId: string }> | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    isSeqLoaded?: (seq: number) => boolean;
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
    items: readonly TItem[];
    listOrientation: TranscriptListOrientation;
    liveTailAnchorMessageId?: string | null;
    platformOS: string;
    rendererKind: 'flashList' | 'legendList';
    resolveSeq?: (item: TItem) => number | null | undefined;
    resolveLiveTailAnchor?: (items: readonly TItem[]) => Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    sessionId: string;
    tailContiguousBoundary?: SessionMessagesTailBoundary | null;
    resolveMessageIds?: (item: TItem) => readonly string[];
    targetWindowState: TranscriptTargetWindowState;
    transcriptNativeHotTailItemCount: number;
    transcriptWebHotTailItemCount: number;
    /** Previous projection to extend when the change is append-only (streaming inserts). */
    previousProjection?: TranscriptRenderWindowProjection<TItem> | null;
}>): TranscriptRenderWindowProjection<TItem> {
    const appendReuse = resolveAppendReuseInternals(params);
    const extended = appendReuse ? tryBuildAppendExtendedProjection(params, appendReuse) : null;
    if (extended) {
        return extended;
    }
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
        isSeqRangeLoaded: params.isSeqRangeLoaded,
        resolveSeq: params.resolveSeq,
        tailContiguousBoundary: params.tailContiguousBoundary ?? null,
        resolveMessageIds: params.resolveMessageIds,
        windowState: params.targetWindowState,
    });
    const canonicalWindowedItems = [
        ...(targetWindow.gaps.older ? [params.createWindowGapItem(targetWindow.gaps.older)] : []),
        ...targetWindow.items,
        ...(targetWindow.gaps.newer ? [params.createWindowGapItem(targetWindow.gaps.newer)] : []),
    ];
    const displayItems = orientTranscriptListItems(canonicalWindowedItems, params.listOrientation);
    const liveTailAnchor = params.resolveLiveTailAnchor?.(canonicalWindowedItems) ?? null;
    const liveTailAnchorMessageId = liveTailAnchor?.messageId ?? params.liveTailAnchorMessageId ?? null;

    const platformIsWeb = params.platformOS === 'web';
    const hotTailItemCount = platformIsWeb
        ? params.transcriptWebHotTailItemCount
        : params.transcriptNativeHotTailItemCount;
    // Legend owns one chronological recycler data projection. Splitting live rows into an edge
    // slot/footer would put visible identities outside Legend MVCP and recreate the zero-cold
    // first-page ownership gap. The hot/cold carve is now strictly FlashList compatibility.
    // A gap is a first-class pagination boundary. Keeping it in the recycler is
    // what lets the existing reached-threshold geometry prefetch before the
    // boundary becomes visible; carving it into a FlashList edge slot would
    // split display and pagination truth.
    const hasWindowGap = targetWindow.gaps.older !== null || targetWindow.gaps.newer !== null;
    const hotColdEnabled =
        !hasWindowGap &&
        params.rendererKind === 'flashList' &&
        (platformIsWeb || hotTailItemCount > 0);
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
    const windowContentIndexById = new Map<string, number>();
    targetWindow.items.forEach((item, index) => {
        if (!windowContentIndexById.has(item.id)) windowContentIndexById.set(item.id, index);
    });
    const renderedWindowContentIndices = listData.map((item) => windowContentIndexById.get(item.id) ?? null);
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
        // Synthetic recycler rows (for example a gap marker) participate in
        // geometry only; they are never navigation/restore targets.
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

    const projection: TranscriptRenderWindowProjection<TItem> = {
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
        nativeHotTailResetRequired: params.platformOS !== 'web' && !hotColdActive,
        reusedAppendOnlyBaseline: false,
        targetWindow,
    };
    registerAppendReuseInternals(projection, {
        items: params.items,
        listOrientation: params.listOrientation,
        platformOS: params.platformOS,
        rendererKind: params.rendererKind,
        hadGaps: hasWindowGap,
        hadTailBoundary: params.tailContiguousBoundary != null,
        displaySourceIndices,
        renderedIndexById,
        sourceIndexById,
        sourceItemById,
        sourceToDisplayIndex,
        sourceToRenderedIndex,
        displayItemIds,
    });
    return projection;
}

/** Eligibility check for the append-only fast path; `null` means full rebuild. */
function resolveAppendReuseInternals<TItem extends RenderWindowSegmentableItem>(
    params: Readonly<Parameters<typeof resolveTranscriptRenderWindowProjection<TItem>>[0]>,
): AppendReuseInternals<TItem> | null {
    const previous = params.previousProjection;
    if (!previous) return null;
    const internals = appendReuseByProjection.get(previous) as AppendReuseInternals<TItem> | undefined;
    if (!internals) return null;
    // The fast path is the steady streaming shape only: web standard-order Legend list, no
    // target window, no gaps, no tail-discontinuity floor. Everything else keeps the exact
    // full-rebuild behavior (including every native path).
    if (params.platformOS !== 'web') return null;
    if (params.listOrientation !== 'standard') return null;
    if (params.rendererKind !== 'legendList') return null;
    if (internals.platformOS !== params.platformOS) return null;
    if (internals.listOrientation !== params.listOrientation) return null;
    if (internals.rendererKind !== params.rendererKind) return null;
    if (internals.hadGaps || params.targetWindowState.isWindowMode) return null;
    if (internals.hadTailBoundary || params.tailContiguousBoundary != null) return null;
    if (!isStrictPrefixByReference(internals.items, params.items)) return null;
    return internals;
}

/**
 * Append-only extension of a previous projection. Display order === source order on the web
 * standard orientation and `listData === displayItems` with the Legend renderer (no hot/cold
 * carve), so every index below extends the previous call's entries instead of rebuilding
 * full-transcript structures per streaming insert. First-wins duplicate-id semantics mirror the
 * full rebuild exactly. Returns `null` when the recomputed host facts violate the fast-path
 * shape (e.g. an unexpected gap), so the caller falls back to a full rebuild.
 */
function tryBuildAppendExtendedProjection<TItem extends RenderWindowSegmentableItem>(
    params: Readonly<Parameters<typeof resolveTranscriptRenderWindowProjection<TItem>>[0]>,
    internals: AppendReuseInternals<TItem>,
): TranscriptRenderWindowProjection<TItem> | null {
    const items = params.items;
    const targetWindow = resolveTranscriptTargetWindowHostFacts({
        items,
        isSeqLoaded: params.isSeqLoaded,
        isSeqRangeLoaded: params.isSeqRangeLoaded,
        resolveSeq: params.resolveSeq,
        tailContiguousBoundary: params.tailContiguousBoundary ?? null,
        resolveMessageIds: params.resolveMessageIds,
        windowState: params.targetWindowState,
    });
    if (targetWindow.gaps.older !== null || targetWindow.gaps.newer !== null) return null;
    if (targetWindow.items !== items) return null;

    const canonicalWindowedItems = items.slice();
    // Standard orientation returns the same reference; kept explicit for the invariant.
    const displayItems = orientTranscriptListItems(canonicalWindowedItems, params.listOrientation);
    const liveTailAnchor = params.resolveLiveTailAnchor?.(canonicalWindowedItems) ?? null;

    const previousItemCount = internals.items.length;
    // Mutate the shared index structures in place (additive-only): a Map copy re-hashes every
    // entry, which measured SLOWER than a full rebuild. Prefix entries never change, so older
    // projections sharing these maps only ever observe additions, and the has() first-wins
    // guards make repeated application (React StrictMode double-invoke) idempotent.
    const sourceIndexById = internals.sourceIndexById;
    const sourceItemById = internals.sourceItemById;
    const renderedIndexById = internals.renderedIndexById;
    const sourceToDisplayIndex = internals.sourceToDisplayIndex;
    const sourceToRenderedIndex = internals.sourceToRenderedIndex;
    const displayItemIds = internals.displayItemIds;
    const appendedDisplaySourceIndices: (number | null)[] = [];
    for (let sourceIndex = previousItemCount; sourceIndex < items.length; sourceIndex += 1) {
        const item = items[sourceIndex];
        if (!item) continue;
        // Mirrors the full rebuild's `displayItems.map(item => sourceIndexById.get(item.id) ?? null)`:
        // the mapped value is the FIRST occurrence index of the id, resolved before this row's own
        // entry is registered so an appended duplicate keeps pointing at the prefix original.
        const mappedSourceIndex = sourceIndexById.get(item.id) ?? sourceIndex;
        appendedDisplaySourceIndices.push(mappedSourceIndex);
        if (!sourceIndexById.has(item.id)) sourceIndexById.set(item.id, sourceIndex);
        if (!sourceItemById.has(item.id)) sourceItemById.set(item.id, item);
        if (!sourceToDisplayIndex.has(mappedSourceIndex)) sourceToDisplayIndex.set(mappedSourceIndex, sourceIndex);
        if (!sourceToRenderedIndex.has(mappedSourceIndex)) sourceToRenderedIndex.set(mappedSourceIndex, sourceIndex);
        if (!renderedIndexById.has(item.id)) renderedIndexById.set(item.id, sourceIndex);
        displayItemIds.add(item.id);
    }
    const displaySourceIndices = internals.displaySourceIndices.concat(appendedDisplaySourceIndices);
    const renderedSourceIndices = displaySourceIndices;
    const renderedWindowContentIndices = displaySourceIndices;
    const outsideDataFallbackIndex = items.length <= 0
        ? null
        : params.listOrientation === 'inverted'
            ? 0
            : items.length - 1;
    const resolveRendererTargetForItemId = (itemId: string): TranscriptRendererDataTarget | null => {
        const sourceItem = sourceItemById.get(itemId);
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

    const projection: TranscriptRenderWindowProjection<TItem> = {
        canonicalWindowedItems,
        displayItems,
        entrySlice: {
            bounds: null,
            items,
            withheldCount: 0,
        },
        hotCold: {
            active: false,
            coldCount: items.length,
            coldItems: canonicalWindowedItems,
            hotCount: 0,
            hotItems: [],
            hotItemsCanonical: [],
            nativeEdgeSlotItems: [],
            splitIndex: items.length,
            webFooterItems: [],
        },
        indexMap: {
            displayIndexToSourceIndex: (displayIndex) => readIndex(displaySourceIndices, displayIndex),
            hasRenderedContentOutsideRecycler: false,
            hotEdgeSourceIndices: [],
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
        listData: displayItems,
        liveTailAnchor,
        nativeHotTailResetRequired: false,
        reusedAppendOnlyBaseline: true,
        targetWindow,
    };
    registerAppendReuseInternals(projection, {
        items,
        listOrientation: params.listOrientation,
        platformOS: params.platformOS,
        rendererKind: params.rendererKind,
        hadGaps: false,
        hadTailBoundary: false,
        displaySourceIndices,
        renderedIndexById,
        sourceIndexById,
        sourceItemById,
        sourceToDisplayIndex,
        sourceToRenderedIndex,
        displayItemIds,
    });
    return projection;
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
