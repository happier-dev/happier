import { describe, expect, it } from 'vitest';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { planSessionSplitCanvasDropAction, resolveSessionCanvasEntityDrop } from './planSessionSplitCanvasDropAction';
import { resolveSessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { collectOpenSessionIds, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState } from './sessionSplitCanvasState';

const scope = { serverId: 'home-a', accountId: 'account-a' };
describe('Session canvas C2 drop owner', () => {
    it('keeps both Sessions in the target leaf, inserts before the current anchor and focuses an existing qualified member', () => {
        let state = resolveSessionSplitCanvasState({ sessionId: 'a', scope });
        const target = { leafId: state.focusedLeafId!, placement: 'center' } as const;
        for (const sessionId of ['b', 'c']) {
            const action = planSessionSplitCanvasDropAction({ state, item: { kind: 'session', scope, address: { serverId: scope.serverId, sessionId } }, target });
            expect(action).not.toBeNull();
            state = reduceSessionSplitCanvasState(state, action!, { routeSessionId: 'a' });
        }
        expect(collectSplitCanvasLeaves(state.root)).toHaveLength(1);
        expect(collectOpenSessionIds(state)).toEqual(['a', 'b', 'c']);
        const leaf = collectSplitCanvasLeaves(state.root)[0];
        const b = leaf.payload.group.tabIds[1];
        const insert = planSessionSplitCanvasDropAction({ state, item: { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'd' } }, target, beforeTabId: b });
        state = reduceSessionSplitCanvasState(state, insert!, { routeSessionId: 'a' });
        expect(collectOpenSessionIds(state)).toEqual(['a', 'd', 'b', 'c']);
        const reveal = planSessionSplitCanvasDropAction({ state, item: { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'b' } }, target });
        state = reduceSessionSplitCanvasState(state, reveal!, { routeSessionId: 'a' });
        expect(collectOpenSessionIds(state)).toEqual(['a', 'd', 'b', 'c']);
        expect(collectSplitCanvasLeaves(state.root)[0].payload.group.activeTabId).toBe(b);
    });

    it('refuses other realms and unsupported items, and admits edges only through measured SplitCanvas constraints', () => {
        const state = resolveSessionSplitCanvasState({ sessionId: 'a', scope });
        const target = { leafId: state.focusedLeafId!, placement: 'right' } as const;
        const item = { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'b' } } as const;
        expect(planSessionSplitCanvasDropAction({ state, item, target })).toBeNull();
        expect(planSessionSplitCanvasDropAction({ state, item, target, measurement: { availableSizePx: 500, minimumExistingSizePx: 320 } })).toBeNull();
        expect(planSessionSplitCanvasDropAction({ state, item: { ...item, scope: { ...scope, accountId: 'other' } }, target: { ...target, placement: 'center' } })).toBeNull();
        expect(planSessionSplitCanvasDropAction({ state, item: { kind: 'destination', scope, href: '/settings' }, target: { ...target, placement: 'center' } })).toBeNull();
        const action = planSessionSplitCanvasDropAction({ state, item, target, measurement: { availableSizePx: 1000, minimumExistingSizePx: 320 } });
        expect(action?.type).toBe('openSessionInSplit');
        expect(collectOpenSessionIds(reduceSessionSplitCanvasState(state, action!, { routeSessionId: 'a' }))).toEqual(['a', 'b']);
    });

    it('refuses unchanged strip slots and distinguishes a sole tab over its own pane edge', () => {
        let state = resolveSessionSplitCanvasState({ sessionId: 'a', scope });
        const leafId = state.focusedLeafId!;
        const tabId = collectSplitCanvasLeaves(state.root)[0].payload.group.tabIds[0];
        const workspaceScope = resolveSessionSplitCanvasScope({ serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', workspaceCacheKey: tryBuildWorkspaceCacheKey({ serverId: scope.serverId, machineId: 'machine', rootPath: '/repo' })! })!;
        const base = { canvasKey: workspaceScope.workspaceCacheKey, workspaceScope,
            item: { kind: 'workspace-tab', scope, tabId },
            target: { leafId, placement: 'center' }, resolveWorkspaceScope: () => workspaceScope } as const;
        const soleTabAdmission = resolveSessionCanvasEntityDrop({ ...base, state, target: { leafId, placement: 'right' },
            measurement: { availableSizePx: 1200, minimumExistingSizePx: 400 } });
        state = reduceSessionSplitCanvasState(state, { type: 'openSession', sessionId: 'b', leafId });
        const neighbor = collectSplitCanvasLeaves(state.root)[0].payload.group.tabIds[1];
        for (const beforeTabId of [tabId, neighbor]) {
            expect(planSessionSplitCanvasDropAction({ ...base, state, beforeTabId })).toBeNull();
            expect(resolveSessionCanvasEntityDrop({ ...base, state, beforeTabId }))
                .toMatchObject({ status: 'refused', reason: { code: 'already_here' } });
        }
        expect(soleTabAdmission).toMatchObject({ status: 'refused', reason: { code: 'canvas_tab_cannot_split_own_pane' } });
        expect(resolveSessionCanvasEntityDrop({ ...base, state, beforeTabId: null }))
            .toMatchObject({ status: 'allowed', effect: { actionId: 'session.canvas.tabs.move' } });
        expect(resolveSessionCanvasEntityDrop({ ...base, state, target: { leafId, placement: 'right' },
            measurement: { availableSizePx: 1200, minimumExistingSizePx: 400 } }))
            .toMatchObject({ status: 'allowed', effect: { actionId: 'session.canvas.tabs.move' } });
    });
});
