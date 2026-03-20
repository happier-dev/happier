import { useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSpring, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

export type UseSessionInlineDragParams = Readonly<{
    sessionKey: string | null;
    groupKey: string;
    rowHeight: number;
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
}>;

export type UseSessionInlineDragResult = Readonly<{
    gesture: GestureType | undefined;
    animatedStyle: AnimatedStyle<ViewStyle>;
}>;

export function useSessionInlineDrag(params: UseSessionInlineDragParams): UseSessionInlineDragResult {
    const { sessionKey, groupKey, rowHeight, onDragStart, onDragEnd, dataIndex, totalItemCount, dropIndicatorIdx, dropIndicatorEdge } = params;

    // Use refs for callbacks so the gesture object is never recreated when
    // callbacks change. This keeps the active Pan gesture alive.
    const onDragStartRef = useRef(onDragStart);
    onDragStartRef.current = onDragStart;
    const onDragEndRef = useRef(onDragEnd);
    onDragEndRef.current = onDragEnd;

    const translateY = useSharedValue(0);
    const isDragging = useSharedValue(false);
    const scale = useSharedValue(1);
    const didEnd = useSharedValue(false);

    const gesture = useMemo(() => {
        if (!sessionKey) return undefined;

        // Wrap ref reads in plain functions so the worklet can schedule them on
        // the JS thread. The ref.current is always the latest callback.
        const fireDragStart = (sk: string) => {
            onDragStartRef.current(sk);
        };
        const fireDragEnd = (sk: string, gk: string, delta: number) => {
            onDragEndRef.current(sk, gk, delta);
        };

        return Gesture.Pan()
            .minDistance(4)
            .onStart(() => {
                'worklet';
                isDragging.value = true;
                translateY.value = 0;
                scale.value = withSpring(1.03);
                didEnd.value = false;
                scheduleOnRN(fireDragStart, sessionKey);
            })
            .onUpdate((e) => {
                'worklet';
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
                // Compute how many positions the item moved based on gesture offset.
                const positionDelta = Math.round(translateY.value / rowHeight);

                isDragging.value = false;
                // Reset immediately — the reorder callback will commit the new
                // position, so the item should snap to its slot once React
                // re-renders with the updated data.
                translateY.value = 0;
                scale.value = withSpring(1);
                didEnd.value = true;
                dropIndicatorIdx.value = -1;
                scheduleOnRN(fireDragEnd, sessionKey, groupKey, positionDelta);
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
                isDragging.value = false;
                translateY.value = 0;
                scale.value = withSpring(1);
                dropIndicatorIdx.value = -1;
                scheduleOnRN(fireDragEnd, sessionKey, groupKey, positionDelta);
            });
    // Only recreate when the row's identity or size changes — NOT when callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey, groupKey, rowHeight, dataIndex, totalItemCount]);

    const animatedStyle = useAnimatedStyle<ViewStyle>(() => {
        if (!isDragging.value && translateY.value === 0 && scale.value === 1) {
            return {};
        }
        return {
            // position: 'relative' is needed on web for zIndex to create a stacking context
            position: 'relative' as const,
            transform: [{ translateY: translateY.value }, { scale: scale.value }],
            zIndex: isDragging.value ? 1000 : 0,
            ...(isDragging.value
                ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 8 }
                : {}),
        };
    });

    return { gesture, animatedStyle };
}
