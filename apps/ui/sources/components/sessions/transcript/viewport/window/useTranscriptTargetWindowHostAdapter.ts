import * as React from 'react';

import { applyTranscriptJumpResult } from '../jump/applyTranscriptJumpResult';
import { resolveTranscriptJumpStrategy } from '../jump/resolveTranscriptJumpStrategy';
import type {
    TranscriptJumpResult,
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
    TranscriptJumpTargetRole,
} from '../jump/transcriptJumpTargetTypes';
import { resolveTargetWindowAlignmentCommand } from '../driver/targetWindowAlignmentCommand';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationJumpRequest,
} from '../../navigation/transcriptNavigationTypes';
import type { TranscriptViewportJumpAlignment } from '../transcriptViewportTypes';
import type { WebTranscriptScrollMetrics } from '../../webTranscriptScrollMetrics';
import { resolveTranscriptTargetWindowDisplay } from './resolveTranscriptTargetWindowDisplay';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowDisplayResult,
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
} from './transcriptTargetWindowTypes';

export type TranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem> = Readonly<{
    activeWindowState: TranscriptTargetWindowState | null;
    display: TranscriptTargetWindowDisplayResult<TItem> | null;
    gaps: Readonly<{
        newer: TranscriptWindowGapDescriptor | null;
        older: TranscriptWindowGapDescriptor | null;
    }>;
    hasMoreNewer: boolean;
    items: readonly TItem[];
    targetWindowActive: boolean;
}>;

function createWindowGapDescriptor(params: Readonly<{
    direction: 'older' | 'newer';
    windowId: string;
}>): TranscriptWindowGapDescriptor {
    return {
        direction: params.direction,
        id: `transcript-window-gap:${params.windowId}:${params.direction}`,
    };
}

/**
 * Whether the window display left out a loaded MESSAGE row on the given side of the presented
 * run. Seqless synthetic chrome is deliberately not counted: omitting it does not mean earlier
 * or later messages exist, and a gap row claiming so would be a false affordance.
 *
 * Scanning only the two sides is sufficient because the presented run is a contiguous source
 * span (`resolveTranscriptTargetWindowDisplay`) — nothing can be omitted from its middle.
 */
function hasOmittedSequenceItem<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    direction: 'older' | 'newer';
    displayItems: readonly TItem[];
    items: readonly TItem[];
    resolveSeq?: (item: TItem) => number | null | undefined;
}>): boolean {
    const firstDisplayedId = params.displayItems[0]?.id;
    const lastDisplayedId = params.displayItems[params.displayItems.length - 1]?.id;
    if (!firstDisplayedId || !lastDisplayedId) return false;
    const firstIndex = params.items.findIndex((item) => item.id === firstDisplayedId);
    const lastIndex = params.items.findIndex((item) => item.id === lastDisplayedId);
    if (firstIndex < 0 || lastIndex < firstIndex) return false;
    const start = params.direction === 'older' ? 0 : lastIndex + 1;
    const end = params.direction === 'older' ? firstIndex : params.items.length;
    for (let index = start; index < end; index += 1) {
        const item = params.items[index];
        if (!item) continue;
        const seq = params.resolveSeq ? params.resolveSeq(item) : item.seq;
        if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) return true;
    }
    return false;
}

