import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionSplitCanvasPersistenceSnapshot, sessionCanvasTabId, type SessionSplitCanvasPersistenceSnapshot } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { resolveSessionSplitCanvasScopeKey, type SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { activeSessionForLeaf, collectOpenSessionIds, findSessionLeafById, resolveSessionSplitCanvasState, runSessionSplitCanvasCommand } from './sessionSplitCanvasState';

const data = vi.hoisted(() => ({ ready: false, layouts: {} as Record<string, SessionSplitCanvasPersistenceSnapshot> }));
const write = vi.hoisted(() => vi.fn((layouts: Record<string, SessionSplitCanvasPersistenceSnapshot>) => { data.layouts = layouts; }));
// This hook needs only the Account settings boundary. The full storage testkit also initializes
// unrelated Action catalogs; membership, snapshot validation, and hydration remain real here.
vi.mock('@/sync/domains/state/storage', () => ({
    useIsDataReady: () => data.ready,
    useSettingMutable: () => [data.layouts, write] as const,
}));
const entityScope = { serverId: 'server-a', accountId: 'account-a' };
const scope: SessionSplitCanvasScope = { workspaceCacheKey: 'server-a:machine-1:/repo', serverId: 'server-a', machineId: 'machine-1', rootPath: '/repo' };
const scopeKey = resolveSessionSplitCanvasScopeKey(scope)!;
function persistedTabs() {
    const initial = resolveSessionSplitCanvasState({ sessionId: 'sess_a', scope: entityScope });
    const next = runSessionSplitCanvasCommand(initial, { type: 'openSession', sessionId: 'sess_b', leafId: initial.focusedLeafId! });
    return createSessionSplitCanvasPersistenceSnapshot(next);
}

describe('useSessionSplitCanvasState', () => {
    afterEach(() => { standardCleanup(); data.ready = false; data.layouts = {}; write.mockClear(); });

    it('does not write on mount or accept user mutations before Account hydration', async () => {
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({ routeSessionId: 'sess_a', scope, entityScope }));
        await act(async () => { hook.getCurrent().dispatch({ type: 'openSession', sessionId: 'sess_b', leafId: hook.getCurrent().state.focusedLeafId! }); });
        expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a']);
        expect(write).not.toHaveBeenCalled();
    });

    it('restores hydrated tab membership and selection before user writes', async () => {
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({ routeSessionId: 'sess_a', scope, entityScope }));
        data.ready = true;
        data.layouts = { [scopeKey]: persistedTabs() };
        await hook.rerender(undefined);
        const state = hook.getCurrent().state;
        expect(collectOpenSessionIds(state)).toEqual(['sess_a', 'sess_b']);
        expect(activeSessionForLeaf(findSessionLeafById(state, state.focusedLeafId))?.address.sessionId).toBe('sess_b');
        expect(write).not.toHaveBeenCalled();
    });

    it('keeps both members when the route changes within the same workspace', async () => {
        data.ready = true;
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(({ routeSessionId }: { routeSessionId: string }) => useSessionSplitCanvasState({ routeSessionId, scope, entityScope }), { initialProps: { routeSessionId: 'sess_a' } });
        await hook.rerender({ routeSessionId: 'sess_b' });
        const state = hook.getCurrent().state;
        expect(collectOpenSessionIds(state)).toEqual(['sess_a', 'sess_b']);
        expect(activeSessionForLeaf(findSessionLeafById(state, state.focusedLeafId))?.address.sessionId).toBe('sess_b');
        expect(write).toHaveBeenCalledTimes(1);
        expect(data.layouts[scopeKey]).toEqual(createSessionSplitCanvasPersistenceSnapshot(state));
    });

    it('rejects a saved canvas belonging to another Account even on the same Home', async () => {
        data.ready = true;
        data.layouts = { [scopeKey]: persistedTabs() };
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({ routeSessionId: 'sess_a', scope, entityScope: { ...entityScope, accountId: 'account-b' } }));
        expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a']);
        expect(hook.getCurrent().state.scope.accountId).toBe('account-b');
        expect(write).not.toHaveBeenCalled();
    });

    it('persists one canonical snapshot for user membership and selected-tab changes', async () => {
        data.ready = true;
        data.layouts = { [scopeKey]: persistedTabs() };
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({ routeSessionId: 'sess_a', scope, entityScope }));
        await act(async () => { hook.getCurrent().dispatch({ type: 'activateTab', tabId: sessionCanvasTabId(entityScope, 'sess_a') }); });
        expect(write).toHaveBeenCalledTimes(1);
        const saved = data.layouts[scopeKey];
        expect(saved.root?.kind).toBe('leaf');
        if (saved.root?.kind !== 'leaf') throw new Error('Expected tabbed leaf');
        expect(saved.root.payload.group.tabIds).toEqual([sessionCanvasTabId(entityScope, 'sess_a'), sessionCanvasTabId(entityScope, 'sess_b')]);
        expect(saved.root.payload.group.activeTabId).toBe(sessionCanvasTabId(entityScope, 'sess_a'));
        expect(saved).not.toHaveProperty('maxLeaves');
    });
});
