import { describe, expect, it } from 'vitest';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { collectOpenSessionIds, reconcileSessionSplitCanvasRouteAnchor, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState, resolveSessionSplitCanvasKeyboardTarget, resolveSessionSplitCanvasRouteSessionAfterAction, runSessionSplitCanvasCommand } from './sessionSplitCanvasState';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const initial = () => resolveSessionSplitCanvasState({ sessionId: 'a', scope });
const open = (state: ReturnType<typeof initial>, sessionId: string) => runSessionSplitCanvasCommand(state, { type: 'openSession', sessionId, leafId: state.focusedLeafId! });

describe('tabbed Session canvas state', () => {
    it('adds/selects a route anchor without evicting existing members or changing leaf identity', () => {
        const state = open(initial(), 'b');
        const next = reconcileSessionSplitCanvasRouteAnchor(state, 'c');
        expect(next.focusedLeafId).toBe(state.focusedLeafId);
        expect(collectOpenSessionIds(next)).toEqual(['a', 'b', 'c']);
        const restored = resolveSessionSplitCanvasState({ sessionId: 'a', scope, persistedSnapshot: { version: 1, scope, root: next.root, focusedLeafId: next.focusedLeafId, maximizedLeafId: null } });
        expect(restored.root).toBe(next.root);
        expect(collectSplitCanvasLeaves(restored.root)[0].payload.group.activeTabId).toBe(collectSplitCanvasLeaves(next.root)[0].payload.group.activeTabId);
        const reveal = runSessionSplitCanvasCommand(next, { type: 'focusSession', sessionId: 'a' });
        expect(collectOpenSessionIds(reveal)).toEqual(['a', 'b', 'c']);
        expect(resolveSessionSplitCanvasKeyboardTarget(reveal, { routeSessionId: 'a', targetKind: 'session' })?.sessionId).toBe('a');
    });

    it('moves tabs through the shared group owner and closes only an emptied source leaf', () => {
        let state = open(initial(), 'b');
        state = runSessionSplitCanvasCommand(state, { type: 'openSessionInSplit', sessionId: 'c', direction: 'right', measurement: { availableSizePx: 1000, minimumExistingSizePx: 320 } });
        const leaves = collectSplitCanvasLeaves(state.root);
        const a = leaves[0].payload.group.tabIds[0];
        const b = leaves[0].payload.group.tabIds[1];
        const targetLeafId = leaves[1].id;
        state = runSessionSplitCanvasCommand(state, { type: 'moveTab', tabId: b, targetLeafId });
        expect(collectOpenSessionIds(state)).toEqual(['a', 'c', 'b']);
        state = runSessionSplitCanvasCommand(state, { type: 'moveTab', tabId: a, targetLeafId, beforeTabId: b });
        expect(collectSplitCanvasLeaves(state.root)).toHaveLength(1);
        expect(collectOpenSessionIds(state)).toEqual(['c', 'a', 'b']);
        const same = runSessionSplitCanvasCommand(state, { type: 'moveTab', tabId: a, targetLeafId });
        expect(same).toBe(state);
        state = runSessionSplitCanvasCommand(state, { type: 'reorderTab', tabId: b, beforeTabId: a });
        expect(collectOpenSessionIds(state)).toEqual(['c', 'b', 'a']);
    });

    it('reanchors a closed route member, retains the last member and keeps composer commands on the active visible member', () => {
        let state = open(initial(), 'b');
        const leaf = collectSplitCanvasLeaves(state.root)[0];
        const action = { type: 'closeTab', tabId: leaf.payload.group.tabIds[0] } as const;
        expect(resolveSessionSplitCanvasRouteSessionAfterAction(state, action, { routeSessionId: 'a' })).toBe('b');
        expect(resolveSessionSplitCanvasRouteSessionAfterAction(state, action, { routeSessionId: 'a', committedState: state })).toBeNull();
        state = reduceSessionSplitCanvasState(state, action, { routeSessionId: 'a' });
        expect(collectOpenSessionIds(state)).toEqual(['b']);
        expect(runSessionSplitCanvasCommand(state, { type: 'closeTab', tabId: collectSplitCanvasLeaves(state.root)[0].payload.group.activeTabId! })).toBe(state);
        expect(resolveSessionSplitCanvasKeyboardTarget(state, { routeSessionId: 'b', composerOwningLeafId: state.focusedLeafId, targetKind: 'composer' })).toMatchObject({ sessionId: 'b', source: 'composer' });
        expect(resolveSessionSplitCanvasKeyboardTarget({ ...state, focusedLeafId: null }, { routeSessionId: '', targetKind: 'session' })).toBeNull();
    });

    it('requires measurement for a new edge and preserves all tabs on refused splits or another Account restore', () => {
        const state = open(initial(), 'b');
        expect(runSessionSplitCanvasCommand(state, { type: 'openSessionInSplit', sessionId: 'c', direction: 'right' })).toBe(state);
        expect(runSessionSplitCanvasCommand(state, { type: 'openSessionInSplit', sessionId: 'c', direction: 'right', measurement: { availableSizePx: 500, minimumExistingSizePx: 320 } })).toBe(state);
        const restored = resolveSessionSplitCanvasState({ sessionId: 'a', scope: { ...scope, accountId: 'other' }, persistedSnapshot: { version: 1, scope, root: state.root, focusedLeafId: state.focusedLeafId, maximizedLeafId: null } });
        expect(collectOpenSessionIds(restored)).toEqual(['a']);
    });

    it('splits an existing tab without duplicating membership or accepting an undersized move', () => {
        const state = open(initial(), 'b');
        const leaf = collectSplitCanvasLeaves(state.root)[0];
        const b = leaf.payload.group.tabIds[1];
        const command = { type: 'splitTab', tabId: b, targetLeafId: leaf.id, direction: 'left', measurement: { availableSizePx: 1000, minimumExistingSizePx: 320 } } as const;
        expect(runSessionSplitCanvasCommand(state, { ...command, measurement: { availableSizePx: 500, minimumExistingSizePx: 320 } })).toBe(state);
        const next = runSessionSplitCanvasCommand(state, command);
        expect(collectSplitCanvasLeaves(next.root)).toHaveLength(2);
        expect(collectOpenSessionIds(next)).toEqual(['b', 'a']);
        expect(new Set(collectSplitCanvasLeaves(next.root).map(node => node.id)).size).toBe(2);
        expect(next.focusedLeafId).toBe(collectSplitCanvasLeaves(next.root)[0].id);
        const bLeaf = collectSplitCanvasLeaves(next.root)[0];
        expect(runSessionSplitCanvasCommand(next, { ...command, targetLeafId: bLeaf.id })).toBe(next);
    });
});
