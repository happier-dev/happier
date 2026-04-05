import { useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSpring, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';

export type UseSessionInlineDragParams = Readonly<{
    sessionKey: string | null;
    groupKey: string;
    rowHeight: number;
    enabled?: boolean;
    onDragStart: (sessionKey: string) => void;
    /**
     * Called once when the drag gesture ends (or is cancelled).
     * `positionDelta` is the number of positions the item should move
     * (positive = down, negative = up, 0 = no change).
     *
     * The reorder is deferred to drag-end so that the FlatList data never
     * changes while the gesture is active. Changing data mid-gesture causes
     * React's keyed reconciliation to unmount/remount the dragged item's DOM
     * node, which releases pointer capture and kills the Pan gesture.
     */
    onDragEnd: (sessionKey: string, groupKey: string, positionDelta: number) => void;
    /** Flat-list data index of this row (used for drop indicator computation). */
    dataIndex: number;
    /** Total number of items in the FlatList data array. */
    totalItemCount: number;
    /**
     * Shared value written by the dragging row to tell all rows which
     * flat-list index should display the drop indicator. `-1` = hidden.
     */
    dropIndicatorIdx: SharedValue<number>;
    /**
     * `0` = show indicator at the top edge of the target row,
     * `1` = show indicator at the bottom edge (used when inserting after the last item).
     */
    dropIndicatorEdge: SharedValue<number>;
    /**
     * Optional: require a long-press before the drag gesture activates (native UX).
     * When omitted, dragging activates immediately on pointer movement (web handle UX).
     */
    activateAfterLongPressMs?: number;
    /**
     * Optional: invoked when a long-press activates the gesture (native UX).
     * This is intended for opening a context menu *during* the long-press.
     *
     * Callers should still be prepared to cancel/close the menu if the user
     * begins dragging to reorder.
     */
    onLongPressActivated?: (sessionKey: string) => void;
}>;

export type UseSessionInlineDragResult = Readonly<{
    gesture: GestureType | ComposedGesture | undefined;
    animatedStyle: AnimatedStyle<ViewStyle>;
}>;

export function useSessionInlineDrag(params: UseSessionInlineDragParams): UseSessionInlineDragResult {
    const {
        sessionKey,
        groupKey,
        rowHeight,
        enabled = true,
        onDragStart,
        onDragEnd,
        dataIndex,
        totalItemCount,
        dropIndicatorIdx,
        dropIndicatorEdge,
        activateAfterLongPressMs,
        onLongPressActivated,
    } = params;
    const { theme } = useUnistyles();
    const dragLiftShadow = theme.colors.shadowLevels[5];

    // Use refs for callbacks so the gesture object is never recreated when
    // callbacks change. This keeps the active Pan gesture alive.
    const onDragStartRef = useRef(onDragStart);
    onDragStartRef.current = onDragStart;
    const onDragEndRef = useRef(onDragEnd);
    onDragEndRef.current = onDragEnd;
    const onLongPressActivatedRef = useRef(onLongPressActivated);
    onLongPressActivatedRef.current = onLongPressActivated;

    const translateY = useSharedValue(0);
    const isDragging = useSharedValue(false);
    const scale = useSharedValue(1);
    const didEnd = useSharedValue(false);
    const didStartDrag = useSharedValue(false);

    const gesture = useMemo(() => {
        if (!sessionKey || enabled === false) return undefined;

        // Wrap ref reads in plain functions so the worklet can schedule them on
        // the JS thread. The ref.current is always the latest callback.
        const fireDragStart = (sk: string) => {
            onDragStartRef.current(sk);
        };
        const fireDragEnd = (sk: string, gk: string, delta: number) => {
            onDragEndRef.current(sk, gk, delta);
        };
        const fireLongPressActivated = (sk: string) => {
            onLongPressActivatedRef.current?.(sk);
        };

        const requiresLongPress = typeof activateAfterLongPressMs === 'number';

        // Pan drives the actual drag/reorder. On native we delay its activation with
        // `activateAfterLongPress(...)` so the list can still scroll naturally.
        let pan = Gesture.Pan().minDistance(requiresLongPress ? 0 : 4);
        if (typeof activateAfterLongPressMs === 'number') {
            const panWithLongPress = pan as unknown as { activateAfterLongPress?: (ms: number) => typeof pan };
            if (typeof panWithLongPress.activateAfterLongPress === 'function') {
                // Call as a method (not extracted) so `this` binding is preserved.
                pan = panWithLongPress.activateAfterLongPress(activateAfterLongPressMs);
            }
        }

        const dragStartThreshold = requiresLongPress ? 8 : 0;

        const panGesture = pan
            .onStart(() => {
                'worklet';
                translateY.value = 0;
                didEnd.value = false;
                didStartDrag.value = false;
            })
            .onUpdate((e) => {
                'worklet';
                if (!didStartDrag.value) {
                    if (Math.abs(e.translationY) < dragStartThreshold) return;
                    didStartDrag.value = true;
                    isDragging.value = true;
                    scale.value = withSpring(1.03);
                    scheduleOnRN(fireDragStart, sessionKey);
                }
                // Free movement — no snapping, no real-time data reorder.
                // The item follows the pointer exactly.
                translateY.value = e.translationY;

                // Compute which row should show the drop indicator line.
                const delta = Math.round(e.translationY / rowHeight);
                if (delta === 0) {
                    dropIndicatorIdx.value = -1;
                } else if (delta > 0) {
                    // Moving DOWN: indicator goes on the top edge of the row
                    // *after* the last row we'd displace, i.e. originIdx + delta + 1.
                    const targetRow = dataIndex + delta + 1;
                    if (targetRow < totalItemCount) {
                        dropIndicatorIdx.value = targetRow;
                        dropIndicatorEdge.value = 0; // top
                    } else {
                        // Past the end — show bottom border on the last item.
                        dropIndicatorIdx.value = totalItemCount - 1;
                        dropIndicatorEdge.value = 1; // bottom
                    }
                } else {
                    // Moving UP: indicator goes on the top edge of the
                    // destination row.
                    dropIndicatorIdx.value = dataIndex + delta;
                    dropIndicatorEdge.value = 0; // top
                }
            })
            .onEnd(() => {
                'worklet';
                const positionDelta = Math.round(translateY.value / rowHeight);
                const didDrag = didStartDrag.value === true;

                // Reset immediately — the reorder callback will commit the new
                // position, so the item should snap to its slot once React
                // re-renders with the updated data.
                translateY.value = 0;
                scale.value = withSpring(1);
                didEnd.value = true;
                dropIndicatorIdx.value = -1;
                didStartDrag.value = false;
                isDragging.value = false;
                if (didDrag) {
                    scheduleOnRN(fireDragEnd, sessionKey, groupKey, positionDelta);
                }
            })
            .onFinalize(() => {
                'worklet';
                // Covers gesture cancel / system interrupt.
                // Skip if onEnd already handled it.
                if (didEnd.value) {
                    didEnd.value = false;
                    return;
                }
                const positionDelta = Math.round(translateY.value / rowHeight);
                const didDrag = didStartDrag.value === true;
                translateY.value = 0;
                scale.value = withSpring(1);
                dropIndicatorIdx.value = -1;
                didStartDrag.value = false;
                isDragging.value = false;
                if (didDrag) {
                    scheduleOnRN(fireDragEnd, sessionKey, groupKey, positionDelta);
                }
            });

        // `activateAfterLongPress` on Pan only fires once the user starts moving, which
        // is perfect for reordering but too late for showing a context menu.
        // Add a dedicated LongPress gesture so callers can open a menu while the
        // user is still holding the row down (before lifting their finger).
        if (!requiresLongPress || typeof activateAfterLongPressMs !== 'number') return panGesture;

        const longPressGesture = Gesture.LongPress()
            .minDuration(activateAfterLongPressMs)
            .maxDistance(10)
            .onStart(() => {
                'worklet';
                scheduleOnRN(fireLongPressActivated, sessionKey);
            });

        return Gesture.Simultaneous(longPressGesture, panGesture);
    // Only recreate when the row's identity or size changes — NOT when callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, sessionKey, groupKey, rowHeight, dataIndex, totalItemCount]);

    const animatedStyle = useAnimatedStyle<ViewStyle>(() => {
        if (!enabled) {
            return {
                position: 'relative' as const,
                transform: [{ translateY: 0 }, { scale: 1 }],
                zIndex: 0,
                shadowColor: dragLiftShadow.shadowColor,
                shadowOffset: dragLiftShadow.shadowOffset,
                shadowOpacity: 0,
                shadowRadius: 0,
                elevation: 0,
            };
        }
        return {
            // position: 'relative' is needed on web for zIndex to create a stacking context
            position: 'relative' as const,
            transform: [{ translateY: translateY.value }, { scale: scale.value }],
            zIndex: isDragging.value ? 1000 : 0,
            // Always write shadow props so they reliably clear after the drag ends.
            shadowColor: dragLiftShadow.shadowColor,
            shadowOffset: dragLiftShadow.shadowOffset,
            shadowOpacity: isDragging.value ? dragLiftShadow.shadowOpacity : 0,
            shadowRadius: isDragging.value ? dragLiftShadow.shadowRadius : 0,
            elevation: isDragging.value ? dragLiftShadow.elevation : 0,
        };
    });

    return { gesture, animatedStyle };
}
