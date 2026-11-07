import * as React from 'react';
import { PanResponder, Platform } from 'react-native';
import { resolvePointerClientPoint } from './resolvePointerClientPoint.js';

export type DockedPaneResizeAxis = 'x' | 'y';
/** `both`: a centred surface; either edge moves and the opposite one mirrors it, so the size changes by twice the travel. */
export type DockedPaneResizeEdge = 'start' | 'end' | 'both';

export type DockedPaneResizeCommitMeta = Readonly<{
    attemptedSizePx: number;
    clampedSizePx: number;
    exceededMinPx: boolean;
    exceededMaxPx: boolean;
    overshootPx: number;
    collapseArmed: boolean;
}>;

export type ResizableSizeInput = Readonly<{
    axis: DockedPaneResizeAxis;
    resizeEdge: DockedPaneResizeEdge;
    sizePx: number;
    minSizePx: number;
    maxSizePx: number;
    onCommitSizePx: (sizePx: number, meta?: DockedPaneResizeCommitMeta) => void;
    onDragSizePx?: (sizePx: number | null, meta?: DockedPaneResizeCommitMeta | null) => void;
    collapse?: true;
    onCollapseArmedChange?: (armed: boolean) => void;
    onCollapse?: () => void;
    onResetRequest?: () => void;
    readClientPoint?: typeof resolvePointerClientPoint;
}>;

type ResizableEdgeHandle = Readonly<{
    /** Opaque platform responder props, consumed by HappierResizeHandle. */
    panHandlers: Readonly<Record<string, unknown>>;
    webHandleProps: Readonly<{
        onKeyDown: (event: unknown) => void;
        onPressIn: (event: unknown) => void;
        onPointerDown: (event: unknown) => void;
        onMouseDown: (event: unknown) => void;
        onTouchStart: (event: unknown) => void;
        onDoubleClick: () => void;
    }>;
}>;

export type ResizableSizeResult = Readonly<{
    effectiveSizePx: number;
    /** A drag is in progress (the handle draws its seam in full ink). */
    dragging: boolean;
    canResize: boolean;
    /** Opaque platform responder props, consumed by HappierResizeHandle. */
    panHandlers: Readonly<Record<string, unknown>>;
    webHandleProps: Readonly<{
        onKeyDown: (event: unknown) => void;
        onPressIn: (event: unknown) => void;
        onPointerDown: (event: unknown) => void;
        onMouseDown: (event: unknown) => void;
        onTouchStart: (event: unknown) => void;
        onDoubleClick: () => void;
    }>;
    accessibilityHandleProps: Readonly<{
        accessibilityValue: Readonly<{ min: number; max: number; now: number }>;
        accessibilityActions: ReadonlyArray<Readonly<{ name: 'increment' | 'decrement' }>>;
        onAccessibilityAction: (event: unknown) => void;
    }>;
    /** The end edge's handle of a `both` surface; `panHandlers`/`webHandleProps` above are its start edge. */
    endHandle?: ResizableEdgeHandle;
}>;

function resolveAxisDelta(gesture: Readonly<{ dx?: number; dy?: number }>, axis: DockedPaneResizeAxis): number {
    const raw = axis === 'x' ? gesture.dx : gesture.dy;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : {};
}

function stopEvent(event: unknown) {
    const record = readRecord(event);
    if (typeof record.preventDefault === 'function') record.preventDefault.call(event);
    if (typeof record.stopPropagation === 'function') record.stopPropagation.call(event);
}

