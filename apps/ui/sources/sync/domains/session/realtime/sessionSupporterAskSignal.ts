type LiveTurnListener = (sessionId: string, event: 'task_started' | 'task_complete') => void;
const listeners = new Set<LiveTurnListener>();

export function subscribeSessionSupporterAskSignal(listener: LiveTurnListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function publishSessionSupporterAskSignal(sessionId: string, type: string): void {
    if (type !== 'task_started' && type !== 'task_complete') return;
    for (const listener of listeners) listener(sessionId, type);
}
