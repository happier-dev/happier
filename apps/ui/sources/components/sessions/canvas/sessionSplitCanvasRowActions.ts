import { areSessionSplitCanvasScopesCompatible, type SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionSplitCanvasRuntimeSnapshot } from './sessionSplitCanvasRuntime';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getSessionSplitCanvasRuntimeController, getSessionSplitCanvasRuntimeSnapshot } from './sessionSplitCanvasRuntime';

export type SessionCanvasRowAdmission = Readonly<{
    sessionId: string;
    scope: SessionSplitCanvasScope | null;
    isCanvasEligible: boolean;
    activeEntityScope: EntityDragScopeV1 | null;
}>;

export type SessionCanvasRowCallbacks = Readonly<{
    openInSplitRight: () => void;
    openInSplitDown: () => void;
    revealInSplit: () => void;
}>;

export function resolveSessionSplitCanvasRowActionMode(input: SessionCanvasRowAdmission & Readonly<{
    runtimeSnapshot: SessionSplitCanvasRuntimeSnapshot;
}>): 'none' | 'open' | 'reveal' {
    const runtime = input.runtimeSnapshot;
    if (!input.isCanvasEligible || !input.scope || !areSessionSplitCanvasScopesCompatible(input.scope, runtime.scope)
        || !areServerAccountScopesEqual(input.activeEntityScope, runtime.entityScope)
        || !runtime.canvasKey || runtime.canvasKey !== input.scope?.workspaceCacheKey
        || input.scope.serverId !== runtime.entityScope?.serverId
        || runtime.scope?.serverId !== runtime.entityScope?.serverId) return 'none';
    return input.runtimeSnapshot.openSessionIds.includes(input.sessionId) ? 'reveal' : 'open';
}

export function createSessionSplitCanvasRowActionCallbacks(readRow: () => SessionCanvasRowAdmission): SessionCanvasRowCallbacks {
    const open = (direction: 'right' | 'down') => {
        const row = readRow();
        const mode = resolveSessionSplitCanvasRowActionMode({ ...row, runtimeSnapshot: getSessionSplitCanvasRuntimeSnapshot() });
        if (mode === 'open') getSessionSplitCanvasRuntimeController()?.openSessionInSplit({ sessionId: row.sessionId, direction });
    };
    return {
        openInSplitRight: () => open('right'),
        openInSplitDown: () => open('down'),
        revealInSplit: () => {
            const row = readRow();
            if (resolveSessionSplitCanvasRowActionMode({ ...row, runtimeSnapshot: getSessionSplitCanvasRuntimeSnapshot() }) === 'reveal') {
                getSessionSplitCanvasRuntimeController()?.focusSession(row.sessionId);
            }
        },
    };
}
