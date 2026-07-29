import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';

export type NativeTranscriptViewportRef = Readonly<{
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => {
        x: number;
        y: number;
        width: number;
        height: number;
    } | undefined;
    getAbsoluteLastScrollOffset?: () => number;
}>;

export type NativeTranscriptViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type NativeTranscriptViewportAnchor = Readonly<{
    kind: NativeTranscriptViewportAnchorKind;
    messageId?: string | null;
    itemId: string;
    itemOffsetPx: number;
    capturedAtMs: number;
}>;

export type NativeTranscriptViewportAnchorDescriptor = Readonly<{
    kind: NativeTranscriptViewportAnchorKind;
    messageId?: string | null;
    itemId: string;
}>;

export type NativeTranscriptViewportAnchorCaptureResult =
    | Readonly<{
        status: 'captured';
        index: number;
        anchor: NativeTranscriptViewportAnchor;
    }>
    | Readonly<{
        status: 'methods_unavailable';
        missingMethods: readonly string[];
    }>
    | Readonly<{
        status: 'no_visible_indices' | 'no_measurable_items' | 'no_anchorable_item';
    }>;

export type NativeTranscriptViewportAnchorRestorePlanResult =
    | Readonly<{ status: 'planned'; index: number; viewOffset: number }>
    | Readonly<{ status: 'invalid_index' | 'invalid_offset' }>;

export type NativeTranscriptViewportAnchorMeasuredOffsetRestorePlanResult =
    | Readonly<{ status: 'planned'; targetOffsetY: number }>
    | Readonly<{ status: 'invalid_input' | 'not_scrollable' | 'layout_unavailable' }>;

export type NativeTranscriptViewportAnchorRestoreObservationResult =
    | Readonly<{
        status: 'aligned' | 'misaligned';
        observedItemOffsetPx: number;
        deltaPx: number;
    }>
    | Readonly<{
        status: 'visible_fallback' | 'not_visible' | 'waiting_for_layout' | 'invalid_input';
    }>;

const NATIVE_FIRST_VISIBLE_FALLBACK_SCAN_AHEAD_ITEM_COUNT = 24;

type NativeTranscriptAnchorSourceItem = Readonly<{
    id?: unknown;
    kind?: unknown;
    messageId?: unknown;
    toolMessageIds?: unknown;
}>;

type NativeTranscriptLayout = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

function isFiniteLayout(layout: NativeTranscriptLayout | undefined): layout is NativeTranscriptLayout {
    if (layout == null) return false;
    return (
        Number.isFinite(layout.x) &&
        Number.isFinite(layout.y) &&
        Number.isFinite(layout.width) &&
        Number.isFinite(layout.height)
    );
}

function resolveDefaultAnchorDescriptor(item: unknown): NativeTranscriptViewportAnchorDescriptor | null {
    if (typeof item !== 'object' || item == null) return null;

    const source = item as NativeTranscriptAnchorSourceItem;
    if (typeof source.id !== 'string' || source.id.length === 0) return null;

    if (source.kind === 'message' && typeof source.messageId === 'string' && source.messageId.length > 0) {
        return {
            kind: 'message',
            itemId: source.id,
            messageId: source.messageId,
        };
    }

    if (source.kind === 'tool-calls-group') {
        return {
            kind: 'toolGroup',
            itemId: source.id,
        };
    }

    return {
        kind: 'item',
        itemId: source.id,
    };
}

function clampIndex(index: number, maxExclusive: number): number | null {
    if (!Number.isInteger(index) || index < 0 || index >= maxExclusive) return null;
    return index;
}

function resolveVisibleRange(
    ref: NativeTranscriptViewportRef,
    dataLength: number,
): { startIndex: number; endIndex: number } | null {
    if (dataLength <= 0) return null;

    if (typeof ref.computeVisibleIndices === 'function') {
        const range = ref.computeVisibleIndices();
        const startIndex = Math.max(0, Math.min(range.startIndex, dataLength - 1));
        const endIndex = Math.max(startIndex, Math.min(range.endIndex, dataLength - 1));
        return { startIndex, endIndex };
    }

    if (typeof ref.getFirstVisibleIndex === 'function') {
        const startIndex = clampIndex(ref.getFirstVisibleIndex(), dataLength);
        if (startIndex == null) return null;
        return {
            startIndex,
            endIndex: Math.min(dataLength - 1, startIndex + NATIVE_FIRST_VISIBLE_FALLBACK_SCAN_AHEAD_ITEM_COUNT),
        };
    }

    return null;
}

