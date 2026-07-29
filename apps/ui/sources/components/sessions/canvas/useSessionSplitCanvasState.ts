import * as React from 'react';

import { useSplitCanvasPersistence } from '@/components/appShell/splitCanvas/hooks/useSplitCanvasPersistence';
import type { SplitCanvasAction } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { useIsDataReady, useSettingMutable } from '@/sync/domains/state/storage';
import {
    readPersistedSessionSplitCanvasSnapshot,
    shouldPersistSessionSplitCanvasSnapshot,
    writePersistedSessionSplitCanvasSnapshot,
    type SessionSplitCanvasLeafPayload,
} from '@/sync/domains/session/sessionSplitCanvasPersistence';
import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { resolveSessionSplitCanvasScopeKey } from '@/sync/domains/session/sessionSplitCanvasScope';
import {
    reconcileSessionSplitCanvasRouteAnchor,
    reduceSessionSplitCanvasState,
    resolveSessionSplitCanvasState,
    runSessionSplitCanvasCommand,
    type SessionSplitCanvasState,
} from './sessionSplitCanvasState';

export type { SessionSplitCanvasState } from './sessionSplitCanvasState';

function areJsonEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function useSessionSplitCanvasState(input: Readonly<{
    routeSessionId: string;
    scope: SessionSplitCanvasScope | null;
}>): Readonly<{
    state: SessionSplitCanvasState;
    dispatch: (action: SplitCanvasAction<SessionSplitCanvasLeafPayload>) => void;
    openSessionInSplit: (input: Readonly<{
        sessionId: string;
        direction: 'right' | 'down';
    }>) => void;
    focusSession: (sessionId: string) => void;
}> {
    const [sessionSplitCanvasLayoutsV1, setSessionSplitCanvasLayoutsV1] = useSettingMutable('sessionSplitCanvasLayoutsV1');
    const isDataReady = useIsDataReady();
    const scopeKey = React.useMemo(() => resolveSessionSplitCanvasScopeKey(input.scope), [input.scope]);
    const persistedSnapshot = React.useMemo(() => readPersistedSessionSplitCanvasSnapshot({
        settings: { sessionSplitCanvasLayoutsV1 },
        scopeKey,
    }), [scopeKey, sessionSplitCanvasLayoutsV1]);
    const resolvedState = React.useMemo(() => resolveSessionSplitCanvasState({
        sessionId: input.routeSessionId,
        persistedSnapshot,
    }), [input.routeSessionId, persistedSnapshot]);
    const [state, setState] = React.useState<SessionSplitCanvasState>(resolvedState);
    const restoreIdentity = React.useMemo(() => JSON.stringify({
        scopeKey,
        persistedSnapshot,
    }), [persistedSnapshot, scopeKey]);
    const lastRestoreIdentityRef = React.useRef<string | null>(null);
    const previousRouteSessionIdRef = React.useRef(input.routeSessionId);
    const [persistenceReadyIdentity, setPersistenceReadyIdentity] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (lastRestoreIdentityRef.current === restoreIdentity) {
            return;
        }
        lastRestoreIdentityRef.current = restoreIdentity;
        setState((current) => (areJsonEqual(current, resolvedState) ? current : resolvedState));
    }, [resolvedState, restoreIdentity]);

    React.useEffect(() => {
        const previousRouteSessionId = previousRouteSessionIdRef.current;
        previousRouteSessionIdRef.current = input.routeSessionId;
        setState((current) => reconcileSessionSplitCanvasRouteAnchor(current, input.routeSessionId, {
            previousRouteSessionId,
        }));
    }, [input.routeSessionId]);

    React.useEffect(() => {
        if (!scopeKey || !isDataReady) {
            return;
        }
        if (persistenceReadyIdentity === restoreIdentity) {
            return;
        }
        if (!areJsonEqual(state, resolvedState)) {
            return;
        }
        setPersistenceReadyIdentity(restoreIdentity);
    }, [isDataReady, persistenceReadyIdentity, resolvedState, restoreIdentity, scopeKey, state]);

    const dispatch = React.useCallback((action: SplitCanvasAction<SessionSplitCanvasLeafPayload>) => {
        setState((current) => reduceSessionSplitCanvasState(current, action, {
            routeSessionId: input.routeSessionId,
        }));
    }, [input.routeSessionId]);

    const openSessionInSplit = React.useCallback((command: Readonly<{
        sessionId: string;
        direction: 'right' | 'down';
    }>) => {
        setState((current) => runSessionSplitCanvasCommand(current, {
            type: 'openSessionInSplit',
            sessionId: command.sessionId,
            direction: command.direction,
        }));
    }, []);

    const focusSession = React.useCallback((sessionId: string) => {
        setState((current) => runSessionSplitCanvasCommand(current, {
            type: 'focusSession',
            sessionId,
        }));
    }, []);

    useSplitCanvasPersistence<SessionSplitCanvasLeafPayload>({
        state,
        enabled: Boolean(scopeKey) && isDataReady && persistenceReadyIdentity === restoreIdentity,
        onPersist: React.useCallback((snapshot) => {
            if (!scopeKey) {
                return;
            }
            const persisted = sessionSplitCanvasLayoutsV1?.[scopeKey] ?? null;
            if (!shouldPersistSessionSplitCanvasSnapshot({
                persisted,
                snapshot,
                routeSessionId: input.routeSessionId,
            })) {
                return;
            }
            setSessionSplitCanvasLayoutsV1(writePersistedSessionSplitCanvasSnapshot({
                settings: { sessionSplitCanvasLayoutsV1 },
                scopeKey,
                snapshot,
            }).sessionSplitCanvasLayoutsV1);
        }, [scopeKey, sessionSplitCanvasLayoutsV1, setSessionSplitCanvasLayoutsV1]),
    });

    return {
        state,
        dispatch,
        openSessionInSplit,
        focusSession,
    };
}
