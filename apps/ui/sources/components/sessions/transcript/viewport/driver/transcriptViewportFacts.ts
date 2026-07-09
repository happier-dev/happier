/**
 * C3 DRIVER FACT SEAM — the orientation-agnostic boundary between the transcript host and the platform
 * scroll physics (native inverted FlashList / web standard DOM).
 *
 * Above this seam the host holds only semantic FACTS (read) and issues semantic COMMANDS; below it the
 * platform drivers own the raw scroll primitives. Native fact readers are command-space specific; web DOM
 * raw scrollTop identity stays outside this native fact source.
 *
 * The G1 lint rule (added once the surface is complete) forbids raw scroll primitives above this seam:
 * `scrollTop`, `scrollToIndex`, `scrollToOffset`, `viewOffset`, `isInverted`, `getAbsoluteLastScrollOffset`,
 * and any `contentHeight - layoutHeight - offset` math.
 *
 * This file grows incrementally (C3 steps A→…): STEP A introduces the read-FACT surface
 * (`TranscriptViewportFactSource`). Later steps add the remaining facts (gestureActive, …) and the COMMAND surface
 * (scrollToLiveTail, scrollToAnchor, scrollToSeq,
 * applyHistoryCorrection, setBottomMaintenance, …) by extending these types — NOT by adding a competing path
 * alongside the existing `viewport/` controller spine (see `../createTranscriptViewportCommandController.ts`).
 */
export interface TranscriptViewportFactSource {
    /**
     * Canonical px distance from the visual live-tail edge (0 = pinned at the bottom). `null` = unknown
     * (no measured native offset, or zero/unmeasured layout). This is the ONLY upward expression of the
     * raw native offset mapping: callers never read `getAbsoluteLastScrollOffset` or
     * raw-to-canonical conversion helpers directly. `override` lets a caller supply freshly-measured content/layout
     * heights (e.g. during a content-size change before the refs settle).
     */
    getDistanceFromLiveTail(override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>): number | null;

    /**
     * Orientation-agnostic content/layout geometry. This is the read-side choke point for code that only
     * needs to know whether the list has measured content, measured viewport, and whether it can scroll.
     * It deliberately does not expose raw offset. `null` means the layout geometry is not usable yet.
     */
    getContentMetrics(override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>): TranscriptViewportContentMetrics | null;

    /**
     * Canonical oldest-first source range for the currently visible rendered rows. Platform/rendered index
     * polarity stays private to the driver; callers above the seam never interpret inverted rendered indices.
     * `null` means the list cannot report a reliable visible range yet.
     */
    getVisibleSourceRange(): TranscriptViewportVisibleSourceRange | null;

    /**
     * Map a rendered list edge callback (`onStartReached` / `onEndReached`) to the semantic transcript edge.
     * Inverted/native polarity remains private to the driver.
     */
    resolveReachedEdge(edge: TranscriptViewportRenderedEdge): TranscriptViewportSemanticEdge;

    /**
     * Map a raw native scroll offset to the CANONICAL (0 = oldest edge) offset. Web DOM
     * scrollTop identity is handled before this method is reached.
     */
    toCanonicalOffset(rawOffsetY: number, override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>): number;

    /**
     * Normalize one native raw scroll observation into the semantic facts the host needs. Native raw
     * offset math and live-tail detection stay below this seam; callers above it consume canonical offset,
     * distance-from-live-tail, and raw-live-tail state as a single consistent snapshot.
     */
    resolveObservedOffset(
        rawOffsetY: number,
        override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>,
    ): TranscriptViewportObservedOffset | null;
}

export type TranscriptViewportContentMetrics = Readonly<{
    contentHeight: number;
    layoutHeight: number;
    scrollable: boolean;
}>;

export type TranscriptViewportVisibleSourceRange = Readonly<{
    firstSourceIndex: number;
    lastSourceIndex: number;
}>;

export type TranscriptViewportObservedOffset = Readonly<{
    rawOffsetY: number;
    canonicalOffsetY: number;
    distanceFromLiveTailPx: number;
    isAtRawLiveTail: boolean;
}>;

export type TranscriptViewportRenderedEdge = 'start' | 'end';

export type TranscriptViewportSemanticEdge = 'older' | 'newer';

/**
 * The read accessors native fact drivers need from the host: closures over the list ref and
 * the measured geometry refs. Passing closures (rather than the refs themselves) keeps the driver pure and
 * unit-testable without React, and keeps the raw `getAbsoluteLastScrollOffset` call on the host side of the
 * closure boundary so the driver body never names a FlashList primitive type.
 */
export type NativeListFactReaders = Readonly<{
    /** `listRef.current?.getAbsoluteLastScrollOffset?.()` — the raw native scroll offset (undefined if unavailable). */
    readRawScrollOffset: () => number | undefined;
    /** The last measured content height (px). */
    readContentHeight: () => number;
    /** The last measured layout (viewport) height (px). */
    readLayoutHeight: () => number;
    /** `listRef.current?.computeVisibleIndices?.()` — rendered list indices, if the platform can compute them. */
    readRenderedVisibleRange?: () => Readonly<{ startIndex: number; endIndex: number }> | null | undefined;
    /** `listRef.current?.getFirstVisibleIndex?.()` fallback when the platform cannot compute a range. */
    readFirstVisibleRenderedIndex?: () => number | null | undefined;
    /** Number of rendered rows in the current list data. */
    readRenderedItemCount?: () => number;
    /**
     * Optional authoritative rendered-index -> canonical source-index remap. The host can provide this for
     * hot/cold slices where rendered item count is not the same as the full source item count.
     */
    readSourceIndexForRenderedIndex?: (renderedIndex: number) => number | null | undefined;
}>;

export type NativeInvertedFlashListFactReaders = NativeListFactReaders;