function chooseFocusLineIndex<T>(params: Readonly<{
    getLayout: (index: number) => NativeTranscriptLayout | undefined;
    range: { startIndex: number; endIndex: number };
    absoluteFocusLineY: number;
}>): { index: number; layout: NativeTranscriptLayout } | null {
    let nearest: { index: number; layout: NativeTranscriptLayout; distancePx: number } | null = null;

    for (let index = params.range.startIndex; index <= params.range.endIndex; index += 1) {
        const layout = params.getLayout(index);
        if (!isFiniteLayout(layout)) continue;

        const top = layout.y;
        const bottom = layout.y + layout.height;
        if (top <= params.absoluteFocusLineY && bottom >= params.absoluteFocusLineY) {
            return { index, layout };
        }

        const distancePx = params.absoluteFocusLineY < top
            ? top - params.absoluteFocusLineY
            : params.absoluteFocusLineY - bottom;
        if (nearest == null || distancePx < nearest.distancePx) {
            nearest = { index, layout, distancePx };
        }
    }

    return nearest == null ? null : { index: nearest.index, layout: nearest.layout };
}

export function captureNativeTranscriptViewportAnchor<T>(params: Readonly<{
    ref: NativeTranscriptViewportRef | null | undefined;
    data: readonly T[];
    focusOffsetPx: number;
    capturedAtMs: number;
    resolveAnchor?: (item: T, index: number) => NativeTranscriptViewportAnchorDescriptor | null;
}>): NativeTranscriptViewportAnchorCaptureResult {
    const ref = params.ref;
    const missingMethods: string[] = [];
    if (ref == null) {
        return {
            status: 'methods_unavailable',
            missingMethods: ['getLayout', 'getAbsoluteLastScrollOffset', 'computeVisibleIndices|getFirstVisibleIndex'],
        };
    }

    const getLayout = ref.getLayout;
    const getAbsoluteLastScrollOffset = ref.getAbsoluteLastScrollOffset;
    const hasVisibleIndexMethod = typeof ref.computeVisibleIndices === 'function' || typeof ref.getFirstVisibleIndex === 'function';
    if (typeof getLayout !== 'function') missingMethods.push('getLayout');
    if (typeof getAbsoluteLastScrollOffset !== 'function') missingMethods.push('getAbsoluteLastScrollOffset');
    if (!hasVisibleIndexMethod) {
        missingMethods.push('computeVisibleIndices|getFirstVisibleIndex');
    }
    if (typeof getLayout !== 'function' || typeof getAbsoluteLastScrollOffset !== 'function' || !hasVisibleIndexMethod) {
        return { status: 'methods_unavailable', missingMethods };
    }

    const visibleRange = resolveVisibleRange(ref, params.data.length);
    if (visibleRange == null) return { status: 'no_visible_indices' };

    const absoluteScrollOffset = readNativeAbsoluteScrollOffset(ref);
    if (absoluteScrollOffset === null) return { status: 'no_measurable_items' };
    const candidate = chooseFocusLineIndex({
        getLayout,
        range: visibleRange,
        absoluteFocusLineY: absoluteScrollOffset + params.focusOffsetPx,
    });
    if (candidate == null) return { status: 'no_measurable_items' };

    const item = params.data[candidate.index];
    if (item == null) return { status: 'no_anchorable_item' };

    const descriptor = params.resolveAnchor?.(item, candidate.index) ?? resolveDefaultAnchorDescriptor(item);
    if (descriptor == null) return { status: 'no_anchorable_item' };

    return {
        status: 'captured',
        index: candidate.index,
        anchor: {
            ...descriptor,
            itemOffsetPx: candidate.layout.y - absoluteScrollOffset,
            capturedAtMs: params.capturedAtMs,
        },
    };
}

