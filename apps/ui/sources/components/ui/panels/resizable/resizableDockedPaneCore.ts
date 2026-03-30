import * as React from 'react';
import { PanResponder, Platform } from 'react-native';
import { resolvePointerClientPoint } from '../resolvePointerClientPoint';

export type DockedPaneResizeAxis = 'x' | 'y';
export type DockedPaneResizeEdge = 'start' | 'end';

export type DockedPaneResizeCommitMeta = Readonly<{
    attemptedSizePx: number;
    clampedSizePx: number;
    exceededMinPx: boolean;
    exceededMaxPx: boolean;
}>;

export type ResizableDockedPaneCoreInput = Readonly<{
    axis: DockedPaneResizeAxis;
    resizeEdge: DockedPaneResizeEdge;
    sizePx: number;
    minSizePx: number;
    maxSizePx: number;
    onCommitSizePx: (sizePx: number, meta?: DockedPaneResizeCommitMeta) => void;
    onDragSizePx?: (sizePx: number | null, meta?: DockedPaneResizeCommitMeta | null) => void;
}>;

export type ResizableDockedPaneCoreResult = Readonly<{
    effectiveSizePx: number;
    canResize: boolean;
    panHandlers: unknown;
    webHandleProps: Readonly<Record<string, unknown>>;
}>;

