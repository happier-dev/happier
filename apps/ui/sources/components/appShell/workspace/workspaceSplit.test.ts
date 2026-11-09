import { describe, expect, it } from 'vitest';
import { createWorkspaceEmptyTab, createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { createWorkspaceSplit, WORKSPACE_VIEW_MINIMUM } from './workspaceSplit';
import { projectWorkspaceTabsList } from './workspaceActions';
import { WORKSPACE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/workspaceActionFamily';

describe('workspace measured split owner', () => {
    it('exposes the canonical nested split relationships needed to target a tab group', () => {
        let state = createWorkspaceState(createWorkspaceEmptyTab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: createWorkspaceEmptyTab('b') });
        let sequence = 0;
        for (const [tabId, direction] of [['b', 'right'], ['a', 'down']] as const) {
            const action = createWorkspaceSplit(state, { groupId: 'group:1', tabId, direction,
                availableSizePx: 1200, minimumExistingSizePx: direction === 'right' ? WORKSPACE_VIEW_MINIMUM.width : WORKSPACE_VIEW_MINIMUM.height,
                createId: () => `group:${++sequence + 1}` });
            if (!action) throw new Error('The measured nested split must fit');
            state = reduceWorkspaceState(state, action);
        }
        const listed = projectWorkspaceTabsList(state);
        const root = state.root;
        if (root.kind !== 'split' || root.first.kind !== 'split') throw new Error('The source must contain the nested split');
        expect(listed.rootNodeId).toBe(root.id);
        expect(listed.splits).toContainEqual({ id: root.id, axis: root.axis, ratio: root.ratio,
            firstNodeId: root.first.id, secondNodeId: root.second.id });
        expect(listed.splits).toContainEqual({ id: root.first.id, axis: root.first.axis, ratio: root.first.ratio,
            firstNodeId: root.first.first.id, secondNodeId: root.first.second.id });
        expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.list'].parse(listed)).toEqual(listed);
    });
    it('rejects an undersized split then moves the real selected tab and preserves its source', () => {
        let state = createWorkspaceState(createWorkspaceEmptyTab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: createWorkspaceEmptyTab('b') });
        let sequence = 0;
        const input = { groupId: 'group:1', tabId: 'b', direction: 'right' as const,
            minimumExistingSizePx: WORKSPACE_VIEW_MINIMUM.width, createId: () => `split:${++sequence}` };
        expect(createWorkspaceSplit(state, { ...input, availableSizePx: WORKSPACE_VIEW_MINIMUM.width * 2 - 1 })).toBeNull();
        const action = createWorkspaceSplit(state, { ...input, availableSizePx: WORKSPACE_VIEW_MINIMUM.width * 2 });
        if (!action) throw new Error('The measured two-pane minimum must fit');
        const next = reduceWorkspaceState(state, action);
        expect(next.root).toMatchObject({ kind: 'split', axis: 'row' });
        expect(next.groups['group:1'].tabIds).toEqual(['a']);
        expect(next.groups[next.focusedGroupId].tabIds).toEqual(['b']);
    });

    it('keeps a singleton destination unique and fills the source after a downward split', () => {
        const state = createWorkspaceState({ id: 'notes', target: { kind: 'plugin:notes', params: {} }, pinned: true, preview: false });
        let sequence = 0;
        const action = createWorkspaceSplit(state, { groupId: 'group:1', direction: 'down',
            availableSizePx: WORKSPACE_VIEW_MINIMUM.height * 2, minimumExistingSizePx: WORKSPACE_VIEW_MINIMUM.height,
            createId: () => `split:${++sequence}` });
        if (!action) throw new Error('The measured vertical two-pane minimum must fit');
        const next = reduceWorkspaceState(state, action);
        expect(next.root).toMatchObject({ kind: 'split', axis: 'column' });
        expect(next.groups[next.focusedGroupId].tabIds).toEqual(['notes']);
        expect(next.tabs[next.groups['group:1'].activeTabId].target.kind).toBe('newTab');
        expect(Object.values(next.tabs).filter((tab) => tab.target.kind === 'plugin:notes')).toHaveLength(1);
    });
});
