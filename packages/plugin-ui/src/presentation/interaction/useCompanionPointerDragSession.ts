import * as React from 'react';
import type { View } from 'react-native';

import { COMPANION_DRAG_THRESHOLD_PX, COMPANION_VELOCITY_SAMPLE_WINDOW_MS } from './companionPointerDragConfig.js';
import {
    resolveCompanionDragVelocity,
    type CompanionDragVelocitySample,
} from './resolveCompanionDragVelocity.js';

type PointerCoordinateReader = (event: unknown) => Readonly<{ x: number | null; y: number | null }>;

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

type PointerEventTargetLike = Readonly<{
    closest?: (selector: string) => unknown;
}>;

/** Platform event/capture boundary. The host owns listener installation and cleanup. */
export type CompanionPointerListenerHost = Readonly<{
    capturePointer: (target: unknown, pointerId: number | null) => void;
    releasePointer: (target: unknown, pointerId: number | null) => void;
    listenForStart: (target: unknown, start: (event: unknown) => void) => () => void;
    listenForActive: (target: unknown, handlers: Readonly<{
        move: (event: unknown) => void;
        end: (event: unknown) => void;
        cancel: (event: unknown) => void;
    }>) => () => void;
}>;

type ActiveCompanionPointerDrag = {
    pointerId: CompanionPointerId;
    numericPointerId: number | null;
    startedOnHandle: boolean;
    hasMoved: boolean;
    pointer: PointerPoint;
    previous: PointerPoint;
    samples: CompanionDragVelocitySample[];
    captureTarget: unknown;
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

function readCurrentTarget(event: unknown): unknown {
    const eventRecord = readRecord(event);
    const currentTarget = eventRecord.currentTarget;
    return currentTarget != null && typeof currentTarget === 'object'
        ? currentTarget
        : null;
}

function targetMatches(target: PointerEventTargetLike | null, selector: string): boolean {
    return typeof target?.closest === 'function' && target.closest(selector) != null;
}

function resolvePoint(
    event: unknown,
    coordinateSpace: CompanionPointerDragCoordinateSpace,
    readClientPoint: PointerCoordinateReader,
    readScreenPoint: PointerCoordinateReader,
): PointerPoint | null {
    const point = coordinateSpace === 'screen'
        ? readScreenPoint(event)
        : readClientPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function resolveScreenPoint(event: unknown, readPoint: PointerCoordinateReader): PointerPoint | null {
    const point = readPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function resolveClientPoint(event: unknown, readPoint: PointerCoordinateReader): PointerPoint | null {
    const point = readPoint(event);
    return point.x != null && point.y != null ? { x: point.x, y: point.y } : null;
}

function pushVelocitySample(
    samples: CompanionDragVelocitySample[],
    point: PointerPoint,
    timeMs: number,
): CompanionDragVelocitySample[] {
    const next = [...samples, { x: point.x, y: point.y, timeMs }];
    return next.filter((sample) => timeMs - sample.timeMs <= COMPANION_VELOCITY_SAMPLE_WINDOW_MS);
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
export type UseCompanionPointerDragSessionParams<TDragState> = Readonly<{
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
    readClientPoint: PointerCoordinateReader;
    readScreenPoint: PointerCoordinateReader;
    pointerHost: CompanionPointerListenerHost;
}>;

export function useCompanionPointerDragSession<TDragState = never>(input: UseCompanionPointerDragSessionParams<TDragState>): {
    dragState: TDragState | null;
    dragTargetRef: React.RefCallback<View>;
    pointerHandlers: Readonly<{ onPointerDown?: (event: unknown) => void }>;
    shouldSuppressPress: () => boolean;
} {
    const [dragState, setDragState] = React.useState<TDragState | null>(null);
    const activeDragRef = React.useRef<ActiveCompanionPointerDrag | null>(null);
    const attachedTargetRef = React.useRef<unknown>(null);
    const attachedStartCleanupRef = React.useRef<(() => void) | null>(null);
    const suppressNextPressRef = React.useRef(false);
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const enabled = input.enabled !== false;

    const cleanupActiveDrag = React.useCallback(() => {
        const active = activeDragRef.current;
        active?.cleanupListeners?.();
        inputRef.current.pointerHost.releasePointer(active?.captureTarget ?? null, active?.numericPointerId ?? null);
        activeDragRef.current = null;
        setDragState(null);
    }, []);

    const endActiveDrag = React.useCallback((event: unknown, cancelled: boolean) => {
        const active = activeDragRef.current;
        if (!active) return;
        if (!eventMatchesActivePointer(event, active)) return;
        const screenPoint = resolveScreenPoint(event, inputRef.current.readScreenPoint) ?? active.previous;
        const clientPoint = resolveClientPoint(event, inputRef.current.readClientPoint) ?? active.previous;
        const coordinatePoint = resolvePoint(event, inputRef.current.coordinateSpace, inputRef.current.readClientPoint, inputRef.current.readScreenPoint) ?? active.previous;
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
        const movePoint = resolvePoint(moveEvent, inputRef.current.coordinateSpace, inputRef.current.readClientPoint, inputRef.current.readScreenPoint);
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
        if (inputRef.current.enabled === false) return;
        if (readButton(event) != null && readButton(event) !== 0) return;

        const target = readTarget(event);
        if (targetMatches(target, inputRef.current.selectors.noDrag)) return;
        const startedOnHandle = targetMatches(target, inputRef.current.selectors.handle);
        if (!startedOnHandle) return;

        const point = resolvePoint(event, inputRef.current.coordinateSpace, inputRef.current.readClientPoint, inputRef.current.readScreenPoint);
        const screenPoint = resolveScreenPoint(event, inputRef.current.readScreenPoint);
        const clientPoint = resolveClientPoint(event, inputRef.current.readClientPoint);
        if (!point || !screenPoint || !clientPoint) return;

        cleanupActiveDrag();
        suppressNextPressRef.current = false;
        const pointerId = readPointerId(event);
        const numericPointerId = readNumericPointerId(pointerId);
        const captureTarget = readCurrentTarget(event) ?? attachedTargetRef.current;
        inputRef.current.pointerHost.capturePointer(captureTarget, numericPointerId);

        const eventRecord = readRecord(event);
        if (typeof eventRecord.preventDefault === 'function') eventRecord.preventDefault.call(event);
        if (typeof eventRecord.stopPropagation === 'function') eventRecord.stopPropagation.call(event);

        const cleanupListeners = inputRef.current.pointerHost.listenForActive(captureTarget, {
            move: handleMove,
            end: (event) => endActiveDrag(event, false),
            cancel: (event) => endActiveDrag(event, true),
        });

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
        attachedStartCleanupRef.current?.();
        const next = node != null && typeof node === 'object' ? node : null;
        attachedTargetRef.current = next;
        if (inputRef.current.enabled !== false) {
            attachedStartCleanupRef.current = inputRef.current.pointerHost.listenForStart(next, startDrag);
        }
    }, [startDrag]);

    React.useEffect(() => {
        const target = attachedTargetRef.current;
        if (!target) return;
        if (enabled) {
            return inputRef.current.pointerHost.listenForStart(target, startDrag);
        }
        attachedStartCleanupRef.current?.();
        suppressNextPressRef.current = false;
        cleanupActiveDrag();
        return undefined;
    }, [cleanupActiveDrag, enabled, startDrag]);

    React.useEffect(() => () => {
        attachedStartCleanupRef.current?.();
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
        enabled ? { onPointerDown: startDrag } : {}
    ), [enabled, startDrag]);

    return {
        dragState,
        dragTargetRef,
        pointerHandlers,
        shouldSuppressPress,
    };
}
