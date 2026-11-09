/** @vitest-environment jsdom */
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { parseRecentWorkspaceFiles, recentWorkspaceFilesKey } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import type { FileViewActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const route = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
        const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
        return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
    },
    text: async () => await vi.importActual('@/text'),
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ segments: [], pathname: () => route.pathname, params: () => route.params }).module;
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
// Empty-query Quick Open uses the recycler; jsdom has no measured viewport.
// Substitute that native layout boundary while keeping row rendering and activation real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({ renderItems: true });
});
installDisconnectedServerSocketBoundary();
// Load these after the native boundary has selected real React Native Web;
// the testkit barrel otherwise evaluates its render helpers before that choice.
const [{ serveActionHomes }, { installBrowserStorageLockBoundary }] = await Promise.all([
    import('@/dev/testkit/harness/actionHomesHttpHarness'), import('@/dev/testkit'),
]);

// The complete palette, command dispatcher, modal manager/host, controller and
// presentation stay real; only the navigator, native UI and network leave this process.
const { ModalProvider } = await import('@/modal/ModalProvider');
const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { recentWorkspaceFilesState } = await import('@/sync/domains/state/filePaneUiState');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
// Amortize the runner's cold TypeScript transformation outside operation deadlines,
// as the former static import did. The owner graph test independently proves that
// this body is absent from startup; these journeys exercise its real lazy opening.
await import('@/components/appShell/search/UniversalSearchModal');
const [{ WorkspaceProvider }, { AppPaneProvider }, { resolveCompactAppDestinations },
    { useUniversalSearchRuntime }, { invokeWorkspaceAction }, { recordRecentWorkspaceFile },
    { tryBuildWorkspaceCacheKey }] = await Promise.all([
    import('@/components/appShell/workspace/WorkspaceProvider'), import('@/components/appShell/panes/AppPaneProvider'),
    import('@/components/appShell/destinations/compactAppDestinationCatalog'),
    import('@/components/appShell/search/UniversalSearchRuntimeContext'),
    import('@/components/appShell/workspace/workspaceActionRuntime'),
    import('@/sync/domains/workspaces/files/recentWorkspaceFiles'), import('@/sync/domains/workspaces/workspaceScope'),
]);

it.each(['checkout', 'idle', 'focus'] as const)('opens Text in files from the presented Project: %s', async contract => {
    const restoreLocks = installBrowserStorageLockBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://project-text-search.test',
        serverIdentityId: 'srv_project_text_search', accountId: 'alice', currentAccount: true,
        settings: { commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } }],
        route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [{ id: 'search-project',
                serverId: 'srv_project_text_search', machineId: 'studio', rootPath: '/repo', label: 'Search project', createdAtMs: 1 }] }))
            : undefined });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
    const { readProjectWidgetAreaContextV1 } = await import('@/sync/domains/widgets/projectWidgetAreaContext');
    const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
    const { resolveKeyboardPlatform } = await import('@/keyboard/runtime');
    const { t } = await import('@/text');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initial = storage.getState();
    let disconnect: (() => Promise<unknown>) | undefined;
    try {
        disconnect = await homes.restoreActiveConnection();
        const account = captureActiveServerAccountScopeLifetime()!;
        await vi.waitFor(() => expect(storage.getState().projectAccountRows!.status).toBe('ready'));
        const checkout = storage.getState().projectAccountRows!.workspaceRefs.find(ref => ref.id === 'search-project')!;
        const scopeId = buildProjectPaneScopeId(checkout.id, checkout.serverId);
        // Project pages use the direct adapter, not a registered Session-style driver.
        const projectContext = readProjectWidgetAreaContextV1({ serverId: checkout.serverId,
            projectRef: checkout, activeCheckout: checkout, authority: account });
        storage.setState({ isDataReady: true, settings: { ...settingsDefaults,
            commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } });
        await act(async () => root.render(<InjectedAuthProvider credentials={null}><ModalProvider><AppPaneProvider>
            <CommandPaletteProvider><AppPaneScopeHost scopeId={scopeId}
                surfaceScope={{ targetKind: 'project', projectId: checkout.id, projectContext,
                    accountLifetime: account, serverId: checkout.serverId, machineId: checkout.machineId,
                    projectionPhase: 'current' }}
                main={<button data-testid="project-search-origin">Project Code</button>} /></CommandPaletteProvider>
        </AppPaneProvider></ModalProvider></InjectedAuthProvider>));
        container.querySelector<HTMLButtonElement>('button')!.focus();
        const command = ['macos', 'ios'].includes(resolveKeyboardPlatform());
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'H', code: 'KeyH', altKey: !command, metaKey: command, shiftKey: true, bubbles: true, cancelable: true,
        })));
        const host = () => document.querySelector('[data-testid="universal-search-host"]');
        await vi.waitFor(() => expect(host()).not.toBeNull());
        if (contract === 'checkout') await vi.waitFor(() => expect(host()!.textContent).toContain('Search project'));
        if (contract === 'idle') expect(host()!.textContent).not.toContain(t('selectionList.emptyMatch'));
        if (contract === 'focus') expect(document.activeElement).toBe(host()!.querySelector('input'));
    } finally {
        await act(async () => root.unmount());
        container.remove();
        try { await disconnect?.(); }
        finally { await homes.dispose(); restoreLocks(); storage.setState(initial, true); }
    }
});

