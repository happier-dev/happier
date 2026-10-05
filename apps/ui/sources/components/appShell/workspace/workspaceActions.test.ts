import { describe, expect, it, vi } from 'vitest';
import { ActionIdSchema, isWorkspaceActionId } from '@happier-dev/protocol';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createWorkspaceActionAdapter } from './workspaceActions';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceEmptyTab, createWorkspaceState, reduceWorkspaceState } from './workspaceState';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

describe('workspace Action intent adapter', () => {
    it('uses live measurements for atomic destination edges and focuses already-open destinations without requiring geometry', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { id: 'current', target: { kind: 'session', params: { id: 'current', serverId: 'home-a' } }, pinned: false, preview: true } });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => `new:${++id}`, onChange: () => {} });
        // The mounted canvas's pixel measurement is the actual platform boundary.
        let availableSizePx = 400;
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation,
            readCanvas: () => ({ readSplitMeasurement: () => ({ availableSizePx, minimumExistingSizePx: 420 }), resizeSplit: () => false }),
            createId: () => `new:${++id}` });
        const before = state;
        expect(execute('workspace.tabs.open', { href: '/session/incoming?serverId=home-a', mode: 'splitLeft', groupId: 'group:1' })).toMatchObject({ ok: false, errorCode: 'workspace_destination_unavailable' });
        expect(state).toBe(before);
        availableSizePx = 1200;
        expect(execute('workspace.tabs.open', { href: '/session/incoming?serverId=home-a', mode: 'splitLeft', groupId: 'group:1' })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['a', 'current']);
        expect(state.tabs.current).toBe(before.tabs.current);
        const incoming = state.groups[state.focusedGroupId].activeTabId;
        const unmeasured = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        expect(unmeasured('workspace.tabs.open', { href: '/session/incoming?serverId=home-a', mode: 'splitDown', groupId: 'group:1' })).toEqual({ ok: true });
        expect(state.groups[state.focusedGroupId].activeTabId).toBe(incoming);
        expect(Object.keys(state.groups)).toHaveLength(2);
    });

    it('opens kept destinations before current anchors and uses the same anchored reorder owner', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: createWorkspaceEmptyTab('anchor') });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => `new:${++id}`, onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        expect(execute('workspace.tabs.open', { href: '/session/b?serverId=home-a', groupId: 'group:1', beforeTabId: 'anchor', mode: 'newTab' })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['a', 'new:1', 'anchor']);
        expect(execute('workspace.tabs.open', { href: '/session/b?serverId=home-a', mode: 'newTab' })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['a', 'new:1', 'anchor']);
        expect(execute('workspace.tabs.reorder', { tabId: 'anchor', beforeTabId: 'a' })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['anchor', 'a', 'new:1']);
        expect(execute('workspace.tabs.reorder', { tabId: 'anchor', beforeTabId: 'deleted' })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['a', 'new:1', 'anchor']);
    });

    it('lists local closed tabs and reopens the selected tab through the navigation owner', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => `new:${++id}`, onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        navigation.initialize('/session/a?serverId=home-a');
        navigation.closeTab('group:1', 'a');
        const closed = ActionIdSchema.parse('workspace.tabs.closed.list');
        const reopen = ActionIdSchema.parse('workspace.tabs.reopen');
        if (!isWorkspaceActionId(closed) || !isWorkspaceActionId(reopen)) throw new Error('Expected workspace Actions');
        expect(execute(closed, {})).toMatchObject({ ok: true, tabs: [{ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } } }] });
        expect(execute(reopen, { tabId: 'missing' })).toMatchObject({ ok: false, errorCode: 'workspace_closed_tab_not_found' });
        expect(execute(reopen, { tabId: 'a' })).toEqual({ ok: true });
        expect(state.groups[state.focusedGroupId].activeTabId).toBe('a');
        expect(execute(closed, {})).toEqual({ ok: true, tabs: [] });
        expect(execute(reopen, {})).toMatchObject({ ok: false, errorCode: 'workspace_closed_tab_not_found' });
    });
    it('reorders through the real navigation reducer and returns typed rejection for invalid positions', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: createWorkspaceEmptyTab('b') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: createWorkspaceEmptyTab('c') });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({
            getState: () => state, getCatalog: () => catalog,
            dispatch: (action) => { state = reduceWorkspaceState(state, action); },
            transport: { commit: () => {} }, createId: () => `new:${++id}`, onChange: () => {},
        });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        navigation.initialize('/session/a?serverId=home-a');
        navigation.activateTab('group:1', 'c');
        const history = navigation.history;
        const actionId = ActionIdSchema.parse('workspace.tabs.reorder');
        if (!isWorkspaceActionId(actionId)) throw new Error('Expected a workspace Action');
        expect(execute(actionId, { tabId: 'a', index: 2 })).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(['b', 'c', 'a']);
        expect(state.groups['group:1'].activeTabId).toBe('c');
        const beforeInvalid = state;
        expect(execute(actionId, { tabId: 'a', index: 3 })).toMatchObject({ ok: false, errorCode: 'workspace_tab_index_out_of_range' });
        expect(execute(actionId, { tabId: 'a', index: -1 })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(execute(actionId, { tabId: 'a', index: 0.5 })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(execute(actionId, { tabId: 'missing', index: 0 })).toMatchObject({ ok: false, errorCode: 'workspace_tab_not_found' });
        expect(state).toBe(beforeInvalid);
        expect(navigation.history).toBe(history);
    });
});
