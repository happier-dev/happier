import * as React from 'react';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

export type SessionResumeRequestListener = (invocation?: CurrentUiContextCommandInvocation) => Promise<boolean>;

/**
 * Resume listeners keyed by Session id, then by the exact Home that registered them.
 *
 * Two Homes can host the same Session id, so a qualified request must reach that Home's Session
 * and no other. The unqualified legacy entry point stays admissible only while exactly one Home
 * has a listener for the id: with several, resuming the focused or first one would resume the
 * wrong Session.
 */
type ResumeRequestScope = {
    listeners: Set<SessionResumeRequestListener>;
    observers: Set<() => void>;
};
const listenersBySessionId = new Map<string, Map<string, ResumeRequestScope>>();

function getResumeRequestScope(sessionId: string, serverScope: string): ResumeRequestScope {
    const scopes = listenersBySessionId.get(sessionId) ?? new Map<string, ResumeRequestScope>();
    const scope = scopes.get(serverScope) ?? { listeners: new Set(), observers: new Set() };
    scopes.set(serverScope, scope);
    listenersBySessionId.set(sessionId, scopes);
    return scope;
}

function retireEmptyResumeRequestScope(sessionId: string, serverScope: string, scope: ResumeRequestScope) {
    if (scope.listeners.size || scope.observers.size) return;
    const scopes = listenersBySessionId.get(sessionId);
    scopes?.delete(serverScope);
    if (scopes?.size === 0) listenersBySessionId.delete(sessionId);
}

function normalizeServerScope(serverId: string | null | undefined): string {
    return typeof serverId === 'string' ? serverId.trim() : '';
}

function readResumeListeners(
    sessionId: string,
    serverScope: string,
): Set<SessionResumeRequestListener> | undefined {
    const listenersByServerScope = listenersBySessionId.get(sessionId);
    if (!listenersByServerScope) return undefined;
    if (serverScope) return listenersByServerScope.get(serverScope)?.listeners;
    const registered = [...listenersByServerScope.values()].filter(scope => scope.listeners.size > 0);
    return registered.length === 1 ? registered[0].listeners : undefined;
}

/** Presence comes only from the existing exact-Home register/unregister lifecycle. */
export function useSessionResumeRequestAvailable(sessionId: string, serverId: string | null | undefined): boolean {
    const serverScope = normalizeServerScope(serverId);
    const subscribe = React.useCallback((observer: () => void) => {
        if (!serverScope) return () => {};
        const scope = getResumeRequestScope(sessionId, serverScope);
        scope.observers.add(observer);
        return () => {
            scope.observers.delete(observer);
            retireEmptyResumeRequestScope(sessionId, serverScope, scope);
        };
    }, [sessionId, serverScope]);
    const getSnapshot = React.useCallback(() => Boolean(serverScope
        && listenersBySessionId.get(sessionId)?.get(serverScope)?.listeners.size), [sessionId, serverScope]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function emitSessionResumeRequest(
    sessionId: string,
    serverId?: string | null,
    invocation?: CurrentUiContextCommandInvocation,
): Promise<boolean> {
    const serverScope = normalizeServerScope(serverId);
    const listeners = readResumeListeners(sessionId, serverScope);
    if (!listeners || listeners.size === 0) {
        throw new Error(
            `No resume listener is registered for session ${sessionId}${serverScope ? ` on Home ${serverScope}` : ''}`,
        );
    }

    const results = await Promise.all(Array.from(listeners, (listener) => listener(invocation)));
    return results.every(Boolean);
}

export function useSessionResumeRequestListener(
    sessionId: string,
    listener: SessionResumeRequestListener,
    serverId?: string | null,
): void {
    const serverScope = normalizeServerScope(serverId);
    React.useEffect(() => {
        const scope = getResumeRequestScope(sessionId, serverScope);
        const listeners = scope.listeners;
        const wasAvailable = listeners.size > 0;
        listeners.add(listener);
        if (!wasAvailable) for (const observer of scope.observers) observer();
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) for (const observer of scope.observers) observer();
            retireEmptyResumeRequestScope(sessionId, serverScope, scope);
        };
    }, [listener, sessionId, serverScope]);
}
