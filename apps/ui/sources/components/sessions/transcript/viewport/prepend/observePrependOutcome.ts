import { planNativeTranscriptViewportAnchorMeasuredOffsetRestore } from '@/components/sessions/transcript/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorIndex,
    type TranscriptViewportAnchorResolvableItem,
} from '@/components/sessions/transcript/transcriptViewportAnchorResolution';

/**
 * Default alignment tolerance for classifying a prepend as MVCP-preserved.
 * Mirrors the legacy `TRANSCRIPT_NATIVE_PREPEND_ANCHOR_RESTORE_ALIGNMENT_TOLERANCE_PX` constant.
 */
export const PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX = 4;

export type PrependAnchorKey = Readonly<{
    itemId: string;
    messageId?: string | null;
}>;

export type PrependCapturedAnchor = Readonly<{
    key: PrependAnchorKey;
    /** Anchor row top relative to the viewport top at capture time (px). */
    itemOffsetPx: number;
    capturedDataLength: number;
    capturedFirstItemId: string | null;
}>;

export type PrependPostCommitObservation = Readonly<{
    items: readonly TranscriptViewportAnchorResolvableItem[];
    getLayout: (index: number) => Readonly<{ y: number }> | undefined;
    absoluteScrollOffset: number;
    contentHeight: number;
    layoutHeight: number;
}>;

export type PrependOutcomeUnresolvableReason =
    | 'anchor-missing'
    | 'layout-not-ready'
    | 'identity-unchanged';

export type PrependOutcome =
    | Readonly<{ kind: 'mvcp-preserved'; observedItemOffsetPx: number; deltaPx: number }>
    | Readonly<{ kind: 'needs-fallback'; targetOffsetY: number; deltaPx: number }>
    | Readonly<{ kind: 'unresolvable'; reason: PrependOutcomeUnresolvableReason }>;

function resolveCurrentFirstItemId(items: readonly TranscriptViewportAnchorResolvableItem[]): string | null {
    const id = items[0]?.id;
    return typeof id === 'string' ? id : null;
}

/**
 * Pure post-commit classifier for one native prepend transaction:
 * - `mvcp-preserved`: the anchor row sits within tolerance of its captured viewport offset (0 writes).
 * - `needs-fallback`: the anchor survived but is misaligned; carries the single corrective offset (1 write).
 * - `unresolvable`: no actionable observation (`identity-unchanged` = the prepend is not visible in
 *   this items snapshot yet → observe again later; `anchor-missing` = anchor not mappable to the
 *   committed data; `layout-not-ready` = observe again later).
 */
export function observePrependOutcome(params: Readonly<{
    capturedAnchor: PrependCapturedAnchor;
    postCommit: PrependPostCommitObservation;
    tolerancePx?: number;
}>): PrependOutcome {
    const { capturedAnchor, postCommit } = params;
    const tolerancePx = params.tolerancePx ?? PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX;

    if (
        postCommit.items.length <= capturedAnchor.capturedDataLength &&
        resolveCurrentFirstItemId(postCommit.items) === capturedAnchor.capturedFirstItemId
    ) {
        return { kind: 'unresolvable', reason: 'identity-unchanged' };
    }

    const anchorIndex = resolveTranscriptViewportAnchorIndex({
        anchor: {
            itemId: capturedAnchor.key.itemId,
            messageId: capturedAnchor.key.messageId ?? null,
        },
        items: postCommit.items,
    });
    if (anchorIndex == null) {
        return { kind: 'unresolvable', reason: 'anchor-missing' };
    }

    const layout = postCommit.getLayout(anchorIndex);
    if (
        layout == null ||
        !Number.isFinite(layout.y) ||
        !Number.isFinite(postCommit.absoluteScrollOffset) ||
        !Number.isFinite(capturedAnchor.itemOffsetPx)
    ) {
        return { kind: 'unresolvable', reason: 'layout-not-ready' };
    }

    const observedItemOffsetPx = layout.y - postCommit.absoluteScrollOffset;
    const deltaPx = observedItemOffsetPx - capturedAnchor.itemOffsetPx;
    if (Math.abs(deltaPx) <= Math.max(0, tolerancePx)) {
        return { kind: 'mvcp-preserved', observedItemOffsetPx, deltaPx };
    }

    const fallbackPlan = planNativeTranscriptViewportAnchorMeasuredOffsetRestore({
        contentHeight: postCommit.contentHeight,
        itemLayoutY: layout.y,
        itemOffsetPx: capturedAnchor.itemOffsetPx,
        layoutHeight: postCommit.layoutHeight,
    });
    if (fallbackPlan.status !== 'planned') {
        return { kind: 'unresolvable', reason: 'layout-not-ready' };
    }

    return { kind: 'needs-fallback', targetOffsetY: fallbackPlan.targetOffsetY, deltaPx };
}
