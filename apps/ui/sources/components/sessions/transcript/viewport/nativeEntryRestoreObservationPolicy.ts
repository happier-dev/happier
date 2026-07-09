export type NativeEntryRestoreObservationTarget = Readonly<{
    contentHeight?: number;
    kind: 'anchor' | 'distance';
    offsetY: number;
    sessionId: string;
    targetOffsetY?: number;
    targetOffsetYWasClamped?: boolean;
}>;

export function nativeEntryRestoreObservationMatches(
    target: NativeEntryRestoreObservationTarget | null | undefined,
    params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        observedOffsetY: number;
        sessionId: string;
        tolerancePx: number;
    }>,
): boolean {
    if (!target || target.sessionId !== params.sessionId) return false;
    if (Math.abs(params.distanceFromBottom - target.offsetY) <= params.tolerancePx) {
        return true;
    }
    return nativeEntryRestoreTargetOffsetMatches(target, params);
}

export type NativeSliceEntryObservationStatus = 'aligned' | 'misaligned' | 'inconclusive';

/**
 * Slice-from-anchor entry observation (N2b): an anchored entry lands write-free
 * by building the data window at the anchor, so the conclusive contract is the
 * saved pixel offset of the persisted anchor. Visibility is still required, but
 * a visible row at the wrong viewport offset is misaligned.
 */
export function resolveNativeSliceEntryObservation(params: Readonly<{
    anchorIndex?: number | null;
    anchorLayout: Readonly<{ y: number; height: number }> | null | undefined;
    absoluteScrollOffset: number;
    contentHeight?: number;
    itemOffsetPx: number;
    layoutHeight: number;
    tolerancePx: number;
    visibleRange?: Readonly<{ startIndex: number; endIndex: number }> | null;
}>): NativeSliceEntryObservationStatus {
    const layout = params.anchorLayout;
    if (
        layout == null ||
        !Number.isFinite(layout.y) ||
        !Number.isFinite(layout.height) ||
        !Number.isFinite(params.absoluteScrollOffset) ||
        !Number.isFinite(params.itemOffsetPx) ||
        !Number.isFinite(params.layoutHeight) ||
        !Number.isFinite(params.tolerancePx) ||
        params.layoutHeight <= 0
    ) {
        return 'inconclusive';
    }
    if (
        params.contentHeight != null &&
        (
            !Number.isFinite(params.contentHeight) ||
            params.contentHeight <= params.layoutHeight
        )
    ) {
        return 'inconclusive';
    }
    const anchorIndex = params.anchorIndex;
    const visibleRange = params.visibleRange;
    if (
        visibleRange == null ||
        typeof anchorIndex !== 'number' ||
        !Number.isFinite(anchorIndex) ||
        !Number.isFinite(visibleRange.startIndex) ||
        !Number.isFinite(visibleRange.endIndex) ||
        visibleRange.startIndex > visibleRange.endIndex
    ) {
        return 'inconclusive';
    }
    if (anchorIndex < visibleRange.startIndex || anchorIndex > visibleRange.endIndex) {
        return 'misaligned';
    }
    const viewportTop = params.absoluteScrollOffset;
    const viewportBottom = params.absoluteScrollOffset + params.layoutHeight;
    const rowTop = layout.y;
    const rowBottom = layout.y + Math.max(0, layout.height);
    if (!(rowTop < viewportBottom && rowBottom > viewportTop)) {
        return 'misaligned';
    }

    const observedItemOffsetPx = rowTop - params.absoluteScrollOffset;
    const deltaPx = observedItemOffsetPx - params.itemOffsetPx;
    return Math.abs(deltaPx) <= Math.max(0, params.tolerancePx) ? 'aligned' : 'misaligned';
}

function nativeEntryRestoreTargetOffsetMatches(
    target: NativeEntryRestoreObservationTarget,
    params: Readonly<{
        contentHeight: number;
        observedOffsetY: number;
        tolerancePx: number;
    }>,
): boolean {
    return (
        target.kind === 'distance' &&
        target.targetOffsetYWasClamped !== true &&
        targetContentReady(target, params) &&
        Number.isFinite(target.targetOffsetY) &&
        Math.abs(params.observedOffsetY - (target.targetOffsetY ?? 0)) <= params.tolerancePx
    );
}

function targetContentReady(
    target: NativeEntryRestoreObservationTarget,
    params: Readonly<{
        contentHeight: number;
        tolerancePx: number;
    }>,
): boolean {
    return target.contentHeight == null || params.contentHeight + params.tolerancePx >= target.contentHeight;
}
