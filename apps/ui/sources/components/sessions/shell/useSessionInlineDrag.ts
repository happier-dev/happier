import { useMemo, useRef } from 'react';
import { Platform, type ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSpring, type AnimatedStyle } from 'react-native-reanimated';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';
import { createDragHapticsSession, type DragHapticsOutcome } from '@/components/ui/treeDragDrop/createDragHapticsSession';

import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    TREE_DROP_OVERLAY_KIND_OUTLINE,
    type TreeDropOverlaySharedValues,
    type TreeDropResult,
    type TreeDropVisualGeometry,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import type { SessionListTreeDropResult } from './drop-resolution/sessionListTreeTypes';

const DRAGGED_SESSION_ROW_OPACITY = 0.38;

const CONTEXT_MENU_STATIONARY_TOUCH_TOLERANCE = 10;

/**
 * The drag wrapper resolves this from a pointer: the canonical `TreeDropResult`
 * (used for the final commit intent) plus numeric viewport-overlay geometry
 * (written into the single list-level overlay's shared values per frame).
 *
 * Pixel geometry never crosses into React props — it flows only through
 * `TreeDropOverlaySharedValues`, so a pointer move never reconciles list rows.
 */
export type UseSessionInlineDragResolvedDrop = Readonly<{
    result: TreeDropResult;
    geometry: TreeDropVisualGeometry;
    /** Stable effective insertion destination from the canonical resolver. */
    destinationKey: string | null;
}>;

const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
    destinationKey: null,
});

function isCommitEligibleResolvedDrop(resolved: UseSessionInlineDragResolvedDrop): boolean {
    const kind = resolved.result.instruction.kind;
    return kind !== 'idle' && kind !== 'blocked';
}

/** Empty/unchanged targets may use the last eligible drop and otherwise end quietly. */
export function isUnchangedSessionDropResult(result: SessionListTreeDropResult): boolean {
    if (result.sessionListBlockReason) return false;
    const instruction = result.instruction;
    return instruction.kind === 'idle'
        || (
            instruction.kind === 'blocked'
            && (instruction.reason === 'no-target' || instruction.reason === 'same-position')
        );
}

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

export type UseSessionInlineDragCancelEvent = Readonly<{
    sessionKey: string;
    groupKey: string;
    dataIndex: number;
}>;

