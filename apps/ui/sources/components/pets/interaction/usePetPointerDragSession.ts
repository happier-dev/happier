import * as React from 'react';
import { Platform, type View } from 'react-native';
import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import { resolvePointerClientPoint } from '@/components/ui/panels/resolvePointerClientPoint';
import { resolvePointerScreenPoint } from '@/components/ui/panels/resolvePointerScreenPoint';

import { PET_DRAG_THRESHOLD_PX, PET_VELOCITY_SAMPLE_WINDOW_MS } from './petPointerDragConfig';
import { resolvePetDragAnimationState } from './resolvePetDragAnimationState';
import {
    resolvePetDragVelocity,
    type PetDragVelocitySample,
} from './resolvePetDragVelocity';

export type PetPointerDragCoordinateSpace = 'client' | 'screen';

export type PetPointerId = number | string;

export type PetPointerDragMove = Readonly<{
    pointerId: PetPointerId;
    deltaX: number;
    deltaY: number;
    totalDeltaX: number;
    totalDeltaY: number;
    coordinateSpace: PetPointerDragCoordinateSpace;
}>;

export type PetPointerDragStart = Readonly<{
    pointerId: PetPointerId;
    screenX: number;
    screenY: number;
    clientX: number;
    clientY: number;
    startedAtMs: number;
    startedOnMascot: boolean;
    coordinateSpace: PetPointerDragCoordinateSpace;
}>;

export type PetPointerDragEnd = Readonly<{
    pointerId: PetPointerId;
    cancelled: boolean;
    screenX: number;
    screenY: number;
    clientX: number;
    clientY: number;
    coordinateSpace: PetPointerDragCoordinateSpace;
}>;

export type PetPointerDragRelease = Readonly<{
    pointerId: PetPointerId;
    velocityX: number;
    velocityY: number;
    sampleWindowMs: number;
    coordinateSpace: PetPointerDragCoordinateSpace;
}>;

type PointerPoint = Readonly<{ x: number; y: number }>;

type PointerCaptureTarget = Readonly<{
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
}>;

type PointerEventTargetLike = Readonly<{
    closest?: (selector: string) => unknown;
}>;

type PointerListenerTarget = Readonly<{
    addEventListener?: (type: string, listener: EventListener) => void;
    removeEventListener?: (type: string, listener: EventListener) => void;
}>;

type ActivePetPointerDrag = {
    pointerId: PetPointerId;
    numericPointerId: number | null;
    startedOnMascot: boolean;
    hasMoved: boolean;
    pointer: PointerPoint;
    previous: PointerPoint;
    samples: PetDragVelocitySample[];
    captureTarget: PointerCaptureTarget | null;
    cleanupListeners: (() => void) | null;
};

const NO_DRAG_SELECTOR = '[data-pet-no-drag="true"], .no-drag';
const MASCOT_SELECTOR = '[data-pet-mascot="true"], [data-avatar-mascot="true"], [data-avatar-overlay-hit-region]';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readPointerId(event: unknown): PetPointerId {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    const pointerId = nativeEvent.pointerId ?? eventRecord.pointerId;
    return typeof pointerId === 'string' || typeof pointerId === 'number' ? pointerId : 1;
}

function readExplicitPointerId(event: unknown): PetPointerId | null {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    const pointerId = nativeEvent.pointerId ?? eventRecord.pointerId;
    return typeof pointerId === 'string' || typeof pointerId === 'number' ? pointerId : null;
}

function readNumericPointerId(pointerId: PetPointerId): number | null {
    return typeof pointerId === 'number' && Number.isFinite(pointerId) ? pointerId : null;
}

function readEventTimeMs(event: unknown): number {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    return readNumber(nativeEvent.timeStamp) ?? readNumber(eventRecord.timeStamp) ?? Date.now();
}

function readButton(event: unknown): number | null {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    return readNumber(nativeEvent.button) ?? readNumber(eventRecord.button);
}

function readTarget(event: unknown): PointerEventTargetLike | null {
    const eventRecord = readRecord(event);
    const target = eventRecord.target;
    return target != null && typeof target === 'object' ? target as PointerEventTargetLike : null;
}