it('keeps the canonical file opener when Search renders in the global modal outside Workspace context', async () => {
    const restoreLocks = installBrowserStorageLockBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-search-portal.test',
        serverIdentityId: 'srv_search_portal', accountId: 'alice', currentAccount: true }],
        route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [{ id: 'portal-project',
                serverId: 'srv_search_portal', machineId: 'studio', rootPath: '/repo', label: null, createdAtMs: 1 }] }))
            : undefined });
    let disconnect: (() => Promise<unknown>) | undefined;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initial = storage.getState();
    try {
        disconnect = await homes.restoreActiveConnection();
        const scope = storage.getState().profileScope!;
        const workspace = { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo' };
        const workspaceKey = tryBuildWorkspaceCacheKey(workspace)!;
        route.pathname = '/projects/portal-project/overview';
        route.params = { workspaceRefId: 'portal-project', serverId: scope.serverId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${encodeURIComponent(scope.serverId)}`);
        replacePersistentUiStateForTest(recentWorkspaceFilesState, parseRecentWorkspaceFiles(recordRecentWorkspaceFile({}, recentWorkspaceFilesKey(scope, workspaceKey), 'from-search.ts')));
        storage.setState({ isDataReady: true, settings: { ...storage.getState().settings, commandPaletteEnabled: true } });
        await vi.waitFor(() => expect(storage.getState().projectAccountRows).toMatchObject({ status: 'ready',
            workspaceRefs: [expect.objectContaining({ id: 'portal-project' })] }));
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false } });
        let runtime!: ReturnType<typeof useUniversalSearchRuntime>;
        let navigation!: WorkspaceNavigationContextValue;
        function SearchOpener() { runtime = useUniversalSearchRuntime(); return null; }
        // This is the actual global host: React owns the Search controller
        // outside Workspace, so only the captured opener can reach its Action.
        await act(async () => root.render(<InjectedAuthProvider credentials={null}><ModalProvider><AppPaneProvider>
            <WorkspaceProvider enabled catalog={catalog}>{owner => { navigation = owner;
                return <CommandPaletteProvider><SearchOpener /></CommandPaletteProvider>;
            }}</WorkspaceProvider></AppPaneProvider></ModalProvider></InjectedAuthProvider>));
        await vi.waitFor(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: true });
        });
        await act(async () => runtime.open(undefined, { ...workspace, accountId: scope.accountId, sessionId: null }, { source: 'files' }));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')).not.toBeNull());
        const fileRow = () => document.querySelector<HTMLElement>('[data-testid="universal-search:option:files:from-search.ts"]');
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(fileRow(), document.querySelector('[data-testid="universal-search-host"]')?.textContent ?? 'Search host missing').not.toBeNull();
        });
        await act(async () => { fileRow()!.click(); });
        await vi.waitFor(() => {
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            expect(tab.target).toMatchObject({ kind: 'project', params: { workspaceRefId: 'portal-project',
                serverId: scope.serverId, initialFile: 'from-search.ts' } });
        });
    } finally {
        await act(async () => root.unmount());
        route.pathname = '/'; route.params = {};
        container.remove();
        try { await disconnect?.(); }
        finally { await homes.dispose(); restoreLocks(); storage.setState(initial, true); }
    }
});

it('reopens Search through the app-shell shortcut after its route-modal host retires', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const before = storage.getState().settings;
    storage.setState({ settings: { ...settingsDefaults, commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } });
    const render = (routeFocused: boolean) => <InjectedAuthProvider credentials={null}>
        <ModalProvider><CommandPaletteProvider>
            <ModalProvider active={routeFocused}><button>Session</button></ModalProvider>
        </CommandPaletteProvider></ModalProvider>
    </InjectedAuthProvider>;
    const open = () => act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', altKey: true, bubbles: true, cancelable: true }));
    });
    const palette = () => document.querySelector('[data-testid="universal-search-host"]');
    try {
        await act(async () => root.render(render(false)));
        // A route becomes focused after the app-shell provider is registered.
        await act(async () => root.render(render(true)));
        // Escape must cancel the first open even before its body import settles.
        // Two key presses, as a person makes them: the pending open claims Escape from the first press's
        // commit. Synchronous acts commit that press without letting the body import settle.
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', altKey: true, bubbles: true, cancelable: true }));
        });
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        });
        await act(async () => {});
        expect(palette()).toBeNull();
        await open();
        await vi.waitFor(() => expect(palette()).not.toBeNull());
        // This is the route scope's actual active=false transition, not a mocked
        // dismissal callback. The app-shell owner survives the route navigation.
        await act(async () => root.render(render(false)));
        expect(palette()).toBeNull();
        await open();
        await vi.waitFor(() => expect(palette()).not.toBeNull());
        expect(document.querySelectorAll('[data-testid="universal-search-host"]')).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        storage.setState({ settings: before });
        container.remove();
    }
});

it('uses the presented File page for global quick open and symbols without focusing its DOM', async () => {
    const restoreLocks = installBrowserStorageLockBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-search-presented-file.test',
        serverIdentityId: 'srv_search_presented_file', accountId: 'alice', currentAccount: true,
        settings: { commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } }],
        route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [{ id: 'presented-project',
                serverId: 'srv_search_presented_file', machineId: 'studio', rootPath: '/repo', label: null, createdAtMs: 1 }] }))
            : undefined });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { registerFileViewActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
    const { resolveKeyboardPlatform } = await import('@/keyboard/runtime');
    const { t } = await import('@/text');
    let disconnect: (() => Promise<unknown>) | undefined;
    let release: (() => void) | undefined;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initial = storage.getState();
    try {
        disconnect = await homes.restoreActiveConnection();
        const account = storage.getState().profileScope!;
        const workspace = { serverId: account.serverId, machineId: 'studio', rootPath: '/repo' };
        const searchScope = { ...workspace, accountId: account.accountId, sessionId: null };
        await vi.waitFor(() => expect(storage.getState().projectAccountRows).toMatchObject({ status: 'ready',
            workspaceRefs: [expect.objectContaining({ id: 'presented-project' })] }));
        storage.setState({ isDataReady: true, settings: { ...settingsDefaults,
            commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } });
        // No File route or focused element supplies scope. This is the mounted
        // page's existing command bridge, not a second Search registry.
        route.pathname = '/'; route.params = {};
        const symbols: WorkspaceSymbolSearchInput = {
            target: { kind: 'workspaceFile', scope: workspace, path: 'notes.md', workspaceRefId: 'presented-project',
                sessionId: null, serverId: account.serverId, accountId: account.accountId },
            resolverKey: 'presented-notes', language: 'markdown', isDark: false, unavailableHint: 'Unavailable',
            accountLifetime: captureActiveServerAccountScopeLifetime()!, isCurrent: () => true,
            getText: () => '# Presented heading\n', flushPendingChange() {},
        };
        const owner = {
            tabId: 'notes.md', active: true, serverId: account.serverId, accountId: account.accountId,
            mode: 'view', blame: false, availableModes: ['view'], blameAvailable: false,
            changesScopeAvailable: false, set: () => false, search: { scope: searchScope, symbols },
        } satisfies FileViewActionOwner;
        release = registerFileViewActionOwner('presented-file-test', () => owner);
        let runtime!: ReturnType<typeof useUniversalSearchRuntime>;
        function SearchOpener() { runtime = useUniversalSearchRuntime(); return null; }
        await act(async () => root.render(<InjectedAuthProvider credentials={null}><ModalProvider>
            <CommandPaletteProvider><SearchOpener /><button data-testid="outside-file">Outside the File page</button></CommandPaletteProvider>
        </ModalProvider></InjectedAuthProvider>));
        container.querySelector<HTMLButtonElement>('[data-testid="outside-file"]')!.focus();
        const command = ['macos', 'ios'].includes(resolveKeyboardPlatform());
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'p', code: 'KeyP', ctrlKey: !command, metaKey: command, bubbles: true, cancelable: true,
        })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')).not.toBeNull());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')?.textContent).toContain('repo'));
        const input = document.querySelector<HTMLInputElement>('[data-testid="universal-search-host"] input')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '@');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')?.textContent).toContain('Presented heading'));
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')).toBeNull());
        // An explicitly addressed caller must not inherit the presented file's
        // scope or symbols (terminal Jump has the same exclusion at ingress).
        await act(async () => runtime.open('@', {
            accountId: account.accountId, serverId: account.serverId,
            sessionId: null, machineId: null, rootPath: null,
        }, { source: 'files' }));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="universal-search-host"]')?.textContent)
            .toContain(t('universalSearch.quickOpen.symbolsNeedFile')));
    } finally {
        release?.();
        await act(async () => root.unmount());
        route.pathname = '/'; route.params = {};
        container.remove();
        try { await disconnect?.(); }
        finally { await homes.dispose(); restoreLocks(); storage.setState(initial, true); }
    }
});

it.each(['rail', 'railItem'] as const)('moves focus into the Search input when Alt+K is pressed with focus on the app rail (%s)', async focusOn => {
    const { View } = await import('react-native');
    const { usePaneRegionFocusBoundary } = await import('@/components/appShell/panes/paneRegion');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const before = storage.getState().settings;
    storage.setState({ settings: { ...settingsDefaults, commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } });
    // The rail's own focus region, as AppRail attaches it: a labelled navigation landmark that F6 focuses.
    function Rail() {
        const boundary = usePaneRegionFocusBoundary('rail', true);
        return <View ref={boundary.ref} onFocus={boundary.onFocus} testID="rail"
            {...{ role: 'navigation', tabIndex: -1, onFocusCapture: boundary.onFocusCapture }}>
            <button data-testid="rail-item">Sessions</button>
        </View>;
    }
    const palette = () => document.querySelector('[data-testid="universal-search-host"]');
    try {
        await act(async () => root.render(<InjectedAuthProvider credentials={null}>
            <ModalProvider><CommandPaletteProvider><Rail /></CommandPaletteProvider></ModalProvider>
        </InjectedAuthProvider>));
        const origin = container.querySelector<HTMLElement>(focusOn === 'rail' ? '[data-testid="rail"]' : '[data-testid="rail-item"]')!;
        origin.focus();
        expect(document.activeElement).toBe(origin);
        // A person's key press: it starts on the focused element and bubbles to the document.
        await act(async () => {
            origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', altKey: true, bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(palette()?.querySelector('input')).toBeTruthy());
        await act(async () => {});
        expect(document.activeElement).toBe(palette()!.querySelector('input'));
        await act(async () => {
            document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(palette()).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(origin));
    } finally {
        await act(async () => root.unmount());
        storage.setState({ settings: before });
        container.remove();
    }
});
