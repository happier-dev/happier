import type { NativeInvertedFlashListFactReaders, TranscriptViewportFactSource } from './transcriptViewportFacts';
import {
    resolveNativeInvertedBottomRawOffset,
    toNativeInvertedCanonicalOffset,
} from './nativeInvertedRawScroll';

/**
 * Native INVERTED FlashList driver facts (C3) — the single owner of native inverted scroll physics: the raw
 * scroll offset and native inverted raw offset math. The host reads only the orientation-agnostic facts on
 * `TranscriptViewportFactSource`; no raw scroll primitive crosses the seam.
 *
 * STEP A introduces the read-FACT surface (`getDistanceFromLiveTail`). The math here is relocated verbatim
 * from the former host `ChatList#readCurrentNativeDistanceFromBottom` (behavior-preserving); subsequent C3
 * steps grow this factory into the full driver (contentMetrics / visibleSourceRange facts + the command
 * `perform` surface).
 */
export function createNativeInvertedFlashListFactSource(
    readers: NativeInvertedFlashListFactReaders,
): TranscriptViewportFactSource {
    const resolveGeometry = (override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>) => {
        const layoutHeight = typeof override?.layoutHeight === 'number' && Number.isFinite(override.layoutHeight)
            ? override.layoutHeight
            : readers.readLayoutHeight();
        const contentHeight = typeof override?.contentHeight === 'number' && Number.isFinite(override.contentHeight)
            ? override.contentHeight
            : readers.readContentHeight();
        if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        return { contentHeight, layoutHeight };
    };

    const mapRenderedIndexToSourceIndex = (renderedIndex: number): number | null => {
        if (!Number.isInteger(renderedIndex) || renderedIndex < 0) return null;
        const sourceIndex = readers.readSourceIndexForRenderedIndex?.(renderedIndex);
        if (typeof sourceIndex === 'number' && Number.isInteger(sourceIndex) && sourceIndex >= 0) {
            return sourceIndex;
        }
        const renderedItemCount = readers.readRenderedItemCount?.() ?? 0;
        if (!Number.isInteger(renderedItemCount) || renderedItemCount <= 0 || renderedIndex >= renderedItemCount) {
            return null;
        }
        return renderedItemCount - 1 - renderedIndex;
    };

    return {
        getContentMetrics(override) {
            const geometry = resolveGeometry(override);
            if (!geometry) return null;
            const { contentHeight, layoutHeight } = geometry;
            const normalizedContentHeight = Math.max(0, contentHeight);
            const normalizedLayoutHeight = Math.max(0, layoutHeight);
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

            const startSourceIndex = mapRenderedIndexToSourceIndex(range.startIndex);
            const endSourceIndex = mapRenderedIndexToSourceIndex(range.endIndex);
            if (startSourceIndex === null || endSourceIndex === null) return null;
            return {
                firstSourceIndex: Math.min(startSourceIndex, endSourceIndex),
                lastSourceIndex: Math.max(startSourceIndex, endSourceIndex),
            };
        },
        resolveReachedEdge(edge) {
            return edge === 'start' ? 'newer' : 'older';
        },
        getDistanceFromLiveTail(override) {
            const offset = readers.readRawScrollOffset();
            if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
            const geometry = resolveGeometry(override);
            if (!geometry) return null;
            const { contentHeight, layoutHeight } = geometry;
            const canonicalOffset = toNativeInvertedCanonicalOffset({
                rawOffsetY: offset,
                contentHeight,
                layoutHeight,
            });
            return Math.max(0, Math.trunc(contentHeight - layoutHeight - canonicalOffset));
        },
        toCanonicalOffset(rawOffsetY, override) {
            const geometry = resolveGeometry(override) ?? { contentHeight: 0, layoutHeight: 0 };
            const { contentHeight, layoutHeight } = geometry;
            return toNativeInvertedCanonicalOffset({
                rawOffsetY,
                contentHeight,
                layoutHeight,
            });
        },
        resolveObservedOffset(rawOffsetY, override) {
            if (typeof rawOffsetY !== 'number' || !Number.isFinite(rawOffsetY)) return null;
            const geometry = resolveGeometry(override);
            if (!geometry) return null;
            const { contentHeight, layoutHeight } = geometry;
            const canonicalOffsetY = toNativeInvertedCanonicalOffset({
                rawOffsetY,
                contentHeight,
                layoutHeight,
            });
            return {
                rawOffsetY,
                canonicalOffsetY,
                distanceFromLiveTailPx: Math.max(0, Math.trunc(contentHeight - layoutHeight - canonicalOffsetY)),
                isAtRawLiveTail: Math.abs(rawOffsetY - resolveNativeInvertedBottomRawOffset()) <= 1,
            };
        },
    };
}
