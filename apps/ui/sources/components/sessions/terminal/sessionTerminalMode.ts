import * as React from 'react';

export type SessionTerminalMode = 'workspace_shell' | 'session_attach';

const modeBySessionId = new Map<string, SessionTerminalMode>();
const listenersBySessionId = new Map<string, Set<() => void>>();

export function readSessionTerminalMode(sessionId: string): SessionTerminalMode {
    return modeBySessionId.get(sessionId) ?? 'workspace_shell';
}

export function setSessionTerminalMode(sessionId: string, mode: SessionTerminalMode): void {
    if (readSessionTerminalMode(sessionId) === mode) return;
    modeBySessionId.set(sessionId, mode);
    for (const listener of listenersBySessionId.get(sessionId) ?? []) listener();
}

function subscribeSessionTerminalMode(sessionId: string, listener: () => void): () => void {
    const listeners = listenersBySessionId.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    listenersBySessionId.set(sessionId, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersBySessionId.delete(sessionId);
    };
}

export function useSessionTerminalMode(sessionId: string): SessionTerminalMode {
    return React.useSyncExternalStore(
        React.useCallback((listener) => subscribeSessionTerminalMode(sessionId, listener), [sessionId]),
        React.useCallback(() => readSessionTerminalMode(sessionId), [sessionId]),
        React.useCallback(() => readSessionTerminalMode(sessionId), [sessionId]),
    );
}