export function resolveTranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    isSeqLoaded?: (seq: number) => boolean;
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
    resolveSeq?: (item: TItem) => number | null | undefined;
    tailContiguousFloorSeq?: number | null;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    const activeWindowState = params.windowState.isWindowMode ? params.windowState : null;
    const display = activeWindowState
        ? resolveTranscriptTargetWindowDisplay({
            items: params.items,
            windowState: activeWindowState,
            resolveSeq: params.resolveSeq,
            isSeqLoaded: params.isSeqLoaded,
            isSeqRangeLoaded: params.isSeqRangeLoaded,
        })
        : null;
    const tailFloorActive =
        activeWindowState === null &&
        typeof params.tailContiguousFloorSeq === 'number' &&
        Number.isFinite(params.tailContiguousFloorSeq) &&
        params.tailContiguousFloorSeq > 0;
    const hasOmittedOlderSequenceItems = display
        ? hasOmittedSequenceItem({
            direction: 'older',
            displayItems: display.items,
            items: params.items,
            resolveSeq: params.resolveSeq,
        })
        : false;
    const hasOmittedNewerSequenceItems = display
        ? hasOmittedSequenceItem({
            direction: 'newer',
            displayItems: display.items,
            items: params.items,
            resolveSeq: params.resolveSeq,
        })
        : false;
    const olderGap = activeWindowState
        ? (
            activeWindowState.hasMoreOlder === true ||
            hasOmittedOlderSequenceItems
                ? createWindowGapDescriptor({
                    direction: 'older',
                    windowId: activeWindowState.windowId ?? 'target',
                })
                : null
        )
        : tailFloorActive
            ? createWindowGapDescriptor({
                direction: 'older',
                windowId: 'tail',
            })
            : null;
    const newerGap =
        activeWindowState &&
        (
            activeWindowState.hasMoreNewer === true ||
            hasOmittedNewerSequenceItems
        )
            ? createWindowGapDescriptor({
                direction: 'newer',
                windowId: activeWindowState.windowId ?? 'target',
            })
            : null;
    return {
        activeWindowState,
        display,
        gaps: {
            newer: newerGap,
            older: olderGap,
        },
        hasMoreNewer: activeWindowState?.hasMoreNewer === true,
        items: display?.items ?? boundTailItemsToContiguousFloor({
            items: params.items,
            resolveSeq: params.resolveSeq,
            tailContiguousFloorSeq: params.tailContiguousFloorSeq ?? null,
        }),
        targetWindowActive: activeWindowState !== null,
    };
}

/**
 * Tail-reset discontinuity floor (sync `sessionMessagesTailDiscontinuity`): when a large
 * catch-up gap tail-resets onto an existing loaded prefix, only content at or above the
 * floor is contiguous with the live tail. Tail display must not glue the stale prefix
 * onto the island; target-window display is unaffected (jumps below the floor render
 * through their own window). Rows without a seq are synthetic tail chrome and stay.
 *
 * The island opens at the first row at or above the floor and everything from there on is kept
 * whole. Decomposed item seqs are locally non-monotonic (a turn or tool group anchors on its
 * FIRST message while neighbouring units already covered later seqs), so a below-floor anchor
 * can sit INSIDE the island rather than in the stale prefix. Filtering the whole list dropped
 * it from the middle of the tail, and the single older gap row sits at the top — it can never
 * describe a hole punched below itself, so those rows were withheld with no affordance at all.
 * Only the stale prefix ahead of the island is still filtered, which is where the gap row is.
 */
function boundTailItemsToContiguousFloor<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    resolveSeq?: (item: TItem) => number | null | undefined;
    tailContiguousFloorSeq: number | null;
}>): readonly TItem[] {
    const floorSeq = params.tailContiguousFloorSeq;
    if (typeof floorSeq !== 'number' || !Number.isFinite(floorSeq) || floorSeq <= 0) return params.items;
    const resolveItemSeq = (item: TItem): number | null => {
        const rawSeq = params.resolveSeq ? params.resolveSeq(item) : item.seq;
        if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq) || rawSeq < 0) return null;
        return Math.trunc(rawSeq);
    };
    let islandStartIndex = params.items.length;
    for (let index = 0; index < params.items.length; index += 1) {
        const item = params.items[index];
        if (!item) continue;
        // Rows without a seq are synthetic chrome: they never open the island.
        const seq = resolveItemSeq(item);
        if (seq !== null && seq >= floorSeq) {
            islandStartIndex = index;
            break;
        }
    }
    if (islandStartIndex === 0) return params.items;
    // Ahead of the island: the stale prefix the floor exists to withhold, minus the synthetic
    // chrome that carries no seq of its own. From the island start: kept whole.
    const bounded = params.items.filter((item, index) => (
        index >= islandStartIndex || resolveItemSeq(item) === null
    ));
    return bounded.length === params.items.length ? params.items : bounded;
}

export function useTranscriptTargetWindowHostAdapter<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
    resolveSeq?: (item: TItem) => number | null | undefined;
    tailContiguousFloorSeq?: number | null;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    return React.useMemo(() => resolveTranscriptTargetWindowHostFacts(params), [
        params.items,
        params.isSeqRangeLoaded,
        params.resolveSeq,
        params.tailContiguousFloorSeq,
        params.windowState,
    ]);
}

export type TranscriptJumpTargetRequest = Readonly<{
    normalizedTargetSeq: number;
    role: TranscriptJumpTargetRole | null | undefined;
    routeMessageId: string | null;
    transcriptBlockIndex: number | null | undefined;
}>;

