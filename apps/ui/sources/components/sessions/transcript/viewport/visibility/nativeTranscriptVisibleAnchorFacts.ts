import {
    mapTranscriptListIndexBetweenOrders,
    type TranscriptListOrientation,
} from '../../listOrientation';
import {
    deriveCurrentTranscriptAnchor,
    type TranscriptNavigationAnchorCandidate,
    type TranscriptVisibleSourceRange,
} from './deriveCurrentTranscriptAnchor';
import type { NavigationVisibilitySnapshot } from './transcriptNavigationVisibilityStore';

export type NativeTranscriptViewableItem = Readonly<{
    index?: number | null;
    isViewable?: boolean;
}>;

export type NativeTranscriptVisibleAnchorFactsInput = Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    itemCount: number;
    orientation: TranscriptListOrientation;
    preferUserTurnAnchor?: boolean;
    viewableItems: readonly NativeTranscriptViewableItem[];
}>;

function normalizeRenderedIndex(value: unknown): number | null {
    return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

export function translateNativeViewableItemsToVisibleSourceRange(
    params: Readonly<{
        itemCount: number;
        orientation: TranscriptListOrientation;
        viewableItems: readonly NativeTranscriptViewableItem[];
    }>,
): TranscriptVisibleSourceRange | null {
    if (!Number.isInteger(params.itemCount) || params.itemCount <= 0) return null;
    const sourceIndices: number[] = [];
    for (const item of params.viewableItems) {
        if (item.isViewable === false) continue;
        const renderedIndex = normalizeRenderedIndex(item.index);
        if (renderedIndex === null) continue;
        const sourceIndex = mapTranscriptListIndexBetweenOrders(
            renderedIndex,
            params.itemCount,
            params.orientation,
        );
        if (sourceIndex === null) continue;
        sourceIndices.push(sourceIndex);
    }
    if (sourceIndices.length === 0) return null;
    return {
        firstSourceIndex: Math.min(...sourceIndices),
        lastSourceIndex: Math.max(...sourceIndices),
    };
}

export function deriveNativeTranscriptVisibleAnchorFacts(
    input: NativeTranscriptVisibleAnchorFactsInput,
): NavigationVisibilitySnapshot {
    const visibleSourceRange = translateNativeViewableItemsToVisibleSourceRange(input);
    return deriveCurrentTranscriptAnchor({
        anchors: input.anchors,
        preferUserTurnAnchor: input.preferUserTurnAnchor,
        visibleSourceRange,
    });
}
