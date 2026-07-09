export type TranscriptListOrientation = 'standard' | 'inverted';

export type TranscriptListPresentation = Readonly<{
    orientation: TranscriptListOrientation;
}>;

function isInRangeIndex(index: number, count: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < count;
}

export function resolveTranscriptListPresentation(
    params: Readonly<{ platformIsWeb: boolean }>,
): TranscriptListPresentation {
    return {
        orientation: params.platformIsWeb ? 'standard' : 'inverted',
    };
}

export function orientTranscriptListItems<T>(
    items: readonly T[],
    orientation: TranscriptListOrientation,
): readonly T[] {
    if (orientation === 'standard' || items.length <= 1) {
        return items;
    }

    return [...items].reverse();
}

export function mapTranscriptListIndexBetweenOrders(
    index: number,
    count: number,
    orientation: TranscriptListOrientation,
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }

    return orientation === 'inverted' ? count - 1 - index : index;
}

export function resolveOlderNeighborRenderedIndex(
    index: number,
    count: number,
    orientation: TranscriptListOrientation,
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }

    const neighborIndex = orientation === 'inverted' ? index + 1 : index - 1;
    return isInRangeIndex(neighborIndex, count) ? neighborIndex : null;
}

export function resolveEntrySliceSourceBounds(
    params: Readonly<{
        anchorSourceIndex: number;
        count: number;
        orientation: TranscriptListOrientation;
    }>,
): Readonly<{ start: number; end: number }> {
    const { anchorSourceIndex, count, orientation } = params;
    if (count <= 0 || !isInRangeIndex(anchorSourceIndex, count)) {
        return { start: 0, end: Math.max(0, count) };
    }

    if (orientation === 'inverted') {
        return { start: 0, end: Math.min(count, anchorSourceIndex + 1) };
    }

    return { start: Math.max(0, anchorSourceIndex), end: count };
}

export function resolveOrientedListEdgeSlots<T>(
    params: Readonly<{
        orientation: TranscriptListOrientation;
        visualBottomNode: T;
        visualTopNode: T;
    }>,
): Readonly<{ listFooterNode: T; listHeaderNode: T }> {
    if (params.orientation === 'inverted') {
        return {
            listFooterNode: params.visualTopNode,
            listHeaderNode: params.visualBottomNode,
        };
    }

    return {
        listFooterNode: params.visualBottomNode,
        listHeaderNode: params.visualTopNode,
    };
}
