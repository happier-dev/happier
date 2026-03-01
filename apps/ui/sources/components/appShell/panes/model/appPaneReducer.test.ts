import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from './appPaneReducer';

function createFileTab(path: string) {
    return { key: `file:${path}`, kind: 'file', title: path.split('/').at(-1) ?? path, resource: { path } };
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
        expect(state.scopes['session:1']?.details.tabs.map((t) => t.key)).toEqual(['file:README.md']);
    });

    it('supports preview-tab behavior (single preview slot) and pinning', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'session:1' });

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('a.txt'), openAs: 'preview' });
        expect(state.scopes['session:1']?.details.tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:a.txt', true, false],
        ]);

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('b.txt'), openAs: 'preview' });
        expect(state.scopes['session:1']?.details.tabs.map((t) => t.key)).toEqual(['file:b.txt']);
        expect(state.scopes['session:1']?.details.tabs[0]?.isPreview).toBe(true);

        state = appPaneReduce(state, { type: 'pinDetailsTab', scopeId: 'session:1', tabKey: 'file:b.txt' });
        expect(state.scopes['session:1']?.details.tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
        ]);

        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('c.txt'), openAs: 'preview' });
        expect(state.scopes['session:1']?.details.tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
            ['file:c.txt', true, false],
        ]);

        // Opening an existing preview tab as pinned should pin it (no duplicates).
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'session:1', tab: createFileTab('c.txt'), openAs: 'pinned' });
        expect(state.scopes['session:1']?.details.tabs.map((t) => [t.key, t.isPreview, t.isPinned])).toEqual([
            ['file:b.txt', false, true],
            ['file:c.txt', false, true],
        ]);
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

        expect((state.scopes['session:1'] as any)?.right?.tabState?.git).toEqual({ commitMessageDraft: 'wip: draft' });
    });
});