function resolveAxisDelta(gesture: Readonly<{ dx?: number; dy?: number }>, axis: DockedPaneResizeAxis): number {
    const raw = axis === 'x' ? gesture.dx : gesture.dy;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function resolveWebClientCoord(event: any, axis: DockedPaneResizeAxis): number | null {
    const point = resolvePointerClientPoint(event);
    return axis === 'x' ? point.x : point.y;
}

function resolveWebFallbackCoord(event: any, axis: DockedPaneResizeAxis): number | null {
    const locationKey = axis === 'x' ? 'locationX' : 'locationY';
    const location = (() => {
        const value = event?.nativeEvent?.[locationKey];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    })();

    const rectAxisKey = axis === 'x' ? 'left' : 'top';
    const targetAxis = (() => {
        const currentTarget = event?.currentTarget;
        if (typeof currentTarget?.getBoundingClientRect === 'function') {
            const rect = currentTarget.getBoundingClientRect?.();
            const value = rect?.[rectAxisKey];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        const target = event?.target;
        if (typeof target?.getBoundingClientRect === 'function') {
            const rect = target.getBoundingClientRect?.();
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

function resolveClampedSizeState(value: number, minSizePx: number, maxSizePx: number): DockedPaneResizeCommitMeta {
    return {
        attemptedSizePx: value,
        clampedSizePx: Math.min(maxSizePx, Math.max(minSizePx, value)),
        exceededMinPx: value < minSizePx,
        exceededMaxPx: value > maxSizePx,
    };
}

export function useResizableDockedPaneCore(input: ResizableDockedPaneCoreInput): ResizableDockedPaneCoreResult {
    const { sizePx, minSizePx, maxSizePx, onCommitSizePx } = input;
    const onDragSizePx = input.onDragSizePx;
    const axis = input.axis;
    const resizeEdge = input.resizeEdge;
    const edgeSign = resizeEdge === 'start' ? -1 : 1;

    const canResize = maxSizePx - minSizePx > 1;

    const dragStartSizeRef = React.useRef<number | null>(null);
    const dragStartClientCoordRef = React.useRef<number | null>(null);
    const dragLatestSizeRef = React.useRef<number | null>(null);
    const dragLatestAttemptedSizeRef = React.useRef<number | null>(null);
    const dragExceededMinRef = React.useRef(false);
    const dragExceededMaxRef = React.useRef(false);
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

    const createCommitMeta = React.useCallback((attemptedSizePx: number | null, clampedSizePx: number): DockedPaneResizeCommitMeta => {
        const attempted = attemptedSizePx ?? clampedSizePx;
        return {
            attemptedSizePx: attempted,
            clampedSizePx,
            exceededMinPx: dragExceededMinRef.current || attempted < minSizePxRef.current,
            exceededMaxPx: dragExceededMaxRef.current || attempted > maxSizePxRef.current,
        };
    }, []);

    const resetDragTracking = React.useCallback(() => {
        dragStartSizeRef.current = null;
        dragStartClientCoordRef.current = null;
        dragLatestSizeRef.current = null;
        dragLatestAttemptedSizeRef.current = null;
        dragExceededMinRef.current = false;
        dragExceededMaxRef.current = false;
        setDragSizePx(null);
    }, []);

    const effectiveSizePx = dragSizePx ?? clampLatest(sizePx);
    effectiveSizeRef.current = effectiveSizePx;

    const panResponder = React.useMemo(() => {
        return PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                const startSizePx = effectiveSizeRef.current;
                dragStartSizeRef.current = startSizePx;
                dragLatestSizeRef.current = startSizePx;
                dragLatestAttemptedSizeRef.current = startSizePx;
                dragExceededMinRef.current = false;
                dragExceededMaxRef.current = false;
                setDragSizePx(startSizePx);
                onDragSizePxRef.current?.(startSizePx, createCommitMeta(startSizePx, startSizePx));
            },
            onPanResponderMove: (_event, gesture) => {
                const start = dragStartSizeRef.current ?? effectiveSizeRef.current;
                const delta = resolveAxisDelta(gesture, axis);
                const attempted = start + (edgeSign * delta);
                const next = resolveClampedSizeState(attempted, minSizePxRef.current, maxSizePxRef.current);
                dragLatestAttemptedSizeRef.current = attempted;
                dragExceededMinRef.current = dragExceededMinRef.current || next.exceededMinPx;
                dragExceededMaxRef.current = dragExceededMaxRef.current || next.exceededMaxPx;
                dragLatestSizeRef.current = next.clampedSizePx;
                setDragSizePx(next.clampedSizePx);
                onDragSizePxRef.current?.(next.clampedSizePx, next);
            },
            onPanResponderRelease: () => {
                const next = clampLatest(dragLatestSizeRef.current ?? effectiveSizeRef.current);
                const commitMeta = createCommitMeta(dragLatestAttemptedSizeRef.current, next);
                resetDragTracking();
                onCommitSizePxRef.current(next, commitMeta);
                onDragSizePxRef.current?.(null, null);
            },
            onPanResponderTerminate: () => {
                resetDragTracking();
                onDragSizePxRef.current?.(null, null);
            },
        });
    }, [axis, clampLatest, createCommitMeta, edgeSign, resetDragTracking]);

    const handleWebPointerDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        webDragCleanupRef.current?.();
        let clientCoord = resolveWebClientCoord(event, axis);
        if (clientCoord == null) {
            clientCoord = resolveWebFallbackCoord(event, axis);
        }

        event?.preventDefault?.();
        event?.stopPropagation?.();

        const startSizePx = effectiveSizeRef.current;
        dragStartSizeRef.current = startSizePx;
        dragStartClientCoordRef.current = clientCoord;
        dragLatestSizeRef.current = startSizePx;
        dragLatestAttemptedSizeRef.current = startSizePx;
        dragExceededMinRef.current = false;
        dragExceededMaxRef.current = false;
        setDragSizePx(startSizePx);
        onDragSizePxRef.current?.(startSizePx, createCommitMeta(startSizePx, startSizePx));

        const win: any = (globalThis as any).window;
        if (!win?.addEventListener) return;

        const onMove = (moveEvent: any) => {
            const nextClient = resolveWebClientCoord(moveEvent, axis);
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
            const attempted = startSize + (edgeSign * delta);
            const next = resolveClampedSizeState(attempted, minSizePxRef.current, maxSizePxRef.current);
            dragLatestAttemptedSizeRef.current = attempted;
            dragExceededMinRef.current = dragExceededMinRef.current || next.exceededMinPx;
            dragExceededMaxRef.current = dragExceededMaxRef.current || next.exceededMaxPx;
            dragLatestSizeRef.current = next.clampedSizePx;
            setDragSizePx(next.clampedSizePx);
            onDragSizePxRef.current?.(next.clampedSizePx, next);
            moveEvent?.preventDefault?.();
        };

        const cleanup = () => {
            win.removeEventListener?.('pointermove', onMove);
            win.removeEventListener?.('mousemove', onMove);
            win.removeEventListener?.('touchmove', onMove);
            win.removeEventListener?.('pointerup', onUp);
            win.removeEventListener?.('mouseup', onUp);
            win.removeEventListener?.('touchend', onUp);
            win.removeEventListener?.('pointercancel', onUp);
            win.removeEventListener?.('touchcancel', onUp);
            if (webDragCleanupRef.current === cleanup) {
                webDragCleanupRef.current = null;
            }
        };
        webDragCleanupRef.current = cleanup;

        const onUp = (_upEvent: any) => {
            cleanup();
            const next = clampLatest(dragLatestSizeRef.current ?? effectiveSizeRef.current);
            const commitMeta = createCommitMeta(dragLatestAttemptedSizeRef.current, next);
            resetDragTracking();
            onCommitSizePxRef.current(next, commitMeta);
            onDragSizePxRef.current?.(null, null);
        };

        win.addEventListener('pointermove', onMove);
        win.addEventListener('mousemove', onMove);
        win.addEventListener('touchmove', onMove);
        win.addEventListener('pointerup', onUp);
        win.addEventListener('mouseup', onUp);
        win.addEventListener('touchend', onUp);
        win.addEventListener('pointercancel', onUp);
        win.addEventListener('touchcancel', onUp);

        const target = event?.currentTarget ?? event?.target;
        const pointerId = event?.nativeEvent?.pointerId ?? event?.pointerId;
        if (typeof target?.setPointerCapture === 'function' && typeof pointerId === 'number') {
            try {
                target.setPointerCapture(pointerId);
            } catch {
                // Best-effort pointer capture; ignore failures.
            }
        }
    }, [axis, clampLatest, createCommitMeta, edgeSign, resetDragTracking]);

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
            dragExceededMinRef.current = false;
            dragExceededMaxRef.current = false;
            if (hadActiveDrag) {
                onDragSizePxRef.current?.(null, null);
            }
        };
    }, []);

    const handleKeyDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        const key = String(event?.key ?? '');

        const supportsKey =
            axis === 'x'
                ? (key === 'ArrowLeft' || key === 'ArrowRight')
                : (key === 'ArrowUp' || key === 'ArrowDown');
        if (!supportsKey) return;

        event?.preventDefault?.();
        event?.stopPropagation?.();

        const step = event?.shiftKey ? 32 : 8;
        const arrowSign =
            axis === 'x'
                ? (key === 'ArrowRight' ? 1 : -1)
                : (key === 'ArrowDown' ? 1 : -1);
        const next = resolveClampedSizeState(
            effectiveSizeRef.current + (arrowSign * edgeSign * step),
            minSizePxRef.current,
            maxSizePxRef.current
        );
        onCommitSizePxRef.current(next.clampedSizePx, next);
    }, [axis, edgeSign]);

    return {
        effectiveSizePx,
        canResize,
        panHandlers: panResponder.panHandlers,
        webHandleProps: {
            onKeyDown: handleKeyDown,
            onPressIn: handleWebPointerDown,
            onPointerDown: handleWebPointerDown,
            onMouseDown: handleWebPointerDown,
            onTouchStart: handleWebPointerDown,
        },
    };
}
