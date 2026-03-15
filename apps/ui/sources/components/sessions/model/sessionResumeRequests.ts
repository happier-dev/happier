import * as React from 'react';

export type SessionResumeRequestListener = (sessionId: string) => void;

const listeners = new Set<SessionResumeRequestListener>();

export function emitSessionResumeRequest(sessionId: string): void {
    for (const listener of listeners) {
        try {
            listener(sessionId);
        } catch {
            // Listener errors should not break other listeners.
        }
    }
}

export function useSessionResumeRequestListener(listener: SessionResumeRequestListener): void {
    React.useEffect(() => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }, [listener]);
}
