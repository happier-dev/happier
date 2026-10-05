import { useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { useSharedValue, useAnimatedStyle, type AnimatedStyle } from 'react-native-reanimated';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { HAPPIER_CARRIED_SOURCE_OPACITY } from '@happier-dev/plugin-ui/presentation';

import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    TREE_DROP_OVERLAY_KIND_OUTLINE,
    type TreeDropOverlaySharedValues,
    type TreeDropResult,
    type TreeDropVisualGeometry,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';

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

/**
 * The pointer/touch adapter of a Session-list carry. The host attaches the gesture to the whole row on
 * desktop and to the Organize grip on phones; it never lifts on a long press, which stays the menu's
 * (K1). One completed, successful end completes the carry; an unsuccessful end, a finalize without
 * an end, or a cancelled touch cancels it, so the system taking the pointer away never writes.
 */
export function useSessionInlineDrag(params: UseSessionInlineDragParams): UseSessionInlineDragResult {
    const {
        sessionKey,
        groupKey,
        enabled = true,
        dataIndex,
        overlayShared,
    } = params;

    const callbacksRef = useRef(params);
    callbacksRef.current = params;

    const isDragging = useSharedValue(false);
    const didEnd = useSharedValue(false);
    const didStartDrag = useSharedValue(false);

    const gesture = useMemo(() => {
        if (!sessionKey || enabled === false) return undefined;

        const resolveDropForPointer = (
            absoluteX: number | null | undefined,
            absoluteY: number | null | undefined,
        ): UseSessionInlineDragResolvedDrop => callbacksRef.current.resolveDropResult({
            sessionKey,
            groupKey,
            dataIndex,
            pointer: pointerFromAbsoluteCoordinates(absoluteX, absoluteY),
        }) ?? IDLE_RESOLVED_DROP;

        const fireDragStart = () => {
            callbacksRef.current.onDragStart(sessionKey);
        };
        const fireDragUpdate = (absoluteX: number, absoluteY: number) => {
            const resolved = resolveDropForPointer(absoluteX, absoluteY);
            writeOverlayGeometry(overlayShared, resolved.geometry);
            callbacksRef.current.onDragUpdate?.({ sessionKey, groupKey, dataIndex, result: resolved.result });
        };
        const fireDragComplete = (absoluteX: number | null, absoluteY: number | null) => {
            const resolved = resolveDropForPointer(absoluteX, absoluteY);
            hideOverlay(overlayShared);
            callbacksRef.current.onDropResult({ sessionKey, groupKey, dataIndex, result: resolved.result });
        };
        const fireDragCancel = () => {
            hideOverlay(overlayShared);
            callbacksRef.current.onDragCancel?.({ sessionKey, groupKey, dataIndex });
        };
        const clearOverlay = () => {
            hideOverlay(overlayShared);
        };

        return Gesture.Pan()
            .minDistance(ENTITY_DRAG_ACTIVATION_DISTANCE_PX)
            .cancelsTouchesInView(false)
            .onStart(() => {
                'worklet';
                didEnd.value = false;
                didStartDrag.value = false;
                scheduleOnRN(clearOverlay);
            })
            .onUpdate((e) => {
                'worklet';
                if (!didStartDrag.value) {
                    didStartDrag.value = true;
                    isDragging.value = true;
                    scheduleOnRN(fireDragStart);
                }
                scheduleOnRN(fireDragUpdate, e.absoluteX, e.absoluteY);
            })
            .onEnd((e, success) => {
                'worklet';
                const didDrag = didStartDrag.value === true;
                didEnd.value = true;
                didStartDrag.value = false;
                isDragging.value = false;
                if (!didDrag) {
                    scheduleOnRN(clearOverlay);
                } else if (success === false) {
                    scheduleOnRN(fireDragCancel);
                } else {
                    scheduleOnRN(fireDragComplete, e.absoluteX, e.absoluteY);
                }
            })
            .onFinalize(() => {
                'worklet';
                if (didEnd.value) {
                    didEnd.value = false;
                    return;
                }
                const didDrag = didStartDrag.value === true;
                didStartDrag.value = false;
                isDragging.value = false;
                scheduleOnRN(didDrag ? fireDragCancel : clearOverlay);
            })
            .onTouchesCancelled(() => {
                'worklet';
                const didDrag = didStartDrag.value === true;
                didEnd.value = true;
                didStartDrag.value = false;
                isDragging.value = false;
                scheduleOnRN(didDrag ? fireDragCancel : clearOverlay);
            });
    // Only recreate when the row's identity changes — callbacks are read through a ref.
    }, [didEnd, didStartDrag, enabled, groupKey, isDragging, sessionKey, dataIndex, overlayShared]);

    const animatedStyle = useAnimatedStyle<ViewStyle>(() => ({
        opacity: enabled && isDragging.value ? HAPPIER_CARRIED_SOURCE_OPACITY : 1,
    }));

    return { gesture, animatedStyle };
}
