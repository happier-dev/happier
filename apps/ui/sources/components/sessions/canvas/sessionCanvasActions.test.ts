import { describe, expect, it } from 'vitest';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { resolveSessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { createSessionCanvasActionAdapter } from './sessionCanvasActions';
import { collectOpenSessionIds, reduceSessionSplitCanvasState, resolveSessionSplitCanvasState } from './sessionSplitCanvasState';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const workspace = resolveSessionSplitCanvasScope({ serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo', workspaceCacheKey: tryBuildWorkspaceCacheKey({ serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' })! })!;
function harness() {
    let state = resolveSessionSplitCanvasState({ sessionId: 'a', scope });
    let measurement: { availableSizePx: number; minimumExistingSizePx: number } | null = { availableSizePx: 1000, minimumExistingSizePx: 320 };
    const execute = createSessionCanvasActionAdapter({
        canvasKey: workspace.workspaceCacheKey,
        getState: () => state,
        dispatch: action => { state = reduceSessionSplitCanvasState(state, action); return state; },
        readCanvas: () => ({ readSplitMeasurement: () => measurement, resizeSplit: () => false }),
        getWorkspaceScope: identity => {
            const target = { serverId: identity.serverId, machineId: 'machine-a', rootPath: identity.sessionId === 'foreign' ? '/elsewhere' : '/repo' };
            return resolveSessionSplitCanvasScope({ ...target, workspaceCacheKey: tryBuildWorkspaceCacheKey(target)! });
        },
    });
    return { execute, getState: () => state, setMeasurement: (next: typeof measurement) => { measurement = next; } };
}
describe('mounted Session canvas Action intent adapter', () => {
    it('opens kept Sessions before semantic anchors, reveals existing members and refuses wrong canvas/scope/workspace', () => {
        const h = harness();
        const base = { scope, canvasKey: workspace.workspaceCacheKey };
        const leafId = h.getState().focusedLeafId!;
        expect(h.execute('session.canvas.tabs.open', { ...base, sessionId: 'b', leafId })).toEqual({ status: 'applied' });
        const b = collectSplitCanvasLeaves(h.getState().root)[0].payload.group.activeTabId;
        expect(h.execute('session.canvas.tabs.open', { ...base, sessionId: 'c', leafId, beforeTabId: b })).toEqual({ status: 'applied' });
        expect(collectOpenSessionIds(h.getState())).toEqual(['a', 'c', 'b']);
        h.execute('session.canvas.tabs.open', { ...base, sessionId: 'a', leafId, placement: 'right' });
        expect(collectSplitCanvasLeaves(h.getState().root)).toHaveLength(1);
        expect(h.execute('session.canvas.tabs.open', { ...base, sessionId: 'foreign', leafId })).toMatchObject({ status: 'refused' });
        expect(h.execute('session.canvas.tabs.open', { ...base, canvasKey: 'other', sessionId: 'x', leafId })).toMatchObject({ status: 'refused' });
        expect(h.execute('session.canvas.tabs.close', { ...base, scope: { ...scope, accountId: 'other' }, tabId: b })).toMatchObject({ status: 'refused' });
        expect(collectOpenSessionIds(h.getState())).toEqual(['a', 'c', 'b']);
    });
    it('reads current measured admission at execution and lists exact membership without mutating on refusal', () => {
        const h = harness();
        const base = { scope, canvasKey: workspace.workspaceCacheKey };
        const leafId = h.getState().focusedLeafId!;
        h.setMeasurement(null);
        expect(h.execute('session.canvas.tabs.open', { ...base, sessionId: 'b', leafId, placement: 'right' })).toMatchObject({ status: 'refused' });
        expect(collectOpenSessionIds(h.getState())).toEqual(['a']);
        h.setMeasurement({ availableSizePx: 1000, minimumExistingSizePx: 320 });
        expect(h.execute('session.canvas.tabs.open', { ...base, sessionId: 'b', leafId, placement: 'right' })).toEqual({ status: 'applied' });
        const listing = h.execute('session.canvas.tabs.list', base);
        expect(listing).toMatchObject({ status: 'listed', leaves: [{ tabIds: expect.any(Array) }, { tabIds: expect.any(Array) }] });
        if (listing.status === 'listed') expect(listing.tabs.map(tab => tab.address)).toEqual([{ serverId: scope.serverId, sessionId: 'a' }, { serverId: scope.serverId, sessionId: 'b' }]);
    });
});
