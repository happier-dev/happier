import * as React from 'react';

type ScrollToOffset = (params: { offset: number; animated?: boolean }) => void;
type ScrollToIndex = (params: {
    index: number;
    animated?: boolean;
    viewOffset?: number;
    viewPosition?: number;
}) => void;

type SessionListViewabilityInfo = Readonly<{
    viewableItems: readonly Readonly<{
        item?: unknown;
        index?: number | null;
        isViewable?: boolean;
    }>[];
}>;

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
    anchor: {
        nodeId: string;
        viewportOffset: number;
        measurementGeneration: number;
        measured: boolean;
    } | null;
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
        anchor: null,
    };
    retainedScrollByKey.set(retentionKey, entry);
    return entry;
}

export function releaseSessionListScrollRetention(retentionKey: string): boolean {
    return retainedScrollByKey.delete(retentionKey);
}

export function resetSessionListScrollRetentionForTests(): void {
    retainedScrollByKey.clear();
}

export function useSessionListScrollRetention(params: Readonly<{
    retentionKey: string;
    scrollToOffset: ScrollToOffset;
    scrollToIndex?: ScrollToIndex;
    nodeIds?: readonly string[];
    measureNodeViewportOffset?: (nodeId: string) => Promise<number | null>;
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
    // Native event handlers stay stable and read activity when delivered, including
    // callbacks already held when the list becomes inactive.
    const surfaceActiveRef = React.useRef(surfaceActive);
    surfaceActiveRef.current = surfaceActive;
    const retentionKeyRef = React.useRef(params.retentionKey);
    retentionKeyRef.current = params.retentionKey;
    const scrollToOffsetRef = React.useRef(params.scrollToOffset);
    scrollToOffsetRef.current = params.scrollToOffset;
    const scrollToIndexRef = React.useRef(params.scrollToIndex);
    scrollToIndexRef.current = params.scrollToIndex;
    const measureNodeViewportOffsetRef = React.useRef(params.measureNodeViewportOffset);
    measureNodeViewportOffsetRef.current = params.measureNodeViewportOffset;
    const retentionEntry = React.useMemo(
        () => getScrollRetentionEntry(params.retentionKey),
        [params.retentionKey],
    );

    const visibleViewportHeightRef = React.useRef(0);
    const contentHeightRef = React.useRef<number | null>(null);
    const pendingMembershipRestoreRef = React.useRef<Readonly<{
        retentionKey: string;
        nodeId: string;
        targetIndex: number;
        measurementGeneration: number;
    }> | null>(null);

    const restorePendingMembershipAnchor = React.useCallback(() => {
        const pending = pendingMembershipRestoreRef.current;
        const anchor = retentionEntry.anchor;
        if (!pending || !anchor || !anchor.measured) return;
        if (
            pending.retentionKey !== retentionKeyRef.current
            || pending.nodeId !== anchor.nodeId
            || pending.measurementGeneration !== anchor.measurementGeneration
        ) return;
        pendingMembershipRestoreRef.current = null;
        if (!surfaceActiveRef.current) return;
        scrollToIndexRef.current?.({
            index: pending.targetIndex,
            animated: false,
            viewOffset: anchor.viewportOffset,
            viewPosition: 0,
        });
    }, [retentionEntry]);

    const handleViewableItemsChanged = React.useCallback((info: SessionListViewabilityInfo) => {
        if (!surfaceActiveRef.current) return;
        const firstVisibleSession = [...info.viewableItems]
            .filter((token) => token.isViewable !== false)
            .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER))
            .map((token) => token.item)
            .find((item): item is Readonly<{ id: string }> => (
                typeof item === 'object'
                && item !== null
                && typeof (item as { id?: unknown }).id === 'string'
                && (item as { id: string }).id.startsWith('session:')
            ));
        if (!firstVisibleSession) {
            retentionEntry.anchor = null;
            return;
        }

        const previousGeneration = retentionEntry.anchor?.measurementGeneration ?? 0;
        const anchor = {
            nodeId: firstVisibleSession.id,
            viewportOffset: 0,
            measurementGeneration: previousGeneration + 1,
            measured: measureNodeViewportOffsetRef.current === undefined,
        };
        retentionEntry.anchor = anchor;
        if (anchor.measured) {
            restorePendingMembershipAnchor();
            return;
        }
        void Promise.resolve()
            .then(() => measureNodeViewportOffsetRef.current?.(anchor.nodeId) ?? null)
            .then(
                (measuredOffset) => {
                    if (retentionEntry.anchor !== anchor) return;
                    anchor.viewportOffset = readFiniteNumber(measuredOffset) ?? 0;
                    anchor.measured = true;
                    restorePendingMembershipAnchor();
                },
                () => {
                    if (retentionEntry.anchor !== anchor) return;
                    anchor.viewportOffset = 0;
                    anchor.measured = true;
                    restorePendingMembershipAnchor();
                },
            );
    }, [restorePendingMembershipAnchor, retentionEntry]);

    const previousMembershipRef = React.useRef<Readonly<{
        retentionKey: string;
        nodeIds: readonly string[];
    }> | null>(null);
    React.useEffect(() => {
        const nextNodeIds = params.nodeIds;
        if (!nextNodeIds || !params.scrollToIndex) return;
        const previous = previousMembershipRef.current;
        previousMembershipRef.current = { retentionKey: params.retentionKey, nodeIds: nextNodeIds };
        if (!previous || previous.retentionKey !== params.retentionKey) {
            pendingMembershipRestoreRef.current = null;
            return;
        }
        if (
            previous.nodeIds.length === nextNodeIds.length
            && previous.nodeIds.every((nodeId, index) => nodeId === nextNodeIds[index])
        ) return;

        const anchor = retentionEntry.anchor;
        if (!anchor) return;
        const targetIndex = nextNodeIds.indexOf(anchor.nodeId);
        if (targetIndex < 0) {
            pendingMembershipRestoreRef.current = null;
            if (surfaceActive) {
                scrollToOffsetRef.current({ offset: 0, animated: false });
            }
            return;
        }
        // Reordering below the visible anchor does not change its content position.
        // Reissuing scrollToIndex here would move an already-correct viewport.
        if (previous.nodeIds.indexOf(anchor.nodeId) === targetIndex
            && previous.nodeIds.slice(0, targetIndex).every((nodeId, index) => nodeId === nextNodeIds[index])) return;
        pendingMembershipRestoreRef.current = {
            retentionKey: params.retentionKey,
            nodeId: anchor.nodeId,
            targetIndex,
            measurementGeneration: anchor.measurementGeneration,
        };
        restorePendingMembershipAnchor();
    }, [params.nodeIds, params.retentionKey, params.scrollToIndex, restorePendingMembershipAnchor, retentionEntry, surfaceActive]);

    const handleScrollInteractionStart = React.useCallback(() => {
        pendingMembershipRestoreRef.current = null;
    }, []);

    React.useEffect(() => () => {
        if (visibleViewportHeightRef.current <= 0) return;
        if (retentionEntry.lastVisibleOffsetY <= 0) return;
        retentionEntry.restorePending = true;
    }, [retentionEntry]);

    const handleScroll = React.useCallback((event: SessionListScrollRetentionScrollEvent) => {
        // An inactive surface's scroll events are not the reader's intent.
        if (!surfaceActiveRef.current) return;
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
        handleScrollInteractionStart,
        handleViewableItemsChanged,
    }), [handleLayout, handleScroll, handleScrollInteractionStart, handleViewableItemsChanged]);
}
