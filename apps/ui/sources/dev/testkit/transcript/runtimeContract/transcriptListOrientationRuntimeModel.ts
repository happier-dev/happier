import {
    mapTranscriptListIndexBetweenOrders,
    orientTranscriptListItems,
    resolveTranscriptListPresentation,
    type TranscriptListPresentation,
} from '@/components/sessions/transcript/listOrientation';

export type TranscriptListRuntimePlatform = 'native' | 'web';

export type TranscriptListRuntimeScrollMetrics = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

export type TranscriptListOrientationRuntimeModel<T> = Readonly<{
    mapRenderedIndexToSourceIndex: (index: number) => number | null;
    mapSourceIndexToRenderedIndex: (index: number) => number | null;
    presentation: TranscriptListPresentation;
    renderedItems: readonly T[];
    resolveBottomRawScrollCommandOffset: (metrics: TranscriptListRuntimeScrollMetrics) => number;
    sourceItemCount: number;
}>;

export function createTranscriptListOrientationRuntimeModel<T>(
    params: Readonly<{
        items: readonly T[];
        platform: TranscriptListRuntimePlatform;
    }>,
): TranscriptListOrientationRuntimeModel<T> {
    const presentation = resolveTranscriptListPresentation({
        platformIsWeb: params.platform === 'web',
    });

    const mapIndex = (index: number): number | null => mapTranscriptListIndexBetweenOrders(
        index,
        params.items.length,
        presentation.orientation,
    );

    return {
        mapRenderedIndexToSourceIndex: mapIndex,
        mapSourceIndexToRenderedIndex: mapIndex,
        presentation,
        renderedItems: orientTranscriptListItems(params.items, presentation.orientation),
        resolveBottomRawScrollCommandOffset: (metrics) => {
            // In an inverted (newest-first) presentation the raw bottom offset is 0 by definition.
            if (presentation.orientation === 'inverted') {
                return 0;
            }

            return Math.max(0, Math.trunc(metrics.contentHeight - metrics.layoutHeight));
        },
        sourceItemCount: params.items.length,
    };
}