function resolveWebFallbackCoord(event: unknown, axis: DockedPaneResizeAxis): number | null {
    const record = readRecord(event);
    const locationKey = axis === 'x' ? 'locationX' : 'locationY';
    const location = (() => {
        const value = readRecord(record.nativeEvent)[locationKey];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    })();

    const rectAxisKey = axis === 'x' ? 'left' : 'top';
    const targetAxis = (() => {
        const currentTarget = readRecord(record.currentTarget);
        if (typeof currentTarget?.getBoundingClientRect === 'function') {
            const rect = readRecord(currentTarget.getBoundingClientRect());
            const value = rect?.[rectAxisKey];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        const target = readRecord(record.target);
        if (typeof target?.getBoundingClientRect === 'function') {
            const rect = readRecord(target.getBoundingClientRect());
            const value = rect?.[rectAxisKey];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        return null;
    })();

    if (location != null && targetAxis != null) {
        return targetAxis + location;
    }
    return null;
}

function resolveClampedSizeState(value: number, minSizePx: number, maxSizePx: number, collapse = false): DockedPaneResizeCommitMeta {
    const clampedSizePx = Math.min(maxSizePx, Math.max(minSizePx, value));
    return {
        attemptedSizePx: value,
        clampedSizePx,
        exceededMinPx: value < minSizePx,
        exceededMaxPx: value > maxSizePx,
        overshootPx: value - clampedSizePx,
        collapseArmed: collapse && value < minSizePx - Math.floor(minSizePx / 2),
    };
}

export function useResizableSize(input: ResizableSizeInput): ResizableSizeResult {
    const { sizePx, minSizePx, maxSizePx, onCommitSizePx } = input;
    const onDragSizePx = input.onDragSizePx;
    const axis = input.axis;
    const resizeEdge = input.resizeEdge;
    const inputRef = React.useRef(input);
    inputRef.current = input;
    // Pointer travel to size: a `both` surface's start edge is its primary handle, and the edges mirror each other.
    const travel = resizeEdge === 'both' ? 2 : 1;
    const edgeSign = (resizeEdge === 'end' ? 1 : -1) * travel;
    const endSign = travel;

    const canResize = maxSizePx - minSizePx > 1;

    const dragStartSizeRef = React.useRef<number | null>(null);
    const dragStartClientCoordRef = React.useRef<number | null>(null);
    const dragLatestSizeRef = React.useRef<number | null>(null);
    const dragLatestAttemptedSizeRef = React.useRef<number | null>(null);
    const collapseArmedRef = React.useRef(false);
    const pendingFrameRef = React.useRef<number | null>(null);
    const webDragCleanupRef = React.useRef<(() => void) | null>(null);
    const [dragSizePx, setDragSizePx] = React.useState<number | null>(null);

    const minSizePxRef = React.useRef(minSizePx);
    const maxSizePxRef = React.useRef(maxSizePx);
    const onCommitSizePxRef = React.useRef(onCommitSizePx);
    const onDragSizePxRef = React.useRef(onDragSizePx);
    const effectiveSizeRef = React.useRef(sizePx);

    minSizePxRef.current = minSizePx;
    maxSizePxRef.current = maxSizePx;
    onCommitSizePxRef.current = onCommitSizePx;
    onDragSizePxRef.current = onDragSizePx;

    const clampLatest = React.useCallback((value: number) => {
        return Math.min(maxSizePxRef.current, Math.max(minSizePxRef.current, value));
    }, []);

    const updateCollapseArmed = React.useCallback((armed: boolean) => {
        if (collapseArmedRef.current === armed) return;
        collapseArmedRef.current = armed;
        inputRef.current.onCollapseArmedChange?.(armed);
    }, []);

    const publishDrag = React.useCallback((next: DockedPaneResizeCommitMeta) => {
        dragLatestAttemptedSizeRef.current = next.attemptedSizePx;
        dragLatestSizeRef.current = next.clampedSizePx;
        updateCollapseArmed(next.collapseArmed);
        if (pendingFrameRef.current !== null) return;
        const publish = () => {
            pendingFrameRef.current = null;
            if (dragLatestSizeRef.current === null) return;
            const meta = resolveClampedSizeState(dragLatestAttemptedSizeRef.current ?? dragLatestSizeRef.current,
                minSizePxRef.current, maxSizePxRef.current, inputRef.current.collapse);
            setDragSizePx(meta.clampedSizePx);
            onDragSizePxRef.current?.(meta.clampedSizePx, meta);
        };
        if (typeof globalThis.requestAnimationFrame === 'function') {
            pendingFrameRef.current = globalThis.requestAnimationFrame(publish);
        } else publish();
    }, [updateCollapseArmed]);

    const createCommitMeta = React.useCallback((attemptedSizePx: number | null, clampedSizePx: number): DockedPaneResizeCommitMeta => {
        const attempted = attemptedSizePx ?? clampedSizePx;
        return resolveClampedSizeState(attempted, minSizePxRef.current, maxSizePxRef.current, inputRef.current.collapse);
    }, []);

    const resetDragTracking = React.useCallback(() => {
        dragStartSizeRef.current = null;
        dragStartClientCoordRef.current = null;
        dragLatestSizeRef.current = null;
        dragLatestAttemptedSizeRef.current = null;
        if (pendingFrameRef.current !== null) globalThis.cancelAnimationFrame?.(pendingFrameRef.current);
        pendingFrameRef.current = null;
        updateCollapseArmed(false);
        setDragSizePx(null);
    }, [updateCollapseArmed]);

    const effectiveSizePx = dragSizePx ?? clampLatest(sizePx);
    effectiveSizeRef.current = effectiveSizePx;

    const commitAccessibilityAdjustment = React.useCallback((adjustmentPx: number) => {
        const next = resolveClampedSizeState(
            effectiveSizeRef.current + adjustmentPx,
            minSizePxRef.current,
            maxSizePxRef.current,
        );
        onCommitSizePxRef.current(next.clampedSizePx, next);
    }, []);

    const handleAccessibilityAction = React.useCallback((event: unknown) => {
        const actionName = (event as { nativeEvent?: { actionName?: unknown } } | null | undefined)
            ?.nativeEvent?.actionName;
        if (actionName === 'increment') {
            commitAccessibilityAdjustment(8);
        } else if (actionName === 'decrement') {
            commitAccessibilityAdjustment(-8);
        }
    }, [commitAccessibilityAdjustment]);

    const createPanResponder = React.useCallback((sign: number) => {
        return PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                const startSizePx = effectiveSizeRef.current;
                dragStartSizeRef.current = startSizePx;
                dragLatestSizeRef.current = startSizePx;
                dragLatestAttemptedSizeRef.current = startSizePx;
                setDragSizePx(startSizePx);
                onDragSizePxRef.current?.(startSizePx, createCommitMeta(startSizePx, startSizePx));
            },
            onPanResponderMove: (_event, gesture) => {
                const start = dragStartSizeRef.current ?? effectiveSizeRef.current;
                const delta = resolveAxisDelta(gesture, axis);
                const attempted = start + (sign * delta);
                publishDrag(resolveClampedSizeState(attempted, minSizePxRef.current, maxSizePxRef.current, inputRef.current.collapse));
            },
            onPanResponderRelease: () => {
                const next = clampLatest(dragLatestAttemptedSizeRef.current ?? effectiveSizeRef.current);
                const commitMeta = createCommitMeta(dragLatestAttemptedSizeRef.current, next);
                resetDragTracking();
                if (commitMeta.collapseArmed) inputRef.current.onCollapse?.();
                else onCommitSizePxRef.current(next, commitMeta);
                onDragSizePxRef.current?.(null, null);
            },
            onPanResponderTerminate: () => {
                resetDragTracking();
                onDragSizePxRef.current?.(null, null);
            },
        });
    }, [axis, clampLatest, createCommitMeta, publishDrag, resetDragTracking]);
    const panResponder = React.useMemo(() => createPanResponder(edgeSign), [createPanResponder, edgeSign]);
    const endPanResponder = React.useMemo(() => resizeEdge === 'both' ? createPanResponder(endSign) : null,
        [createPanResponder, endSign, resizeEdge]);

    const beginWebDrag = React.useCallback((event: unknown, sign: number) => {
        if (Platform.OS !== 'web') return;
        if (dragStartSizeRef.current !== null) return;
        webDragCleanupRef.current?.();
        const point = (inputRef.current.readClientPoint ?? resolvePointerClientPoint)(event);
        let clientCoord = axis === 'x' ? point.x : point.y;
        if (clientCoord == null) {
            clientCoord = resolveWebFallbackCoord(event, axis);
        }

        stopEvent(event);

        const startSizePx = effectiveSizeRef.current;
        dragStartSizeRef.current = startSizePx;
        dragStartClientCoordRef.current = clientCoord;
        dragLatestSizeRef.current = startSizePx;
        dragLatestAttemptedSizeRef.current = startSizePx;
        setDragSizePx(startSizePx);
        onDragSizePxRef.current?.(startSizePx, createCommitMeta(startSizePx, startSizePx));

        const win = (globalThis as unknown as { window?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> }).window;
        if (!win?.addEventListener) return;

        const onMove = (moveEvent: unknown) => {
            const point = (inputRef.current.readClientPoint ?? resolvePointerClientPoint)(moveEvent);
            const nextClient = axis === 'x' ? point.x : point.y;
            if (nextClient == null) return;

            const startSize = dragStartSizeRef.current ?? effectiveSizeRef.current;
            let startCoord = dragStartClientCoordRef.current;
            if (startCoord == null) {
                // Some RN web press events do not provide initial coordinates. Establish the drag origin
                // on the first move so subsequent moves can compute a delta.
                dragStartClientCoordRef.current = nextClient;
                startCoord = nextClient;
            }

            const delta = nextClient - startCoord;
            const attempted = startSize + (sign * delta);
            publishDrag(resolveClampedSizeState(attempted, minSizePxRef.current, maxSizePxRef.current, inputRef.current.collapse));
            stopEvent(moveEvent);
        };

        const cleanup = () => {
            win.removeEventListener?.('pointermove', onMove);
            win.removeEventListener?.('mousemove', onMove);
            win.removeEventListener?.('touchmove', onMove);
            win.removeEventListener?.('pointerup', onUp);
            win.removeEventListener?.('mouseup', onUp);
            win.removeEventListener?.('touchend', onUp);
            win.removeEventListener?.('pointercancel', onCancel);
            win.removeEventListener?.('touchcancel', onCancel);
            if (webDragCleanupRef.current === cleanup) {
                webDragCleanupRef.current = null;
            }
        };
        webDragCleanupRef.current = cleanup;

        const onUp = () => {
            cleanup();
            const next = clampLatest(dragLatestAttemptedSizeRef.current ?? effectiveSizeRef.current);
            const commitMeta = createCommitMeta(dragLatestAttemptedSizeRef.current, next);
            resetDragTracking();
            if (commitMeta.collapseArmed) inputRef.current.onCollapse?.();
            else onCommitSizePxRef.current(next, commitMeta);
            onDragSizePxRef.current?.(null, null);
        };
        const onCancel = () => {
            cleanup();
            resetDragTracking();
            onDragSizePxRef.current?.(null, null);
        };

        win.addEventListener('pointermove', onMove);
        win.addEventListener('mousemove', onMove);
        win.addEventListener('touchmove', onMove);
        win.addEventListener('pointerup', onUp);
        win.addEventListener('mouseup', onUp);
        win.addEventListener('touchend', onUp);
        win.addEventListener('pointercancel', onCancel);
        win.addEventListener('touchcancel', onCancel);

        const eventRecord = readRecord(event);
        const target = readRecord(eventRecord.currentTarget ?? eventRecord.target);
        const pointerId = readRecord(eventRecord.nativeEvent).pointerId ?? eventRecord.pointerId;
        if (typeof target?.setPointerCapture === 'function' && typeof pointerId === 'number') {
            try {
                target.setPointerCapture(pointerId);
            } catch {
                // Best-effort pointer capture; ignore failures.
            }
        }
    }, [axis, clampLatest, createCommitMeta, publishDrag, resetDragTracking]);
    const handleWebPointerDown = React.useCallback((event: unknown) => beginWebDrag(event, edgeSign), [beginWebDrag, edgeSign]);
    const handleEndWebPointerDown = React.useCallback((event: unknown) => beginWebDrag(event, endSign), [beginWebDrag, endSign]);

    React.useEffect(() => {
        return () => {
            const hadActiveDrag =
                dragStartSizeRef.current != null
                || dragLatestSizeRef.current != null
                || dragLatestAttemptedSizeRef.current != null;
            webDragCleanupRef.current?.();
            webDragCleanupRef.current = null;
            dragStartSizeRef.current = null;
            dragStartClientCoordRef.current = null;
            dragLatestSizeRef.current = null;
            dragLatestAttemptedSizeRef.current = null;
            if (pendingFrameRef.current !== null) globalThis.cancelAnimationFrame?.(pendingFrameRef.current);
            pendingFrameRef.current = null;
            updateCollapseArmed(false);
            if (hadActiveDrag) {
                onDragSizePxRef.current?.(null, null);
            }
        };
    }, [updateCollapseArmed]);

    const handleArrowKey = React.useCallback((event: unknown, sign: number) => {
        if (Platform.OS !== 'web') return;
        const value = readRecord(event);
        const key = String(value.key ?? '');

        const supportsKey =
            axis === 'x'
                ? (key === 'ArrowLeft' || key === 'ArrowRight')
                : (key === 'ArrowUp' || key === 'ArrowDown');
        if (!supportsKey) return;

        stopEvent(event);

        const step = value.shiftKey ? 32 : 8;
        const arrowSign =
            axis === 'x'
                ? (key === 'ArrowRight' ? 1 : -1)
                : (key === 'ArrowDown' ? 1 : -1);
        const next = resolveClampedSizeState(
            effectiveSizeRef.current + (arrowSign * sign * step),
            minSizePxRef.current,
            maxSizePxRef.current
        );
        onCommitSizePxRef.current(next.clampedSizePx, next);
    }, [axis]);
    const handleKeyDown = React.useCallback((event: unknown) => handleArrowKey(event, edgeSign), [edgeSign, handleArrowKey]);
    const handleEndKeyDown = React.useCallback((event: unknown) => handleArrowKey(event, endSign), [endSign, handleArrowKey]);
    const requestReset = React.useCallback(() => inputRef.current.onResetRequest?.(), []);

    return {
        effectiveSizePx,
        dragging: dragSizePx !== null,
        canResize,
        panHandlers: { ...panResponder.panHandlers },
        webHandleProps: {
            onKeyDown: handleKeyDown,
            onPressIn: handleWebPointerDown,
            onPointerDown: handleWebPointerDown,
            onMouseDown: handleWebPointerDown,
            onTouchStart: handleWebPointerDown,
            onDoubleClick: requestReset,
        },
        accessibilityHandleProps: {
            accessibilityValue: {
                min: minSizePx,
                max: maxSizePx,
                now: effectiveSizePx,
            },
            accessibilityActions: [
                { name: 'increment' },
                { name: 'decrement' },
            ],
            onAccessibilityAction: handleAccessibilityAction,
        },
        ...(endPanResponder ? {
            endHandle: {
                panHandlers: { ...endPanResponder.panHandlers },
                webHandleProps: {
                    onKeyDown: handleEndKeyDown,
                    onPressIn: handleEndWebPointerDown,
                    onPointerDown: handleEndWebPointerDown,
                    onMouseDown: handleEndWebPointerDown,
                    onTouchStart: handleEndWebPointerDown,
                    onDoubleClick: requestReset,
                },
            },
        } : {}),
    };
}

