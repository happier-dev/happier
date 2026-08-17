import * as React from 'react';
import { Platform, type View } from 'react-native';

import { resolvePointerClientPoint } from '@/components/ui/panels/resolvePointerClientPoint';
import { resolvePointerScreenPoint } from '@/components/ui/panels/resolvePointerScreenPoint';

import { COMPANION_DRAG_THRESHOLD_PX, COMPANION_VELOCITY_SAMPLE_WINDOW_MS } from './companionPointerDragConfig';
import {
    resolveCompanionDragVelocity,
    type CompanionDragVelocitySample,
} from './resolveCompanionDragVelocity';

export type CompanionPointerDragCoordinateSpace = 'client' | 'screen';

export type CompanionPointerId = number | string;

export type CompanionPointerDragMove = Readonly<{
    pointerId: CompanionPointerId;
    deltaX: number;
    deltaY: number;
    totalDeltaX: number;
    totalDeltaY: number;
    coordinateSpace: CompanionPointerDragCoordinateSpace;
}>;

export type CompanionPointerDragStart = Readonly<{
    pointerId: CompanionPointerId;
    screenX: number;
    screenY: number;
    clientX: number;
    clientY: number;
    startedAtMs: number;
    startedOnHandle: boolean;
    coordinateSpace: CompanionPointerDragCoordinateSpace;
}>;

export type CompanionPointerDragEnd = Readonly<{
    pointerId: CompanionPointerId;
    cancelled: boolean;
    screenX: number;
    screenY: number;
    clientX: number;
    clientY: number;
    coordinateSpace: CompanionPointerDragCoordinateSpace;
}>;

