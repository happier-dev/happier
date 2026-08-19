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
     * even gone. The viewport does NOT collapse on this path (scrollLength stayed 716 throughout),
     * which is why the height-based trigger alone never fired here.
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
     * One owner for "this surface is presenting". A surface is presenting when it is the live one
     * AND it has a real viewport; leaving that state arms the restore, entering it performs one.
     * Both the height-based path (a retained list collapsing to zero height) and the activity-based
     * path (a session opening on top) are the same transition, so they must not be two triggers.
     */
    const presentingRef = React.useRef(false);
    const evaluatePresentation = React.useCallback((viewportHeight: number, active: boolean) => {
        const presenting = active && viewportHeight > 0;
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

    React.useEffect(() => {
        evaluatePresentation(visibleViewportHeightRef.current, surfaceActive);
    }, [evaluatePresentation, surfaceActive]);

    const handleLayout = React.useCallback((event: SessionListScrollRetentionLayoutEvent) => {
        const height = event.nativeEvent?.layout?.height;
        if (typeof height !== 'number' || !Number.isFinite(height)) return;
        visibleViewportHeightRef.current = Math.max(0, height);
        evaluatePresentation(visibleViewportHeightRef.current, surfaceActive);
    }, [evaluatePresentation, surfaceActive]);

    return React.useMemo(() => ({
        handleLayout,
        handleScroll,
    }), [handleLayout, handleScroll]);
}
