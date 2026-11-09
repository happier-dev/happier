import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createStorageModuleMock, createUseSettingMock } from '@/dev/testkit/mocks/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { decodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { useWorkspaceState } from './useWorkspaceState';
import { useWorkspaceTabSync } from './useWorkspaceTabSync';
import { getStorage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { dispatchKvBatchUpdate } from '@/sync/engine/socket/kvUpdateDispatcher';
import { ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS } from '@/sync/engine/pending/pendingSettings';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';
import * as workspaceSyncedTabs from './workspaceSyncedTabs';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { admitWorkspaceSingletonState, workspaceSingletonDestinationIds } from './workspaceDestinationPolicy';
import { randomUUID } from '@/platform/randomUUID';
import { workspaceLayoutScopeKey } from './workspacePersistence';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const boundary = vi.hoisted(() => ({ enabled: true, ready: true, layouts: {} as Record<string, unknown>, scope: { serverId: 'home', accountId: 'alice' },
    observations: [] as { accountId: string; ids: readonly string[] | null }[],
    catalog: [] as readonly CompactAppDestination[],
}));
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/domains/state/storage', importOriginal => createStorageModuleMock({ importOriginal, overrides: {
    useIsDataReady: () => boundary.ready,
    useActiveServerAccountScope: () => boundary.scope,
    useSetting: createUseSettingMock({ values: { get workspaceTabsSyncEnabled() { return boundary.enabled; } } }),
} }));
const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
Object.defineProperty(boundary, 'layouts', {
    get: () => workspaceLayoutsState.readAll(),
    set: (layouts: Record<string, unknown>) => {
        for (const key of Object.keys(workspaceLayoutsState.readAll())) workspaceLayoutsState.remove(key);
        for (const [key, layout] of Object.entries(layouts)) workspaceLayoutsState.set(key, layout);
        getStorage().setState({ localSettings: { ...getStorage().getState().localSettings, workspaceLayoutV1: {} } });
    },
});
const initialTab = { id: 'placeholder', target: { kind: 'newTab', params: {} }, pinned: false, preview: true };
const tokenFor = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const credentials = { token: tokenFor('alice') };
const portableTab = (id: string) => ({ id, target: { kind: 'settings', params: { pageId: id } }, pinned: false });
const record = (...ids: string[]): SharedWorkspaceTabs => ({ v: 1, tabsById: Object.fromEntries(ids.map(id => [id, portableTab(id)])), order: ids, pairs: [] });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
function servePortableKv(initial: SharedWorkspaceTabs | null, exposeReplace?: (replace: (value: SharedWorkspaceTabs) => void) => void) {
    let stored = initial;
    let version = initial ? 1 : -1;
    const writes: { key: string; record: SharedWorkspaceTabs }[] = [];
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (path === '/v1/kv/bulk') return Response.json({ values: stored
            ? [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version }]
            : [] });
        if (path === '/v1/kv') {
            const body = JSON.parse(String(init?.body)) as { mutations: { key: string; value: string }[] };
            const mutation = body.mutations[0];
            const envelope = decodeBase64StoredJsonContentEnvelope(mutation.value);
            if (envelope?.t !== 'plain') throw new Error('Expected plain fixture');
            const record = envelope.v as SharedWorkspaceTabs;
            writes.push({ key: mutation.key, record });
            if (mutation.key === 'workspace:tabs:v1') stored = record;
            return Response.json({ success: true, results: [{ key: mutation.key, version: ++version }] });
        }
        return Response.json({}, { status: 404 });
    });
    exposeReplace?.(value => { stored = value; version++; });
    return writes;
}
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreModuleLoader: (() => void) | null = null;
async function mountHome(serverUrl: string) {
    // Metro's call-time require must return the same real mounted Sync owner as ESM imports.
    // This bridges the Node module-loading boundary only, not Account or domain behavior.
    const actual = await import('@/sync/syncEngine');
    type Loader = (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown;
    const { createRequire } = getVitestNodeBuiltin<{ createRequire(filename: string | URL): (id: string) => unknown }>('node:module');
    const module = createRequire(import.meta.url)('node:module') as { _load: Loader };
    const previous = module._load;
    const load: Loader = function (request, parent, isMain) {
        if (request === '../sync.ts' && parent?.filename?.replaceAll('\\', '/').endsWith('/sync/runtime/getSyncSingleton.ts')) return actual;
        return previous.call(module, request, parent, isMain);
    };
    module._load = load;
    restoreModuleLoader = () => { if (module._load === load) module._load = previous; };
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        return Response.json({}, { status: 404 });
    } });
    expect(getActiveServerSnapshot().serverId).toBe(connection.home.id);
    getStorage().setState({ profileScope: { serverId: connection.home.id, accountId: 'alice' } });
    expect(getActiveServerAccountScope()?.accountId).toBe('alice');
    return connection.home;
}

