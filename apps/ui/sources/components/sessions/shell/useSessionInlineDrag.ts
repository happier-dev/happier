import { useEffect, useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSpring, type AnimatedStyle } from 'react-native-reanimated';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';

import type { TreeDropResult, TreeInstructionVisual, WindowPointer } from '@/components/ui/treeDragDrop';

const DRAGGED_SESSION_ROW_OPACITY = 0.38;
export const SESSION_INLINE_DRAG_VISUAL_KIND_NONE = 0;
export const SESSION_INLINE_DRAG_VISUAL_KIND_LINE = 1;
export const SESSION_INLINE_DRAG_VISUAL_KIND_OUTLINE = 2;

const CONTEXT_MENU_LONG_PRESS_MAX_DISTANCE = 44;
const CONTEXT_MENU_TOUCH_CANCEL_DISTANCE = CONTEXT_MENU_LONG_PRESS_MAX_DISTANCE;

const IDLE_TREE_DROP_RESULT: TreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' }),
    visual: Object.freeze({ kind: 'none' }),
});

export type SessionInlineDragVisualKind =
    | typeof SESSION_INLINE_DRAG_VISUAL_KIND_NONE
    | typeof SESSION_INLINE_DRAG_VISUAL_KIND_LINE
    | typeof SESSION_INLINE_DRAG_VISUAL_KIND_OUTLINE;

export type SessionInlineDragMirroredValue<T> = {
    value: T;
};

export type SessionInlineDragVisualSharedValues = Readonly<{
    visualKind: SessionInlineDragMirroredValue<SessionInlineDragVisualKind>;
    visualTargetId: SessionInlineDragMirroredValue<string | null>;
    visualEdge: SessionInlineDragMirroredValue<'top' | 'bottom' | null>;
    visualDepth: SessionInlineDragMirroredValue<number>;
}>;

export type UseSessionInlineDragResolveDropResultEvent = Readonly<{
    sessionKey: string;
    groupKey: string;
    dataIndex: number;
    pointer: WindowPointer | null;
}>;

export type UseSessionInlineDragDropResultEvent = Readonly<{
    sessionKey: string;
    groupKey: string;
    dataIndex: number;
    result: TreeDropResult;
}>;

