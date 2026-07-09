type SegmentableTranscriptContentItem =
    | { kind: 'message'; messageId: string }
    | { kind: 'tool_calls'; toolMessageIds: readonly string[] }
    | { kind: string };

type SegmentableTranscriptListItem =
    | { kind: 'message'; id: string; messageId: string }
    | { kind: 'tool-calls-group'; id: string; toolMessageIds: readonly string[] }
    | { kind: 'tool-group-header' | 'tool-group-expand' | 'tool-group-tool' | 'tool-group-footer'; id: string; toolMessageIds: readonly string[] }
    | { kind: 'pending-queue'; id: string }
    | { kind: 'pending-user-action'; id: string }
    | { kind: 'action-draft'; id: string }
    | { kind: 'turn'; id: string; turn: { userMessageId?: string | null; content: readonly SegmentableTranscriptContentItem[] } }
    | { kind: string; id: string };

function isMessageContentItem(
    item: SegmentableTranscriptContentItem,
): item is Extract<SegmentableTranscriptContentItem, { kind: 'message' }> {
    return item.kind === 'message';
}

function isToolCallsContentItem(
    item: SegmentableTranscriptContentItem,
): item is Extract<SegmentableTranscriptContentItem, { kind: 'tool_calls' }> {
    return item.kind === 'tool_calls';
}

/**
 * Generous safety ceiling on the native live-tail carve (`liveTailOnly`). In normal streaming the
 * anchor is a RECENT row (a streaming message, a running tool, the thinking pulse, or the whole-turn
 * floor at the newest committed row), so the live region [anchor, end] is small and this never
 * engages. It only bounds a PATHOLOGICAL live region — e.g. a stale `streaming` flag left far up a
 * huge transcript by an interrupted turn — so the carve can never un-virtualize a huge tail in the
 * edge slot (the ~46-screen device-jank class). It is deliberately well above any real single turn's
 * row count, and only ever clips the OLDEST (settled) rows of the region; the newest growing rows —
 * always at the tail — stay hot.
 */
export const NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS = 48;

