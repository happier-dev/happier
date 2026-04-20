import * as React from 'react';

import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';

export type SessionSplitCanvasRuntimeSnapshot = Readonly<{
    routeSessionId: string | null;
    focusedSessionId: string | null;
    openSessionIds: ReadonlyArray<string>;
    scope: SessionSplitCanvasScope | null;
}>;

export type SessionSplitCanvasRuntimeController = Readonly<{
    focusSession: (sessionId: string) => void;
    openSessionInSplit: (input: Readonly<{
        sessionId: string;
        direction: 'right' | 'down';
    }>) => void;
}>;

const listeners = new Set<() => void>();

let snapshot: SessionSplitCanvasRuntimeSnapshot = {
    routeSessionId: null,
    focusedSessionId: null,
    openSessionIds: [],
    scope: null,
};
let controller: SessionSplitCanvasRuntimeController | null = null;
let runtimeRegistrationVersion = 0;
let pendingResetTimeout: ReturnType<typeof setTimeout> | null = null;

function emitChange(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function getSessionSplitCanvasRuntimeSnapshot(): SessionSplitCanvasRuntimeSnapshot {
    return snapshot;
}

export function getSessionSplitCanvasRuntimeController(): SessionSplitCanvasRuntimeController | null {
    return controller;
}

export function subscribeSessionSplitCanvasRuntime(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useSessionSplitCanvasRuntimeSnapshot(): SessionSplitCanvasRuntimeSnapshot {
    return React.useSyncExternalStore(
        subscribeSessionSplitCanvasRuntime,
        getSessionSplitCanvasRuntimeSnapshot,
        getSessionSplitCanvasRuntimeSnapshot,
    );
}

export function registerSessionSplitCanvasRuntime(input: Readonly<{
    snapshot: SessionSplitCanvasRuntimeSnapshot;
    controller: SessionSplitCanvasRuntimeController;
}>): () => void {
    if (pendingResetTimeout != null) {
        clearTimeout(pendingResetTimeout);
        pendingResetTimeout = null;
    }
    runtimeRegistrationVersion += 1;
    const registrationVersion = runtimeRegistrationVersion;
    const registrationKey = input.controller;
    snapshot = input.snapshot;
    controller = input.controller;
    emitChange();

    return () => {
        pendingResetTimeout = setTimeout(() => {
            pendingResetTimeout = null;
            if (controller !== registrationKey || runtimeRegistrationVersion !== registrationVersion) {
                return;
            }
            snapshot = {
                routeSessionId: null,
                focusedSessionId: null,
                openSessionIds: [],
                scope: null,
            };
            controller = null;
            emitChange();
        }, 0);
    };
}