export type UseSessionInlineDragParams = Readonly<{
    sessionKey: string | null;
    groupKey: string;
    enabled?: boolean;
    onDragStart: (sessionKey: string) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => TreeDropResult;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    /** Flat-list data index of this row (used for drop indicator computation). */
    dataIndex: number;
    /** Minimal visual shared values mirrored from the canonical TreeDropResult. */
    dropVisual: SessionInlineDragVisualSharedValues;
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

function pointerFromAbsoluteCoordinates(absoluteX: number | null | undefined, absoluteY: number | null | undefined): WindowPointer | null {
    if (typeof absoluteX !== 'number' || typeof absoluteY !== 'number') return null;
    if (!Number.isFinite(absoluteX) || !Number.isFinite(absoluteY)) return null;
    return { x: absoluteX, y: absoluteY };
}

function visualKindForInstruction(visual: TreeInstructionVisual): SessionInlineDragVisualKind {
    if (visual.kind === 'line') return SESSION_INLINE_DRAG_VISUAL_KIND_LINE;
    if (visual.kind === 'outline') return SESSION_INLINE_DRAG_VISUAL_KIND_OUTLINE;
    return SESSION_INLINE_DRAG_VISUAL_KIND_NONE;
}

function mirrorDropVisual(target: SessionInlineDragVisualSharedValues, visual: TreeInstructionVisual): void {
    target.visualKind.value = visualKindForInstruction(visual);
    target.visualTargetId.value = visual.kind === 'line' || visual.kind === 'outline' ? visual.targetId : null;
    target.visualEdge.value = visual.kind === 'line' ? visual.edge : null;
    target.visualDepth.value = visual.kind === 'line' ? visual.depth : 0;
}

function clearDropVisual(target: SessionInlineDragVisualSharedValues): void {
    mirrorDropVisual(target, IDLE_TREE_DROP_RESULT.visual);
}

export function useSessionInlineDrag(params: UseSessionInlineDragParams): UseSessionInlineDragResult {
    const {
        sessionKey,
        groupKey,
        enabled = true,
        onDragStart,
        onDragUpdate,
        resolveDropResult,
        onDropResult,
        dataIndex,
        dropVisual,
        activateAfterLongPressMs,
        onLongPressActivated,
    } = params;
    const { theme } = useUnistyles();
    const dragLiftShadow = theme.colors.shadowLevels[5];

    // Use refs for callbacks so the gesture object is never recreated when
    // callbacks change. This keeps the active Pan gesture alive.
    const onDragStartRef = useRef(onDragStart);
    onDragStartRef.current = onDragStart;
    const onDragUpdateRef = useRef(onDragUpdate);
    onDragUpdateRef.current = onDragUpdate;
    const resolveDropResultRef = useRef(resolveDropResult);
    resolveDropResultRef.current = resolveDropResult;
    const onDropResultRef = useRef(onDropResult);
    onDropResultRef.current = onDropResult;
    const onLongPressActivatedRef = useRef(onLongPressActivated);
    onLongPressActivatedRef.current = onLongPressActivated;

    const contextMenuLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contextMenuLongPressStartRef = useRef<Readonly<{ absoluteX: number; absoluteY: number }> | null>(null);
    const contextMenuLongPressActivatedSessionKeyRef = useRef<string | null>(null);
    const translateY = useSharedValue(0);
    const isDragging = useSharedValue(false);
    const scale = useSharedValue(1);
    const didEnd = useSharedValue(false);
    const didStartDrag = useSharedValue(false);
    const didActivateLongPress = useSharedValue(false);

    const clearContextMenuLongPressTimer = () => {
        if (contextMenuLongPressTimerRef.current === null) return;
        clearTimeout(contextMenuLongPressTimerRef.current);
        contextMenuLongPressTimerRef.current = null;
    };

    useEffect(() => {
        return () => {
            clearContextMenuLongPressTimer();
        };
    }, []);

    const gesture = useMemo(() => {
        if (!sessionKey || enabled === false) return undefined;

        // Wrap ref reads in plain functions so the worklet can schedule them on
        // the JS thread. The ref.current is always the latest callback.
        const fireDragStart = (sk: string) => {
            onDragStartRef.current(sk);
        };
        const resolveDropResultForPointer = (
            sk: string,
            gk: string,
            absoluteX: number | null | undefined,
            absoluteY: number | null | undefined,
        ): TreeDropResult => {
            return resolveDropResultRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                pointer: pointerFromAbsoluteCoordinates(absoluteX, absoluteY),
            }) ?? IDLE_TREE_DROP_RESULT;
        };

        const fireDragUpdate = (sk: string, gk: string, absoluteX: number, absoluteY: number) => {
            const result = resolveDropResultForPointer(sk, gk, absoluteX, absoluteY);
            mirrorDropVisual(dropVisual, result.visual);
            onDragUpdateRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                result,
            });
        };
        const fireDragComplete = (sk: string, gk: string, absoluteX: number | null, absoluteY: number | null) => {
            const result = resolveDropResultForPointer(sk, gk, absoluteX, absoluteY);
            clearDropVisual(dropVisual);
            onDropResultRef.current({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                result,
            });
        };
        const fireLongPressActivated = (sk: string) => {
            if (contextMenuLongPressActivatedSessionKeyRef.current === sk) return;
            contextMenuLongPressActivatedSessionKeyRef.current = sk;
            clearContextMenuLongPressTimer();
            onLongPressActivatedRef.current?.(sk);
        };
        const cancelContextMenuLongPressForTouch = () => {
            clearContextMenuLongPressTimer();
            contextMenuLongPressStartRef.current = null;
        };
        const suppressContextMenuLongPressForTouch = (sk: string) => {
            cancelContextMenuLongPressForTouch();
            contextMenuLongPressActivatedSessionKeyRef.current = sk;
        };
        const startContextMenuLongPressTimer = (
            sk: string,
            delayMs: number,
            absoluteX: number,
            absoluteY: number,
        ) => {
            contextMenuLongPressActivatedSessionKeyRef.current = null;
            clearContextMenuLongPressTimer();
            contextMenuLongPressStartRef.current = { absoluteX, absoluteY };
            contextMenuLongPressTimerRef.current = setTimeout(() => {
                contextMenuLongPressTimerRef.current = null;
                fireLongPressActivated(sk);
            }, delayMs);
        };
        const cancelContextMenuLongPressTimerIfMoved = (sk: string, absoluteX: number, absoluteY: number) => {
            const start = contextMenuLongPressStartRef.current;
            if (!start) return;
            const dx = absoluteX - start.absoluteX;
            const dy = absoluteY - start.absoluteY;
            if (Math.hypot(dx, dy) < CONTEXT_MENU_TOUCH_CANCEL_DISTANCE) return;
            suppressContextMenuLongPressForTouch(sk);
        };
        const resetContextMenuLongPressActivation = () => {
            contextMenuLongPressActivatedSessionKeyRef.current = null;
        };

        const requiresLongPress = typeof activateAfterLongPressMs === 'number';

        // Pan drives the actual drag/reorder. On native we delay its activation with
        // `activateAfterLongPress(...)` so the list can still scroll naturally.
        let pan = Gesture.Pan()
            .minDistance(requiresLongPress ? 0 : 4)
            .cancelsTouchesInView(false);
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
                scheduleOnRN(clearDropVisual, dropVisual);
            })
            .onUpdate((e) => {
                'worklet';
                if (!didStartDrag.value) {
                    if (Math.abs(e.translationY) < dragStartThreshold) return;
                    didStartDrag.value = true;
                    isDragging.value = true;
                    scale.value = withSpring(1.03);
                    scheduleOnRN(suppressContextMenuLongPressForTouch, sessionKey);
                    scheduleOnRN(fireDragStart, sessionKey);
                }
                // Free movement — no snapping, no real-time data reorder.
                // The item follows the pointer exactly.
                translateY.value = e.translationY;
                scheduleOnRN(fireDragUpdate, sessionKey, groupKey, e.absoluteX, e.absoluteY);
            })
            .onEnd((e) => {
                'worklet';
                const didDrag = didStartDrag.value === true;

                // Reset immediately — the reorder callback will commit the new
                // position, so the item should snap to its slot once React
                // re-renders with the updated data.
                translateY.value = 0;
                scale.value = withSpring(1);
                didEnd.value = true;
                didStartDrag.value = false;
                isDragging.value = false;
                if (didDrag) {
                    scheduleOnRN(fireDragComplete, sessionKey, groupKey, e.absoluteX, e.absoluteY);
                } else {
                    scheduleOnRN(clearDropVisual, dropVisual);
                }
                scheduleOnRN(cancelContextMenuLongPressForTouch);
            })
            .onFinalize((e) => {
                'worklet';
                // Covers gesture cancel / system interrupt.
                // Skip if onEnd already handled it.
                if (didEnd.value) {
                    didEnd.value = false;
                    return;
                }
                const didDrag = didStartDrag.value === true;
                translateY.value = 0;
                scale.value = withSpring(1);
                didStartDrag.value = false;
                isDragging.value = false;
                if (didDrag) {
                    scheduleOnRN(fireDragComplete, sessionKey, groupKey, e.absoluteX, e.absoluteY);
                } else {
                    scheduleOnRN(clearDropVisual, dropVisual);
                }
                scheduleOnRN(cancelContextMenuLongPressForTouch);
            })
            .onTouchesDown((event) => {
                'worklet';
                if (!requiresLongPress || typeof activateAfterLongPressMs !== 'number') return;
                const touch = event.changedTouches[0] ?? event.allTouches[0];
                if (!touch) return;
                scheduleOnRN(
                    startContextMenuLongPressTimer,
                    sessionKey,
                    activateAfterLongPressMs,
                    touch.absoluteX,
                    touch.absoluteY,
                );
            })
            .onTouchesMove((event) => {
                'worklet';
                if (!requiresLongPress) return;
                const touch = event.changedTouches[0] ?? event.allTouches[0];
                if (!touch) return;
                scheduleOnRN(cancelContextMenuLongPressTimerIfMoved, sessionKey, touch.absoluteX, touch.absoluteY);
            })
            .onTouchesUp(() => {
                'worklet';
                scheduleOnRN(cancelContextMenuLongPressForTouch);
            })
            .onTouchesCancelled(() => {
                'worklet';
                scheduleOnRN(suppressContextMenuLongPressForTouch, sessionKey);
            });

        // `activateAfterLongPress` on Pan only fires once the user starts moving, which
        // is perfect for reordering but too late for showing a context menu.
        // Add a dedicated LongPress gesture so callers can open a menu while the
        // user is still holding the row down (before lifting their finger).
        if (!requiresLongPress || typeof activateAfterLongPressMs !== 'number') return panGesture;

        const longPressGesture = Gesture.LongPress()
            .minDuration(activateAfterLongPressMs)
            .maxDistance(CONTEXT_MENU_LONG_PRESS_MAX_DISTANCE)
            .shouldCancelWhenOutside(false)
            .cancelsTouchesInView(false)
            .onBegin(() => {
                'worklet';
                didActivateLongPress.value = false;
                scheduleOnRN(resetContextMenuLongPressActivation);
            })
            .onStart(() => {
                'worklet';
                if (didStartDrag.value) return;
                if (didActivateLongPress.value) return;
                didActivateLongPress.value = true;
                scheduleOnRN(fireLongPressActivated, sessionKey);
            })
            .onEnd((_event, success) => {
                'worklet';
                if (!success || didActivateLongPress.value) return;
                if (didStartDrag.value) return;
                didActivateLongPress.value = true;
                scheduleOnRN(fireLongPressActivated, sessionKey);
            });

        return Gesture.Simultaneous(longPressGesture, panGesture);
    // Only recreate when the row's identity or size changes — NOT when callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, sessionKey, groupKey, dataIndex, dropVisual]);

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
            opacity: isDragging.value ? DRAGGED_SESSION_ROW_OPACITY : 1,
        };
    });

    return { gesture, animatedStyle };
}
