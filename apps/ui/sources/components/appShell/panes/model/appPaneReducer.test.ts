import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from './appPaneReducer';
import { buildDetailsWorkspaceStateView } from '../details/workspace/detailsWorkspaceSelectors';

function createFileTab(path: string) {
    return { key: `file:${path}`, kind: 'file', title: path.split('/').at(-1) ?? path, resource: { path } };
}

function createTerminalTab(params: Readonly<{
    key: string;
    cwd: string;
}>) {
    return {
        key: params.key,
        kind: 'terminal',
        title: 'Terminal',
        resource: {
            kind: 'terminal',
            terminalInstanceId: params.key.replace(/^terminal:/, ''),
            cwd: params.cwd,
        },
    };
}

function getDetailsView(state: ReturnType<typeof createAppPaneState>, scopeId: string) {
    const details = state.scopes[scopeId]?.details;
    if (!details) {
        throw new Error(`Missing details state for ${scopeId}`);
    }
    return buildDetailsWorkspaceStateView(details);
}

describe('appPaneReduce', () => {
    it('creates and activates scopes, keeping an LRU order', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:2' });
        expect(state.activeScopeId).toBe('session:2');
        expect(state.scopeLru).toEqual(['session:2', 'session:1']);
    });

    it('does not clear details tabs when closing the details pane', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('README.md'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'closeDetails', scopeId: 'session:1' });
        expect(state.scopes['session:1']?.details.isOpen).toBe(false);
        expect(getDetailsView(state, 'session:1').tabs.map((t) => t.key)).toEqual(['file:README.md']);
    });

    it('supports preview-tab behavior (single preview slot) and pinning', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'preview' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:a.txt', true, false],
        ]);

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'preview' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => t.key)).toEqual(['file:b.txt']);
        expect(getDetailsView(state, 'session:1').tabs[0]?.isPreview).toBe(true);

        state = appPaneReduce(state, { type: 'pinDetailsTab', scopeId: 'session:1', tabKey: 'file:b.txt' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
        ]);

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('c.txt'), openAs: 'preview' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
            ['file:c.txt', true, false],
        ]);

        // Opening an existing preview tab as pinned should pin it (no duplicates).
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('c.txt'), openAs: 'pinned' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
            ['file:c.txt', false, true],
        ]);
    });

    it('supports unpinning a details tab back into the preview slot', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'preview' });
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:a.txt', false, true],
            ['file:b.txt', true, false],
        ]);

        state = appPaneReduce(state, { type: 'unpinDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });

        // Unpinned tab becomes the sole preview; existing preview is removed.
        expect(getDetailsView(state, 'session:1').tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:a.txt', true, false],
        ]);
        expect(getDetailsView(state, 'session:1').activeTabKey).toBe('file:a.txt');
    });

    it('refreshes an existing details tab resource when reopening the same keyed tab', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, {
            type: 'openDetailsTab',
            scopeId: 'session:1',
            tab: createTerminalTab({
                key: 'terminal:project:wr_1:terminal',
                cwd: '/repo/.worktrees/feature-a',
            }),
            openAs: 'pinned',
        });
        state = appPaneReduce(state, {
            type: 'setDetailsTabState',
            scopeId: 'session:1',
            tabKey: 'terminal:project:wr_1:terminal',
            nextState: { scrollbackCursor: 42 },
        });

        state = appPaneReduce(state, {
            type: 'openDetailsTab',
            scopeId: 'session:1',
            tab: createTerminalTab({
                key: 'terminal:project:wr_1:terminal',
                cwd: '/repo/.worktrees/feature-b',
            }),
            openAs: 'pinned',
        });

        const terminalTab = getDetailsView(state, 'session:1').tabs.find((tab) => tab.key === 'terminal:project:wr_1:terminal');
        expect(terminalTab).toMatchObject({
            isPinned: true,
            isPreview: false,
            resource: {
                kind: 'terminal',
                cwd: '/repo/.worktrees/feature-b',
            },
        });
        expect(state.scopes['session:1']?.details.tabState['terminal:project:wr_1:terminal']).toEqual({
            scrollbackCursor: 42,
        });
        expect(getDetailsView(state, 'session:1').activeTabKey).toBe('terminal:project:wr_1:terminal');
    });

    it('supports split-capable details workspaces with focused groups', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });

        state = appPaneReduce(state, {
            type: 'splitDetailsGroup',
            scopeId: 'session:1',
            axis: 'vertical',
        });

        expect(state.scopes['session:1']?.details.root).toEqual({
            kind: 'split',
            id: expect.any(String),
            axis: 'row',
            ratio: 0.5,
            first: {
                id: 'group:1',
                kind: 'leaf',
                leafKind: 'details-group',
                payload: { groupId: 'group:1' },
            },
            second: {
                id: 'group:2',
                kind: 'leaf',
                leafKind: 'details-group',
                payload: { groupId: 'group:2' },
            },
        });
        expect(state.scopes['session:1']?.details.focusedGroupId).toBe('group:2');
        expect(state.scopes['session:1']?.details.groupsById['group:1']?.tabKeys).toEqual(['file:a.txt']);
        expect(state.scopes['session:1']?.details.groupsById['group:2']?.tabKeys).toEqual([]);

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'preview' });

        expect(state.scopes['session:1']?.details.groupsById['group:1']?.tabKeys).toEqual(['file:a.txt']);
        expect(state.scopes['session:1']?.details.groupsById['group:2']?.tabKeys).toEqual(['file:b.txt']);
        expect(state.scopes['session:1']?.details.tabsByKey['file:b.txt']).toMatchObject({
            isPinned: false,
            isPreview: true,
        });

        state = appPaneReduce(state, { type: 'setActiveDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        expect(state.scopes['session:1']?.details.focusedGroupId).toBe('group:1');
        expect(state.scopes['session:1']?.details.groupsById['group:1']?.activeTabKey).toBe('file:a.txt');

        state = appPaneReduce(state, { type: 'closeDetailsTab', scopeId: 'session:1', tabKey: 'file:b.txt' });
        expect(state.scopes['session:1']?.details.root).toEqual({
            id: 'group:1',
            kind: 'leaf',
            leafKind: 'details-group',
            payload: { groupId: 'group:1' },
        });
        expect(state.scopes['session:1']?.details.focusedGroupId).toBe('group:1');
        expect(state.scopes['session:1']?.details.groupsById['group:2']).toBeUndefined();
    });

    it('preserves requested split placement for details groups', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });

        const splitBeforeAction = {
            type: 'splitDetailsGroup' as const,
            scopeId: 'session:1',
            axis: 'vertical' as const,
            placement: 'before' as const,
        };

        state = appPaneReduce(state, splitBeforeAction);

        expect(state.scopes['session:1']?.details.root).toEqual({
            kind: 'split',
            id: expect.any(String),
            axis: 'row',
            ratio: 0.5,
            first: {
                id: 'group:2',
                kind: 'leaf',
                leafKind: 'details-group',
                payload: { groupId: 'group:2' },
            },
            second: {
                id: 'group:1',
                kind: 'leaf',
                leafKind: 'details-group',
                payload: { groupId: 'group:1' },
            },
        });
        expect(state.scopes['session:1']?.details.focusedGroupId).toBe('group:2');
    });

    it('evicts least-recently-used scopes beyond the max', () => {
        let state = createAppPaneState({ maxScopesInMemory: 2 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:2' });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:3' });

        expect(Object.keys(state.scopes).sort()).toEqual(['session:2', 'session:3']);
        expect(state.scopes['session:1']).toBeUndefined();
    });

    it('retains right tab state across open/close cycles', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'git' });
        state = appPaneReduce(state, {
            type: 'setRightTabState',
            scopeId: 'session:1',
            tabId: 'git',
            nextState: { commitMessageDraft: 'wip: draft' },
        });
        state = appPaneReduce(state, { type: 'closeRight', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'git' });

        expect(state.scopes['session:1']?.right.tabState.git).toEqual({ commitMessageDraft: 'wip: draft' });
    });

    it('treats reopening the same right tab as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });

        const reopened = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });

        expect(reopened).toBe(state);
    });

    it('retains bottom tab state across open/close cycles', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'openBottom', scopeId: 'session:1', tabId: 'terminal' });

        state = appPaneReduce(state, { type: 'setBottomTabState', scopeId: 'session:1', tabId: 'terminal', nextState: { history: ['echo hello'] } });

        state = appPaneReduce(state, { type: 'closeBottom', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openBottom', scopeId: 'session:1', tabId: 'terminal' });

        expect(state.scopes['session:1']?.bottom.tabState.terminal).toEqual({ history: ['echo hello'] });
    });

    it('ignores semantically identical persisted empty scopes when merging after activation', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        const merged = appPaneReduce(state, {
            type: 'mergePersistedScopes',
            scopes: {
                'session:1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabState: {},
                        tabsByKey: {},
                        groupsById: {},
                        root: null,
                        focusedGroupId: null,
                        maximizedGroupId: null,
                        nextGroupOrdinal: 1,
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
        });

        expect(merged).toBe(state);
    });
});
