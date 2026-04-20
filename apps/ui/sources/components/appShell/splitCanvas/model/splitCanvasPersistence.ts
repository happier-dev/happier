import type {
    SplitCanvasPersistenceSnapshot,
    SplitCanvasState,
} from './splitCanvasTypes';

export type { SplitCanvasPersistenceSnapshot } from './splitCanvasTypes';

export function createSplitCanvasPersistenceSnapshot<TLeafPayload>(
    state: SplitCanvasState<TLeafPayload>,
): SplitCanvasPersistenceSnapshot<TLeafPayload> {
    return {
        version: 1,
        root: state.root,
        focusedLeafId: state.focusedLeafId,
        maximizedLeafId: state.maximizedLeafId,
        maxLeaves: state.maxLeaves,
    };
}

export function parseSplitCanvasPersistenceSnapshot<TLeafPayload>(
    value: unknown,
): SplitCanvasPersistenceSnapshot<TLeafPayload> | null {
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as SplitCanvasPersistenceSnapshot<TLeafPayload>;
    if (snapshot.version !== 1) return null;
    return snapshot;
}
