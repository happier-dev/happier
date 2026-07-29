import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';
import { useAnimatedStyle, useSharedValue, withSpring, type AnimatedStyle } from 'react-native-reanimated';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';

import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';

const DRAGGED_ROW_OPACITY = 0.38;
const DRAG_LIFT_SCALE = 1.03;
const DRAG_ACTIVATE_MIN_DISTANCE = 4;

/** Fallback row height used before a row has reported its measured layout. */
export const DEFAULT_REORDER_ROW_HEIGHT = 56;

const STATIC_ROW_STYLE: ViewStyle = Object.freeze({ position: 'relative', transform: [{ translateY: 0 }, { scale: 1 }] });

/**
 * Moves `draggedId` to `targetIndex` within the flat id list. `targetIndex` is
 * an insertion position in the list WITHOUT the dragged id (0..others.length).
 */
export function reorderFlatIds(
    orderedIds: ReadonlyArray<string>,
    draggedId: string,
    targetIndex: number,
): string[] {
    const others = orderedIds.filter((id) => id !== draggedId);
    const clamped = Math.max(0, Math.min(targetIndex, others.length));
    return [...others.slice(0, clamped), draggedId, ...others.slice(clamped)];
}

export type FlatReorderTargetIndexParams = Readonly<{
    orderedIds: ReadonlyArray<string>;
    draggedId: string;
    rowHeights: ReadonlyMap<string, number>;
    /** Finger translation (px) along the list axis since drag start. */
    translationY: number;
    fallbackRowHeight?: number;
}>;

/**
 * Resolves the insertion index for a flat single-container reorder from the
 * dragged row's translation. Non-dragged rows keep their original screen slots;
 * the insertion point is the count of those rows whose midpoint sits above the
 * dragged row's (translated) center. Variable row heights are supported via the
 * measured `rowHeights` map.
 */
export function resolveFlatReorderTargetIndex(params: FlatReorderTargetIndexParams): number {
    const { orderedIds, draggedId, rowHeights, translationY } = params;
    const fallback = params.fallbackRowHeight ?? DEFAULT_REORDER_ROW_HEIGHT;

    const draggedIndex = orderedIds.indexOf(draggedId);
    if (draggedIndex < 0) return 0;

    const tops = new Map<string, number>();
    let acc = 0;
    for (const id of orderedIds) {
        tops.set(id, acc);
        acc += rowHeights.get(id) ?? fallback;
    }

    const draggedHeight = rowHeights.get(draggedId) ?? fallback;
    const draggedCenter = (tops.get(draggedId) ?? 0) + draggedHeight / 2 + translationY;

    let insertionIndex = 0;
    for (const id of orderedIds) {
        if (id === draggedId) continue;
        const center = (tops.get(id) ?? 0) + (rowHeights.get(id) ?? fallback) / 2;
        if (center < draggedCenter) insertionIndex += 1;
    }
    return insertionIndex;
}

export type UseListInlineReorderParams<T extends { id: string }> = Readonly<{
    items: ReadonlyArray<T>;
    enabled?: boolean;
    /** Numeric overlay shared values for the single list-level drop indicator. */
    overlayShared: TreeDropOverlaySharedValues;
    /** Commit the new order. Called on drag-end only when the order changed. */
    onCommitOrder: (orderedIds: string[]) => void | Promise<void>;
    fallbackRowHeight?: number;
}>;

export type UseListInlineReorderResult<T extends { id: string }> = Readonly<{
    /** Pan gesture for a row (index seeds the drag-start position), or `undefined` when disabled. */
    gestureForRow: (id: string, index?: number) => GestureType | undefined;
    /** Animated lift style for a row (active transform only on the dragged row). */
    animatedStyleForRow: (id: string) => AnimatedStyle<ViewStyle>;
    /** Report a row's measured layout so variable-height reorder math stays exact. */
    onRowLayout: (id: string, event: LayoutChangeEvent) => void;
    /** Frozen snapshot during a drag; live items otherwise. */
    frozenItems: ReadonlyArray<T>;
    /** Id of the row currently being dragged, or `null`. */
    draggingId: string | null;
}>;