export type UseSessionInlineDragParams = Readonly<{
    sessionKey: string | null;
    groupKey: string;
    enabled?: boolean;
    onDragStart: (sessionKey: string) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | DragHapticsOutcome | Promise<void | DragHapticsOutcome>;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    /** Flat-list data index of this row (used for drop indicator computation). */
    dataIndex: number;
    /**
     * Numeric, worklet-readable overlay geometry shared values for the single
     * list-level drop overlay. The drag wrapper writes resolved geometry here
     * each move and hides it on drop/cancel; it never mirrors semantic fields.
     */
    overlayShared: TreeDropOverlaySharedValues;
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

/**
 * Writes resolved viewport-overlay geometry into the single list-level overlay's
 * numeric shared values. This is the only place row drag touches the overlay:
 * the values are read by `useAnimatedStyle` in `TreeDropOverlay`, so the moving
 * line/outline never requires a React rerender of the list rows.
 */
function writeOverlayGeometry(target: TreeDropOverlaySharedValues, geometry: TreeDropVisualGeometry): void {
    if (geometry.kind === 'none') {
        hideOverlay(target);
        return;
    }
    target.overlayVisible.value = 1;
    target.overlayKind.value = geometry.kind === 'line'
        ? TREE_DROP_OVERLAY_KIND_LINE
        : TREE_DROP_OVERLAY_KIND_OUTLINE;
    target.overlayTop.value = geometry.geometry.top;
    target.overlayHeight.value = geometry.geometry.height;
    target.overlayLeft.value = geometry.geometry.left;
    target.overlayRight.value = geometry.geometry.left + geometry.geometry.width;
    target.overlayDepth.value = geometry.kind === 'line' ? geometry.depth : 0;
}

function hideOverlay(target: TreeDropOverlaySharedValues): void {
    target.overlayVisible.value = 0;
    target.overlayKind.value = TREE_DROP_OVERLAY_KIND_NONE;
}

/**
 * Builds the drag gesture and lift/translate style for one session-list row
 * (session, folder, or project header).
 *
 * The pan resolves a drop result on every move, writes its geometry into the
 * shared list-level overlay, and commits or cancels through the callbacks.
 * With `activateAfterLongPressMs` (native) the drag starts only after a hold,
 * so taps on child Pressables and list scrolling keep working; a parallel
 * LongPress gesture drives `onLongPressActivated`. Returns no gesture when
 * `enabled` is false.
 */
export function useSessionInlineDrag(params: UseSessionInlineDragParams): UseSessionInlineDragResult {
    const {
        sessionKey,
        groupKey,
        enabled = true,
        onDragStart,
        onDragUpdate,
        resolveDropResult,
        onDropResult,
        onDragCancel,
        dataIndex,
        overlayShared,
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
    const onDragCancelRef = useRef(onDragCancel);
    onDragCancelRef.current = onDragCancel;
    const onLongPressActivatedRef = useRef(onLongPressActivated);
    onLongPressActivatedRef.current = onLongPressActivated;

    const contextMenuLongPressActivatedSessionKeyRef = useRef<string | null>(null);
    const translateY = useSharedValue(0);
    const isDragging = useSharedValue(false);
    const scale = useSharedValue(1);
    const didEnd = useSharedValue(false);
    const didStartDrag = useSharedValue(false);
    const didDragDuringTouch = useSharedValue(false);
    const didActivateLongPress = useSharedValue(false);
    const lastCommitEligibleResolvedDropRef = useRef<UseSessionInlineDragResolvedDrop | null>(null);
    const dragHapticsRef = useRef<ReturnType<typeof createDragHapticsSession> | null>(null);

    const gesture = useMemo(() => {
        if (!sessionKey || enabled === false) return undefined;

        // Wrap ref reads in plain functions so the worklet can schedule them on
        // the JS thread. The ref.current is always the latest callback.
        const fireDragStart = (sk: string) => {
            dragHapticsRef.current?.cancel();
            dragHapticsRef.current = createDragHapticsSession();
            onDragStartRef.current(sk);
        };
        const resolveDropForPointer = (
            sk: string,
            gk: string,
            absoluteX: number | null | undefined,
            absoluteY: number | null | undefined,
        ): UseSessionInlineDragResolvedDrop => {
            return resolveDropResultRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                pointer: pointerFromAbsoluteCoordinates(absoluteX, absoluteY),
            }) ?? IDLE_RESOLVED_DROP;
        };

        const fireDragUpdate = (sk: string, gk: string, absoluteX: number, absoluteY: number) => {
            const resolved = resolveDropForPointer(sk, gk, absoluteX, absoluteY);
            if (isCommitEligibleResolvedDrop(resolved)) {
                lastCommitEligibleResolvedDropRef.current = resolved;
            } else {
                lastCommitEligibleResolvedDropRef.current = null;
            }
            dragHapticsRef.current?.updateDestination(resolved.destinationKey);
            writeOverlayGeometry(overlayShared, resolved.geometry);
            onDragUpdateRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                result: resolved.result,
            });
        };
        const fireDragComplete = async (sk: string, gk: string, absoluteX: number | null, absoluteY: number | null) => {
            const resolved = resolveDropForPointer(sk, gk, absoluteX, absoluteY);
            const committed = isUnchangedSessionDropResult(resolved.result)
                ? lastCommitEligibleResolvedDropRef.current ?? resolved
                : resolved;
            lastCommitEligibleResolvedDropRef.current = null;
            const haptics = dragHapticsRef.current;
            dragHapticsRef.current = null;
            hideOverlay(overlayShared);
            try {
                const outcome = await onDropResultRef.current({
                    sessionKey: sk,
                    groupKey: gk,
                    dataIndex,
                    result: committed.result,
                });
                haptics?.finish(outcome ?? 'unknown');
            } catch (error) {
                haptics?.finish('unknown');
                console.warn('Session reorder failed', error);
            }
        };
        const fireDragCancel = (sk: string, gk: string) => {
            dragHapticsRef.current?.cancel();
            dragHapticsRef.current = null;
            lastCommitEligibleResolvedDropRef.current = null;
            hideOverlay(overlayShared);
            onDragCancelRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
            });
        };
        const clearOverlay = () => {
            dragHapticsRef.current?.cancel();
            dragHapticsRef.current = null;
            lastCommitEligibleResolvedDropRef.current = null;
            hideOverlay(overlayShared);
        };
        const fireLongPressActivated = (sk: string) => {
            if (contextMenuLongPressActivatedSessionKeyRef.current === sk) return;
            contextMenuLongPressActivatedSessionKeyRef.current = sk;
            onLongPressActivatedRef.current?.(sk);
        };
        const suppressContextMenuLongPressForTouch = (sk: string) => {
            contextMenuLongPressActivatedSessionKeyRef.current = sk;
        };
        const resetContextMenuLongPressActivation = () => {
            contextMenuLongPressActivatedSessionKeyRef.current = null;
        };

        const requiresLongPress = typeof activateAfterLongPressMs === 'number';

        // Pan drives the actual drag/reorder. On native we delay its activation with
        // `activateAfterLongPress(...)` so the list can still scroll naturally.
        // Android Pan activates on the first move when minDistance is 0 (before the
        // long-press delay) and ignores `cancelsTouchesInView`, so that activation
        // cancels taps on child Pressables. Keep Android on its native touch-slop default.
        const panMinDistance = !requiresLongPress ? 4 : Platform.OS === 'android' ? null : 0;
        let pan = Gesture.Pan().cancelsTouchesInView(false);
        if (panMinDistance !== null) {
            pan = pan.minDistance(panMinDistance);
        }
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
                didDragDuringTouch.value = false;
                scheduleOnRN(clearOverlay);
            })
            .onUpdate((e) => {
                'worklet';
                if (!didStartDrag.value) {
                    if (Math.abs(e.translationY) < dragStartThreshold) return;
                    didStartDrag.value = true;
                    didDragDuringTouch.value = true;
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
            .onEnd((e, success) => {
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
                    didDragDuringTouch.value = true;
                    if (success === false) scheduleOnRN(fireDragCancel, sessionKey, groupKey);
                    else scheduleOnRN(fireDragComplete, sessionKey, groupKey, e.absoluteX, e.absoluteY);
                } else {
                    scheduleOnRN(clearOverlay);
                }
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
                    didDragDuringTouch.value = true;
                    scheduleOnRN(fireDragCancel, sessionKey, groupKey);
                } else {
                    scheduleOnRN(clearOverlay);
                }
            })
            .onTouchesDown(() => {
                'worklet';
                didDragDuringTouch.value = false;
            })
            .onTouchesCancelled(() => {
                'worklet';
                const didDrag = didStartDrag.value === true;
                translateY.value = 0;
                scale.value = withSpring(1);
                didEnd.value = true;
                didStartDrag.value = false;
                didDragDuringTouch.value = true;
                isDragging.value = false;
                if (didDrag) {
                    scheduleOnRN(fireDragCancel, sessionKey, groupKey);
                } else {
                    scheduleOnRN(clearOverlay);
                }
                scheduleOnRN(suppressContextMenuLongPressForTouch, sessionKey);
            });

        // `activateAfterLongPress` on Pan only fires once the user starts moving, which
        // is perfect for reordering but too late for showing a context menu.
        // Add a dedicated LongPress gesture so callers can open a menu while the
        // user is still holding the row down (before lifting their finger).
        if (!requiresLongPress || typeof activateAfterLongPressMs !== 'number') return panGesture;

        const longPressGesture = Gesture.LongPress()
            .minDuration(activateAfterLongPressMs)
            .maxDistance(CONTEXT_MENU_STATIONARY_TOUCH_TOLERANCE)
            .shouldCancelWhenOutside(false)
            .cancelsTouchesInView(false)
            .onBegin(() => {
                'worklet';
                didActivateLongPress.value = false;
                scheduleOnRN(resetContextMenuLongPressActivation);
            })
            .onStart(() => {
                'worklet';
                if (didDragDuringTouch.value) return;
                if (didStartDrag.value) return;
                if (didActivateLongPress.value) return;
                didActivateLongPress.value = true;
                scheduleOnRN(fireLongPressActivated, sessionKey);
            })
            .onEnd((_event, success) => {
                'worklet';
                if (!success || didActivateLongPress.value) return;
                if (didDragDuringTouch.value) return;
                if (didStartDrag.value) return;
                didActivateLongPress.value = true;
                scheduleOnRN(fireLongPressActivated, sessionKey);
            });

        return Gesture.Simultaneous(longPressGesture, panGesture);
    // Only recreate when the row's identity or size changes — NOT when callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, sessionKey, groupKey, dataIndex, overlayShared]);

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
