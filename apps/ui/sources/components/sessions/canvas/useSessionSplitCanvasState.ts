import * as React from 'react';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { useIsDataReady, useSettingMutable } from '@/sync/domains/state/storage';
import { createSessionSplitCanvasPersistenceSnapshot, readPersistedSessionSplitCanvasSnapshot, shouldPersistSessionSplitCanvasSnapshot, writePersistedSessionSplitCanvasSnapshot } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { resolveSessionSplitCanvasScopeKey } from '@/sync/domains/session/sessionSplitCanvasScope';
import { reconcileSessionSplitCanvasRouteAnchor, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState, type SessionCanvasSplitMeasurement, type SessionSplitCanvasAction, type SessionSplitCanvasState } from './sessionSplitCanvasState';

export type { SessionSplitCanvasState } from './sessionSplitCanvasState';
export function useSessionSplitCanvasState(input: Readonly<{
    routeSessionId: string;
    scope: SessionSplitCanvasScope;
    entityScope: EntityDragScopeV1;
}>) {
    const [layouts, setLayouts] = useSettingMutable('sessionSplitCanvasLayoutsV1');
    const isDataReady = useIsDataReady();
    const scopeKey = resolveSessionSplitCanvasScopeKey(input.scope)!;
    const persistedSnapshot = React.useMemo(() => readPersistedSessionSplitCanvasSnapshot({
        settings: { sessionSplitCanvasLayoutsV1: layouts }, scopeKey,
    }), [layouts, scopeKey]);
    const initial = React.useMemo(() => resolveSessionSplitCanvasState({
        sessionId: input.routeSessionId, scope: input.entityScope, persistedSnapshot,
    }), [input.routeSessionId, input.entityScope.serverId, input.entityScope.accountId, persistedSnapshot]);
    const [state, setState] = React.useState(initial);
    const stateRef = React.useRef(state);
    const latest = React.useRef({ input, layouts, isDataReady, scopeKey, setLayouts });
    latest.current = { input, layouts, isDataReady, scopeKey, setLayouts };
    const restoreRef = React.useRef(persistedSnapshot);
    const routeRef = React.useRef(input.routeSessionId);
    React.useEffect(() => {
        if (restoreRef.current === persistedSnapshot) return;
        restoreRef.current = persistedSnapshot;
        const current = stateRef.current;
        if (JSON.stringify(createSessionSplitCanvasPersistenceSnapshot(current)) === JSON.stringify(createSessionSplitCanvasPersistenceSnapshot(initial))) return;
        stateRef.current = initial;
        setState(initial);
    }, [initial, persistedSnapshot]);
    const getState = React.useCallback(() => stateRef.current, []);
    const commitState = React.useCallback((next: SessionSplitCanvasState): SessionSplitCanvasState => {
        const current = stateRef.current;
        const context = latest.current;
        if (!context.isDataReady || current.scope.serverId !== context.input.entityScope.serverId
            || current.scope.accountId !== context.input.entityScope.accountId) return current;
        if (next === current) return current;
        stateRef.current = next;
        setState(next);
        const snapshot = createSessionSplitCanvasPersistenceSnapshot(next);
        if (shouldPersistSessionSplitCanvasSnapshot({ persisted: context.layouts[context.scopeKey], snapshot, routeSessionId: context.input.routeSessionId })) {
            context.setLayouts(writePersistedSessionSplitCanvasSnapshot({
                settings: { sessionSplitCanvasLayoutsV1: context.layouts }, scopeKey: context.scopeKey, snapshot,
            }).sessionSplitCanvasLayoutsV1);
        }
        return next;
    }, []);
    const dispatch = React.useCallback((action: SessionSplitCanvasAction): SessionSplitCanvasState => commitState(
        reduceSessionSplitCanvasState(stateRef.current, action, { routeSessionId: latest.current.input.routeSessionId }),
    ), [commitState]);
    React.useEffect(() => {
        if (!isDataReady || routeRef.current === input.routeSessionId) return;
        routeRef.current = input.routeSessionId;
        commitState(reconcileSessionSplitCanvasRouteAnchor(stateRef.current, input.routeSessionId));
    }, [input.routeSessionId, isDataReady, commitState]);
    const focusSession = React.useCallback((sessionId: string) => { dispatch({ type: 'focusSession', sessionId }); }, [dispatch]);
    const openSessionInSplit = React.useCallback((command: Readonly<{
        sessionId: string; direction: 'right' | 'down'; measurement?: SessionCanvasSplitMeasurement;
    }>) => { dispatch({ type: 'openSessionInSplit', ...command }); }, [dispatch]);
    return { state, getState, dispatch, focusSession, openSessionInSplit };
}
