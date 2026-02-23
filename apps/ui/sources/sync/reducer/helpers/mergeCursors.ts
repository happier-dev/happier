import type { ReducerState } from '../reducer';
import { isDebugFlagEnabled } from './debugFlags';

type StreamCursor = ReducerState['streamMergeCursor'];

type MergeCursorKind = 'stream' | 'thinking' | 'sidechain-thinking';

type MergeCursorDebugEvent = Readonly<{
    kind: MergeCursorKind;
    reason: string;
    from: unknown;
    to: unknown;
    sidechainId?: string;
}>;

export function isMergeCursorDebugEnabled(): boolean {
    return isDebugFlagEnabled({
        globalKey: '__HAPPIER_DEBUG_MERGE_CURSORS__',
        localStorageKey: 'happier.debug.mergeCursors',
    });
}

function maybeLog(event: MergeCursorDebugEvent): void {
    if (!isMergeCursorDebugEnabled()) return;
    // Never log message bodies. Cursor transitions are safe to log and help diagnose streaming regressions.
    // eslint-disable-next-line no-console
    console.log('[merge-cursors]', event);
}

export function setStreamMergeCursor(state: ReducerState, next: StreamCursor, reason: string): void {
    const prev = state.streamMergeCursor;
    if (prev?.messageId === next?.messageId && prev?.streamKey === next?.streamKey) return;
    state.streamMergeCursor = next;
    maybeLog({
        kind: 'stream',
        reason,
        from: prev,
        to: next,
    });
}

export function setThinkingMergeCursor(state: ReducerState, next: string | null, reason: string): void {
    const prev = state.thinkingMergeCursor;
    if (prev === next) return;
    state.thinkingMergeCursor = next;
    maybeLog({
        kind: 'thinking',
        reason,
        from: prev,
        to: next,
    });
}

export function clearAllMainMergeCursors(state: ReducerState, reason: string): void {
    setThinkingMergeCursor(state, null, reason);
    setStreamMergeCursor(state, null, reason);
}

export function getSidechainThinkingMergeCursor(state: ReducerState, sidechainId: string): string | null {
    const prev = state.sidechainThinkingMergeCursors.get(sidechainId);
    return typeof prev === 'string' ? prev : null;
}

export function setSidechainThinkingMergeCursor(
    state: ReducerState,
    sidechainId: string,
    next: string | null,
    reason: string,
): void {
    const prev = getSidechainThinkingMergeCursor(state, sidechainId);
    if (prev === next) return;
    if (next === null) {
        state.sidechainThinkingMergeCursors.delete(sidechainId);
    } else {
        state.sidechainThinkingMergeCursors.set(sidechainId, next);
    }
    maybeLog({
        kind: 'sidechain-thinking',
        reason,
        from: prev,
        to: next,
        sidechainId,
    });
}