export function resolveTranscriptJumpTargetRequest(target: TranscriptJumpTarget): TranscriptJumpTargetRequest | null {
    const targetSeq = target.kind === 'seq' ? target.seq : target.seqHint;
    if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq) || targetSeq < 0) return null;
    return {
        normalizedTargetSeq: Math.trunc(targetSeq),
        routeMessageId: target.kind === 'route-message-id' ? target.routeMessageId : null,
        transcriptBlockIndex: target.kind === 'route-message-id' ? target.transcriptBlockIndex : null,
        role: target.kind === 'route-message-id' ? target.role : null,
    };
}

export function resolveTranscriptTargetWindowLoadTarget(
    target: TranscriptJumpTarget,
    fallbackSeq: number,
): { kind: 'seq'; seq: number } | { kind: 'route-message-id'; routeMessageId: string; seqHint: number } {
    return target.kind === 'seq'
        ? { kind: 'seq', seq: Math.trunc(target.seq) }
        : {
            kind: 'route-message-id',
            routeMessageId: target.routeMessageId,
            seqHint: Math.trunc(target.seqHint ?? fallbackSeq),
        };
}

/**
 * Rendered-window truth for navigation jump planning. On web the item space spans ALL
 * loaded items, so it cannot distinguish "loaded" from "rendered": a loaded-but-
 * virtualized-out target must still prefer target-window materialization, otherwise the
 * jump degrades to a single unverified wrong-space write (WQA-4 RG2 class).
 */
export function resolveTranscriptNavigationTargetInRenderedWindow(params: Readonly<{
    platformOS: string;
    isTargetInItemSpace: boolean;
    isTargetMountedInDom: () => boolean;
}>): boolean {
    if (!params.isTargetInItemSpace) return false;
    if (params.platformOS !== 'web') return true;
    return params.isTargetMountedInDom();
}

export function resolveTranscriptNavigationJumpPlan(params: Readonly<{
    entry: TranscriptNavigationEntry;
    isTargetInRenderedWindow: (target: TranscriptJumpTarget) => boolean;
    request: TranscriptNavigationJumpRequest;
    sessionId: string;
}>): Readonly<{
    align: TranscriptViewportJumpAlignment;
    preferTargetWindow: boolean;
    target: TranscriptJumpTarget;
}> | null {
    const { entry, request } = params;
    const scope = request.scope;
    if (scope.kind !== 'main' || scope.sessionId !== params.sessionId) return null;
    const targetSeq = request.target.kind === 'seq' ? request.target.seq : request.target.seqHint ?? entry.seq;
    if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) return null;
    const target = request.target.kind === 'route-message-id' && typeof request.target.seqHint !== 'number' && typeof entry.seq === 'number'
        ? { ...request.target, seqHint: entry.seq }
        : request.target;
    return {
        align: resolveTargetWindowAlignmentCommand({
            anchorKind: entry.kind,
            requestedAlign: request.align,
        }),
        preferTargetWindow: entry.loaded === false || !params.isTargetInRenderedWindow(target),
        target,
    };
}

export function resolveTranscriptNavigationPaneJumpRequest(
    entry: TranscriptNavigationEntry,
    sessionId: string,
): TranscriptNavigationJumpRequest | null {
    if (entry.sessionId !== sessionId) return null;
    if (typeof entry.seq !== 'number' || !Number.isFinite(entry.seq)) return null;
    return {
        align: entry.kind === 'user-turn' ? 'top' : 'center',
        scope: { kind: 'main', sessionId },
        source: 'panel',
        target: entry.routeMessageId
            ? {
                kind: 'route-message-id',
                role: entry.role,
                routeMessageId: entry.routeMessageId,
                seqHint: entry.seq,
                transcriptBlockIndex: entry.transcriptBlockIndex,
            }
            : { kind: 'seq', seq: entry.seq },
    };
}

