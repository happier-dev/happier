import { afterEach, describe, expect, it } from 'vitest';
import { collectOpenSessionIds, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState } from './sessionSplitCanvasState';
import { sessionCanvasTabId } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { createSessionCanvasActionAdapter } from './sessionCanvasActions';
import { registerSessionSplitCanvasRuntime, type SessionSplitCanvasRuntimeSnapshot } from './sessionSplitCanvasRuntime';
import { createSessionSplitCanvasRowActionCallbacks } from './sessionSplitCanvasRowActions';

const entityScope = { serverId: 'server-a', accountId: 'account-a' };
const scope = { workspaceCacheKey: 'server-a:machine-1:/repo', serverId: 'server-a', machineId: 'machine-1', rootPath: '/repo' };
const snapshot: SessionSplitCanvasRuntimeSnapshot = {
    routeSessionId: 'anchor', focusedSessionId: 'anchor', openSessionIds: ['anchor'],
    scope, entityScope, canvasKey: scope.workspaceCacheKey,
};
const row = { sessionId: 'next', scope, isCanvasEligible: true, activeEntityScope: entityScope };

describe('Session canvas row admission and live callbacks', () => {
    let retire: (() => void) | null = null;
    afterEach(() => { retire?.(); retire = null; });

    it('uses the live canvas Action owner and refuses stale callbacks before runtime retirement notifications', () => {
        let state = resolveSessionSplitCanvasState({ sessionId: 'anchor', scope: entityScope });
        const execute = createSessionCanvasActionAdapter({ canvasKey: scope.workspaceCacheKey, getState: () => state,
            dispatch: action => { state = reduceSessionSplitCanvasState(state, action); return state; },
            // Pixel measurement comes from the mounted native/DOM canvas boundary.
            readCanvas: () => ({ readSplitMeasurement: () => ({ availableSizePx: 1200, minimumExistingSizePx: 420 }), resizeSplit: () => false }),
            getWorkspaceScope: () => scope });
        const controller = {
            executeAction: execute,
            openSessionInSplit: (input: Readonly<{ sessionId: string; direction: 'right' | 'down' }>) => {
                execute('session.canvas.tabs.open', { scope: entityScope, canvasKey: scope.workspaceCacheKey,
                    sessionId: input.sessionId, leafId: state.focusedLeafId, placement: input.direction });
            },
            focusSession: (sessionId: string) => {
                execute('session.canvas.tabs.activate', { scope: entityScope, canvasKey: scope.workspaceCacheKey,
                    tabId: sessionCanvasTabId(entityScope, sessionId) });
            },
        };
        retire = registerSessionSplitCanvasRuntime({ snapshot, controller });
        let currentRow = row;
        const callbacks = createSessionSplitCanvasRowActionCallbacks(() => currentRow);
        callbacks.openInSplitRight();
        expect(collectOpenSessionIds(state)).toEqual(['anchor', 'next']);
        const kept = state;
        retire();
        callbacks.openInSplitDown();
        expect(state).toBe(kept);
        retire = registerSessionSplitCanvasRuntime({ snapshot: { ...snapshot, entityScope: { ...entityScope, accountId: 'account-b' } }, controller });
        callbacks.openInSplitDown();
        expect(state).toBe(kept);
        currentRow = { ...row, activeEntityScope: { ...entityScope, accountId: 'account-b' } };
        retire();
        retire = registerSessionSplitCanvasRuntime({ snapshot: { ...snapshot, openSessionIds: ['anchor', 'next'] }, controller });
        callbacks.revealInSplit();
        expect(state).toBe(kept);
    });
});
