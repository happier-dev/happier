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
     * Opening a session deactivates the list underneath while it keeps rendering. MEASURED in
     * remote-dev: the platform then moves the native scroll view and reports it as an ordinary
     * scroll event - `y: 0` in some runs, `y: -9999055` in others, both with a valid contentSize and
     * layoutMeasurement. Nothing about the value distinguishes it from the reader scrolling to the
     * top, so only the surface state can, and recording it overwrites the reader's place with the
     * platform's.
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
        // An inactive surface's scroll events are not the reader's intent.
        if (!surfaceActive) return;
        const offsetY = readFiniteNumber(event.nativeEvent?.contentOffset?.y);
        if (offsetY == null) return;

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
        // The reader is scrolling this surface right now, so any pending restore is void. Reported
        // in remote-dev: a restore landing mid-gesture yanks them back to the old position, which is
        // worse than the stale position it was trying to fix.
        retentionEntry.restorePending = false;
    }, [retentionEntry, surfaceActive]);

    const handleLayout = React.useCallback((event: SessionListScrollRetentionLayoutEvent) => {
        const height = event.nativeEvent?.layout?.height;
        if (typeof height !== 'number' || !Number.isFinite(height)) return;

        const wasVisible = visibleViewportHeightRef.current > 0;
        const nextHeight = Math.max(0, height);
        visibleViewportHeightRef.current = nextHeight;

        if (nextHeight <= 0) {
            if (retentionEntry.lastVisibleOffsetY > 0) {
                retentionEntry.restorePending = true;
            }
            return;
        }

        if (!wasVisible && retentionEntry.restorePending && retentionEntry.lastVisibleOffsetY > 0) {
            retentionEntry.restorePending = false;
            const restoredOffsetY = resolveRetainableScrollOffset({
                contentHeight: contentHeightRef.current,
                offsetY: retentionEntry.lastVisibleOffsetY,
                viewportHeight: nextHeight,
            });
            if (restoredOffsetY == null || restoredOffsetY <= 0) return;
            scrollToOffsetRef.current({ offset: restoredOffsetY, animated: false });
        }
    }, [retentionEntry]);

    return React.useMemo(() => ({
        handleLayout,
        handleScroll,
    }), [handleLayout, handleScroll]);
}