export type CompanionPointerDragRelease = Readonly<{
    pointerId: CompanionPointerId;
    velocityX: number;
    velocityY: number;
    sampleWindowMs: number;
    coordinateSpace: CompanionPointerDragCoordinateSpace;
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

type ActiveCompanionPointerDrag = {
    pointerId: CompanionPointerId;
    numericPointerId: number | null;
    startedOnHandle: boolean;
    hasMoved: boolean;
    pointer: PointerPoint;
    previous: PointerPoint;
    samples: CompanionDragVelocitySample[];
    captureTarget: PointerCaptureTarget | null;
    cleanupListeners: (() => void) | null;
};

/**
 * Which DOM elements start a drag, and which never do. Supplied by the companion, because the
 * attributes belong to its own markup — the pet's mascot and the Voice orb's body are different
 * objects and neither should have to know the other's selector.
 */
export type CompanionPointerDragSelectors = Readonly<{
    /** A pointer-down inside this never starts a drag (actions, menus, tray rows). */
    noDrag: string;
    /** A drag only starts when the pointer went down inside this grab handle. */
    handle: string;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readPointerId(event: unknown): CompanionPointerId {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    const pointerId = nativeEvent.pointerId ?? eventRecord.pointerId;
    return typeof pointerId === 'string' || typeof pointerId === 'number' ? pointerId : 1;
}

function readExplicitPointerId(event: unknown): CompanionPointerId | null {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);
    const pointerId = nativeEvent.pointerId ?? eventRecord.pointerId;
    return typeof pointerId === 'string' || typeof pointerId === 'number' ? pointerId : null;
}

function readNumericPointerId(pointerId: CompanionPointerId): number | null {
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
    coordinateSpace: CompanionPointerDragCoordinateSpace,
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
    samples: CompanionDragVelocitySample[],
    point: PointerPoint,
    timeMs: number,
): CompanionDragVelocitySample[] {
    const next = [...samples, { x: point.x, y: point.y, timeMs }];
    return next.filter((sample) => timeMs - sample.timeMs <= COMPANION_VELOCITY_SAMPLE_WINDOW_MS);
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

function eventMatchesActivePointer(event: unknown, active: ActiveCompanionPointerDrag): boolean {
    const pointerId = readExplicitPointerId(event);
    return pointerId == null || String(pointerId) === String(active.pointerId);
}

/**
 * Pointer-driven drag for a floating companion on web.
 *
 * `TDragState` is the companion's own idea of what dragging *means* — the pet turns horizontal
 * motion into a running animation, the Voice orb has no such state at all. The hook therefore owns
 * only the pointer session and defers that mapping to `resolveDragState`; without the inversion
 * this module would have to import the pet's protocol animation vocabulary to move an orb.
 */
export function useCompanionPointerDragSession<TDragState = never>(input: Readonly<{
    /** False keeps the target known but attaches no listener and starts no session. */
    enabled?: boolean;
    coordinateSpace: CompanionPointerDragCoordinateSpace;
    selectors: CompanionPointerDragSelectors;
    /** Omitted when the companion has no drag-specific visual state. */
    resolveDragState?: (deltaX: number, current: TDragState | null) => TDragState | null;
    onDragMove: (move: CompanionPointerDragMove) => void;
    onDragStart?: (start: CompanionPointerDragStart) => void;
    onDragEnd?: (end: CompanionPointerDragEnd) => void;
    onDragRelease?: (release: CompanionPointerDragRelease) => void;
    onActivate?: () => void | Promise<void>;
}>): {
    dragState: TDragState | null;
    dragTargetRef: React.RefCallback<View>;
    pointerHandlers: Readonly<{ onPointerDown?: (event: unknown) => void }>;
    shouldSuppressPress: () => boolean;
} {
    const [dragState, setDragState] = React.useState<TDragState | null>(null);
    const activeDragRef = React.useRef<ActiveCompanionPointerDrag | null>(null);
    const attachedTargetRef = React.useRef<PointerListenerTarget | null>(null);
    const suppressNextPressRef = React.useRef(false);
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const enabled = input.enabled !== false;

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
                const velocity = resolveCompanionDragVelocity(active.samples);
                if (velocity) {
                    inputRef.current.onDragRelease?.({
                        pointerId: active.pointerId,
                        velocityX: velocity.x,
                        velocityY: velocity.y,
                        sampleWindowMs: COMPANION_VELOCITY_SAMPLE_WINDOW_MS,
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

        /*
         * A zero-movement press is a tap, and suppression only ever meant "this session already
         * performed it". Suppressing unconditionally made the session eat a tap it never handled:
         * a companion with no `onActivate` (the Voice orb) got its `click` — which react-native-web
         * dispatches *after* `pointerup` and turns into `onPress` — cancelled by
         * `shouldSuppressPress`, so a collapsed orb could not be clicked at all. Only the consumer
         * that actually takes the tap here suppresses the press that would repeat it.
         */
        const activate = inputRef.current.onActivate;
        if (activate && !active.hasMoved && active.startedOnHandle && !cancelled) {
            suppressNextPressRef.current = true;
            void activate();
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
            Math.abs(totalDeltaX) >= COMPANION_DRAG_THRESHOLD_PX
            || Math.abs(totalDeltaY) >= COMPANION_DRAG_THRESHOLD_PX;
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
        const resolveDragState = inputRef.current.resolveDragState;
        if (resolveDragState) setDragState((current) => resolveDragState(deltaX, current));
        const moveRecord = readRecord(moveEvent);
        const preventDefault = moveRecord.preventDefault;
        if (typeof preventDefault === 'function') preventDefault.call(moveEvent);
    }, []);

    const startDrag = React.useCallback((event: unknown) => {
        if (Platform.OS !== 'web') return;
        if (inputRef.current.enabled === false) return;
        if (readButton(event) != null && readButton(event) !== 0) return;

        const target = readTarget(event);
        if (targetMatches(target, inputRef.current.selectors.noDrag)) return;
        const startedOnHandle = targetMatches(target, inputRef.current.selectors.handle);
        if (!startedOnHandle) return;

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
            startedOnHandle,
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
            startedOnHandle,
            coordinateSpace: inputRef.current.coordinateSpace,
        });
    }, [cleanupActiveDrag, endActiveDrag, handleMove]);

    const dragTargetRef = React.useCallback((node: View | null) => {
        const previous = attachedTargetRef.current;
        if (previous) {
            previous.removeEventListener?.('pointerdown', startDrag as EventListener);
        }
        const next = node != null && typeof node === 'object' ? node as PointerListenerTarget : null;
        attachedTargetRef.current = next;
        if (Platform.OS === 'web' && inputRef.current.enabled !== false) {
            next?.addEventListener?.('pointerdown', startDrag as EventListener);
        }
    }, [startDrag]);

    React.useEffect(() => {
        const target = attachedTargetRef.current;
        if (Platform.OS !== 'web' || !target) return;
        if (enabled) {
            target.addEventListener?.('pointerdown', startDrag as EventListener);
            return () => target.removeEventListener?.('pointerdown', startDrag as EventListener);
        }
        target.removeEventListener?.('pointerdown', startDrag as EventListener);
        suppressNextPressRef.current = false;
        cleanupActiveDrag();
        return undefined;
    }, [cleanupActiveDrag, enabled, startDrag]);

    React.useEffect(() => () => {
        attachedTargetRef.current?.removeEventListener?.('pointerdown', startDrag as EventListener);
        attachedTargetRef.current = null;
        cleanupActiveDrag();
    }, [cleanupActiveDrag, startDrag]);

    const shouldSuppressPress = React.useCallback(() => {
        if (inputRef.current.enabled === false) return false;
        if (!suppressNextPressRef.current) return false;
        suppressNextPressRef.current = false;
        return true;
    }, []);

    const pointerHandlers = React.useMemo(() => (
        Platform.OS === 'web' && enabled ? { onPointerDown: startDrag } : {}
    ), [enabled, startDrag]);

    return {
        dragState,
        dragTargetRef,
        pointerHandlers,
        shouldSuppressPress,
    };
}
