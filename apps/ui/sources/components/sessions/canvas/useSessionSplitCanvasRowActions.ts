import * as React from 'react';

import { createSessionSplitCanvasRowActionCallbacks, resolveSessionSplitCanvasRowActionMode, type SessionCanvasRowCallbacks } from './sessionSplitCanvasRowActions';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import {
    getSessionSplitCanvasRuntimeSnapshot,
    subscribeSessionSplitCanvasRuntime,
} from './sessionSplitCanvasRuntime';
import { useSessionCanvasEligibility } from './useSessionCanvasEligibility';

export type SessionSplitCanvasRowActionState = Readonly<{
    mode: 'none' | 'open' | 'reveal';
}> & SessionCanvasRowCallbacks;

function useResolvedSessionSplitCanvasRowActions(input: Readonly<{
    sessionId: string;
    scope: ReturnType<typeof useSessionCanvasEligibility>['scope'];
    isCanvasEligible: boolean;
}>): SessionSplitCanvasRowActionState {
    const accountScope = useActiveServerAccountScope();
    const latest = React.useRef(input);
    latest.current = input;
    const callbacks = React.useMemo(() => createSessionSplitCanvasRowActionCallbacks(() => ({
        ...latest.current, activeEntityScope: getActiveServerAccountScope(),
    })), []);
    const mode: SessionSplitCanvasRowActionState['mode'] = React.useSyncExternalStore<SessionSplitCanvasRowActionState['mode']>(
        subscribeSessionSplitCanvasRuntime,
        () => resolveSessionSplitCanvasRowActionMode({
            isCanvasEligible: input.isCanvasEligible,
            scope: input.scope,
            runtimeSnapshot: getSessionSplitCanvasRuntimeSnapshot(),
            sessionId: input.sessionId,
            activeEntityScope: accountScope ? getActiveServerAccountScope() : null,
        }),
        () => 'none',
    );

    return React.useMemo(() => ({ mode, ...callbacks }), [mode, callbacks]);
}

export function useSessionSplitCanvasRowActions(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): SessionSplitCanvasRowActionState {
    const eligibility = useSessionCanvasEligibility(input.sessionId, {
        routeServerId: input.serverId,
    });

    return useResolvedSessionSplitCanvasRowActions({
        sessionId: input.sessionId,
        scope: eligibility.scope,
        isCanvasEligible: eligibility.isCanvasEligible,
    });
}

export function useSessionSplitCanvasRowActionsForScope(input: Readonly<{
    sessionId: string;
    scope: ReturnType<typeof useSessionCanvasEligibility>['scope'];
}>): SessionSplitCanvasRowActionState {
    return useResolvedSessionSplitCanvasRowActions({
        sessionId: input.sessionId,
        scope: input.scope,
        isCanvasEligible: input.scope != null,
    });
}
