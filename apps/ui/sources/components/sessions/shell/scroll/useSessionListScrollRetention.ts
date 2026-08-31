import * as React from 'react';

type ScrollToOffset = (params: { offset: number; animated?: boolean }) => void;

type SessionListScrollRetentionLayoutEvent = Readonly<{
    nativeEvent?: {
        layout?: {
            height?: number;
        };
    };
}>;

type SessionListScrollRetentionScrollEvent = Readonly<{
    nativeEvent?: {
        contentOffset?: {
            y?: number;
        };
        contentSize?: {
            height?: number;
        };
        layoutMeasurement?: {
            height?: number;
        };
    };
}>;

type SessionListScrollRetentionEntry = {
    lastVisibleOffsetY: number;
    restorePending: boolean;
};

const retainedScrollByKey = new Map<string, SessionListScrollRetentionEntry>();
const SCROLL_OFFSET_TOLERANCE_PX = 2;

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveScrollableOffsetLimit(contentHeight: number | null, viewportHeight: number): number | null {
    if (contentHeight == null || contentHeight <= 0 || viewportHeight <= 0) return null;
    return Math.max(0, contentHeight - viewportHeight);
}

function resolveRetainableScrollOffset(params: Readonly<{
    contentHeight: number | null;
    offsetY: number;
    viewportHeight: number;
}>): number | null {
    if (params.offsetY < 0) return null;

    const maxOffset = resolveScrollableOffsetLimit(params.contentHeight, params.viewportHeight);
    if (maxOffset == null) return params.offsetY;
    if (params.offsetY > maxOffset + SCROLL_OFFSET_TOLERANCE_PX) return null;
    return Math.min(params.offsetY, maxOffset);
}

function getScrollRetentionEntry(retentionKey: string): SessionListScrollRetentionEntry {
    const existing = retainedScrollByKey.get(retentionKey);
    if (existing) return existing;
    const entry = {
        lastVisibleOffsetY: 0,
        restorePending: false,
    };
    retainedScrollByKey.set(retentionKey, entry);
    return entry;
}

export function useSessionListScrollRetention(params: Readonly<{
    retentionKey: string;
    scrollToOffset: ScrollToOffset;
    /**
     * Whether this surface is the live one. Defaults to true.
     *
     * Opening a session deactivates the list underneath. MEASURED on device: the native stack then
     * delivers exactly ONE scroll event for the list it is putting away, carrying either a parked
     * offset (-9999055) or a plain 0 - with a valid contentSize and layoutMeasurement either way.
     * Nothing about the value distinguishes it from the reader scrolling to the top, so only the
     * surface state can, and accepting it is what loses the reader's place before the screen has
     * even gone.
     *
     * This gates RECORDING only. It deliberately does not arm a restore: the viewport does not
     * collapse on this path (MEASURED: 716 throughout), so the reader was never actually moved, and
     * restoring on the way back yanks someone who has already started scrolling.
     */
    surfaceActive?: boolean;
}>) {
    const surfaceActive = params.surfaceActive !== false;
    const scrollToOffsetRef = React.useRef(params.scrollToOffset);
    scrollToOffsetRef.current = params.scrollToOffset;
    const retentionEntry = React.useMemo(
        () => getScrollRetentionEntry(params.retentionKey),
        [params.retentionKey],
    );

    const visibleViewportHeightRef = React.useRef(0);
    const contentHeightRef = React.useRef<number | null>(null);

    React.useEffect(() => () => {
        if (visibleViewportHeightRef.current <= 0) return;
        if (retentionEntry.lastVisibleOffsetY <= 0) return;
        retentionEntry.restorePending = true;
    }, [retentionEntry]);

    const handleScroll = React.useCallback((event: SessionListScrollRetentionScrollEvent) => {
        const offsetY = readFiniteNumber(event.nativeEvent?.contentOffset?.y);
        if (offsetY == null) return;

        if (!surfaceActive) {
            // An inactive surface's scroll events are not the reader's intent. Deactivating the
            // screen moves the native scroll view, and MEASURED on device that arrives as `y: 0` in
            // some runs and `y: -9999055` in others - indistinguishable by value from a real scroll
            // to the top, which is why only the surface state can reject it. Recording it would
            // overwrite the reader's place with the platform's.
            return;
        }

        const measuredContentHeight = readFiniteNumber(event.nativeEvent?.contentSize?.height);
        if (measuredContentHeight != null && measuredContentHeight > 0) {
            contentHeightRef.current = measuredContentHeight;
        }

        const measuredViewportHeight = readFiniteNumber(event.nativeEvent?.layoutMeasurement?.height);
        const viewportHeight = measuredViewportHeight != null
            ? measuredViewportHeight
            : visibleViewportHeightRef.current;
        if (viewportHeight <= 0) return;

        const retainedOffsetY = resolveRetainableScrollOffset({
            contentHeight: contentHeightRef.current,
            offsetY,
            viewportHeight,
        });
        if (retainedOffsetY == null) return;

        retentionEntry.lastVisibleOffsetY = retainedOffsetY;
        // The reader is scrolling this surface right now, so any pending restore is void. Without
        // this, coming back to the list and immediately scrolling yanks them to the old position
        // mid-gesture - a worse defect than the one the restore exists to fix.
        retentionEntry.restorePending = false;
    }, [retentionEntry, surfaceActive]);

    /**
     * A restore is armed by the position actually being LOST, which means this surface stopped
     * having a viewport at all - it collapsed to zero height, or the component unmounted (above).
     *
     * Deliberately NOT armed by the surface going data-inactive. Opening a session deactivates this
     * list while it keeps its viewport (MEASURED on device: 716 throughout), so nothing moved the
     * reader and there is nothing to put back. Arming there fires a restore exactly as the screen
     * returns, which yanks a reader who has already started scrolling - a worse defect than the
     * stale position it would be correcting.
     */
    const presentingRef = React.useRef(false);
    const evaluatePresentation = React.useCallback((viewportHeight: number) => {
        const presenting = viewportHeight > 0;
        const wasPresenting = presentingRef.current;
        presentingRef.current = presenting;

        if (!presenting) {
            if (retentionEntry.lastVisibleOffsetY > 0) {
                retentionEntry.restorePending = true;
            }
            return;
        }
        if (wasPresenting) return;
        if (!retentionEntry.restorePending || retentionEntry.lastVisibleOffsetY <= 0) return;

        retentionEntry.restorePending = false;
        const restoredOffsetY = resolveRetainableScrollOffset({
            contentHeight: contentHeightRef.current,
            offsetY: retentionEntry.lastVisibleOffsetY,
            viewportHeight,
        });
        if (restoredOffsetY == null || restoredOffsetY <= 0) return;
        scrollToOffsetRef.current({ offset: restoredOffsetY, animated: false });
    }, [retentionEntry]);

    const handleLayout = React.useCallback((event: SessionListScrollRetentionLayoutEvent) => {
        const height = event.nativeEvent?.layout?.height;
        if (typeof height !== 'number' || !Number.isFinite(height)) return;
        visibleViewportHeightRef.current = Math.max(0, height);
        evaluatePresentation(visibleViewportHeightRef.current);
    }, [evaluatePresentation]);

    return React.useMemo(() => ({
        handleLayout,
        handleScroll,
    }), [handleLayout, handleScroll]);
}
