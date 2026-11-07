import type { Message } from '@happier-dev/session-core/messages';
import { subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

export type SessionMessageChange = Readonly<{ previous: Message | null; next: Message }>;
export type SessionMessageChanges = Readonly<{
    kind: 'updated' | 'replaced';
    changes: readonly SessionMessageChange[];
}>;
type Listener = (change: SessionMessageChanges) => void;

/** Reducer deltas distinguish tool publications from ordinary assistant text. */
export function hasSessionMessageToolChanges(changes: readonly SessionMessageChange[]): boolean {
    return changes.some(change => change.previous?.kind === 'tool-call' || change.next.kind === 'tool-call');
}

// Only mounted demand is retained here; messages remain owned by the transcript.
const listenersBySessionId = new Map<string, Set<Listener>>();

export function publishSessionMessageChanges(sessionId: string, changes: readonly SessionMessageChange[]): void {
    if (changes.length === 0) return;
    for (const listener of listenersBySessionId.get(sessionId) ?? []) listener({ kind: 'updated', changes });
}

/** Incremental reducer output plus the existing transcript replacement/retirement boundary. */
export function subscribeSessionMessageChanges(sessionId: string, listener: Listener): () => void {
    let listeners = listenersBySessionId.get(sessionId);
    if (!listeners) {
        listeners = new Set();
        listenersBySessionId.set(sessionId, listeners);
    }
    listeners.add(listener);
    const stopLifecycle = subscribeRegisteredStorageState((state, previous) => {
        const next = state.sessionMessages[sessionId];
        const before = previous?.sessionMessages[sessionId];
        if (next?.reducerState === before?.reducerState) return;
        listener({ kind: 'replaced', changes: Object.values(next?.messagesById ?? {})
            .map(message => ({ previous: null, next: message })) });
    }, { sessionMessages: [sessionId] });
    return () => {
        stopLifecycle?.();
        listeners.delete(listener);
        if (listeners.size === 0) listenersBySessionId.delete(sessionId);
    };
}
