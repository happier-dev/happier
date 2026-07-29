import type {
    TranscriptListShellRef,
    TranscriptRendererVisibleSourceIndexRange,
} from '@/components/sessions/transcript/viewport/shell/renderer/types';

import {
    deriveCurrentTranscriptAnchor,
    type TranscriptNavigationAnchorCandidate,
    type TranscriptVisibleSourceRange,
} from './deriveCurrentTranscriptAnchor';
import {
    EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
    type NavigationVisibilitySnapshot,
    type NavigationVisibilityStore,
} from './transcriptNavigationVisibilityStore';

/**
 * Reads the renderer's own visible window — the ONE viewport fact navigation
 * visibility consumes on web and native alike — and normalizes a renderer that
 * cannot answer yet to `null` (an UNMEASURED frame, never "viewing row 0").
 */
export function readRendererVisibleSourceIndexRange(
    listNode: TranscriptListShellRef | null | undefined,
): TranscriptRendererVisibleSourceIndexRange | null {
    return listNode?.readVisibleSourceIndexRange?.() ?? null;
}

export type TranscriptNavigationVisibilityWriteDecision =
    | Readonly<{ kind: 'write'; snapshot: NavigationVisibilitySnapshot }>
    | Readonly<{ kind: 'skip'; reason: 'unmeasured-viewport' | 'no-subscribers' }>;

function normalizeVisibleSourceRange(
    range: TranscriptRendererVisibleSourceIndexRange | null | undefined,
    itemCount: number,
): TranscriptVisibleSourceRange | null {
    if (!Number.isInteger(itemCount) || itemCount <= 0) return null;
    if (!range) return null;
    const { startIndex, endIndex } = range;
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
    const low = Math.trunc(Math.min(startIndex, endIndex));
    const high = Math.trunc(Math.max(startIndex, endIndex));
    if (low < 0 || low >= itemCount) return null;
    return {
        firstSourceIndex: low,
        lastSourceIndex: Math.min(high, itemCount - 1),
    };
}

/**
 * Distinguishes the two "nothing to show" cases explicitly.
 *
 * - A genuinely empty anchor set writes the empty snapshot: the rail must clear.
 * - An unmeasured / detached frame (no renderer range, or no rendered items)
 *   SKIPS, so a transient zero-height layout pass cannot blanket-clobber a good
 *   snapshot with empty and blank every marker.
 */
export function resolveTranscriptNavigationVisibilityWrite(input: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    itemCount: number;
    landedAnchorId?: string | null;
    visibleSourceRange: TranscriptRendererVisibleSourceIndexRange | null | undefined;
}>): TranscriptNavigationVisibilityWriteDecision {
    if (input.anchors.length === 0) {
        return { kind: 'write', snapshot: EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT };
    }
    const visibleSourceRange = normalizeVisibleSourceRange(input.visibleSourceRange, input.itemCount);
    if (!visibleSourceRange) return { kind: 'skip', reason: 'unmeasured-viewport' };
    return {
        kind: 'write',
        snapshot: deriveCurrentTranscriptAnchor({
            anchors: input.anchors,
            landedAnchorId: input.landedAnchorId,
            preferUserTurnAnchor: true,
            visibleSourceRange,
        }),
    };
}

/**
 * The single publication point for navigation visibility. Every trigger (scroll
 * ingress, layout/content-size change, native viewability, anchor/entry change,
 * consumer arrival) funnels through here so the store has exactly one writer.
 */
export function publishTranscriptNavigationVisibility(params: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    itemCount: number;
    /** Jump-landing intent; wins `currentAnchorId` while it is still an anchor. */
    landedAnchorId?: string | null;
    readVisibleSourceRange: () => TranscriptRendererVisibleSourceIndexRange | null | undefined;
    store: NavigationVisibilityStore;
}>): TranscriptNavigationVisibilityWriteDecision {
    if (!params.store.hasSubscribers()) return { kind: 'skip', reason: 'no-subscribers' };
    let visibleSourceRange: TranscriptRendererVisibleSourceIndexRange | null | undefined = null;
    try {
        visibleSourceRange = params.readVisibleSourceRange();
    } catch {
        // A detached renderer is an unmeasured frame, not an empty transcript.
        return { kind: 'skip', reason: 'unmeasured-viewport' };
    }
    const decision = resolveTranscriptNavigationVisibilityWrite({
        anchors: params.anchors,
        itemCount: params.itemCount,
        landedAnchorId: params.landedAnchorId,
        visibleSourceRange,
    });
    if (decision.kind === 'write') params.store.set(decision.snapshot);
    return decision;
}
