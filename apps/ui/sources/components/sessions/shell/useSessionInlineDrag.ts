import { useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSpring, type AnimatedStyle } from 'react-native-reanimated';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';

import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    TREE_DROP_OVERLAY_KIND_OUTLINE,
    type TreeDropOverlaySharedValues,
    type TreeDropResult,
    type TreeDropVisualGeometry,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';

const DRAGGED_SESSION_ROW_OPACITY = 0.38;
const CONTEXT_MENU_STATIONARY_TOUCH_TOLERANCE = 10;

export type UseSessionInlineDragResolvedDrop = Readonly<{
    result: TreeDropResult;
    geometry: TreeDropVisualGeometry;
}>;

const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
});

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
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    dataIndex: number;
    overlayShared: TreeDropOverlaySharedValues;
    activateAfterLongPressMs?: number;
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

function hideOverlay(target: TreeDropOverlaySharedValues): void {
    target.overlayVisible.value = 0;
    target.overlayKind.value = TREE_DROP_OVERLAY_KIND_NONE;
}

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

    const onDragStartRef = useRef(onDragStart);
    onDragStartRef.current = onDragStart;
    const onDragUpdateRef = useRef(onDragUpdate);
    onDragUpdateRef.current = onDragUpdate;
    const onDragCancelRef = useRef(onDragCancel);
    onDragCancelRef.current = onDragCancel;
    const resolveDropResultRef = useRef(resolveDropResult);
    resolveDropResultRef.current = resolveDropResult;
    const onDropResultRef = useRef(onDropResult);
    onDropResultRef.current = onDropResult;
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

    const gesture = useMemo(() => {
        if (!sessionKey || enabled === false) return undefined;

        const fireDragStart = (sk: string) => {
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
            writeOverlayGeometry(overlayShared, resolved.geometry);
            onDragUpdateRef.current?.({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                result: resolved.result,
            });
        };
        const fireDragComplete = (sk: string, gk: string, absoluteX: number | null, absoluteY: number | null) => {
            const resolved = resolveDropForPointer(sk, gk, absoluteX, absoluteY);
            hideOverlay(overlayShared);
            onDropResultRef.current({
                sessionKey: sk,
                groupKey: gk,
                dataIndex,
                result: resolved.result,
            });
        };
        const fireDragCancel = (sk: string, gk: string) => {
            hideOverlay(overlayShared);
            onDragCancelRef.current?.({ sessionKey: sk, groupKey: gk, dataIndex });
        };
        const clearOverlay = () => {
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

        let pan = Gesture.Pan()
            .minDistance(requiresLongPress ? 0 : 4)
            .cancelsTouchesInView(false);
        if (typeof activateAfterLongPressMs === 'number') {
            const panWithLongPress = pan as unknown as { activateAfterLongPress?: (ms: number) => typeof pan };
            if (typeof panWithLongPress.activateAfterLongPress === 'function') {
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
                translateY.value = e.translationY;
                scheduleOnRN(fireDragUpdate, sessionKey, groupKey, e.absoluteX, e.absoluteY);
            })
            .onEnd((e) => {
                'worklet';
                const didDrag = didStartDrag.value === true;

                translateY.value = 0;
                scale.value = withSpring(1);
                didEnd.value = true;
                didStartDrag.value = false;
                isDragging.value = false;
                if (didDrag) {
                    didDragDuringTouch.value = true;
                    scheduleOnRN(fireDragComplete, sessionKey, groupKey, e.absoluteX, e.absoluteY);
                } else {
                    scheduleOnRN(clearOverlay);
                }
            })
            .onFinalize(() => {
                'worklet';
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
            position: 'relative' as const,
            transform: [{ translateY: translateY.value }, { scale: scale.value }],
            zIndex: isDragging.value ? 1000 : 0,
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