export function useListInlineReorder<T extends { id: string }>(
    params: UseListInlineReorderParams<T>,
): UseListInlineReorderResult<T> {
    const { items, enabled = true, overlayShared, onCommitOrder, fallbackRowHeight } = params;
    const { theme } = useUnistyles();
    const dragLiftShadow = theme.colors.shadowLevels[5];

    const [draggingId, setDraggingId] = useState<string | null>(null);

    const itemsRef = useRef(items);
    itemsRef.current = items;
    const onCommitOrderRef = useRef(onCommitOrder);
    onCommitOrderRef.current = onCommitOrder;
    const overlaySharedRef = useRef(overlayShared);
    overlaySharedRef.current = overlayShared;
    const fallbackRowHeightRef = useRef(fallbackRowHeight);
    fallbackRowHeightRef.current = fallbackRowHeight;

    const frozenItemsRef = useRef<ReadonlyArray<T> | null>(null);
    const frozenIdsRef = useRef<string[] | null>(null);
    const pendingTargetIndexRef = useRef(0);
    const rowLayoutsRef = useRef(new Map<string, { width: number; height: number }>());

    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const isDragging = useSharedValue(false);
    const didEnd = useSharedValue(false);

    const hideOverlay = useCallback(() => {
        const target = overlaySharedRef.current;
        target.overlayVisible.value = 0;
        target.overlayKind.value = TREE_DROP_OVERLAY_KIND_NONE;
    }, []);

    const resetDragState = useCallback(() => {
        frozenItemsRef.current = null;
        frozenIdsRef.current = null;
        pendingTargetIndexRef.current = 0;
        setDraggingId(null);
    }, []);

    const beginDrag = useCallback((id: string, startIndex: number) => {
        const snapshot = itemsRef.current;
        frozenItemsRef.current = snapshot;
        const frozenIds = snapshot.map((item) => item.id);
        frozenIdsRef.current = frozenIds;
        // Seed the pending target with the dragged row's start position so a drop
        // without movement is a no-op. Prefer the caller-supplied render index;
        // fall back to a lookup if it is stale/out of range.
        pendingTargetIndexRef.current = startIndex >= 0 && startIndex < frozenIds.length
            ? startIndex
            : frozenIds.indexOf(id);
        setDraggingId(id);
    }, []);

    const updateDrag = useCallback((id: string, translationY: number) => {
        const frozenIds = frozenIdsRef.current;
        if (!frozenIds) return;

        const layouts = rowLayoutsRef.current;
        const rowHeights = new Map<string, number>();
        for (const [rowId, layout] of layouts) rowHeights.set(rowId, layout.height);

        const targetIndex = resolveFlatReorderTargetIndex({
            orderedIds: frozenIds,
            draggedId: id,
            rowHeights,
            translationY,
            fallbackRowHeight: fallbackRowHeightRef.current,
        });
        pendingTargetIndexRef.current = targetIndex;

        // Draw the drop line at the boundary above the insertion slot.
        const fallback = fallbackRowHeightRef.current ?? DEFAULT_REORDER_ROW_HEIGHT;
        const others = frozenIds.filter((rowId) => rowId !== id);
        let boundaryTop = 0;
        for (let i = 0; i < targetIndex && i < others.length; i += 1) {
            boundaryTop += layouts.get(others[i])?.height ?? fallback;
        }
        const draggedWidth = layouts.get(id)?.width ?? 0;
        const target = overlaySharedRef.current;
        target.overlayVisible.value = 1;
        target.overlayKind.value = TREE_DROP_OVERLAY_KIND_LINE;
        target.overlayTop.value = boundaryTop;
        target.overlayHeight.value = 2;
        target.overlayLeft.value = 0;
        target.overlayRight.value = draggedWidth;
        target.overlayDepth.value = 0;
    }, []);

    const completeDrag = useCallback((id: string) => {
        hideOverlay();
        const frozenIds = frozenIdsRef.current;
        const targetIndex = pendingTargetIndexRef.current;
        resetDragState();
        if (!frozenIds) return;
        const nextOrder = reorderFlatIds(frozenIds, id, targetIndex);
        const changed = nextOrder.length !== frozenIds.length
            || nextOrder.some((rowId, index) => rowId !== frozenIds[index]);
        if (changed) {
            void onCommitOrderRef.current(nextOrder);
        }
    }, [hideOverlay, resetDragState]);

    const cancelDrag = useCallback(() => {
        hideOverlay();
        resetDragState();
    }, [hideOverlay, resetDragState]);

    const onRowLayout = useCallback((id: string, event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        rowLayoutsRef.current.set(id, { width, height });
    }, []);

    const gestureForRow = useCallback((id: string, index = -1): GestureType | undefined => {
        if (!enabled) return undefined;
        return Gesture.Pan()
            .minDistance(DRAG_ACTIVATE_MIN_DISTANCE)
            .cancelsTouchesInView(false)
            .onStart(() => {
                'worklet';
                translateY.value = 0;
                didEnd.value = false;
                isDragging.value = true;
                scale.value = withSpring(DRAG_LIFT_SCALE);
                scheduleOnRN(beginDrag, id, index);
            })
            .onUpdate((event) => {
                'worklet';
                translateY.value = event.translationY;
                scheduleOnRN(updateDrag, id, event.translationY);
            })
            .onEnd(() => {
                'worklet';
                translateY.value = 0;
                scale.value = withSpring(1);
                isDragging.value = false;
                didEnd.value = true;
                scheduleOnRN(completeDrag, id);
            })
            .onFinalize(() => {
                'worklet';
                if (didEnd.value) {
                    didEnd.value = false;
                    return;
                }
                translateY.value = 0;
                scale.value = withSpring(1);
                isDragging.value = false;
                scheduleOnRN(cancelDrag);
            })
            .onTouchesCancelled(() => {
                'worklet';
                translateY.value = 0;
                scale.value = withSpring(1);
                isDragging.value = false;
                didEnd.value = true;
                scheduleOnRN(cancelDrag);
            });
    }, [enabled, beginDrag, updateDrag, completeDrag, cancelDrag, translateY, scale, isDragging, didEnd]);

    const dragAnimatedStyle = useAnimatedStyle<ViewStyle>(() => ({
        position: 'relative',
        // Force the transform back to identity the instant the drag ends. On web,
        // Reanimated writes inline styles that linger after the row swaps to the
        // static style, so relying on `scale.value` springing back to 1 leaves the
        // dropped row stuck at `scale(1.03)` (visibly overflowing its neighbours).
        // Gating on `isDragging` guarantees the last applied frame is identity.
        transform: isDragging.value
            ? [{ translateY: translateY.value }, { scale: scale.value }]
            : [{ translateY: 0 }, { scale: 1 }],
        zIndex: isDragging.value ? 1000 : 0,
        shadowColor: dragLiftShadow.shadowColor,
        shadowOffset: dragLiftShadow.shadowOffset,
        shadowOpacity: isDragging.value ? dragLiftShadow.shadowOpacity : 0,
        shadowRadius: isDragging.value ? dragLiftShadow.shadowRadius : 0,
        elevation: isDragging.value ? dragLiftShadow.elevation : 0,
        opacity: isDragging.value ? DRAGGED_ROW_OPACITY : 1,
    }));

    const animatedStyleForRow = useCallback(
        (id: string): AnimatedStyle<ViewStyle> => (id === draggingId ? dragAnimatedStyle : STATIC_ROW_STYLE),
        [draggingId, dragAnimatedStyle],
    );

    const frozenItems = draggingId !== null && frozenItemsRef.current ? frozenItemsRef.current : items;

    return {
        gestureForRow,
        animatedStyleForRow,
        onRowLayout,
        frozenItems,
        draggingId,
    };
}
