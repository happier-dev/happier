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
import { resolveTranscriptTargetWindowDisplay } from './resolveTranscriptTargetWindowDisplay';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowDisplayResult,
    TranscriptTargetWindowState,
} from './transcriptTargetWindowTypes';

export type TranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem> = Readonly<{
    activeWindowState: TranscriptTargetWindowState | null;
    display: TranscriptTargetWindowDisplayResult<TItem> | null;
    hasMoreNewer: boolean;
    items: readonly TItem[];
    targetWindowActive: boolean;
}>;

export function resolveTranscriptTargetWindowHostFacts<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    isSeqLoaded?: (seq: number) => boolean;
    resolveSeq?: (item: TItem) => number | null | undefined;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    const activeWindowState = params.windowState.isWindowMode ? params.windowState : null;
    const display = activeWindowState
        ? resolveTranscriptTargetWindowDisplay({
            items: params.items,
            windowState: activeWindowState,
            resolveSeq: params.resolveSeq,
            isSeqLoaded: params.isSeqLoaded,
        })
        : null;
    return {
        activeWindowState,
        display,
        hasMoreNewer: activeWindowState?.hasMoreNewer === true,
        items: display?.items ?? params.items,
        targetWindowActive: activeWindowState !== null,
    };
}

export function useTranscriptTargetWindowHostAdapter<TItem extends TranscriptTargetWindowDisplayItem>(params: Readonly<{
    items: readonly TItem[];
    resolveSeq?: (item: TItem) => number | null | undefined;
    windowState: TranscriptTargetWindowState;
}>): TranscriptTargetWindowHostFacts<TItem> {
    return React.useMemo(() => resolveTranscriptTargetWindowHostFacts(params), [
        params.items,
        params.resolveSeq,
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

export function isTranscriptSeqMountedInWebRenderedWindow<TItem>(params: Readonly<{
    hasAnyTestId: (container: Element, testIds: readonly string[]) => boolean;
    hotTailTestIdPrefix: string;
    items: readonly TItem[];
    platformOS: string;
    prependAnchorTestIdPrefix: string;
    resolveContainer: () => Element | null | undefined;
    resolveItemId: (item: TItem) => string | null | undefined;
    resolveSeq: (item: TItem) => number | null | undefined;
    seq: number;
}>): boolean {
    if (params.platformOS !== 'web') return false;
    if (typeof params.seq !== 'number' || !Number.isFinite(params.seq)) return false;
    const container = params.resolveContainer();
    if (!container) return false;
    const normalizedSeq = Math.trunc(params.seq);
    for (const item of params.items) {
        if (params.resolveSeq(item) !== normalizedSeq) continue;
        const normalizedItemId = params.resolveItemId(item)?.trim();
        if (!normalizedItemId) continue;
        if (params.hasAnyTestId(container, [
            `${params.prependAnchorTestIdPrefix}${normalizedItemId}`,
            `${params.hotTailTestIdPrefix}${normalizedItemId}`,
        ])) return true;
    }
    return false;
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

export function resolveTranscriptRouteJumpSeqPlan(params: Readonly<{
    committedMessagesCount: number;
    hasUsableWebMetrics: () => boolean;
    inFlightJumpSeq: number | null;
    isLoaded: boolean;
    jumpToSeq: number | null | undefined;
    lastJumpSeq: number | null;
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
    if (params.lastJumpSeq === normalizedTarget || params.inFlightJumpSeq === normalizedTarget) return null;
    if (!params.sessionId) return null;
    return normalizedTarget;
}

export async function executeTranscriptTargetWindowJump(params: Readonly<{
    align?: TranscriptViewportJumpAlignment;
    canRenderTargetWindow: boolean;
    forceTargetWindow?: boolean;
    isTargetInRenderedWindow?: () => boolean;
    isTargetMounted: () => boolean;
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
    const scrollToTarget = (options: Readonly<{ allowVirtualizedRenderedTarget?: boolean }> = {}): boolean => {
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
     *  4. after a successful settle, keeps re-verifying for a bounded window: FlashList's async
     *     re-measurement (and live streaming growth) can collapse estimated heights and move the
     *     target away from the settled scrollTop after the fact (P2SMOKE3-S3-JUMP-GAP).
     * Runs inside the explicit-jump write barrier held by the caller for the whole jump.
     */
    const performWebWindowLanding = async (
        landedResult: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>,
    ): Promise<void> => {
        let landed = false;
        const landOnce = (): void => {
            if (scrollToTarget({ allowVirtualizedRenderedTarget: true }) && !landed) {
                landed = true;
                params.onJumpLanded?.(landedResult);
            }
        };
        if (typeof params.readScrollTop() !== 'number') {
            // No usable scroll metrics (host harness or detached container): single-shot landing.
            if (params.isTargetMounted()) {
                landOnce();
                return;
            }
            await Promise.resolve();
            await Promise.resolve();
            if (params.isTargetMounted() || params.isTargetInRenderedWindow?.()) {
                landOnce();
            }
            return;
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
                landOnce();
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
                        params.nudgeScrollForGap != null &&
                        typeof lastObservedAfterWrite === 'number' &&
                        Math.abs(observedAfter - lastObservedAfterWrite) <= 1
                    ) {
                        consecutiveStableNonMountedFrames++;
                        if (consecutiveStableNonMountedFrames >= 2) {
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
        }
        if (!landed) return;
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
    };
    const renderTargetWindow = async (
        request: Readonly<{
            direction: 'older' | 'newer' | null;
            target: TranscriptJumpTarget;
            targetSeq: number;
        }>,
    ) => {
        return await params.loadTargetWindow(request);
    };

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
            pageTowardTarget: params.pageTowardTarget,
        },
    });

    if (result.status === 'scrolled') {
        params.onJumpLanded?.(result);
        return result;
    }
    if (result.status === 'window-rendered' && params.platformOS !== 'web') {
        params.scrollToTarget();
        params.onJumpLanded?.(result);
        return result;
    }
    if (result.status === 'window-rendered' && params.platformOS === 'web') {
        await performWebWindowLanding(result);
        return result;
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
        if (fallbackResult.status === 'window-rendered') {
            if (params.platformOS !== 'web') {
                params.onJumpLanded?.(fallbackResult);
            } else {
                await performWebWindowLanding(fallbackResult);
            }
        }
        return fallbackResult;
    }
    return result;
}