export function buildTranscriptHotColdSegments<T extends SegmentableTranscriptListItem>(params: Readonly<{
    enabled: boolean;
    hotTailItemCount: number;
    items: readonly T[];
    activeThinkingMessageId: string | null;
    liveTailAnchorMessageId?: string | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    /**
     * Hard ceiling on the number of hot-tail items, applied AFTER the active-item pullers.
     * The pullers (active thinking row, expanded tool groups, pending/draft, fork dividers) pull
     * the split earlier so those items render un-virtualized — correct for web (trailing-24 window,
     * web-virtualized cold side). On NATIVE the hot tail renders OUTSIDE the recycler in the edge
     * slot, so an early active item dragging the split toward index 0 un-virtualizes the whole
     * transcript (device-proven: ~46 screens → blank/jank). Native passes this cap so the hot tail
     * can never exceed the trailing window. Undefined = no cap (web behavior, unchanged).
     */
    maxHotTailItems?: number;
    /**
     * NATIVE live-tail mode. When true the hot tail is ONLY the actively-streaming live region —
     * the rows from the currently-streaming message (`liveTailAnchorMessageId`) to the end — and is
     * EMPTY whenever nothing is streaming. This is the correct shape for the native edge-slot carve,
     * whose sole job is to keep the per-token-growing row in real layout: when idle there is no
     * growing row, so carving anything just renders an orphaned/stale trailing block outside the
     * recycler. (Web does NOT set this — it keeps a trailing-N window so recent rows stay un-recycled
     * for smooth scrolling, and its hot tail lives in the in-flow footer, not a detached edge slot.)
     */
    liveTailOnly?: boolean;
}>): { coldItems: T[]; hotItems: T[]; splitIndex: number } {
    const items = Array.isArray(params.items) ? params.items : [];
    if (!params.enabled || items.length === 0) {
        return {
            coldItems: [...items],
            hotItems: [],
            splitIndex: items.length,
        };
    }

    if (items.length === 1) {
        return {
            coldItems: [...items],
            hotItems: [],
            splitIndex: 1,
        };
    }

    if (params.liveTailOnly === true) {
        // No carve unless a row is actively streaming. The live tail starts at the earliest item
        // tied to the streaming message and runs to the end; everything older (including completed
        // tool groups) stays in the recycler, so nothing orphans/persists at the bottom when idle.
        const liveTailAnchorMessageId = params.liveTailAnchorMessageId ?? params.activeThinkingMessageId;
        if (liveTailAnchorMessageId == null) {
            return { coldItems: [...items], hotItems: [], splitIndex: items.length };
        }
        let activeIndex = -1;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            if (item.kind === 'message') {
                if (item.messageId === liveTailAnchorMessageId) { activeIndex = index; break; }
                continue;
            }
            if (
                item.kind === 'tool-calls-group' ||
                item.kind === 'tool-group-header' ||
                item.kind === 'tool-group-expand' ||
                item.kind === 'tool-group-tool' ||
                item.kind === 'tool-group-footer'
            ) {
                if (item.toolMessageIds.some((id: string) => id === liveTailAnchorMessageId)) {
                    activeIndex = index;
                    break;
                }
                continue;
            }
            if (item.kind === 'turn') {
                const turn = item.turn;
                const turnHasActive =
                    (turn.userMessageId != null && turn.userMessageId === liveTailAnchorMessageId) ||
                    turn.content.some((c: SegmentableTranscriptContentItem) => {
                        if (isMessageContentItem(c)) return c.messageId === liveTailAnchorMessageId;
                        if (isToolCallsContentItem(c)) return c.toolMessageIds.some((id: string) => id === liveTailAnchorMessageId);
                        return false;
                    });
                if (turnHasActive) { activeIndex = index; break; }
            }
        }
        if (activeIndex < 0) {
            return { coldItems: [...items], hotItems: [], splitIndex: items.length };
        }
        // The live region [activeIndex, end] is the genuinely-active turn: the per-token-growing
        // row(s) — anchored at the first streaming/running/thinking/floor row — plus their trailing
        // pending/draft. It MUST stay hot in FULL so the growing tail flows in real layout. The
        // `maxHotTailItems` cap is NOT applied as a forward clip here: pushing the split PAST the
        // anchor (the old `Math.max(activeIndex, length - cap)`) dropped the earliest growing rows —
        // including the streaming anchor — into the cold recycler whenever the live region exceeded
        // the cap, re-exposing the exact overlap the carve exists to kill (R3). The newest growing
        // tail is therefore ALWAYS hot; only a PATHOLOGICAL live region (a stale anchor far up a huge
        // transcript) is bounded — by the safety ceiling, which clips only the OLDEST settled rows so
        // we never un-virtualize a huge tail. A user-raised `maxHotTailItems` above the ceiling
        // widens the bound to honor that explicit choice.
        let liveSplit = activeIndex;
        const configuredCap =
            typeof params.maxHotTailItems === 'number' && Number.isFinite(params.maxHotTailItems)
                ? Math.max(0, Math.trunc(params.maxHotTailItems))
                : 0;
        const safetyCeiling = Math.max(configuredCap, NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS);
        if (items.length - activeIndex > safetyCeiling) {
            liveSplit = items.length - safetyCeiling;
        }
        // FIX 3 (activeIndex==0): the anchor is the OLDEST matching row of the live region — i.e. the
        // first streaming / running / thinking / floor row — so the per-token-growing content starts
        // AT the anchor. When the anchor lands at index 0 the whole window is the live region and there
        // is no settled cold body below it. The never-empty-cold clamp would then force index 0 — the
        // growing anchor itself — into the cold recycler (the trailing pending/draft rows are static,
        // not growing, so the only growing row IS the index-0 anchor), re-exposing the exact overlap
        // the carve exists to kill. The carve only adds value when a genuine cold body precedes the
        // anchor (liveSplit > 0); when liveSplit would be 0 we do NOT carve and leave the growing row
        // in the recycler under C1's monotonic height floor. (A pathological huge window already gets a
        // positive liveSplit from the safety ceiling above, so it still carves with a non-empty cold.)
        if (liveSplit <= 0) {
            return { coldItems: [...items], hotItems: [], splitIndex: items.length };
        }
        liveSplit = Math.min(liveSplit, items.length - 1);
        return { coldItems: items.slice(0, liveSplit), hotItems: items.slice(liveSplit), splitIndex: liveSplit };
    }

    const normalizedHotTailItemCount =
        typeof params.hotTailItemCount === 'number' && Number.isFinite(params.hotTailItemCount)
            ? Math.max(1, Math.trunc(params.hotTailItemCount))
            : 1;
    const trailingHotStartIndex = Math.max(0, items.length - normalizedHotTailItemCount);
    let splitIndex = trailingHotStartIndex;

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === 'message') {
            if (item.messageId === params.activeThinkingMessageId) {
                splitIndex = Math.min(splitIndex, index);
            }
            continue;
        }

        if (item.kind === 'tool-calls-group') {
            if (item.toolMessageIds.some((id: string) => params.expandedToolCallsAnchorMessageIds.has(id))) {
                splitIndex = Math.min(splitIndex, index);
            }
            continue;
        }

        // Per-unit tool-group rows (N2c): every unit of an EXPANDED group joins the hot
        // tail, mirroring the whole-card tool-calls-group rule above.
        if (
            item.kind === 'tool-group-header' ||
            item.kind === 'tool-group-expand' ||
            item.kind === 'tool-group-tool' ||
            item.kind === 'tool-group-footer'
        ) {
            if (item.toolMessageIds.some((id: string) => params.expandedToolCallsAnchorMessageIds.has(id))) {
                splitIndex = Math.min(splitIndex, index);
            }
            continue;
        }

        if (item.kind === 'pending-queue' || item.kind === 'pending-user-action' || item.kind === 'action-draft') {
            splitIndex = Math.min(splitIndex, index);
            continue;
        }

        if (item.kind === 'fork-divider') {
            splitIndex = Math.min(splitIndex, index);
            continue;
        }

        if (item.kind === 'turn') {
            if (item.turn.userMessageId && item.turn.userMessageId === params.activeThinkingMessageId) {
                splitIndex = Math.min(splitIndex, index);
                continue;
            }

            const keepsTurnHot = item.turn.content.some((contentItem: SegmentableTranscriptContentItem) => {
                if (isMessageContentItem(contentItem)) {
                    return contentItem.messageId === params.activeThinkingMessageId;
                }
                if (isToolCallsContentItem(contentItem)) {
                    return contentItem.toolMessageIds.some((id: string) => params.expandedToolCallsAnchorMessageIds.has(id));
                }
                return false;
            });
            if (keepsTurnHot) {
                splitIndex = Math.min(splitIndex, index);
            }
        }
    }

    // Native hard ceiling (opt-in). The pullers above can drag the split toward index 0; on
    // native the hot tail renders un-virtualized in the inverted edge slot, so an early active
    // item would un-virtualize the whole transcript (device-proven: ~46 screens → blank/jank).
    // Cap the hot tail to the trailing window so the carve stays bounded to the live tail. The
    // newest (streaming) row is always within the trailing window, so the overlap fix is kept.
    // Undefined = web (no cap, pullers fully applied).
    if (typeof params.maxHotTailItems === 'number' && Number.isFinite(params.maxHotTailItems)) {
        const maxHot = Math.max(0, Math.trunc(params.maxHotTailItems));
        splitIndex = Math.max(splitIndex, items.length - maxHot);
    }

    // Ensure the cold segment is never empty. Keeping at least one cold item avoids rendering
    // the entire transcript in a footer-only block (which breaks index-based scroll operations).
    splitIndex = Math.max(1, Math.min(splitIndex, items.length - 1));

    return {
        coldItems: items.slice(0, splitIndex),
        hotItems: items.slice(splitIndex),
        splitIndex,
    };
}