function Probe() {
    const singletonPolicyKey = JSON.stringify([...workspaceSingletonDestinationIds(boundary.catalog)].sort());
    const admitState = React.useCallback((state: WorkspaceState, retainedState?: WorkspaceState) => admitWorkspaceSingletonState(state, boundary.catalog, randomUUID, retainedState), [singletonPolicyKey]);
    const local = useWorkspaceState({ initialTab, windowId: 'test-window', admitState });
    const owner = useWorkspaceTabSync({ local, enabled: true, catalog: boundary.catalog });
    boundary.observations.push({ accountId: boundary.scope.accountId, ids: owner.sharedTabs?.order ?? null });
    return React.createElement('WorkspaceOwner', { owner });
}

describe('live workspace tab sync hook', () => {
    beforeEach(() => { boundary.layouts = {}; });
    afterEach(async () => { vi.useRealTimers(); standardCleanup(); await connection?.dispose(); connection = null; restoreModuleLoader?.(); restoreModuleLoader = null; resetRuntimeFetch(); boundary.layouts = {}; boundary.enabled = true; boundary.ready = true; boundary.observations = []; boundary.catalog = []; });
    it.each([true, false])('builds a local render projection only while sync is off: sync=%s', async syncEnabled => {
        boundary.enabled = syncEnabled;
        // No credentials isolates render work from the controller's necessary projections.
        const projection = vi.spyOn(workspaceSyncedTabs, 'projectWorkspaceSharedTabs');
        try {
            const screen = await renderScreen(<Probe />);
            const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
            if (syncEnabled) expect(projection).not.toHaveBeenCalled();
            else expect(owner().sharedTabs?.order).toEqual([]);
            projection.mockClear();
            act(() => owner().dispatch({ type: 'openTab', groupId: 'group:1', tab: { ...portableTab('local'), preview: false } }));
            expect(owner().state.tabs.local.target).toEqual(portableTab('local').target);
            expect(projection).toHaveBeenCalledTimes(syncEnabled ? 0 : 1);
            if (!syncEnabled) expect(owner().sharedTabs?.order).toEqual(['local']);
            projection.mockClear();
            const target = { kind: 'settings', params: { pageId: 'usage', window: 'month' } };
            act(() => owner().dispatch({ type: 'setTarget', tabId: 'local', target }));
            expect(owner().state.tabs.local.target).toEqual(target);
            expect(projection).toHaveBeenCalledTimes(syncEnabled ? 0 : 1);
            if (!syncEnabled) expect(owner().sharedTabs?.tabsById.local.target).toEqual(target);
            await screen.unmount();
        } finally {
            projection.mockRestore();
        }
    });
    it.each(['workflows', 'plugin:acme.notes:notes'])('keeps retained %s contents while pin and later close reach the shared singleton', async kind => {
        const home = await mountHome('https://workspace-retained-singleton.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.catalog = kind === 'workflows' ? [{ id: kind, kind: 'builtin', title: 'Workflows', icon: 'tree-structure', order: 40,
            placement: { kind: 'rail', region: 'app' }, activation: 'navigate', availability: 'available', routePath: '/workflows' }]
            : [{ id: kind, kind: 'plugin', container: 'appPage', destination: { pluginId: 'acme.notes', localId: 'notes' }, title: 'Notes', icon: 'file', order: 40,
                placement: { kind: 'rail', region: 'plugins' }, activation: 'navigate', availability: 'available', routePath: '/plugins/acme.notes/notes' }];
        const editor = { id: 'device-editor', target: { kind, params: { definitionDraftSeedId: 'SECOND' } }, pinned: false, preview: false };
        const peer = { id: 'peer-editor', target: { kind, params: { definitionDraftSeedId: 'FIRST' } }, pinned: false };
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), createWorkspaceState(editor));
        const writes = servePortableKv({ v: 1, order: [peer.id], tabsById: { [peer.id]: peer }, pairs: [] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
        expect(owner().state.tabs[editor.id].target).toEqual(editor.target);
        const retainedTarget = owner().state.tabs[editor.id].target;
        expect(owner().state.tabs[peer.id]).toBeUndefined();
        expect(owner().state.groups['group:1'].activeTabId).toBe(editor.id);
        expect(writes).toHaveLength(0);
        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'setPinned', tabId: editor.id, pinned: true }));
        await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        expect(writes.at(-1)?.record.tabsById[peer.id].pinned).toBe(true);
        expect(owner().state.tabs[editor.id].target).toBe(retainedTarget);
        act(() => owner().dispatch({ type: 'closeTab', groupId: 'group:1', tabId: editor.id,
            newTab: { ...initialTab, id: 'blank' }, remember: false }));
        await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        expect(writes.at(-1)?.record.order).toEqual([]);
        expect(owner().state.tabs[editor.id]).toBeUndefined();
        await screen.unmount();
    });
    it.each([false, true])('reconsiders a deferred shared close immediately after local pane departure: split=%s', async split => {
        const home = await mountHome('https://workspace-deferred-close.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        let saved = createWorkspaceState({ ...portableTab('a'), preview: false });
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: { ...portableTab('b'), preview: false } });
        if (split) {
            saved = reduceWorkspaceState(saved, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1', newGroupId: 'second',
                axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 300, minimumSecondSizePx: 300 });
            saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'second', tab: { ...portableTab('c'), preview: false } });
            saved = reduceWorkspaceState(saved, { type: 'activateTab', groupId: 'second', tabId: 'b' });
            saved = reduceWorkspaceState(saved, { type: 'focusGroup', groupId: 'group:1' });
        }
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), saved);
        let replace!: (value: SharedWorkspaceTabs) => void;
        const writes = servePortableKv(split ? record('a', 'b', 'c') : record('a', 'b'), update => { replace = update; });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
        replace(split ? record('a', 'c') : record('a'));
        await act(async () => {
            await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: 2 }] }, credentials,
                shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
        });
        await vi.waitFor(() => expect(owner().sharedTabs?.order).toEqual(split ? ['a', 'c'] : ['a']));
        expect(owner().state.tabs.b).toBeDefined();
        expect(owner().state.groups[split ? 'second' : 'group:1'].activeTabId).toBe('b');
        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'activateTab', groupId: split ? 'second' : 'group:1', tabId: split ? 'c' : 'a' }));
        expect(owner().state.tabs.b).toBeUndefined();
        expect(owner().state.groups[split ? 'second' : 'group:1'].activeTabId).toBe(split ? 'c' : 'a');
        await act(async () => {
            await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: 2 }] }, credentials,
                shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
            await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS);
        });
        expect(owner().state.tabs.b).toBeUndefined();
        expect(writes).toHaveLength(0);
        await screen.unmount();
    });
    it('imports remote tabs without reuploading, then debounces only accepted local semantic edits', async () => {
        const home = await mountHome('https://workspace-hook.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        let stored = record('remote');
        let version = 1;
        const writes: SharedWorkspaceTabs[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            expect(target.origin).toBe('https://workspace-hook.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (target.pathname === '/v1/kv/bulk') return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version }] });
            if (target.pathname === '/v1/kv') {
                const body = JSON.parse(String(init?.body)) as { mutations: { key: string; value: string; version: number }[] };
                const mutation = body.mutations[0];
                const envelope = decodeBase64StoredJsonContentEnvelope(mutation.value);
                if (envelope?.t !== 'plain') throw new Error('Expected plain Account fixture');
                if (mutation.key === 'workspace:tabs:v1') { stored = envelope.v as SharedWorkspaceTabs; writes.push(stored); }
                version++;
                return Response.json({ success: true, results: [{ key: mutation.key, version }] });
            }
            return Response.json({}, { status: 404 });
        });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().state.tabs.remote).toBeDefined());
        expect(writes).toEqual([]);
        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'activateTab', groupId: 'group:1', tabId: 'remote' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(900); });
        expect(writes).toEqual([]);
        act(() => owner().dispatch({ type: 'openTab', groupId: 'group:1', tab: { ...portableTab('local'), preview: false } }));
        expect(writes).toEqual([]);
        await act(async () => { await vi.advanceTimersByTimeAsync(900); });
        expect(writes.at(-1)?.order).toEqual(['remote', 'local']);
        await screen.unmount();
    });
    it('retains a reordered tab set through the debounced write, remote echo and reload', async () => {
        const home = await mountHome('https://workspace-reorder.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        const writes = servePortableKv(record('a', 'b', 'c'));
        let screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().sharedTabs?.order).toEqual(['a', 'b', 'c']));
        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'reorderTab', groupId: 'group:1', tabId: 'c', index: 0 }));
        act(() => owner().dispatch({ type: 'reorderTab', groupId: 'group:1', tabId: 'placeholder', index: 1 }));
        const localOrder = owner().state.groups['group:1'].tabIds;
        expect(localOrder).toEqual(['c', 'placeholder', 'a', 'b']);
        await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        expect(writes.at(-1)?.record.order).toEqual(['c', 'a', 'b']);
        await act(async () => {
            await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: 2 }] }, credentials,
                shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
        });
        expect(owner().state.groups['group:1'].tabIds).toEqual(localOrder);
        await screen.unmount();
        vi.useRealTimers();
        screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
        expect(owner().state.groups['group:1'].tabIds).toEqual(localOrder);
        await screen.unmount();
    });
    it('keeps local tabs on unavailable transport and never requires an auth provider', async () => {
        const home = await mountHome('https://workspace-unavailable.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        setRuntimeFetch(async () => { throw new Error('Network request failed'); });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('unavailable'));
        act(() => owner().dispatch({ type: 'openTab', groupId: 'group:1', tab: { ...portableTab('local'), preview: false } }));
        expect(owner().state.tabs.local).toBeDefined();
        await screen.unmount();
        const local = await renderScreen(<Probe />);
        expect(local.root.findByType('WorkspaceOwner').props.owner.state.tabs.local).toBeDefined();
        await local.unmount();
    });
    it('retires exposed records and in-flight callbacks before the replacement Account can observe them', async () => {
        const home = await mountHome('https://workspace-scope.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        let activeCredentials = credentials;
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (new Headers(init?.headers).get('Authorization') === `Bearer ${tokenFor('bob')}`) await pending;
            return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: record('alice-private') }), version: 1 }] });
        });
        const element = () => <InjectedAuthProvider credentials={activeCredentials}><Probe /></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().sharedTabs?.order).toEqual(['alice-private']));
        await act(async () => {
            boundary.scope = { serverId: home.id, accountId: 'bob' };
            activeCredentials = { token: tokenFor('bob') };
            screen.update(element());
        });
        expect(owner().sharedTabs).toBeNull();
        expect(boundary.observations.filter(value => value.accountId === 'bob').some(value => value.ids?.includes('alice-private'))).toBe(false);
        expect(owner().state.tabs['alice-private']).toBeUndefined();
        await screen.unmount();
        release();
    });
    it('does not read or seed the replacement token Account while the local owner still belongs to the prior Account', async () => {
        const home = await mountHome('https://workspace-credential-gap.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        const requests: string[] = [];
        setRuntimeFetch(async (url, init) => {
            if (new Headers(init?.headers).get('Authorization') === `Bearer ${tokenFor('bob')}`) requests.push(String(url));
            return Response.json(currentness);
        });
        const screen = await renderScreen(<InjectedAuthProvider credentials={{ token: tokenFor('bob') }}><Probe /></InjectedAuthProvider>);
        expect(requests).toEqual([]);
        await screen.unmount();
    });
    it('fences an Account retirement during currentness resolution even before React observes the new scope', async () => {
        const home = await mountHome('https://workspace-retirement.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const requests: string[] = [];
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            requests.push(path);
            if (path === '/v1/account/encryption/currentness') { await pending; return Response.json(currentness); }
            return Response.json({ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: record('private') }), version: 1 });
        });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(requests).toContain('/v1/account/encryption/currentness'));
        await act(async () => {
            getStorage().setState({ profileScope: { serverId: home.id, accountId: 'bob' } });
            release();
        });
        expect(requests.some(path => path.startsWith('/v1/kv/'))).toBe(false);
        expect(screen.root.findByType('WorkspaceOwner').props.owner.state.tabs.private).toBeUndefined();
        await screen.unmount();
    });
    it('does not interpret Account settings hydration before layout readiness as deliberate enable', async () => {
        const home = await mountHome('https://workspace-hydration-enable.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.ready = false;
        boundary.enabled = false;
        const saved = createWorkspaceState({ ...portableTab('restored'), preview: false });
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), saved);
        const layouts = boundary.layouts;
        const writes = servePortableKv(record('remote'));
        const element = () => <InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await act(async () => {
            boundary.ready = true;
            boundary.enabled = true;
            screen.update(element());
        });
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
        expect(writes).toEqual([]);
        expect(owner().sharedTabs?.order).toEqual(['remote']);
        expect(boundary.layouts).toBe(layouts);
        await screen.unmount();
    });
    it('deliberately enrolls local intentional tabs on OFF to ON without importing while OFF', async () => {
        const home = await mountHome('https://workspace-toggle.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.enabled = false;
        let stored = record('remote');
        const writes: SharedWorkspaceTabs[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (target.pathname === '/v1/kv/bulk') return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version: 1 }] });
            if (target.pathname === '/v1/kv') {
                const body = JSON.parse(String(init?.body)) as { mutations: { key: string; value: string }[] };
                const mutation = body.mutations[0];
                const envelope = decodeBase64StoredJsonContentEnvelope(mutation.value);
                if (envelope?.t !== 'plain') throw new Error('Expected plain fixture');
                if (mutation.key === 'workspace:tabs:v1') { stored = envelope.v as SharedWorkspaceTabs; writes.push(stored); }
                return Response.json({ success: true, results: [{ key: mutation.key, version: 2 }] });
            }
            return Response.json({}, { status: 404 });
        });
        const element = () => <InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        expect(owner().state.tabs.remote).toBeUndefined();
        act(() => owner().dispatch({ type: 'openTab', groupId: 'group:1', tab: { ...portableTab('local'), preview: false } }));
        await act(async () => { boundary.enabled = true; screen.update(element()); });
        await vi.waitFor(() => expect(writes.at(-1)?.order).toEqual(['remote', 'local']));
        await screen.unmount();
    });
    it('keeps an OFF restored source read-only until an explicit tab edit publishes its projection', async () => {
        const home = await mountHome('https://workspace-off-source.test');
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.enabled = false;
        const saved = createWorkspaceState({ ...portableTab('restored'), preview: false });
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), saved);
        const writes = servePortableKv(null);
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        expect(owner().sharedTabs?.order).toEqual(['restored']);
        expect(writes).toEqual([]);
        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'setPinned', tabId: 'restored', pinned: true }));
        await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        const published = writes.find(value => value.key.startsWith('workspace:handoff-tabs:v1:'))?.record;
        expect(published?.order).toEqual(['restored']);
        expect(published?.tabsById.restored.pinned).toBe(true);
        expect(writes.some(value => value.key === 'workspace:tabs:v1')).toBe(false);
        await screen.unmount();
    });
    it.each([false, true])('enrolls canonical restored pairs only on explicit edit or deliberate enable: enable=%s', async enable => {
        const home = await mountHome(`https://workspace-enroll-pairs-${enable}.test`);
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.enabled = !enable;
        let saved = createWorkspaceState({ ...portableTab('left'), preview: false });
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: { ...portableTab('right'), preview: false } });
        saved = reduceWorkspaceState(saved, { type: 'splitTab', tabId: 'right', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'second', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 300, minimumSecondSizePx: 300 });
        expect(saved.tabPairs).toEqual([['left', 'right']]);
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), saved);
        const writes = servePortableKv(enable ? record('remote') : null);
        const element = () => <InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        if (!enable) {
            await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
            expect(owner().sharedTabs?.order).toEqual(['left', 'right']);
            expect(writes).toEqual([]);
            expect(boundary.layouts[workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' })]).toBe(saved);
            vi.useFakeTimers();
            act(() => owner().dispatch({ type: 'setPinned', tabId: 'left', pinned: true }));
            await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        }
        if (enable) await act(async () => { boundary.enabled = true; screen.update(element()); });
        await vi.waitFor(() => expect(writes.find(value => value.key === 'workspace:tabs:v1')?.record.pairs).toEqual([['left', 'right']]));
        if (!enable) expect(writes.some(value => value.key.startsWith('workspace:handoff-tabs:v1:'))).toBe(false);
        await screen.unmount();
    });
    it.each([true, false])('normalizes unavailable kinds when the actual catalog later declares an app-page singleton, despite KV failure: sync=%s', async syncEnabled => {
        const home = await mountHome(`https://workspace-late-catalog-${syncEnabled}.test`);
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        boundary.enabled = syncEnabled;
        const kind = 'plugin:acme.notes:notes';
        const first = { ...portableTab('first'), target: { kind, params: { subPath: 'first' } } };
        const second = { ...portableTab('second'), target: { kind, params: { subPath: 'last' } } };
        if (!syncEnabled) {
            const saved = reduceWorkspaceState(createWorkspaceState({ ...first, preview: false }),
                { type: 'openTab', groupId: 'group:1', tab: { ...second, preview: false } });
            workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'test-window' }), saved);
        }
        const writes = servePortableKv({ v: 1, tabsById: { first, second }, order: ['first', 'second'], pairs: [] });
        const element = () => <InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().state.tabs.second).toBeDefined());
        vi.useFakeTimers();
        setRuntimeFetch(async () => { throw new Error('KV endpoint unavailable'); });
        if (syncEnabled) {
            await act(async () => {
                await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: 2 }] }, credentials,
                    shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
            });
            expect(owner().tabSyncStatus).toBe('unavailable');
        }
        await act(async () => {
            boundary.catalog = [{ id: kind, kind: 'plugin', container: 'appPage', destination: { pluginId: 'acme.notes', localId: 'notes' },
                title: 'Notes', icon: 'file', order: 40, placement: { kind: 'rail', region: 'plugins' },
                activation: 'navigate', availability: 'available', routePath: '/plugins/acme.notes/notes' }];
            screen.update(element());
        });
        expect(Object.values(owner().state.tabs).filter(tab => tab.target.kind === kind)).toHaveLength(1);
        expect(owner().state.tabs.first.target).toEqual(second.target);
        expect(writes).toEqual([]);
        await screen.unmount();
    });
});
