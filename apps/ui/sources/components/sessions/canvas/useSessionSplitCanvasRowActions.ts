import * as React from 'react';

import { areSessionSplitCanvasScopesCompatible } from '@/sync/domains/session/sessionSplitCanvasScope';
import {
    getSessionSplitCanvasRuntimeController,
    getSessionSplitCanvasRuntimeSnapshot,
    subscribeSessionSplitCanvasRuntime,
    type SessionSplitCanvasRuntimeSnapshot,
} from './sessionSplitCanvasRuntime';
import { useSessionCanvasEligibility } from './useSessionCanvasEligibility';

export type SessionSplitCanvasRowActionState = Readonly<{
    mode: 'none' | 'open' | 'reveal';
    openInSplitRight: () => void;
    openInSplitDown: () => void;
    revealInSplit: () => void;
}>;

function resolveSessionSplitCanvasRowActionMode(input: Readonly<{
    isCanvasEligible: boolean;
    scope: ReturnType<typeof useSessionCanvasEligibility>['scope'];
    runtimeSnapshot: SessionSplitCanvasRuntimeSnapshot;
    sessionId: string;
}>): SessionSplitCanvasRowActionState['mode'] {
    if (!input.isCanvasEligible) {
        return 'none';
    }
    if (!areSessionSplitCanvasScopesCompatible(input.scope, input.runtimeSnapshot.scope)) {
        return 'none';
    }
    if (input.runtimeSnapshot.openSessionIds.includes(input.sessionId)) {
        return 'reveal';
    }
    return 'open';
}

function useResolvedSessionSplitCanvasRowActions(input: Readonly<{
    sessionId: string;
    scope: ReturnType<typeof useSessionCanvasEligibility>['scope'];
    isCanvasEligible: boolean;
}>): SessionSplitCanvasRowActionState {
    const mode: SessionSplitCanvasRowActionState['mode'] = React.useSyncExternalStore<SessionSplitCanvasRowActionState['mode']>(
        subscribeSessionSplitCanvasRuntime,
        () => resolveSessionSplitCanvasRowActionMode({
            isCanvasEligible: input.isCanvasEligible,
            scope: input.scope,
            runtimeSnapshot: getSessionSplitCanvasRuntimeSnapshot(),
            sessionId: input.sessionId,
        }),
        () => 'none',
    );

    const openInSplitRight = React.useCallback(() => {
        if (mode !== 'open') {
            return;
        }
        getSessionSplitCanvasRuntimeController()?.openSessionInSplit({
            sessionId: input.sessionId,
            direction: 'right',
        });
    }, [input.sessionId, mode]);

    const openInSplitDown = React.useCallback(() => {
        if (mode !== 'open') {
            return;
        }
        getSessionSplitCanvasRuntimeController()?.openSessionInSplit({
            sessionId: input.sessionId,
            direction: 'down',
        });
    }, [input.sessionId, mode]);

    const revealInSplit = React.useCallback(() => {
        if (mode !== 'reveal') {
            return;
        }
        getSessionSplitCanvasRuntimeController()?.focusSession(input.sessionId);
    }, [input.sessionId, mode]);

    return React.useMemo(() => ({
        mode,
        openInSplitRight,
        openInSplitDown,
        revealInSplit,
    }), [mode, openInSplitDown, openInSplitRight, revealInSplit]);
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