export function isTranscriptTargetObservedAtAlignment(params: Readonly<{
    align?: TranscriptViewportJumpAlignment;
    item: Pick<Element, 'getBoundingClientRect'>;
    metrics: Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'element' | 'scrollHeight' | 'scrollTop'>;
    tolerancePx?: number;
}>): boolean {
    if (!params.align) return true;
    const containerRect = params.metrics.element.getBoundingClientRect();
    const itemRect = params.item.getBoundingClientRect();
    const itemTop = itemRect.top - containerRect.top;
    const itemHeight = Number.isFinite(itemRect.height)
        ? Math.max(0, itemRect.height)
        : Math.max(0, itemRect.bottom - itemRect.top);
    const rawTarget = params.align.kind === 'center'
        ? params.metrics.scrollTop + itemTop + itemHeight / 2 - params.metrics.clientHeight / 2
        : params.metrics.scrollTop + itemTop - params.align.itemOffsetPx;
    if (!Number.isFinite(rawTarget)) return false;
    const expectedScrollTop = Math.max(
        0,
        Math.min(Math.trunc(rawTarget), Math.max(0, params.metrics.scrollHeight - params.metrics.clientHeight)),
    );
    return Math.abs(params.metrics.scrollTop - expectedScrollTop) <= (params.tolerancePx ?? 1);
}

export function resolveTranscriptRouteJumpSeqPlan(params: Readonly<{
    committedMessagesCount: number;
    hasUsableWebMetrics: () => boolean;
    inFlightJumpSeq: number | null;
    isLoaded: boolean;
    jumpToSeq: number | null | undefined;
    consumedJumpSeq: number | null;
    listContentHeight: number;
    listLayoutHeight: number;
    platformOS: string;
    sessionId: string | null | undefined;
}>): number | null {
    const target = params.jumpToSeq;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;
    if (!params.isLoaded && !(params.platformOS === 'web' && params.committedMessagesCount > 0)) return null;
    if (params.platformOS === 'web' && (params.listLayoutHeight <= 0 || params.listContentHeight <= 0) && !params.hasUsableWebMetrics()) {
        return null;
    }
    const normalizedTarget = Math.trunc(target);
    if (params.consumedJumpSeq === normalizedTarget || params.inFlightJumpSeq === normalizedTarget) return null;
    if (!params.sessionId) return null;
    return normalizedTarget;
}

