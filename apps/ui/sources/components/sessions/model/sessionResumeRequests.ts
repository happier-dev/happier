import * as React from 'react';

export type SessionResumeRequestListener = () => Promise<boolean>;

const listenersBySessionId = new Map<string, Set<SessionResumeRequestListener>>();

export async function emitSessionResumeRequest(sessionId: string): Promise<boolean> {
    const listeners = listenersBySessionId.get(sessionId);
    if (!listeners || listeners.size === 0) {
        throw new Error(`No resume listener is registered for session ${sessionId}`);
    }

    const results = await Promise.all(Array.from(listeners, (listener) => listener()));
    return results.every(Boolean);
}

export function useSessionResumeRequestListener(
    sessionId: string,
    listener: SessionResumeRequestListener,
): void {
    React.useEffect(() => {
        const listeners = listenersBySessionId.get(sessionId) ?? new Set<SessionResumeRequestListener>();
        listeners.add(listener);
        listenersBySessionId.set(sessionId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                listenersBySessionId.delete(sessionId);
            }
        };
    }, [listener, sessionId]);
}
