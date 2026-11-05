import * as React from 'react';
import { gestureTokens } from '@/components/ui/motion/gestureTokens';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { moveDesktopActivityOverlay } from '../runtime/desktopActivityOverlayBridge';
import type { DesktopOverlayDock } from '../runtime/resolveDesktopOverlayPolicy';

export type NotchDragPointerEvent = Readonly<{
    button: number;
    isPrimary?: boolean;
    pointerId: number;
    screenX: number;
    screenY: number;
    currentTarget: HTMLElement;
    preventDefault(): void;
    stopPropagation(): void;
}>;

type PendingMove = { delta: { x: number; y: number }; commit: boolean };
type Drag = {
    pointerId: number;
    target: HTMLElement;
    dock: DesktopOverlayDock;
    start: { x: number; y: number };
    last: { x: number; y: number };
    dragging: boolean;
    pending: PendingMove | null;
};

/** Bind to the notch's drag handle. Screen coordinates retain the grab point as native moves the window. */
export function useNotchDrag(dock: DesktopOverlayDock) {
    const active = React.useRef<Drag | null>(null);
    const pending = React.useRef<PendingMove[]>([]);
    const frame = React.useRef<number | null>(null);
    const suppressClick = React.useRef(false);

    function schedule() {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
            frame.current = null;
            const move = pending.current.shift();
            if (!move) return;
            if (active.current?.pending === move) active.current.pending = null;
            fireAndForget(moveDesktopActivityOverlay(move), { tag: 'useNotchDrag.move' });
            // Two short gestures before a paint still commit individually, one IPC per frame.
            if (pending.current.length > 0) schedule();
        });
    }

    function enqueue(drag: Drag, x: number, y: number, commit: boolean) {
        if (!drag.pending) {
            drag.pending = { delta: { x: 0, y: 0 }, commit: false };
            pending.current.push(drag.pending);
        }
        drag.pending.delta.x += x;
        drag.pending.delta.y += y;
        drag.pending.commit ||= commit;
        schedule();
    }

    function update(event: NotchDragPointerEvent) {
        const drag = active.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const x = drag.dock === 'left' || drag.dock === 'right' ? 0 : event.screenX - drag.start.x;
        const y = drag.dock === 'top' ? 0 : event.screenY - drag.start.y;
        if (!drag.dragging && Math.hypot(x, y) <= gestureTokens.slopPx) return;
        drag.dragging = true;
        suppressClick.current = true;
        const dx = drag.dock === 'left' || drag.dock === 'right' ? 0 : event.screenX - drag.last.x;
        const dy = drag.dock === 'top' ? 0 : event.screenY - drag.last.y;
        drag.last = { x: event.screenX, y: event.screenY };
        if (dx !== 0 || dy !== 0) enqueue(drag, dx, dy, false);
        event.preventDefault();
    }

    function end(event: NotchDragPointerEvent, sample: boolean) {
        const drag = active.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (sample) update(event);
        active.current = null;
        if (drag.dragging) enqueue(drag, 0, 0, true);
        if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    }

    React.useEffect(() => () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        pending.current = [];
        const drag = active.current;
        active.current = null;
        if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    }, []);

    return {
        onPointerDown(event: NotchDragPointerEvent) {
            if (event.button !== 0 || event.isPrimary === false || active.current) return;
            suppressClick.current = false;
            active.current = { pointerId: event.pointerId, target: event.currentTarget, dock,
                start: { x: event.screenX, y: event.screenY }, last: { x: event.screenX, y: event.screenY },
                dragging: false, pending: null };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove: update,
        onPointerUp: (event: NotchDragPointerEvent) => end(event, true),
        onPointerCancel: (event: NotchDragPointerEvent) => end(event, false),
        onLostPointerCapture: (event: NotchDragPointerEvent) => end(event, false),
        onClickCapture(event: Pick<NotchDragPointerEvent, 'preventDefault' | 'stopPropagation'>) {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
        },
    };
}