export async function executeTranscriptTargetWindowJump(params: Readonly<{
    align?: TranscriptViewportJumpAlignment;
    canRenderTargetWindow: boolean;
    forceTargetWindow?: boolean;
    /** Latest-explicit-navigation-wins predicate owned by the unified jump host. */
    isCurrentOperation?: () => boolean;
    isTargetAligned?: () => boolean;
    isTargetInRenderedWindow?: () => boolean;
    isTargetMounted: () => boolean;
    /** True only when the mounted target's matching keyed renderer hold owns correction. */
    isTargetOwnedByRenderer?: () => boolean;
    loadTargetWindow: (request: Readonly<{
        direction: 'older' | 'newer' | null;
        target: TranscriptJumpTarget;
        targetSeq: number;
    }>) => Promise<{
        windowId: string;
        targetSeq?: number | null;
        newerCursor?: number | null;
        hasMoreNewer?: boolean | null;
    } | { status: 'stale' } | null>;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    pageTowardTarget?: (request: Readonly<{
        direction: 'older' | 'newer';
        nearestIndex: number;
        nearestSeq: number;
        target: TranscriptJumpTarget;
        targetSeq: number;
    }>) => Promise<TranscriptJumpResult>;
    platformOS: string;
    readScrollTop: () => number | null;
    rendererKind?: 'flashList' | 'legendList';
    resolveTargetIndex: () => TranscriptJumpTargetIndexResult;
    scrollToTarget: () => boolean;
    target: TranscriptJumpTarget;
    targetSeq: number;
    waitForNextLandingFrame?: () => Promise<void>;
    landingSettleDeadlineMs?: number;
    /**
     * Host genuine-user-movement signal (web): returns true when the user genuinely scrolled
     * after `sinceMs`. When provided, it is the ONLY landing-abort signal — renderer-induced
     * scrollTop drift (re-slices, browser scroll anchoring during window materialization) must
     * not abort the landing. Without it, the loop falls back to a raw scrollTop-delta check.
     */
    hasGenuineUserMovementSince?: (sinceMs: number) => boolean;
    /**
     * Web-only: called when the landing loop detects a FlashList blank-chunk gap — the target
     * row is in item space but approach writes leave scrollTop stable and the target unmounted.
     * A 1-pixel nudge changes scrollTop enough to fire FlashList's scroll listener, which
     * forces chunk re-population at the target position.
     */
    nudgeScrollForGap?: () => void;
}>): Promise<TranscriptJumpResult> {
    const isCurrentOperation = (): boolean => params.isCurrentOperation?.() !== false;
    if (!isCurrentOperation()) return { status: 'aborted' };
    const scrollToTarget = (options: Readonly<{ allowVirtualizedRenderedTarget?: boolean }> = {}): boolean => {
        if (!isCurrentOperation()) return false;
        const applied = params.scrollToTarget();
        if (!applied) return false;
        if (params.canRenderTargetWindow && params.platformOS === 'web') {
            const targetInRenderedWindow = params.isTargetInRenderedWindow?.() ?? params.isTargetMounted();
            if (!targetInRenderedWindow) return false;
            if (!options.allowVirtualizedRenderedTarget && !params.isTargetMounted()) return false;
        }
        return true;
    };

    /**
     * Web landing after a target window renders. The first write can only aim at estimated
     * row layouts (the target row is not mounted yet), so this loop:
     *  1. issues approach writes while the target is unmounted (forcing the renderer band
     *     near the estimated target position; estimates converge as rows get measured),
     *  2. once mounted, re-runs the exact rect-based landing write until the viewport is
     *     stable across two consecutive frames (late measurements shift content under the
     *     first exact write),
     *  3. aborts as soon as a foreign writer (user scroll, another owner) moves the viewport
     *     away from this jump's own last write,
     *  4. transfers correction to a matching renderer-held target immediately; only the
     *     retained FlashList fallback keeps its bounded post-settle re-verification.
     * Runs inside the explicit-jump write barrier held by the caller for the whole jump.
     */
    const performWebWindowLanding = async (
        landedResult: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>,
    ): Promise<boolean> => {
        let landed = false;
        const landOnce = (): boolean => {
            if (!isCurrentOperation()) return false;
            if (!scrollToTarget({ allowVirtualizedRenderedTarget: true })) return false;
            if (!params.isTargetMounted()) return false;
            if (params.isTargetAligned?.() === false) return false;
            if (!landed) {
                landed = true;
                params.onJumpLanded?.(landedResult);
            }
            return true;
        };
        if (typeof params.readScrollTop() !== 'number') {
            // No usable scroll metrics (host harness or detached container): single-shot landing.
            if (params.isTargetMounted()) {
                landOnce();
                return landed;
            }
            await Promise.resolve();
            if (!isCurrentOperation()) return false;
            await Promise.resolve();
            if (!isCurrentOperation()) return false;
            if (params.isTargetMounted() || params.isTargetInRenderedWindow?.()) {
                landOnce();
            }
            return landed;
        }

        const waitFrame = params.waitForNextLandingFrame
            ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 80)));
        const landingStartedAtMs = Date.now();
        // mutable: extended after gap nudge fires to let FlashList finish its async re-render.
        let deadlineAt = landingStartedAtMs + Math.max(0, params.landingSettleDeadlineMs ?? 1800);
        let lastObservedAfterWrite: number | null = null;
        let stableFrames = 0;
        // Counts consecutive frames where approach writes leave scrollTop unchanged and the
        // target remains unmounted — the FlashList blank-chunk gap signature.
        let consecutiveStableNonMountedFrames = 0;
        // True once the gap corrective nudge fires. After this point, approach writes stop so
        // FlashList's async render cycle can complete without repeated scrollToIndex interruption.
        let gapNudgeFired = false;
        for (let iteration = 0; iteration < 60; iteration += 1) {
            if (!isCurrentOperation()) break;
            const observedBefore = params.readScrollTop();
            if (params.hasGenuineUserMovementSince) {
                // The user owns the viewport the moment they genuinely move it.
                if (params.hasGenuineUserMovementSince(landingStartedAtMs)) break;
            } else if (
                lastObservedAfterWrite !== null &&
                typeof observedBefore === 'number' &&
                Math.abs(observedBefore - lastObservedAfterWrite) > 1
            ) {
                break;
            }
            if (params.isTargetMounted()) {
                consecutiveStableNonMountedFrames = 0;
                const landedThisFrame = landOnce();
                if (landedThisFrame && params.isTargetOwnedByRenderer?.() === true) {
                    break;
                }
                const observedAfter = params.readScrollTop();
                if (typeof observedAfter !== 'number') break;
                stableFrames = typeof observedBefore === 'number' && Math.abs(observedAfter - observedBefore) <= 1
                    ? stableFrames + 1
                    : 0;
                lastObservedAfterWrite = observedAfter;
                if (stableFrames >= 2) {
                    break;
                }
            } else {
                stableFrames = 0;
                if (!gapNudgeFired) {
                    // Normal approach-write path: scroll toward target, track scrollTop stability.
                    scrollToTarget();
                    const observedAfter = params.readScrollTop();
                    if (typeof observedAfter !== 'number') break;
                    // Gap detection: two consecutive stable-scrollTop non-mounted frames indicate a
                    // FlashList blank-chunk gap. Fire the corrective nudge once, then stop approach
                    // writes and extend the deadline so FlashList's async layout can settle without
                    // repeated scrollToIndex calls interrupting its render pipeline.
                    if (
                        params.rendererKind === 'flashList' &&
                        params.nudgeScrollForGap != null &&
                        typeof lastObservedAfterWrite === 'number' &&
                        Math.abs(observedAfter - lastObservedAfterWrite) <= 1
                    ) {
                        consecutiveStableNonMountedFrames++;
                        if (consecutiveStableNonMountedFrames >= 2) {
                            if (!isCurrentOperation()) break;
                            params.nudgeScrollForGap();
                            // One restorative approach write brings scrollTop back to the correct
                            // target position immediately after the nudge (the nudge may have written
                            // a ±1px offset). After this, approach writes stop so FlashList's async
                            // layout pipeline can complete without repeated scrollToIndex interruptions.
                            scrollToTarget();
                            gapNudgeFired = true;
                            consecutiveStableNonMountedFrames = 0;
                            // Allow up to 5 s for FlashList to finish measuring items and shift
                            // the target row into the rendered range (live evidence: render
                            // completes within 3–7 s of navigation for a fresh cold window load).
                            deadlineAt = Math.max(deadlineAt, Date.now() + 5000);
                        }
                    } else {
                        consecutiveStableNonMountedFrames = 0;
                    }
                    lastObservedAfterWrite = observedAfter;
                }
                // else: gapNudgeFired — skip approach write; just wait for FlashList to render.
            }
            if (Date.now() > deadlineAt) {
                break;
            }
            await waitFrame();
            if (!isCurrentOperation()) break;
            if (Date.now() > deadlineAt) break;
            if (params.hasGenuineUserMovementSince?.(landingStartedAtMs) === true) break;
        }
        if (!landed) return false;
        if (params.isTargetOwnedByRenderer?.() === true) return true;
        if (params.rendererKind !== 'flashList') return true;
        // Post-settle re-verification (P2SMOKE3-S3-JUMP-GAP): FlashList v2 web re-measures rows
        // asynchronously after a settled landing; streaming growth plus estimated-height collapse
        // can move the target row thousands of px away from the settled scrollTop, leaving the
        // viewport in an unrendered allocation gap. Live evidence: re-measurement keeps shifting
        // the layout for many seconds while a session streams, so the exit criterion is layout
        // QUIESCENCE (no correction needed for ~2s), bounded by a hard cap. Each frame re-issues
        // the exact rect-based landing write (a same-position write is a no-op) and falls back to
        // approach writes if reallocation unmounts the target. Genuine user movement ends
        // re-verification immediately — the user owns the viewport.
        const reverifyDeadlineAt = Date.now() + 15000;
        let reverifyStableFrames = 0;
        for (let iteration = 0; iteration < 190; iteration += 1) {
            if (Date.now() > reverifyDeadlineAt) break;
            await waitFrame();
            if (!isCurrentOperation()) break;
            if (Date.now() > reverifyDeadlineAt) break;
            if (params.hasGenuineUserMovementSince) {
                if (params.hasGenuineUserMovementSince(landingStartedAtMs)) break;
            }
            const observedBefore = params.readScrollTop();
            if (typeof observedBefore !== 'number') break;
            if (
                !params.hasGenuineUserMovementSince &&
                typeof lastObservedAfterWrite === 'number' &&
                Math.abs(observedBefore - lastObservedAfterWrite) > 1
            ) {
                break;
            }
            if (params.isTargetMounted()) {
                scrollToTarget({ allowVirtualizedRenderedTarget: true });
            } else {
                scrollToTarget();
            }
            const observedAfter = params.readScrollTop();
            if (typeof observedAfter !== 'number') break;
            reverifyStableFrames = Math.abs(observedAfter - observedBefore) <= 1
                ? reverifyStableFrames + 1
                : 0;
            lastObservedAfterWrite = observedAfter;
            if (reverifyStableFrames >= 25) break;
        }
        return true;
    };
    const renderTargetWindow = async (
        request: Readonly<{
            direction: 'older' | 'newer' | null;
            target: TranscriptJumpTarget;
            targetSeq: number;
        }>,
    ) => {
        if (!isCurrentOperation()) return { status: 'stale' as const };
        const result = await params.loadTargetWindow(request);
        return isCurrentOperation() ? result : { status: 'stale' as const };
    };

    if (!isCurrentOperation()) return { status: 'aborted' };
    const resolvedTargetIndex = params.resolveTargetIndex();
    const strategy = params.forceTargetWindow === true && params.canRenderTargetWindow && resolvedTargetIndex.status !== 'found'
        ? {
            status: 'render-target-window' as const,
            target: params.target,
            direction: resolvedTargetIndex.status === 'unresolved' ? resolvedTargetIndex.direction : null,
            targetSeq: params.targetSeq,
        }
        : resolveTranscriptJumpStrategy({
        target: params.target,
        scope: { kind: 'main', sessionId: 'host-adapter' },
        targetIndex: resolvedTargetIndex,
        mode: 'mounted-list',
        nearbySeqThreshold: 8,
        canRenderTargetWindow: params.canRenderTargetWindow,
    });

    const result = await applyTranscriptJumpResult({
        strategy,
        adapters: {
            scrollToIndex: () => scrollToTarget(),
            renderTargetWindow: params.canRenderTargetWindow
                ? ({ target, targetSeq, direction }) => renderTargetWindow({ target, targetSeq, direction })
                : undefined,
            pageTowardTarget: params.pageTowardTarget
                ? async (request) => {
                    if (!isCurrentOperation()) return { status: 'aborted' };
                    const pageResult = await params.pageTowardTarget?.(request);
                    return isCurrentOperation()
                        ? (pageResult ?? { status: 'not-found', reason: 'unavailable' })
                        : { status: 'aborted' };
                }
                : undefined,
        },
    });

    if (!isCurrentOperation()) return { status: 'aborted' };
    if (result.status === 'scrolled') {
        if (params.platformOS === 'web') {
            const landed = await performWebWindowLanding(result);
            if (!isCurrentOperation()) return { status: 'aborted' };
            return landed ? result : { status: 'not-found', reason: 'unavailable' };
        }
        if (!isCurrentOperation()) return { status: 'aborted' };
        if (params.isTargetMounted() && params.isTargetAligned?.() !== false) {
            params.onJumpLanded?.(result);
            return result;
        }
        return { status: 'not-found', reason: 'unavailable' };
    }
    if (result.status === 'window-rendered' && params.platformOS !== 'web') {
        if (!isCurrentOperation()) return { status: 'aborted' };
        const applied = params.scrollToTarget();
        if (applied && params.isTargetMounted() && params.isTargetAligned?.() !== false) {
            params.onJumpLanded?.(result);
            return result;
        }
        return { status: 'not-found', reason: 'unavailable' };
    }
    if (result.status === 'window-rendered' && params.platformOS === 'web') {
        const landed = await performWebWindowLanding(result);
        if (!isCurrentOperation()) return { status: 'aborted' };
        return landed ? result : { status: 'not-found', reason: 'unavailable' };
    }
    if (
        params.canRenderTargetWindow &&
        strategy.status === 'scroll-mounted' &&
        result.status === 'not-found'
    ) {
        const fallbackResult = await applyTranscriptJumpResult({
            strategy: {
                status: 'render-target-window',
                target: params.target,
                direction: null,
                targetSeq: params.targetSeq,
            },
            adapters: {
                renderTargetWindow: ({ target, targetSeq, direction }) => renderTargetWindow({ target, targetSeq, direction }),
            },
        });
        if (!isCurrentOperation()) return { status: 'aborted' };
        if (fallbackResult.status === 'window-rendered') {
            if (params.platformOS !== 'web') {
                if (!isCurrentOperation()) return { status: 'aborted' };
                const applied = params.scrollToTarget();
                if (applied && params.isTargetMounted() && params.isTargetAligned?.() !== false) {
                    params.onJumpLanded?.(fallbackResult);
                    return fallbackResult;
                }
            } else {
                const landed = await performWebWindowLanding(fallbackResult);
                if (!isCurrentOperation()) return { status: 'aborted' };
                if (landed) {
                    return fallbackResult;
                }
            }
            return { status: 'not-found', reason: 'unavailable' };
        }
        return fallbackResult;
    }
    return result;
}
