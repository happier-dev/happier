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

/**
 * Slice capability (N2b): the host can build the INITIAL data window starting
 * at/around the anchor message, so an anchored entry needs ZERO scroll writes.
 * Only hosts at the initial-window decision point opt in; after the sliced
 * window commits they re-resolve WITHOUT the capability and the anchor
 * resolves to an in-window observation target.
 */
export type EntryRestoreSliceCapability = Readonly<{
    hostCanBuildAnchorWindow: true;
}>;

/**
 * A slice outcome is a DATA-LAYER act, deliberately kept out of
 * `EntryRestoreTarget` so the entry transaction's writable target space
 * (`EntryRestoreTransactionTarget` = a subset of `EntryRestoreTarget`) can
 * never carry it — same exclusion convention as the wait `none` verdicts.
 * Identity is orientation-free (messageId + seq + intra-item offset); only
 * the window builder differs per orientation.
 */
export type EntryRestoreSliceTarget = Readonly<{
    kind: 'slice';
    anchorMessageId: string;
    anchorSeq: number | null;
    anchorItemOffsetPx: number;
}>;

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

type ResolveEntryRestoreTargetParamsWithSlice<TItem> = ResolveEntryRestoreTargetParams<TItem> & Readonly<{
    slice: EntryRestoreSliceCapability;
}>;

export function resolveEntryRestoreTarget<TItem>(
    params: ResolveEntryRestoreTargetParamsWithSlice<TItem>,
): EntryRestoreTarget | EntryRestoreSliceTarget;
export function resolveEntryRestoreTarget<TItem>(
    params: ResolveEntryRestoreTargetParams<TItem>,
): EntryRestoreTarget;
export function resolveEntryRestoreTarget<TItem>(
    params: ResolveEntryRestoreTargetParams<TItem> & Readonly<{ slice?: EntryRestoreSliceCapability }>,
): EntryRestoreTarget | EntryRestoreSliceTarget {
    if (params.slice?.hostCanBuildAnchorWindow === true && !params.snapshot.shouldFollowBottom) {
        // Slice precedes the fill barrier: it decides WHAT to fill, so empty,
        // unmeasured, unsettled, and under-filled states are all legitimate here.
        const anchor = params.snapshot.anchor;
        const anchorMessageId = anchor?.messageId?.trim() ?? '';
        if (anchor && anchorMessageId) {
            return {
                kind: 'slice',
                anchorMessageId,
                anchorSeq: anchor.seq ?? params.anchorSeqResolver?.(anchor) ?? null,
                anchorItemOffsetPx: Number.isFinite(anchor.itemOffsetPx) ? anchor.itemOffsetPx : 0,
            };
        }
        if (anchor) {
            return { kind: 'none', reason: 'missing-durable-anchor' };
        }
    }

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
        if (survivingTarget) return survivingTarget;
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
