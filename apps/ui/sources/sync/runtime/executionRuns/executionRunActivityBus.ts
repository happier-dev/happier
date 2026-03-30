type Listener = () => void;

const listenersBySessionId = new Map<string, Set<Listener>>();

export function notifyExecutionRunActivity(sessionId: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return;

    const listeners = listenersBySessionId.get(normalizedSessionId);
    if (!listeners || listeners.size === 0) return;

    // Defensive copy: listeners may add/remove subscriptions while handling the notification.
    for (const listener of Array.from(listeners)) {
        try {
            listener();
        } catch {
            // ignore listener errors
        }
    }
}

export function subscribeExecutionRunActivity(sessionId: string, listener: Listener): () => void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return () => {};

    const listeners = listenersBySessionId.get(normalizedSessionId) ?? new Set<Listener>();
    listeners.add(listener);
    listenersBySessionId.set(normalizedSessionId, listeners);

    return () => {
        const current = listenersBySessionId.get(normalizedSessionId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
            listenersBySessionId.delete(normalizedSessionId);
        }
    };
}

