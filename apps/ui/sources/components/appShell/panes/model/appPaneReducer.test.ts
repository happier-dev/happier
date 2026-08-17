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

    it('replaces a details tab in place while preserving tab-local state and group position', () => {
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
            type: 'replaceDetailsTab',
            scopeId: 'session:1',
            tabKey: 'terminal:project:wr_1:terminal',
            tab: createTerminalTab({
                key: 'terminal:project:wr_1:terminal-retargeted',
                cwd: '/repo/.worktrees/feature-b',
            }),
            openAs: 'pinned',
        });

        const details = state.scopes['session:1']?.details;
        expect(details?.tabsByKey['terminal:project:wr_1:terminal']).toBeUndefined();
        expect(details?.tabState['terminal:project:wr_1:terminal']).toBeUndefined();
        expect(details?.tabsByKey['terminal:project:wr_1:terminal-retargeted']).toMatchObject({
            isPinned: true,
            isPreview: false,
            resource: {
                kind: 'terminal',
                cwd: '/repo/.worktrees/feature-b',
            },
        });
        expect(details?.tabState['terminal:project:wr_1:terminal-retargeted']).toEqual({
            scrollbackCursor: 42,
        });
        expect(getDetailsView(state, 'session:1').tabs.map((tab) => tab.key)).toEqual([
            'terminal:project:wr_1:terminal-retargeted',
        ]);
        expect(getDetailsView(state, 'session:1').activeTabKey).toBe('terminal:project:wr_1:terminal-retargeted');
    });

    it('replaces an active preview details tab without falling back to the pinned launchpad tab', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, {
            type: 'openDetailsTab',
            scopeId: 'session:1',
            tab: { key: 'browser:launchpad', kind: 'browser-view', title: 'Open Browser', resource: { kind: 'browser-view', mode: 'launchpad' } },
            openAs: 'pinned',
        });
        state = appPaneReduce(state, {
            type: 'openDetailsTab',
            scopeId: 'session:1',
            tab: { key: 'browser:view:preview', kind: 'browser-view', title: 'Session Inspector', resource: { kind: 'browser-view', target: 'preview' } },
            openAs: 'preview',
        });

        state = appPaneReduce(state, {
            type: 'replaceDetailsTab',
            scopeId: 'session:1',
            tabKey: 'browser:view:preview',
            tab: { key: 'browser:view:preview', kind: 'browser-view', title: 'example.com', resource: { kind: 'browser-view', target: 'external' } },
            openAs: 'preview',
        });

        expect(getDetailsView(state, 'session:1').tabs.map((tab) => [tab.key, tab.title, tab.isPreview, tab.isPinned])).toEqual([
            ['browser:launchpad', 'Open Browser', false, true],
            ['browser:view:preview', 'example.com', true, false],
        ]);
        expect(getDetailsView(state, 'session:1').activeTabKey).toBe('browser:view:preview');
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

    it('opens a qualified details overlay above the retained workspace and restores its prior focus/maximize state on close', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, {
            type: 'splitDetailsGroup',
            scopeId: 'session:1',
            axis: 'vertical',
        });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'setActiveDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        state = appPaneReduce(state, { type: 'setMaximizedDetailsGroup', scopeId: 'session:1', groupId: 'group:1' });

        const rootBeforeOverlay = state.scopes['session:1']?.details.root;
        state = appPaneReduce(state, {
            type: 'openDetailsOverlay',
            scopeId: 'session:1',
            destination: {
                pluginId: 'acme.review',
                localId: 'activity-log',
            },
            instanceKey: 'activity:run-1',
        });

        expect(state.scopes['session:1']?.details).toMatchObject({
            isOpen: true,
            overlay: {
                destination: { pluginId: 'acme.review', localId: 'activity-log' },
                instanceKey: 'activity:run-1',
                returnFocusedGroupId: 'group:1',
                returnMaximizedGroupId: 'group:1',
                returnIsOpen: true,
            },
            root: rootBeforeOverlay,
        });
        expect(state.scopes['session:1']?.details.groupsById['group:1']?.tabKeys).toEqual(['file:a.txt']);
        expect(state.scopes['session:1']?.details.groupsById['group:2']?.tabKeys).toEqual(['file:b.txt']);

        state = appPaneReduce(state, { type: 'closeDetailsOverlay', scopeId: 'session:1' });
        expect(state.scopes['session:1']?.details).toMatchObject({
            isOpen: true,
            overlay: null,
            focusedGroupId: 'group:1',
            maximizedGroupId: 'group:1',
            root: rootBeforeOverlay,
        });
    });

    it('restores an overlay return group before a full details close', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, {
            type: 'splitDetailsGroup',
            scopeId: 'session:1',
            axis: 'vertical',
        });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'setActiveDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        state = appPaneReduce(state, { type: 'setMaximizedDetailsGroup', scopeId: 'session:1', groupId: 'group:1' });
        state = appPaneReduce(state, {
            type: 'openDetailsOverlay',
            scopeId: 'session:1',
            destination: {
                pluginId: 'acme.review',
                localId: 'activity-log',
            },
        });

        // A full-bleed plugin can open an existing Details tab through the
        // canonical host handler while the overlay is retained. That changes
        // the hidden workspace's current focus, but it must not replace the
        // overlay's captured Back/return destination.
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'setMaximizedDetailsGroup', scopeId: 'session:1', groupId: 'group:2' });

        state = appPaneReduce(state, { type: 'closeDetails', scopeId: 'session:1' });

        expect(state.scopes['session:1']?.details).toMatchObject({
            isOpen: false,
            overlay: null,
            focusedGroupId: 'group:1',
            maximizedGroupId: 'group:1',
        });
        expect(state.scopes['session:1']?.details.groupsById['group:1']?.tabKeys).toEqual(['file:a.txt']);
        expect(state.scopes['session:1']?.details.groupsById['group:2']?.tabKeys).toEqual(['file:b.txt']);
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

    it('keeps focus mode scoped to the active pane scope across details workspace changes', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'enterFocusMode', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'pinned' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'setActiveDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'pinDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'unpinDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'splitDetailsGroup', scopeId: 'session:1', axis: 'vertical' });
        expect(state.focusMode.scopeId).toBe('session:1');

        const splitRoot = state.scopes['session:1']?.details.root;
        if (!splitRoot || splitRoot.kind !== 'split') {
            throw new Error('Expected details workspace to be split');
        }

        state = appPaneReduce(state, { type: 'setDetailsSplitRatio', scopeId: 'session:1', splitId: splitRoot.id, ratio: 0.35 });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'moveDetailsTabToGroup', scopeId: 'session:1', tabKey: 'file:a.txt', targetGroupId: 'group:2' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'focusDetailsGroup', scopeId: 'session:1', groupId: 'group:2' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'setMaximizedDetailsGroup', scopeId: 'session:1', groupId: 'group:2' });
        expect(state.focusMode.scopeId).toBe('session:1');
    });

    it('clears focus mode when navigation activates a different scope', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });
        state = appPaneReduce(state, { type: 'enterFocusMode', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:2' });

        expect(state.focusMode.scopeId).toBeNull();
    });

    it('clears focus mode when the focused scope no longer has right or details panes open', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'enterFocusMode', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'closeDetailsTab', scopeId: 'session:1', tabKey: 'file:a.txt' });
        expect(state.focusMode.scopeId).toBe('session:1');

        state = appPaneReduce(state, { type: 'closeRight', scopeId: 'session:1' });
        expect(state.focusMode.scopeId).toBeNull();
    });

    it('clears focus mode when the focused scope is evicted', () => {
        let state = createAppPaneState({ maxScopesInMemory: 2 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });
        state = appPaneReduce(state, { type: 'enterFocusMode', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:2' });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:3' });

        expect(state.scopes['session:1']).toBeUndefined();
        expect(state.focusMode.scopeId).toBeNull();
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

    it('keeps the incumbent right-tab selection while a qualified plugin pane destination is selected', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'git' });

        state = appPaneReduce(state, {
            type: 'selectRightDestination',
            scopeId: 'session:1',
            destination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
                instanceKey: 'selected-review',
            },
        });

        expect(state.scopes['session:1']?.right).toEqual(expect.objectContaining({
            isOpen: true,
            // The legacy tab is the return selection; a plugin pane must not
            // replace it with a lossy local id.
            activeTabId: 'git',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
                instanceKey: 'selected-review',
            },
        }));
        expect(state.scopes['session:1']?.right.selectedDestination).not.toHaveProperty('input');
    });

    it('treats repeated right tab state writes with the same serializable value as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'git' });
        state = appPaneReduce(state, {
            type: 'setRightTabState',
            scopeId: 'session:1',
            tabId: 'git',
            nextState: { activeSubTabId: 'commit', commitMessageDraft: 'wip: draft' },
        });

        const repeated = appPaneReduce(state, {
            type: 'setRightTabState',
            scopeId: 'session:1',
            tabId: 'git',
            nextState: { activeSubTabId: 'commit', commitMessageDraft: 'wip: draft' },
        });

        expect(repeated).toBe(state);
    });

    it('does not treat inherited prototype entries as existing right or bottom tab state', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        state = appPaneReduce(state, {
            type: 'setRightTabState',
            scopeId: 'session:1',
            tabId: '__proto__',
            nextState: Object.prototype,
        });
        state = appPaneReduce(state, {
            type: 'setBottomTabState',
            scopeId: 'session:1',
            tabId: 'constructor',
            nextState: Object,
        });

        expect(Object.prototype.hasOwnProperty.call(state.scopes['session:1']?.right.tabState, '__proto__')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(state.scopes['session:1']?.bottom.tabState, 'constructor')).toBe(true);
    });

    it('treats reopening the same right tab as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });

        const reopened = appPaneReduce(state, { type: 'openRight', scopeId: 'session:1', tabId: 'files' });

        expect(reopened).toBe(state);
    });

    it('treats reopening the same active pinned details tab as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        const tab = createTerminalTab({
            key: 'terminal:project:wr_1:terminal',
            cwd: '/repo',
        });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab, openAs: 'pinned' });

        const reopened = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab, openAs: 'pinned' });

        expect(reopened).toBe(state);
    });

    it('treats repeated details tab state writes with the same serializable value as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, {
            type: 'openDetailsTab',
            scopeId: 'session:1',
            tab: createTerminalTab({
                key: 'terminal:project:wr_1:terminal',
                cwd: '/repo',
            }),
            openAs: 'pinned',
        });
        state = appPaneReduce(state, {
            type: 'setDetailsTabState',
            scopeId: 'session:1',
            tabKey: 'terminal:project:wr_1:terminal',
            nextState: { panel: { scrollbackCursor: 42 }, history: ['echo hello'] },
        });

        const repeated = appPaneReduce(state, {
            type: 'setDetailsTabState',
            scopeId: 'session:1',
            tabKey: 'terminal:project:wr_1:terminal',
            nextState: { panel: { scrollbackCursor: 42 }, history: ['echo hello'] },
        });

        expect(repeated).toBe(state);
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

    it('treats repeated bottom tab state writes with the same serializable value as a no-op', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });
        state = appPaneReduce(state, { type: 'openBottom', scopeId: 'session:1', tabId: 'terminal' });
        state = appPaneReduce(state, {
            type: 'setBottomTabState',
            scopeId: 'session:1',
            tabId: 'terminal',
            nextState: { history: ['echo hello'] },
        });

        const repeated = appPaneReduce(state, {
            type: 'setBottomTabState',
            scopeId: 'session:1',
            tabId: 'terminal',
            nextState: { history: ['echo hello'] },
        });

        expect(repeated).toBe(state);
    });

    it('ignores semantically identical persisted empty scopes when merging after activation', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        const merged = appPaneReduce(state, {
            type: 'mergePersistedScopes',
            scopes: {
                'session:1': {
                    right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabState: {},
                        tabsByKey: {},
                        groupsById: {},
                        root: null,
                        focusedGroupId: null,
                        maximizedGroupId: null,
                        nextGroupOrdinal: 1,
                        overlay: null,
                    },
                    bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
                },
            },
        });

        expect(merged).toBe(state);
    });
});
