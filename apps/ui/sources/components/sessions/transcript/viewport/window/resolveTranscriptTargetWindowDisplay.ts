import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowDisplayResult,
    TranscriptTargetWindowState,
} from './transcriptTargetWindowTypes';

type IndexedDisplayItem<TItem extends TranscriptTargetWindowDisplayItem> = Readonly<{
    item: TItem;
    index: number;
    seq: number;
}>;

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function isActiveWindowState(windowState: TranscriptTargetWindowState): windowState is TranscriptTargetWindowState & {
    isWindowMode: true;
    windowId: string;
    targetSeq: number;
    windowMinSeq: number;
    windowMaxSeq: number;
} {
    return windowState.isWindowMode
        && typeof windowState.windowId === 'string'
        && normalizeSeq(windowState.targetSeq) !== null
        && normalizeSeq(windowState.windowMinSeq) !== null
        && normalizeSeq(windowState.windowMaxSeq) !== null;
}

/** Bounded scan for absorbed-seq gap checks; larger gaps always break contiguity. */
const MAX_LOADED_GAP_SCAN = 512;

function buildLoadedGapCheck(
    isSeqLoaded?: (seq: number) => boolean,
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean,
): (fromExclusive: number, toExclusive: number) => boolean {
    return (fromExclusive, toExclusive) => {
        const gapSize = toExclusive - fromExclusive - 1;
        if (gapSize <= 0) return true;
        if (isSeqRangeLoaded?.(fromExclusive + 1, toExclusive - 1) === true) return true;
        if (!isSeqLoaded || gapSize > MAX_LOADED_GAP_SCAN) return false;
        for (let seq = fromExclusive + 1; seq < toExclusive; seq += 1) {
            if (!isSeqLoaded(seq)) return false;
        }
        return true;
    };
}

function buildContiguousGroups<TItem extends TranscriptTargetWindowDisplayItem>(
    indexedItems: readonly IndexedDisplayItem<TItem>[],
    isSeqLoaded?: (seq: number) => boolean,
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean,
): IndexedDisplayItem<TItem>[][] {
    const groups: IndexedDisplayItem<TItem>[][] = [];
    let current: IndexedDisplayItem<TItem>[] = [];
    let previousSeq: number | null = null;

    const gapIsFullyLoaded = buildLoadedGapCheck(isSeqLoaded, isSeqRangeLoaded);

    for (const indexedItem of indexedItems) {
        if (
            previousSeq == null ||
            // Decomposed item seqs are locally non-monotonic (a tool group anchors on its
            // FIRST call while neighboring units already covered later seqs), so backward
            // steps never break; only a genuine forward hole does. Item-seq gaps are NOT
            // content holes when every intermediate seq is loaded: tool-result/meta
            // messages render inside their owning row and never itemize.
            indexedItem.seq <= previousSeq + 1 ||
            gapIsFullyLoaded(previousSeq, indexedItem.seq)
        ) {
            current.push(indexedItem);
        } else {
            groups.push(current);
            current = [indexedItem];
        }
        previousSeq = previousSeq == null ? indexedItem.seq : Math.max(previousSeq, indexedItem.seq);
    }

    if (current.length > 0) groups.push(current);
    return groups;
}

export function resolveTranscriptTargetWindowDisplay<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    windowState: TranscriptTargetWindowState;
    resolveSeq?: (item: TItem) => number | null | undefined;
    isSeqLoaded?: (seq: number) => boolean;
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
}>): TranscriptTargetWindowDisplayResult<TItem> {
    if (!isActiveWindowState(params.windowState)) {
        return {
            mode: 'tail',
            items: params.items,
            windowId: null,
            targetSeq: null,
            targetPresent: null,
            omittedBeforeCount: 0,
            omittedAfterCount: 0,
        };
    }

    const minSeq = Math.min(params.windowState.windowMinSeq, params.windowState.windowMaxSeq);
    const maxSeq = Math.max(params.windowState.windowMinSeq, params.windowState.windowMaxSeq);
    const targetSeq = params.windowState.targetSeq;
    const indexedWindowItems: IndexedDisplayItem<TItem>[] = [];

    for (let index = 0; index < params.items.length; index++) {
        const item = params.items[index]!;
        const seq = normalizeSeq(params.resolveSeq ? params.resolveSeq(item) : item.seq);
        if (seq == null || seq < minSeq || seq > maxSeq) continue;
        indexedWindowItems.push({ item, index, seq });
    }

    const groups = buildContiguousGroups(indexedWindowItems, params.isSeqLoaded, params.isSeqRangeLoaded);
    // ABSORBED target seqs never itemize (tool-result/meta messages render inside their
    // owning row), so an exact seq match alone blanked a fully-loaded window: the target
    // group came back undefined and the transcript rendered items:[] (live S-H capture
    // 2026-07-11: target-window jump to an absorbed seq dropped 37 mounted rows to 0,
    // persistently). A group also owns the target when its seq span covers it, or when the
    // target sits just beyond a group edge with every intermediate seq loaded.
    const gapIsFullyLoaded = buildLoadedGapCheck(params.isSeqLoaded, params.isSeqRangeLoaded);
    const groupOwnsTarget = (group: readonly IndexedDisplayItem<TItem>[]): boolean => {
        if (group.length === 0) return false;
        if (group.some((entry) => entry.seq === targetSeq)) return true;
        let groupMinSeq = group[0]!.seq;
        let groupMaxSeq = group[0]!.seq;
        for (const entry of group) {
            if (entry.seq < groupMinSeq) groupMinSeq = entry.seq;
            if (entry.seq > groupMaxSeq) groupMaxSeq = entry.seq;
        }
        if (targetSeq >= groupMinSeq && targetSeq <= groupMaxSeq) return true;
        if (targetSeq > groupMaxSeq) return gapIsFullyLoaded(groupMaxSeq, targetSeq + 1);
        return gapIsFullyLoaded(targetSeq - 1, groupMinSeq);
    };
    const targetGroup = groups.find((group) => group.some((entry) => entry.seq === targetSeq))
        ?? groups.find(groupOwnsTarget);

    if (!targetGroup) {
        return {
            mode: 'window',
            items: [],
            windowId: params.windowState.windowId,
            targetSeq,
            targetPresent: false,
            omittedBeforeCount: params.items.length,
            omittedAfterCount: 0,
        };
    }

    const firstIndex = targetGroup[0]?.index ?? 0;
    const lastIndex = targetGroup[targetGroup.length - 1]?.index ?? -1;
    return {
        mode: 'window',
        items: targetGroup.map((entry) => entry.item),
        windowId: params.windowState.windowId,
        targetSeq,
        targetPresent: true,
        omittedBeforeCount: targetGroup.length > 0 ? firstIndex : params.items.length,
        omittedAfterCount: targetGroup.length > 0 ? params.items.length - lastIndex - 1 : 0,
    };
}
