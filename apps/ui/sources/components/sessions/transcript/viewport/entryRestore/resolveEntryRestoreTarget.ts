export type EntryRestoreAnchorSnapshot = Readonly<{
    messageId?: string | null;
    /** Message seq stamped on hydrated (persisted) anchors; identity-first restore. */
    seq?: number | null;
    itemId: string;
    itemOffsetPx: number;
}>;

export type EntryRestoreSnapshot = Readonly<{
    shouldFollowBottom: boolean;
    /** Remembered distance from the bottom of the transcript, in px. */
    offsetY: number | null;
    anchor: EntryRestoreAnchorSnapshot | null;
}>;

export type EntryRestoreContentMeasurement = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

/** Final verdicts: there is genuinely nothing to restore for this entry. */
export type EntryRestoreFinalNoneReason =
    | 'empty-transcript'
    | 'content-fits-viewport'
    | 'missing-durable-anchor'
    | 'missing-restored-distance';

/** Wait verdicts: re-resolve later (after fill settle / first content measurement). */
export type EntryRestoreWaitNoneReason =
    | 'awaiting-fill-settle'
    | 'content-unmeasured';

export type EntryRestoreNoneReason = EntryRestoreFinalNoneReason | EntryRestoreWaitNoneReason;

export type EntryRestoreTarget =
    | Readonly<{ kind: 'bottom' }>
    | Readonly<{ kind: 'anchor'; index: number; itemOffsetPx: number }>
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
    anchorSeqLoadedResolver?: (anchorSeq: number, items: readonly TItem[]) => boolean;
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
        // Under-filled settled content already fits the viewport: there is no restore write.
        return { kind: 'none', reason: 'content-fits-viewport' };
    }

    if (params.snapshot.shouldFollowBottom) {
        return { kind: 'bottom' };
    }

    // An anchor target is a scroll WRITE instruction, so it needs a measured
    // scrollable range and not only the data fact that the row exists.
    const hasScrollableRange = contentMeasured && contentHeight > layoutHeight;

    const anchor = params.snapshot.anchor;
    if (anchor) {
        const exactTarget = toAnchorTarget(
            params.anchorIndexResolver(anchor, params.items),
            anchor.itemOffsetPx,
            params.items.length,
        );
        if (exactTarget) return anchorTargetOrWait(exactTarget, hasScrollableRange);

        const anchorSeqHint = resolveDurableAnchorSeqHint(anchor, params.anchorSeqResolver);
        if (
            params.canMaterializeOlder &&
            anchorSeqHint !== null &&
            params.anchorSeqLoadedResolver?.(anchorSeqHint, params.items) !== true
        ) {
            return {
                kind: 'materialize-then-anchor',
                anchorSeqHint,
            };
        }

        const survivingTarget = toAnchorTarget(
            params.nearestSurvivingResolver(anchor, params.items),
            anchor.itemOffsetPx,
            params.items.length,
        );
        if (survivingTarget) return anchorTargetOrWait(survivingTarget, hasScrollableRange);
    }

    if (!params.fillSettled) {
        return { kind: 'none', reason: 'awaiting-fill-settle' };
    }
    if (!contentMeasured) {
        return { kind: 'none', reason: 'content-unmeasured' };
    }

    const restoredDistanceFromBottom = params.snapshot.offsetY;
    if (typeof restoredDistanceFromBottom !== 'number' || !Number.isFinite(restoredDistanceFromBottom)) {
        return { kind: 'none', reason: 'missing-restored-distance' };
    }
    const distanceFromBottom = Math.max(0, Math.trunc(restoredDistanceFromBottom));
    const maxOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));
    return {
        kind: 'distance-oneshot',
        targetOffsetY: Math.max(0, maxOffsetY - distanceFromBottom),
    };
}

/**
 * Holds a resolved anchor target until the list has a real scrollable range.
 *
 * A resolved index is a DATA fact; the write it authorizes is only meaningful
 * against measured geometry. At entry the list is routinely mounted with no
 * scrollable range at all (native zeroes the content height when the entry
 * arms), and `scrollToIndex` there can only land at offset 0 — while the entry
 * transaction has already counted its one authorized correction as issued, so
 * the wrong landing is permanent. Deferring to the existing `content-unmeasured`
 * wait verdict costs nothing: the owner treats it as a no-op and the existing
 * re-drive re-resolves on the next content/layout measurement. The gate is
 * MEASUREMENT, never fill settle — an under-filled list that settles is caught
 * above by the final `content-fits-viewport` verdict, so this cannot wait
 * forever.
 */
function anchorTargetOrWait(
    target: Extract<EntryRestoreTarget, { kind: 'anchor' }>,
    hasScrollableRange: boolean,
): EntryRestoreTarget {
    return hasScrollableRange ? target : { kind: 'none', reason: 'content-unmeasured' };
}

function toAnchorTarget(
    index: number | null,
    itemOffsetPx: number,
    itemCount: number,
): Extract<EntryRestoreTarget, { kind: 'anchor' }> | null {
    if (index == null || !Number.isInteger(index) || index < 0 || index >= itemCount) return null;

    return {
        kind: 'anchor',
        index,
        itemOffsetPx: Number.isFinite(itemOffsetPx) ? Math.trunc(itemOffsetPx) : 0,
    };
}

function normalizeDimension(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function resolveDurableAnchorSeqHint(
    anchor: EntryRestoreAnchorSnapshot,
    resolver: ((anchor: EntryRestoreAnchorSnapshot) => number | null) | undefined,
): number | null {
    const stampedSeq = normalizeSeq(anchor.seq);
    if (stampedSeq !== null) return stampedSeq;
    return normalizeSeq(resolver?.(anchor));
}

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const seq = Math.trunc(value);
    return seq > 0 ? seq : null;
}
