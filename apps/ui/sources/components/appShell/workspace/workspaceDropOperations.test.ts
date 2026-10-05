import { describe, expect, it } from 'vitest';

import {
    resolveWorkspaceTabCanvasDrop, resolveWorkspaceTabStripDrop,
} from './workspaceDropOperations';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceAction, type WorkspaceState, type WorkspaceTab } from './workspaceState';
import { createWorkspaceDestinationSplit } from './workspaceSplit';

function tab(id: string): WorkspaceTab {
    return { id, target: { kind: `removed:${id}`, params: {} }, pinned: false, preview: false };
}

function apply(state: WorkspaceState, actions: readonly WorkspaceAction[]): WorkspaceState {
    return actions.reduce<WorkspaceState>((current, action) => reduceWorkspaceState(current, action), state);
}

/** group:1 = a, b, c; group:2 = d (to the right). */
function twoPanes(): WorkspaceState {
    let state = createWorkspaceState(tab('a'));
    for (const id of ['b', 'c', 'd']) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
    return reduceWorkspaceState(state, { type: 'splitTab', tabId: 'd', sourceGroupId: 'group:1', targetGroupId: 'group:1',
        newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
}

describe('workspace tab drag and drop', () => {
    it('admits a destination edge atomically without replacing the current preview', () => {
        let state = twoPanes();
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:2', tab: { ...tab('current'), preview: true } });
        let id = 0;
        const input = { groupId: 'group:2', tab: { ...tab('incoming'), preview: true }, direction: 'left' as const,
            minimumExistingSizePx: 400, createId: () => `new:${++id}` };
        expect(createWorkspaceDestinationSplit(state, { ...input, availableSizePx: 500 })).toBeNull();
        expect(state.tabs.incoming).toBeUndefined();
        const action = createWorkspaceDestinationSplit(state, { ...input, availableSizePx: 1200 });
        expect(action).not.toBeNull();
        const next = reduceWorkspaceState(state, action!);
        expect(next.groups['group:2'].tabIds).toEqual(['d', 'current']);
        expect(next.tabs.current).toBe(state.tabs.current);
        expect(next.groups[next.focusedGroupId].tabIds).toEqual(['incoming']);
        expect(next.tabs.incoming.preview).toBe(false);
    });

    it('reorders within a strip and moves a tab from another pane before the tab it lands on', () => {
        const state = twoPanes();
        const reordered = apply(state, resolveWorkspaceTabStripDrop(state, { tabId: 'c', groupId: 'group:1', beforeTabId: 'a' }));
        expect(reordered.groups['group:1'].tabIds).toEqual(['c', 'a', 'b']);
        const atEnd = apply(state, resolveWorkspaceTabStripDrop(state, { tabId: 'a', groupId: 'group:1', beforeTabId: null }));
        expect(atEnd.groups['group:1'].tabIds).toEqual(['b', 'c', 'a']);

        const moved = apply(state, resolveWorkspaceTabStripDrop(state, { tabId: 'b', groupId: 'group:2', beforeTabId: 'd' }));
        expect(moved.groups['group:2'].tabIds).toEqual(['b', 'd']);
        expect(moved.groups['group:1'].tabIds).toEqual(['a', 'c']);
    });

    it('moves a tab into a pane from its centre and splits a pane from its edge, admitted by measured size', () => {
        const state = twoPanes();
        const centre = resolveWorkspaceTabCanvasDrop(state, { tabId: 'a', target: { leafId: 'group:2', placement: 'center' }, createId: () => 'x' });
        expect(centre && reduceWorkspaceState(state, centre).groups['group:2'].tabIds).toEqual(['d', 'a']);

        let ids = 0;
        const edge = resolveWorkspaceTabCanvasDrop(state, { tabId: 'a', target: { leafId: 'group:2', placement: 'down' },
            availableSizePx: 800, minimumExistingSizePx: 200, createId: () => `new:${ids++}` });
        const split = edge ? reduceWorkspaceState(state, edge) : state;
        expect(Object.keys(split.groups)).toHaveLength(3);
        expect(split.groups[split.focusedGroupId].tabIds).toEqual(['a']);

        expect(resolveWorkspaceTabCanvasDrop(state, { tabId: 'a', target: { leafId: 'group:2', placement: 'down' },
            availableSizePx: 300, minimumExistingSizePx: 200, createId: () => 'y' })).toBeNull();
        expect(resolveWorkspaceTabCanvasDrop(state, { tabId: 'a', target: { leafId: 'group:2', placement: 'right' }, createId: () => 'z' })).toBeNull();
    });
});