function readCurrentTarget(event: unknown): PointerCaptureTarget | null {
    const eventRecord = readRecord(event);
    const currentTarget = eventRecord.currentTarget;
    return currentTarget != null && typeof currentTarget === 'object'
        ? currentTarget as PointerCaptureTarget
        : null;
}

function targetMatches(target: PointerEventTargetLike | null, selector: string): boolean {
    return typeof target?.closest === 'function' && target.closest(selector) != null;
}

function resolvePoint(
    event: unknown,
    coordinateSpace: PetPointerDragCoordinateSpace,
): PointerPoint | null {
    const point = coordinateSpace === 'screen'
        ? resolvePointerScreenPoint(event)
        : resolvePointerClientPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function resolveScreenPoint(event: unknown): PointerPoint | null {
    const point = resolvePointerScreenPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function resolveClientPoint(event: unknown): PointerPoint | null {
    const point = resolvePointerClientPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function readWindow(): PointerListenerTarget | null {
    const win = (globalThis as { window?: unknown }).window;
    return win != null && typeof win === 'object' ? win as PointerListenerTarget : null;
}

function pushVelocitySample(
    samples: PetDragVelocitySample[],
    point: PointerPoint,
    timeMs: number,
): PetDragVelocitySample[] {
    const next = [...samples, { x: point.x, y: point.y, timeMs }];
    return next.filter((sample) => timeMs - sample.timeMs <= PET_VELOCITY_SAMPLE_WINDOW_MS);
}

function capturePointer(target: PointerCaptureTarget | null, pointerId: number | null): void {
    if (!target?.setPointerCapture || pointerId == null) return;
    try {
        target.setPointerCapture(pointerId);
    } catch {
        // Pointer capture can fail if the browser has already cancelled the pointer.
    }
}

function releasePointer(target: PointerCaptureTarget | null, pointerId: number | null): void {
    if (!target?.releasePointerCapture || pointerId == null) return;
    try {
        target.releasePointerCapture(pointerId);
    } catch {
        // Best effort cleanup only.
    }
}

function eventMatchesActivePointer(event: unknown, active: ActivePetPointerDrag): boolean {
    const pointerId = readExplicitPointerId(event);
    return pointerId == null || String(pointerId) === String(active.pointerId);
}

export function usePetPointerDragSession(input: Readonly<{
    coordinateSpace: PetPointerDragCoordinateSpace;
    onDragMove: (move: PetPointerDragMove) => void;
    onDragStart?: (start: PetPointerDragStart) => void;
    onDragEnd?: (end: PetPointerDragEnd) => void;
    onDragRelease?: (release: PetPointerDragRelease) => void;
    onActivate?: () => void | Promise<void>;
}>): {
    dragState: PetAnimationStateV1 | null;
    dragTargetRef: React.RefCallback<View>;
    pointerHandlers: Readonly<{
        onPointerDown?: (event: unknown) => void;
        onMouseDown?: (event: unknown) => void;
        onTouchStart?: (event: unknown) => void;
    }>;
    shouldSuppressPress: () => boolean;
} {
    const [dragState, setDragState] = React.useState<PetAnimationStateV1 | null>(null);
    const activeDragRef = React.useRef<ActivePetPointerDrag | null>(null);
    const attachedTargetRef = React.useRef<PointerListenerTarget | null>(null);
    const suppressNextPressRef = React.useRef(false);
    const inputRef = React.useRef(input);
    inputRef.current = input;

    const cleanupActiveDrag = React.useCallback(() => {
        const active = activeDragRef.current;
        active?.cleanupListeners?.();
        releasePointer(active?.captureTarget ?? null, active?.numericPointerId ?? null);
        activeDragRef.current = null;
        setDragState(null);
    }, []);

    const endActiveDrag = React.useCallback((event: unknown, cancelled: boolean) => {
        const active = activeDragRef.current;
        if (!active) return;
        if (!eventMatchesActivePointer(event, active)) return;
        const screenPoint = resolveScreenPoint(event) ?? active.previous;
        const clientPoint = resolveClientPoint(event) ?? active.previous;
        const coordinatePoint = resolvePoint(event, inputRef.current.coordinateSpace) ?? active.previous;
        const timeMs = readEventTimeMs(event);
        active.samples = pushVelocitySample(active.samples, coordinatePoint, timeMs);

        if (active.hasMoved) {
            if (!cancelled) {
                const velocity = resolvePetDragVelocity(active.samples);
                if (velocity) {
                    inputRef.current.onDragRelease?.({
                        pointerId: active.pointerId,
                        velocityX: velocity.x,
                        velocityY: velocity.y,
                        sampleWindowMs: PET_VELOCITY_SAMPLE_WINDOW_MS,
                        coordinateSpace: inputRef.current.coordinateSpace,
                    });
                }
            }
        }

        inputRef.current.onDragEnd?.({
            pointerId: active.pointerId,
            cancelled,
            screenX: screenPoint.x,
            screenY: screenPoint.y,
            clientX: clientPoint.x,
            clientY: clientPoint.y,
            coordinateSpace: inputRef.current.coordinateSpace,
        });

        if (!active.hasMoved && active.startedOnMascot && !cancelled) {
            suppressNextPressRef.current = true;
            void inputRef.current.onActivate?.();
        }

        cleanupActiveDrag();
    }, [cleanupActiveDrag]);

    const handleMove = React.useCallback((moveEvent: unknown) => {
        const active = activeDragRef.current;
        if (!active) return;
        if (!eventMatchesActivePointer(moveEvent, active)) return;
        const movePoint = resolvePoint(moveEvent, inputRef.current.coordinateSpace);
        if (!movePoint) return;

        const deltaX = movePoint.x - active.previous.x;
        const deltaY = movePoint.y - active.previous.y;
        const totalDeltaX = movePoint.x - active.pointer.x;
        const totalDeltaY = movePoint.y - active.pointer.y;
        const exceededThreshold =
            Math.abs(totalDeltaX) >= PET_DRAG_THRESHOLD_PX
            || Math.abs(totalDeltaY) >= PET_DRAG_THRESHOLD_PX;
        if (exceededThreshold) {
            active.hasMoved = true;
            suppressNextPressRef.current = true;
        }
        active.samples = pushVelocitySample(active.samples, movePoint, readEventTimeMs(moveEvent));
        if (!active.hasMoved) {
            const moveRecord = readRecord(moveEvent);
            const preventDefault = moveRecord.preventDefault;
            if (typeof preventDefault === 'function') preventDefault.call(moveEvent);
            return;
        }
        active.previous = movePoint;

        inputRef.current.onDragMove({
            pointerId: active.pointerId,
            deltaX,
            deltaY,
            totalDeltaX,
            totalDeltaY,
            coordinateSpace: inputRef.current.coordinateSpace,
        });
        setDragState((current) => resolvePetDragAnimationState(deltaX, current));
        const moveRecord = readRecord(moveEvent);
        const preventDefault = moveRecord.preventDefault;
        if (typeof preventDefault === 'function') preventDefault.call(moveEvent);
    }, []);

    const startDrag = React.useCallback((event: unknown) => {
        if (Platform.OS !== 'web') return;
        if (readButton(event) != null && readButton(event) !== 0) return;

        const target = readTarget(event);
        if (targetMatches(target, NO_DRAG_SELECTOR)) return;
        const startedOnMascot = targetMatches(target, MASCOT_SELECTOR);
        if (!startedOnMascot) return;

        const point = resolvePoint(event, inputRef.current.coordinateSpace);
        const screenPoint = resolveScreenPoint(event);
        const clientPoint = resolveClientPoint(event);
        if (!point || !screenPoint || !clientPoint) return;

        cleanupActiveDrag();
        suppressNextPressRef.current = false;
        const pointerId = readPointerId(event);
        const numericPointerId = readNumericPointerId(pointerId);
        const captureTarget = readCurrentTarget(event) ?? attachedTargetRef.current as PointerCaptureTarget | null;
        capturePointer(captureTarget, numericPointerId);

        const eventRecord = readRecord(event);
        if (typeof eventRecord.preventDefault === 'function') eventRecord.preventDefault.call(event);
        if (typeof eventRecord.stopPropagation === 'function') eventRecord.stopPropagation.call(event);

        const win = readWindow();
        const onMove = (moveEvent: Event) => handleMove(moveEvent);
        const onUp = (upEvent: Event) => endActiveDrag(upEvent, false);
        const onCancel = (cancelEvent: Event) => endActiveDrag(cancelEvent, true);
        win?.addEventListener?.('pointermove', onMove);
        win?.addEventListener?.('mousemove', onMove);
        win?.addEventListener?.('touchmove', onMove);
        win?.addEventListener?.('pointerup', onUp);
        win?.addEventListener?.('mouseup', onUp);
        win?.addEventListener?.('touchend', onUp);
        win?.addEventListener?.('pointercancel', onCancel);
        win?.addEventListener?.('touchcancel', onCancel);

        const targetWithListeners = captureTarget as PointerListenerTarget | null;
        targetWithListeners?.addEventListener?.('lostpointercapture', onCancel);

        const cleanupListeners = () => {
            win?.removeEventListener?.('pointermove', onMove);
            win?.removeEventListener?.('mousemove', onMove);
            win?.removeEventListener?.('touchmove', onMove);
            win?.removeEventListener?.('pointerup', onUp);
            win?.removeEventListener?.('mouseup', onUp);
            win?.removeEventListener?.('touchend', onUp);
            win?.removeEventListener?.('pointercancel', onCancel);
            win?.removeEventListener?.('touchcancel', onCancel);
            targetWithListeners?.removeEventListener?.('lostpointercapture', onCancel);
        };

        activeDragRef.current = {
            pointerId,
            numericPointerId,
            startedOnMascot,
            hasMoved: false,
            pointer: point,
            previous: point,
            samples: [{ x: point.x, y: point.y, timeMs: readEventTimeMs(event) }],
            captureTarget,
            cleanupListeners,
        };

        inputRef.current.onDragStart?.({
            pointerId,
            screenX: screenPoint.x,
            screenY: screenPoint.y,
            clientX: clientPoint.x,
            clientY: clientPoint.y,
            startedAtMs: readEventTimeMs(event),
            startedOnMascot,
            coordinateSpace: inputRef.current.coordinateSpace,
        });
    }, [cleanupActiveDrag, endActiveDrag, handleMove]);

    const dragTargetRef = React.useCallback((node: View | null) => {
        const previous = attachedTargetRef.current;
        if (previous) {
            previous.removeEventListener?.('pointerdown', startDrag as EventListener);
            previous.removeEventListener?.('mousedown', startDrag as EventListener);
            previous.removeEventListener?.('touchstart', startDrag as EventListener);
        }
        const next = node != null && typeof node === 'object' ? node as PointerListenerTarget : null;
        attachedTargetRef.current = next;
        if (Platform.OS === 'web') {
            next?.addEventListener?.('pointerdown', startDrag as EventListener);
            next?.addEventListener?.('mousedown', startDrag as EventListener);
            next?.addEventListener?.('touchstart', startDrag as EventListener);
        }
    }, [startDrag]);

    React.useEffect(() => () => {
        attachedTargetRef.current?.removeEventListener?.('pointerdown', startDrag as EventListener);
        attachedTargetRef.current?.removeEventListener?.('mousedown', startDrag as EventListener);
        attachedTargetRef.current?.removeEventListener?.('touchstart', startDrag as EventListener);
        attachedTargetRef.current = null;
        cleanupActiveDrag();
    }, [cleanupActiveDrag, startDrag]);

    const shouldSuppressPress = React.useCallback(() => {
        if (!suppressNextPressRef.current) return false;
        suppressNextPressRef.current = false;
        return true;
    }, []);

    const pointerHandlers = React.useMemo(() => (
        Platform.OS === 'web'
            ? {
                onPointerDown: startDrag,
                onMouseDown: startDrag,
                onTouchStart: startDrag,
            }
            : {}
    ), [startDrag]);

    return {
        dragState,
        dragTargetRef,
        pointerHandlers,
        shouldSuppressPress,
    };
}
