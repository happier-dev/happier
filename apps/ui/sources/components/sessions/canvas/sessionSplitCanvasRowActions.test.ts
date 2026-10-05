import { describe, expect, it } from 'vitest';
import type { SessionSplitCanvasRuntimeSnapshot } from './sessionSplitCanvasRuntime';
import { registerSessionSplitCanvasRuntime } from './sessionSplitCanvasRuntime';
import { collectOpenSessionIds, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState } from './sessionSplitCanvasState';
import { createSessionSplitCanvasRowActionCallbacks, resolveSessionSplitCanvasRowActionMode } from './sessionSplitCanvasRowActions';

const entityScope = { serverId: 'server-a', accountId: 'account-a' };
const scope = { workspaceCacheKey: 'server-a:machine-1:/repo', serverId: 'server-a', machineId: 'machine-1', rootPath: '/repo' };
const snapshot: SessionSplitCanvasRuntimeSnapshot = {
    routeSessionId: 'anchor', focusedSessionId: 'anchor', openSessionIds: ['anchor'],
    scope, entityScope, canvasKey: scope.workspaceCacheKey,
};
const row = { sessionId: 'next', scope, isCanvasEligible: true, activeEntityScope: entityScope };

describe('Session canvas row admission', () => {
    it('requires the exact active Home and Account as well as current workspace membership', () => {
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, runtimeSnapshot: snapshot })).toBe('open');
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, sessionId: 'anchor', runtimeSnapshot: snapshot })).toBe('reveal');
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, runtimeSnapshot: { ...snapshot, entityScope: { ...entityScope, accountId: 'account-b' } } })).toBe('none');
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, runtimeSnapshot: { ...snapshot, canvasKey: null } })).toBe('none');
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, activeEntityScope: null, runtimeSnapshot: snapshot })).toBe('none');
        expect(resolveSessionSplitCanvasRowActionMode({ ...row, scope: { ...scope, serverId: 'server-b' }, runtimeSnapshot: snapshot })).toBe('none');
    });
    it('refuses a saved callback after the mounted runtime changes Account before a row rerenders', () => {
        let state = resolveSessionSplitCanvasState({ sessionId: 'anchor', scope: entityScope });
        const controller = {
            executeAction: () => ({ status: 'unavailable' as const }),
            focusSession: (sessionId: string) => { state = reduceSessionSplitCanvasState(state, { type: 'focusSession', sessionId }); },
            openSessionInSplit: (input: Readonly<{ sessionId: string; direction: 'right' | 'down' }>) => {
                state = reduceSessionSplitCanvasState(state, { type: 'openSessionInSplit', ...input,
                    measurement: { availableSizePx: 1200, minimumExistingSizePx: 420 } });
            },
        };
        const retire = registerSessionSplitCanvasRuntime({ snapshot, controller });
        const callbacks = createSessionSplitCanvasRowActionCallbacks(() => row);
        callbacks.openInSplitRight();
        expect(collectOpenSessionIds(state)).toEqual(['anchor', 'next']);
        retire();
        state = resolveSessionSplitCanvasState({ sessionId: 'foreign', scope: { ...entityScope, accountId: 'account-b' } });
        const foreign = state;
        const retireForeign = registerSessionSplitCanvasRuntime({ snapshot: { ...snapshot, entityScope: state.scope, openSessionIds: ['foreign'] }, controller });
        try {
            callbacks.openInSplitDown();
            expect(state).toBe(foreign);
        } finally { retireForeign(); }
    });
});