export function planNativeTranscriptViewportAnchorRestore(params: Readonly<{
    index: number;
    itemOffsetPx: number;
}>): NativeTranscriptViewportAnchorRestorePlanResult {
    if (!Number.isInteger(params.index) || params.index < 0) {
        return { status: 'invalid_index' };
    }
    if (typeof params.itemOffsetPx !== 'number' || !Number.isFinite(params.itemOffsetPx)) {
        return { status: 'invalid_offset' };
    }
    return {
        status: 'planned',
        index: params.index,
        // Native scrollToIndex adds viewOffset to the item layout offset; invert our row-top-to-viewport coordinate.
        viewOffset: -params.itemOffsetPx,
    };
}

export function planNativeTranscriptViewportAnchorMeasuredOffsetRestore(params: Readonly<{
    contentHeight: number;
    itemLayoutY: number;
    itemOffsetPx: number;
    layoutHeight: number;
}>): NativeTranscriptViewportAnchorMeasuredOffsetRestorePlanResult {
    if (
        !Number.isFinite(params.contentHeight) ||
        !Number.isFinite(params.itemLayoutY) ||
        !Number.isFinite(params.itemOffsetPx) ||
        !Number.isFinite(params.layoutHeight)
    ) {
        return { status: 'invalid_input' };
    }
    if (params.layoutHeight <= 0 || params.contentHeight <= params.layoutHeight) {
        return { status: 'not_scrollable' };
    }
    if (params.itemLayoutY < 0 || params.itemLayoutY >= params.contentHeight) {
        return { status: 'layout_unavailable' };
    }

    const maxOffsetY = Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight));
    const targetOffsetY = Math.max(
        0,
        Math.min(maxOffsetY, Math.trunc(params.itemLayoutY - params.itemOffsetPx)),
    );
    return { status: 'planned', targetOffsetY };
}

function isIndexVisibleWithFallback(
    ref: NativeTranscriptViewportRef,
    index: number,
): boolean {
    if (typeof ref.computeVisibleIndices === 'function') {
        const visibleRange = ref.computeVisibleIndices();
        if (
            typeof visibleRange.startIndex === 'number' &&
            Number.isFinite(visibleRange.startIndex) &&
            typeof visibleRange.endIndex === 'number' &&
            Number.isFinite(visibleRange.endIndex)
        ) {
            const startIndex = Math.min(visibleRange.startIndex, visibleRange.endIndex);
            const endIndex = Math.max(visibleRange.startIndex, visibleRange.endIndex);
            return index >= startIndex - 1 && index <= endIndex + 1;
        }
    }

    if (typeof ref.getFirstVisibleIndex === 'function') {
        const firstVisibleIndex = ref.getFirstVisibleIndex();
        if (typeof firstVisibleIndex === 'number' && Number.isFinite(firstVisibleIndex)) {
            return Math.abs(Math.trunc(firstVisibleIndex) - index) <= 1;
        }
    }

    return false;
}

export function resolveNativeTranscriptViewportAnchorRestoreObservation(params: Readonly<{
    ref: NativeTranscriptViewportRef | null | undefined;
    index: number;
    itemOffsetPx: number;
    tolerancePx: number;
}>): NativeTranscriptViewportAnchorRestoreObservationResult {
    if (
        params.ref == null ||
        !Number.isInteger(params.index) ||
        params.index < 0 ||
        !Number.isFinite(params.itemOffsetPx) ||
        !Number.isFinite(params.tolerancePx)
    ) {
        return { status: 'invalid_input' };
    }

    const ref = params.ref;
    const canMeasurePixelOffset =
        typeof ref.getLayout === 'function' &&
        typeof ref.getAbsoluteLastScrollOffset === 'function';

    if (canMeasurePixelOffset) {
        const layout = ref.getLayout(params.index);
        const absoluteScrollOffset = readNativeAbsoluteScrollOffset(ref);
        if (!isFiniteLayout(layout) || absoluteScrollOffset === null) {
            return { status: 'waiting_for_layout' };
        }

        const observedItemOffsetPx = layout.y - absoluteScrollOffset;
        const deltaPx = observedItemOffsetPx - params.itemOffsetPx;
        if (Math.abs(deltaPx) <= Math.max(0, params.tolerancePx)) {
            return {
                status: 'aligned',
                observedItemOffsetPx,
                deltaPx,
            };
        }
        return {
            status: 'misaligned',
            observedItemOffsetPx,
            deltaPx,
        };
    }

    return isIndexVisibleWithFallback(ref, params.index)
        ? { status: 'visible_fallback' }
        : { status: 'not_visible' };
}
