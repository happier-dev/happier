import type { NativeListFactReaders, TranscriptViewportFactSource } from './transcriptViewportFacts';

function resolveGeometry(
    readers: NativeListFactReaders,
    override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>,
): Readonly<{ contentHeight: number; layoutHeight: number }> | null {
    const layoutHeight = typeof override?.layoutHeight === 'number' && Number.isFinite(override.layoutHeight)
        ? override.layoutHeight
        : readers.readLayoutHeight();
    const contentHeight = typeof override?.contentHeight === 'number' && Number.isFinite(override.contentHeight)
        ? override.contentHeight
        : readers.readContentHeight();
    if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
    return { contentHeight, layoutHeight };
}

function resolveMaxOffset(input: Readonly<{ contentHeight: number; layoutHeight: number }>): number {
    return Math.max(0, Math.trunc(input.contentHeight - input.layoutHeight));
}

function resolveStandardDistanceFromLiveTail(input: Readonly<{
    contentHeight: number;
    layoutHeight: number;
    rawOffsetY: number;
}>): number {
    return Math.max(0, resolveMaxOffset(input) - Math.max(0, Math.trunc(input.rawOffsetY)));
}

function mapRenderedIndexToSourceIndex(readers: NativeListFactReaders, renderedIndex: number): number | null {
    if (!Number.isInteger(renderedIndex) || renderedIndex < 0) return null;
    const sourceIndex = readers.readSourceIndexForRenderedIndex?.(renderedIndex);
    if (typeof sourceIndex === 'number' && Number.isInteger(sourceIndex) && sourceIndex >= 0) {
        return sourceIndex;
    }
    const renderedItemCount = readers.readRenderedItemCount?.() ?? 0;
    if (!Number.isInteger(renderedItemCount) || renderedItemCount <= 0 || renderedIndex >= renderedItemCount) {
        return null;
    }
    return renderedIndex;
}

export function createNativeStandardListFactSource(
    readers: NativeListFactReaders,
): TranscriptViewportFactSource {
    return {
        getContentMetrics(override) {
            const geometry = resolveGeometry(readers, override);
            if (!geometry) return null;
            const normalizedContentHeight = Math.max(0, geometry.contentHeight);
            const normalizedLayoutHeight = Math.max(0, geometry.layoutHeight);
            return {
                contentHeight: normalizedContentHeight,
                layoutHeight: normalizedLayoutHeight,
                scrollable: normalizedContentHeight > normalizedLayoutHeight,
            };
        },
        getVisibleSourceRange() {
            const renderedRange = readers.readRenderedVisibleRange?.();
            const range = renderedRange
                ? {
                    startIndex: renderedRange.startIndex,
                    endIndex: renderedRange.endIndex,
                }
                : (() => {
                    const firstVisibleRenderedIndex = readers.readFirstVisibleRenderedIndex?.();
                    return typeof firstVisibleRenderedIndex === 'number'
                        ? { startIndex: firstVisibleRenderedIndex, endIndex: firstVisibleRenderedIndex }
                        : null;
                })();
            if (!range) return null;
            if (
                !Number.isInteger(range.startIndex) ||
                !Number.isInteger(range.endIndex) ||
                range.startIndex < 0 ||
                range.endIndex < 0 ||
                range.startIndex > range.endIndex
            ) return null;

            const startSourceIndex = mapRenderedIndexToSourceIndex(readers, range.startIndex);
            const endSourceIndex = mapRenderedIndexToSourceIndex(readers, range.endIndex);
            if (startSourceIndex === null || endSourceIndex === null) return null;
            return {
                firstSourceIndex: Math.min(startSourceIndex, endSourceIndex),
                lastSourceIndex: Math.max(startSourceIndex, endSourceIndex),
            };
        },
        resolveReachedEdge(edge) {
            return edge === 'start' ? 'older' : 'newer';
        },
        getDistanceFromLiveTail(override) {
            const offset = readers.readRawScrollOffset();
            if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
            const geometry = resolveGeometry(readers, override);
            if (!geometry) return null;
            return resolveStandardDistanceFromLiveTail({
                ...geometry,
                rawOffsetY: offset,
            });
        },
        toCanonicalOffset(rawOffsetY) {
            return Math.max(0, Math.trunc(rawOffsetY));
        },
        resolveObservedOffset(rawOffsetY, override) {
            if (typeof rawOffsetY !== 'number' || !Number.isFinite(rawOffsetY)) return null;
            const geometry = resolveGeometry(readers, override);
            if (!geometry) return null;
            const canonicalOffsetY = Math.max(0, Math.trunc(rawOffsetY));
            const maxOffsetY = resolveMaxOffset(geometry);
            return {
                rawOffsetY,
                canonicalOffsetY,
                distanceFromLiveTailPx: resolveStandardDistanceFromLiveTail({
                    ...geometry,
                    rawOffsetY,
                }),
                isAtRawLiveTail: Math.abs(canonicalOffsetY - maxOffsetY) <= 1,
            };
        },
    };
}
