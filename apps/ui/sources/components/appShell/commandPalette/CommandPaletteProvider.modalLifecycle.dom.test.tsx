/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import type { FileViewActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';

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
installDisconnectedServerSocketBoundary();
// Load these after the native boundary has selected real React Native Web;
// the testkit barrel otherwise evaluates its render helpers before that choice.
const [{ serveActionHomes }, { applyProjectAccountRowsFixture, installBrowserStorageLockBoundary }] = await Promise.all([
    import('@/dev/testkit/harness/actionHomesHttpHarness'), import('@/dev/testkit'),
]);

// The complete palette, command dispatcher, modal manager/host, controller and
// presentation stay real; only the navigator, native UI and network leave this process.
const { ModalProvider } = await import('@/modal/ModalProvider');
const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
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

it('keeps the canonical file opener when Search renders in the global modal outside Workspace context', async () => {
    const restoreLocks = installBrowserStorageLockBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-search-portal.test',
        accountId: 'alice', currentAccount: true }], route: () => undefined });
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
        storage.setState({ isDataReady: true, settings: { ...storage.getState().settings, commandPaletteEnabled: true },
            localSettings: { ...storage.getState().localSettings, recentWorkspaceFilesV1:
                recordRecentWorkspaceFile({}, workspaceKey, 'from-search.ts') } });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'portal-project', ...workspace,
            label: null, createdAtMs: 1 }] });
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
        accountId: 'alice', currentAccount: true,
        settings: { commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } }], route: () => undefined });
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
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'presented-project', ...workspace,
            label: null, createdAtMs: 1 }] });
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
