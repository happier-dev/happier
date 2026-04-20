export const SESSION_SPLIT_CANVAS_DRAG_STATE_EVENT = 'happier:session-split-canvas-drag-state';

export type SessionSplitCanvasDragStateDetail = Readonly<{
    active: boolean;
}>;

export function emitSessionSplitCanvasDragState(active: boolean): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent<SessionSplitCanvasDragStateDetail>(SESSION_SPLIT_CANVAS_DRAG_STATE_EVENT, {
        detail: { active },
    }));
}
