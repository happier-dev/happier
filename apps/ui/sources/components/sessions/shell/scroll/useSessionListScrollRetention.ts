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
}>) {
    const scrollToOffsetRef = React.useRef(params.scrollToOffset);
    scrollToOffsetRef.current = params.scrollToOffset;
    const retentionEntry = React.useMemo(
        () => getScrollRetentionEntry(params.retentionKey),
        [params.retentionKey],
    );

    const visibleViewportHeightRef = React.useRef(0);

    React.useEffect(() => () => {
        if (visibleViewportHeightRef.current <= 0) return;
        if (retentionEntry.lastVisibleOffsetY <= 0) return;
        retentionEntry.restorePending = true;
    }, [retentionEntry]);

    const handleScroll = React.useCallback((event: SessionListScrollRetentionScrollEvent) => {
        const offsetY = event.nativeEvent?.contentOffset?.y;
        if (typeof offsetY !== 'number' || !Number.isFinite(offsetY)) return;

        const measuredViewportHeight = event.nativeEvent?.layoutMeasurement?.height;
        const viewportHeight = typeof measuredViewportHeight === 'number' && Number.isFinite(measuredViewportHeight)
            ? measuredViewportHeight
            : visibleViewportHeightRef.current;
        if (viewportHeight <= 0) return;

        retentionEntry.lastVisibleOffsetY = Math.max(0, offsetY);
        if (retentionEntry.lastVisibleOffsetY === 0) {
            retentionEntry.restorePending = false;
        }
    }, [retentionEntry]);

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
            scrollToOffsetRef.current({ offset: retentionEntry.lastVisibleOffsetY, animated: false });
        }
    }, [retentionEntry]);

    return React.useMemo(() => ({
        handleLayout,
        handleScroll,
    }), [handleLayout, handleScroll]);
}
