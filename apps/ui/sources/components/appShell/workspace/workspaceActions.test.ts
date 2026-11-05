import { describe, expect, it, vi } from 'vitest';
import { ActionIdSchema, isWorkspaceActionId } from '@happier-dev/protocol';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createWorkspaceActionAdapter } from './workspaceActions';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { resolvePhoneWorkspaceTabHref } from './workspacePhoneProjection';
import { createWorkspaceEmptyTab, createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState, parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createFileFindSeedHandoff } from '../panes/fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

describe('workspace Action intent adapter', () => {
    it('opens session and project file arms through real navigation with line ranges and view intent', () => {
        let state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: 'session-a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => `new:${++id}`, onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        const anchor = { kind: 'range', filePath: 'src/a.ts', startLine: 3, endLine: 8 };
        const beforeSilentOpen = state;
        expect(execute('workspace.tabs.open', { file: { target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a' },
            path: 'src/a.ts', anchor }, mode: 'preview', present: false }))
            .toMatchObject({ ok: false, errorCode: 'workspace_file_pane_unavailable' });
        expect(state).toBe(beforeSilentOpen);
        expect(execute('workspace.tabs.open', { file: { target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a' }, path: 'src/a.ts', anchor, view: 'changes', blame: true }, mode: 'preview' })).toEqual({ ok: true });
        const current = state.tabs[state.groups[state.focusedGroupId].activeTabId];
        expect(current.target.kind).toBe('session');
        expect(parseSessionPaneUrlState(current.target.params)?.details).toEqual({ kind: 'file', path: 'src/a.ts', anchor, view: 'changes', blame: true, openAs: 'preview' });
        expect(execute('workspace.tabs.open', { file: { target: { kind: 'project', workspaceRefId: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, path: 'src/a.ts', anchor, view: 'view' }, mode: 'preview' })).toEqual({ ok: true });
        const project = state.tabs[state.groups[state.focusedGroupId].activeTabId];
        expect(project.target.kind).toBe('project');
        expect(project.target.params).toMatchObject({ workspaceRefId: 'workspace-a', initialFile: 'src/a.ts', fileView: 'view', anchor: 'range', startLine: '3', endLine: '8' });
        expect(project.preview).toBe(true);
    });
    it.each([
        ['workspace.tabs.close_others', { tabId: 'b' }, ['pin', 'b']],
        ['workspace.tabs.close_left', { tabId: 'b' }, ['pin', 'b', 'c']],
        ['workspace.tabs.close_right', { tabId: 'b' }, ['pin', 'a', 'b']],
        ['workspace.tabs.close_all', { groupId: 'group:1' }, ['pin']],
    ])('executes %s through the current pane owner while preserving pinned tabs', (name, parameters, remaining) => {
        let state = createWorkspaceState({ id: 'pin', target: { kind: 'session', params: { id: 'pin' } }, pinned: true, preview: false });
        for (const id of ['a', 'b', 'c']) state = reduceWorkspaceState(state, {
            type: 'openTab', groupId: 'group:1', tab: { id, target: { kind: 'session', params: { id } }, pinned: false, preview: false },
        });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => `new:${++id}`, onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++id}` });
        const actionId = ActionIdSchema.parse(name);
        if (!isWorkspaceActionId(actionId)) throw new Error('Expected a workspace Action');
        expect(execute(actionId, parameters)).toEqual({ ok: true });
        expect(state.groups['group:1'].tabIds).toEqual(remaining);
        expect(execute(actionId, name === 'workspace.tabs.close_all' ? { groupId: 'missing' } : { tabId: 'missing' }))
            .toMatchObject({ ok: false, errorCode: name === 'workspace.tabs.close_all' ? 'workspace_group_not_found' : 'workspace_tab_not_found' });
    });
    it.each([false, true])('opens an exact Session file Find through the private handoff without leaking or retargeting the query (phone=%s)', (phone) => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'session-a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            ...(phone ? { resolveOpenHref: (href: string) => resolvePhoneWorkspaceTabHref(catalog, href) } : {}),
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => 'new', onChange: () => {} });
        const handoff = createFileFindSeedHandoff();
        const authority: ServerAccountScopeLifetime = { scope: { serverId: 'home-a', accountId: 'account' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
            createId: () => 'new', chatFind: { handoff, resolveAuthority: serverId => serverId === 'home-a' ? authority : null } });
        const file = { target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a' }, path: 'src/index.ts' };
        const find = { query: 'private session needle', options: { matchCase: true, regex: false }, target: {
            kind: 'session-file', sessionId: 'session-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: file.path,
        } };
        const destination = { host: 'session' as const, id: 'session-a', path: file.path,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' } };
        try {
            expect(execute('workspace.tabs.open', { file, find, mode: 'preview' })).toEqual({ ok: true });
            const selected = state.tabs[state.groups[state.focusedGroupId].activeTabId];
            expect(selected.target.kind).toBe(phone ? 'sessionDetails' : 'session');
            expect(handoff.takeCurrent(destination)?.seed).toEqual({ query: find.query, options: find.options,
                target: { kind: 'file', path: file.path } });
            expect(JSON.stringify(state)).not.toContain(find.query);
            for (const target of [
                { ...find.target, sessionId: 'another-session' },
                { ...find.target, serverId: 'another-home' },
                { ...find.target, path: 'another.ts' },
            ]) {
                const before = state;
                expect(execute('workspace.tabs.open', { file, find: { ...find, target } }))
                    .toMatchObject({ ok: false, errorCode: 'workspace_find_unavailable' });
                expect(state).toBe(before);
                expect(handoff.peekCurrent(destination)).toBeNull();
            }
        } finally { handoff.dispose(); }
    });

    it('opens an exact Project file Find through the private handoff without putting the query in navigation state', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => 'new', onChange: () => {} });
        const handoff = createFileFindSeedHandoff();
        const authority: ServerAccountScopeLifetime = { scope: { serverId: 'home-a', accountId: 'account' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
            createId: () => 'new', chatFind: { handoff, resolveAuthority: serverId => serverId === 'home-a' ? authority : null } });
        const href = '/projects/wr_1/code?serverId=home-a&worktree=%2Frepo&initialFile=src%2Findex.ts';
        const find = { query: 'private needle', options: { matchCase: false, regex: false }, target: {
            kind: 'project-file' as const, workspaceRefId: 'wr_1', serverId: 'home-a', machineId: 'machine-a',
            rootPath: '/repo', path: 'src/index.ts',
        } };
        expect(execute('workspace.tabs.open', { href, find: { ...find, target: { ...find.target, path: 'another.ts' } } }))
            .toMatchObject({ ok: false, errorCode: 'workspace_find_unavailable' });
        expect(handoff.peekCurrent({ host: 'project', id: 'wr_1', path: 'another.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' } })).toBeNull();
        expect(execute('workspace.tabs.open', { href, find })).toEqual({ ok: true });
        expect(handoff.takeCurrent({ host: 'project', id: 'wr_1', path: 'src/index.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' } })?.seed)
            .toEqual({ query: 'private needle', options: { matchCase: false, regex: false },
                target: { kind: 'file', path: 'src/index.ts' } });
        expect(JSON.stringify(state)).not.toContain('private needle');
        handoff.dispose();
    });

    it('opens the exact native hit using the incumbent private chat handoff, never URL or tab persistence', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => 'new', onChange: () => {} });
        const handoff = createFileFindSeedHandoff();
        let current = true;
        const authority: ServerAccountScopeLifetime = { scope: { serverId: 'home-a', accountId: 'account' },
            isCurrent: () => current, onRetire: () => ({ dispose() {} }) };
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
            createId: () => 'new', chatFind: { handoff, resolveAuthority: serverId => serverId === 'home-a' ? authority : null } });
        const request = { href: '/session/a?serverId=home-a', find: { query: 'needle',
            target: { kind: 'native-message', agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' } } };
        expect(execute('workspace.tabs.open', request)).toEqual({ ok: true });
        const destination = { sessionId: 'a', serverId: 'home-a' };
        expect(handoff.takeChatCurrent(destination)?.seed).toEqual({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: `server:${makeExternalSessionHistoricalImportLocalId({
                agentId: 'claude', remoteSessionId: 'native', directItemId: 'item' })}` } });
        expect(JSON.stringify(state)).not.toContain('needle');
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        current = false;
        const before = state;
        expect(execute('workspace.tabs.open', request)).toMatchObject({ ok: false, errorCode: 'workspace_find_unavailable' });
        expect(state).toBe(before);
        handoff.dispose();
    });
    it('opens a file at its selected line through the same Session pane parser instead of another file Action', () => {
        let state = createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'a', serverId: 'home-a' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, transport: { commit: () => {} },
            createId: () => 'new', onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'new' });
        const href = buildScopedSessionRouteHref({ sessionId: 'a', serverId: 'home-a', query: serializeSessionPaneUrlState({
            rightTabId: 'files', details: { kind: 'file', path: 'src/a.ts', anchor: { kind: 'fileLine', startLine: 17 } },
        }) });
        expect(execute('workspace.tabs.open', { href, tabId: 'a' })).toEqual({ ok: true });
        expect(parseSessionPaneUrlState(state.tabs.a.target.params)?.details)
            .toEqual({ kind: 'file', path: 'src/a.ts', anchor: { kind: 'fileLine', startLine: 17 } });
        expect(Object.keys(state.tabs)).toEqual(['a']);
    });
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
