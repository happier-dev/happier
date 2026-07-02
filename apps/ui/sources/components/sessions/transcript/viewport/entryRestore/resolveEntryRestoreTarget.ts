import { planNativeTranscriptViewportAnchorRestore } from '@/components/sessions/transcript/transcriptNativeViewportAnchor';

export type EntryRestoreAnchorSnapshot = Readonly<{
    messageId?: string | null;
    itemId: string;
    itemOffsetPx: number;
}>;

export type EntryRestoreSnapshot = Readonly<{
    shouldFollowBottom: boolean;
    /** Remembered distance from the bottom of the transcript, in px. */
    offsetY: number;
    anchor: EntryRestoreAnchorSnapshot | null;
}>;

export type EntryRestoreContentMeasurement = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

/** Final verdicts: there is genuinely nothing to restore for this entry. */
export type EntryRestoreFinalNoneReason =
    | 'empty-transcript'
    | 'content-fits-viewport';

/** Wait verdicts: re-resolve later (after fill settle / first content measurement). */
export type EntryRestoreWaitNoneReason =
    | 'awaiting-fill-settle'
    | 'content-unmeasured';

export type EntryRestoreNoneReason = EntryRestoreFinalNoneReason | EntryRestoreWaitNoneReason;

export type EntryRestoreTarget =
    | Readonly<{ kind: 'bottom' }>
    | Readonly<{ kind: 'anchor'; index: number; viewOffset: number }>
    | Readonly<{ kind: 'materialize-then-anchor'; anchorSeqHint: number | null }>
    | Readonly<{ kind: 'distance-oneshot'; targetOffsetY: number }>
    | Readonly<{ kind: 'none'; reason: EntryRestoreNoneReason }>;

export type ResolveEntryRestoreTargetParams<TItem> = Readonly<{
    snapshot: EntryRestoreSnapshot;
    items: readonly TItem[];
    contentMeasured: EntryRestoreContentMeasurement;
    /** True once the initial fill barrier settled; gates the one-shot distance fallback. */
    fillSettled: boolean;
    /** True while bounded older-page materialization budget remains for anchor lookup. */
    canMaterializeOlder: boolean;
    anchorIndexResolver: (anchor: EntryRestoreAnchorSnapshot, items: readonly TItem[]) => number | null;
    nearestSurvivingResolver: (anchor: EntryRestoreAnchorSnapshot, items: readonly TItem[]) => number | null;
    anchorSeqResolver?: (anchor: EntryRestoreAnchorSnapshot) => number | null;
}>;

export function resolveEntryRestoreTarget<TItem>(
    params: ResolveEntryRestoreTargetParams<TItem>,
): EntryRestoreTarget {
    if (params.items.length === 0) {
        return { kind: 'none', reason: 'empty-transcript' };
    }

    const contentHeight = normalizeDimension(params.contentMeasured.contentHeight);
    const layoutHeight = normalizeDimension(params.contentMeasured.layoutHeight);
    const contentMeasured = contentHeight > 0 && layoutHeight > 0;
    if (params.fillSettled && contentMeasured && contentHeight <= layoutHeight) {
        // Under-filled settled content fits the viewport: nothing to scroll, and
        // FlashList MVCP misbehaves on under-filled lists (upstream #2050).
        return { kind: 'none', reason: 'content-fits-viewport' };
    }

    if (params.snapshot.shouldFollowBottom) {
        return { kind: 'bottom' };
    }

    const anchor = params.snapshot.anchor;
    if (anchor) {
        const exactTarget = toAnchorTarget(
            params.anchorIndexResolver(anchor, params.items),
            anchor.itemOffsetPx,
            params.items.length,
        );
        if (exactTarget) return exactTarget;

        if (params.canMaterializeOlder) {
            return {
                kind: 'materialize-then-anchor',
                anchorSeqHint: params.anchorSeqResolver?.(anchor) ?? null,
            };
        }

        const survivingTarget = toAnchorTarget(
            params.nearestSurvivingResolver(anchor, params.items),
            anchor.itemOffsetPx,
            params.items.length,
        );
        if (survivingTarget) return survivingTarget;
    }

    if (!params.fillSettled) {
        return { kind: 'none', reason: 'awaiting-fill-settle' };
    }
    if (!contentMeasured) {
        return { kind: 'none', reason: 'content-unmeasured' };
    }

    const distanceFromBottom = Number.isFinite(params.snapshot.offsetY)
        ? Math.max(0, Math.trunc(params.snapshot.offsetY))
        : 0;
    const maxOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));
    return {
        kind: 'distance-oneshot',
        targetOffsetY: Math.max(0, maxOffsetY - distanceFromBottom),
    };
}

function toAnchorTarget(
    index: number | null,
    itemOffsetPx: number,
    itemCount: number,
): Extract<EntryRestoreTarget, { kind: 'anchor' }> | null {
    if (index == null || !Number.isInteger(index) || index < 0 || index >= itemCount) return null;

    const plan = planNativeTranscriptViewportAnchorRestore({
        index,
        itemOffsetPx: Number.isFinite(itemOffsetPx) ? itemOffsetPx : 0,
    });
    if (plan.status !== 'planned') return null;

    return { kind: 'anchor', index: plan.index, viewOffset: plan.viewOffset };
}

function normalizeDimension(value: number): number {
    return Number.isFinite(value) ? value : 0;
}
