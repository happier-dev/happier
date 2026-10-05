import * as React from 'react';
import type { SessionCanvasActionId, SessionCanvasActionOutcome } from '@happier-dev/protocol';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';

export type SessionSplitCanvasRuntimeSnapshot = Readonly<{
    routeSessionId: string | null;
    focusedSessionId: string | null;
    openSessionIds: ReadonlyArray<string>;
    scope: SessionSplitCanvasScope | null;
    entityScope: EntityDragScopeV1 | null;
    canvasKey: string | null;
}>;

export type SessionSplitCanvasRuntimeController = Readonly<{
    executeAction: (actionId: SessionCanvasActionId, input: unknown) => SessionCanvasActionOutcome;
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
    entityScope: null,
    canvasKey: null,
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
        if (controller !== registrationKey || runtimeRegistrationVersion !== registrationVersion) return;
        // Stop answering synchronously; only deleted-tree subscriber notification is deferred.
        controller = null;
        pendingResetTimeout = setTimeout(() => {
            pendingResetTimeout = null;
            if (runtimeRegistrationVersion !== registrationVersion) {
                return;
            }
            snapshot = {
                routeSessionId: null,
                focusedSessionId: null,
                openSessionIds: [],
                scope: null,
                entityScope: null,
                canvasKey: null,
            };
            controller = null;
            emitChange();
        }, 0);
    };
}

export async function invokeSessionCanvasAction(request: Readonly<{ actionId: SessionCanvasActionId; input: unknown; signal?: AbortSignal }>): Promise<SessionCanvasActionOutcome> {
    if (request.signal?.aborted) return { status: 'refused', reason: 'cancelled' };
    return controller ? controller.executeAction(request.actionId, request.input) : { status: 'unavailable' };
}
