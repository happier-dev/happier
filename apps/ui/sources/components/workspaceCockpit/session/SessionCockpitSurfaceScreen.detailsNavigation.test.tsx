import { resolveSessionCockpitMobileCatalog } from './sessionCockpitMobileCatalog';
const mountedCatalog = resolveSessionCockpitMobileCatalog({ terminalTabAvailable: false });
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { resolveHref } from 'expo-router/build/link/href';
import { flushHookEffects, invokeTestInstanceHandler, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn(), back: vi.fn(), href: '/session/s1/details' }));
const routeListeners = new Set<() => void>();
let resetRouteParams = () => {};
function isRouteHref(value: unknown): value is Parameters<typeof resolveHref>[0] {
    return typeof value === 'string' || (typeof value === 'object' && value !== null
        && 'pathname' in value && typeof value.pathname === 'string');
}
const Focus = React.createContext(true);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionFilesViewBoundaries();
vi.doMock('expo-router', async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: () => new URL(React.useSyncExternalStore(listener => {
            routeListeners.add(listener);
            return () => routeListeners.delete(listener);
        }, () => route.href), 'https://happier.test').pathname,
        params: () => route.params,
        router: {
            replace: (href: unknown) => {
                if (!isRouteHref(href)) throw new Error('Expected an Expo string or structured href');
                route.href = resolveHref(href);
                if (typeof window !== 'undefined' && new URL(route.href, window.location.href).href !== window.location.href) {
                    window.history.replaceState(window.history.state, '', route.href);
                }
                route.params = { id: 's1', ...Object.fromEntries(new URL(route.href, 'https://happier.test').searchParams) };
                // Replacing an Expo route replaces its params; setParams overlays
                // from the departing route must not survive in this boundary.
                resetRouteParams();
                route.replace(href);
                for (const listener of routeListeners) listener();
            },
            canGoBack: () => true,
            back: () => { route.href = '/'; route.back(); },
        },
    });
    resetRouteParams = () => { mock.resetParams(); };
    return mock.module;
});
vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) } },
));
vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useIsFocused: () => React.useContext(Focus),
}));
// Only the external navigator is replaced. Session scenes, comparison renderer,
// pane reducer, registration, route producer and URL consumer remain real.
// The cockpit's navigator is the library's tab navigator plus its hosted Chat scene; this harness drives the
// library fake below for both.
vi.mock('./sessionCockpitTabs', async () => ({
    createSessionCockpitTabNavigator: (await import('@react-navigation/bottom-tabs')).createBottomTabNavigator,
}));

vi.mock('@react-navigation/bottom-tabs', () => ({ createBottomTabNavigator: () => ({
    Screen: () => null,
    Navigator: ({ children, initialRouteName, tabBar }: React.PropsWithChildren<{
        initialRouteName: string;
        tabBar: (props: { state: { index: number; routes: Array<{ key: string; name: string }> };
            navigation: { navigate: (name: string) => void; emit: () => { defaultPrevented: boolean } } }) => React.ReactNode;
    }>) => {
        const screens = React.Children.toArray(children).filter(React.isValidElement<{ name: string;
            children: (input: { navigation: { navigate: (name: string) => void; canGoBack: () => boolean; goBack: () => void } }) => React.ReactNode }>);
        const [selected, select] = React.useState(initialRouteName);
        const routes = screens.map(screen => ({ name: screen.props.name, key: screen.props.name }));
        const navigation = { navigate: select, canGoBack: () => false, goBack: () => {}, emit: () => ({ defaultPrevented: false }) };
        return <>{screens.filter(screen => screen.props.name === selected).map(screen =>
            <Focus.Provider key={screen.props.name} value={true}>{screen.props.children({ navigation })}</Focus.Provider>)}
            {tabBar({ state: { routes, index: routes.findIndex(item => item.name === selected) }, navigation })}</>;
    },
}) }));

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
// Compile the real Sync graph during collection, after transport installation;
// the hook deadline belongs to fixture preparation rather than cold compilation.
await loadSyncSingletonForTests();
const { paneUiState, workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
const originalPanes = paneUiState.readAll();
const originalLayouts = workspaceLayoutsState.readAll();
await import('@/components/sessions/panes/SessionDetailsPanel');
await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
await import('@/components/sessions/files/views/SessionFileDetailsView');
await import('./SessionCockpitShell');
beforeAll(async () => {
    await prepareSessionFilesViewTestkit();
});
afterEach(async () => {
    await standardCleanup();
    replacePersistentUiStateForTest(paneUiState, originalPanes);
    replacePersistentUiStateForTest(workspaceLayoutsState, originalLayouts);
    await fixture?.dispose();
    resetRouteParams();
});


/** Closes the phone comparison's one Details tab the way a person does: its header's ⋯, then Close tab. */
async function closeComparisonTabFromMenu(screen: Readonly<{ tree: import('react-test-renderer').ReactTestRenderer }>) {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const menu = screen.tree.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-phone-actions');
    const close = (menu.props.items as { id: string; testID?: string }[]).find((item) => item.testID === 'details-tab-menu-close')!;
    await act(async () => { (menu.props.onSelect as (id: string) => void)(close.id); });
}

it('keeps an unavailable phone workspace settled across parent renders', async () => {
    fixture = await createSessionFilesViewFixture();
    const { usePhoneWorkspaceTabs } = await import('@/components/appShell/workspace/usePhoneWorkspaceTabs');
    let renders = 0;
    const hook = await renderHook(() => { renders++; return usePhoneWorkspaceTabs(); });
    const initial = hook.getCurrent();
    expect(initial).toMatchObject({ available: false, tabs: [], activeTabId: null });
    const before = renders;
    await hook.rerender();
    expect(hook.getCurrent()).toBe(initial);
    // An unchanged, unavailable catalog has no title arrival to schedule another render.
    await flushHookEffects({ cycles: 20 });
    expect(renders).toBe(before + 1);
    await hook.unmount();
});

it('opens a phone Service through the cockpit into its Browser workspace', async () => {
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const features = createRootLayoutFeaturesResponse({ features: { browser: { enabled: true } } });
    const browserTarget = { kind: 'localServicePreview', targetId: 'phone-preview', machineId: 'm1', sessionId: 's1' } as const;
    const resource = { previewId: 'phone-preview', machineId: 'm1', sessionId: 's1', owner: { kind: 'session', id: 's1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
        display: { title: 'Phone service', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget } as const;
    const preview = { previewId: resource.previewId, resource, accessUrl: 'https://phone-preview.test/', expiresAt: Date.now() + 60_000, diagnostics: [] };
    const previewSnapshot = { v: 1, machineId: 'm1', generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] };
    const launcherSnapshot = { v: 1, machineId: 'm1', sessionId: 's1', updatedAt: 1_000, targets: [{
        id: 'inventory:phone-service', source: 'inventory_entry', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'phone-service' },
        machineId: 'm1', sessionId: 's1', title: 'Phone service', confidence: 'high', state: 'available', actions: [], browserTarget,
    }] };
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-browser-cockpit.test', rootPath: '/tmp/repo',
        rpc: request => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
            ? { protocolVersion: 1, snapshot: launcherSnapshot }
            : request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE
                ? { protocolVersion: 1, status: 'existing', preview, snapshot: previewSnapshot }
                : request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT
                    ? { protocolVersion: 1, snapshot: previewSnapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/features' ? Response.json(features)
            : new URL(String(url)).pathname === '/v2/account/settings' ? Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'browser.workspace.open': ['ui'] } },
            } } }) : Response.json({}, { status: 404 }),
    });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId: fixture.home.id, snapshot: { status: 'ready', features } });
    const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
    const { SessionCockpitSurfaceNavigationProvider } = await import('./SessionCockpitSurfaceNavigation');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const switchSurface = vi.fn();
    let browserPane!: ReturnType<typeof useAppPaneScope>;
    function Probe() { browserPane = useAppPaneScope('session:s1:browser'); return null; }
    const screen = await fixture.render(<SessionCockpitSurfaceNavigationProvider value={{ switchSurface, returnToPreviousSurface: () => {} }}>
        <Probe /><SessionCockpitSurfaceScreen catalog={mountedCatalog} sessionId="s1" scopeId="session:s1" surface="services" routeServerId={fixture.home.id} />
    </SessionCockpitSurfaceNavigationProvider>);
    await vi.waitFor(() => expect(screen.findHostByTestId('session-mobile-services-row:inventory:phone-service-open')).not.toBeNull());
    await screen.pressByTestIdAsync('session-mobile-services-row:inventory:phone-service-open');
    expect(browserPane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['browser-view']);
    expect(switchSurface).toHaveBeenCalledWith('browser');
});

it.each([true, false])('leaves phone Details through the real comparison Back with pane open=%s without deleting its retained tab', async (paneOpen) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    fixture = await createSessionFilesViewFixture({ serverUrl: `https://phone-pane-${paneOpen}.test`, rootPath: '/tmp/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: fixture.home.id };
    route.href = '/session/s1/details';
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Probe() { pane = useAppPaneScope('session:s1'); return null; }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <Probe /><SessionCockpitShell sessionId="s1" scopeId="session:s1" surface="tabs" routeServerId={fixture.home.id}
            terminalTabAvailable={false} /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        // Node supplies no native layout events. Deliver the real platform event
        // to each mounted host; the pane and comparison layout owners stay real.
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned' }));
    if (!paneOpen) await act(async () => pane.closeDetails());
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    // One Back on a phone Details tab: the Session header's. The tab closes from its header's ⋯.
    expect(screen.findHostByTestId('scm-comparison-phone-back')).toBeNull();
    route.replace.mockClear();
    await closeComparisonTabFromMenu(screen);
    await flushHookEffects({ cycles: 20 });
    const url = new URL(String(route.replace.mock.calls.at(-1)?.[0]), 'https://happier.test');
    expect(url.pathname).toBe('/session/s1');
    expect(url.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details).toBeUndefined();
    expect(pane.scopeState?.details.isOpen).toBe(false);
    expect(pane.scopeState?.details.tabs.map(item => item.key)).toEqual([tab.key]);
    await screen.unmount();
});

it.each(['git', 'viewer', 'track'] as const)('opens phone Details through workspace navigation and returns to the conversation from %s', async (entry) => {
    const watch = entry !== 'git';
    const fileText = 'export const alpha = 1;\n';
    const read = entry === 'track' ? await (await import('@/dev/testkit/harness/externalActionAccountHttpBoundary'))
        .createExternalActionAccountHttpBoundary({ serverUrl: 'https://phone-git.test', serverIdentityId: 'srv_phone_watch',
            accountId: 'alice', machineId: 'm1', tokenEpoch: 0, actionId: 'daemon.filesystem.readFile',
            execute: () => ({ success: true, content: Buffer.from(fileText).toString('base64') }) }) : null;
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo', entries: [{
        path: 'alpha.txt', kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }] });
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-git.test', rootPath: '/tmp/repo',
        ...(read ? { serverIdentityId: 'srv_phone_watch' } : {}), rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot }
            : request.method === 'scm.diff.file' ? { success: true, diff: '--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1 @@\n-before\n+after\n' }
                : { success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(fileText) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (read && parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read?.handle(parsed, init) ?? (parsed.pathname === '/v1/kv/bulk'
                ? Response.json({ values: [] }) : Response.json({}, { status: 404 }));
        },
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    if (entry === 'track') fixture.storage.getState().applySettingsLocal({ experiments: true,
        featureToggles: { 'scm.writeOperations': true, 'files.editor': true, 'files.reviewComments': false, 'files.diffSyntaxHighlighting': false } });
    fixture.storage.setState({ isDataReady: true, localSettings: {
        ...fixture.storage.getState().localSettings, filesTrackAgentEdits: false,
    } });
    replacePersistentUiStateForTest(workspaceLayoutsState, {});
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { readSessionPresentationAdapterAtAddress } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    route.params = { id: 's1', serverId: fixture.home.id, mobileSurface: watch ? 'chat' : 'git' };
    if (!watch) route.params.right = 'git';
    route.href = `/session/s1?${new URLSearchParams(route.params)}`;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let instanceKey = '';
    let observingReturn = false;
    const returnedRightPresentations: boolean[] = [];
    function Probe() {
        pane = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, instanceKey));
        if (observingReturn && selectedTab().target.kind === 'session') {
            returnedRightPresentations.push(pane.scopeState?.right.isOpen === true);
        }
        return null;
    }
    const selectedTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target);
            if (!href) throw new Error('The production workspace target must have a route');
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target}
                pathname={new URL(href, 'https://happier.test').pathname} focused visible phone
                navigation={navigation.navigationForTab(selected.id)}>
                <Probe /><WorkspaceDestinationBody target={selected.target} pathname={new URL(href, 'https://happier.test').pathname}
                    renderSession={() => <SessionDestinationBody />} renderSessionDetails={() => <SessionDetailsDestinationBody />} />
            </DestinationInstanceHost>;
        }}</WorkspaceProvider><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await flushHookEffects({ cycles: 20 });
    // An older same-Session File context must never win the later scene selection.
    const originalInstanceKey = instanceKey;
    await act(async () => {
        workspace.dispatch({ type: 'openTab', groupId: workspace.state.focusedGroupId,
            tab: { id: 'stale-file-context', preview: false, pinned: false,
                target: { kind: 'session', params: { id: 's1', serverId: fixture.home.id,
                    details: 'file', path: 'old-settings.ts' } } } });
        workspace.activateTab(workspace.state.focusedGroupId, originalInstanceKey);
    });
    if (entry === 'track') {
        const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
        const { readWorkspaceFileView } = await import('@/components/workspaces/files/details/workspaceFileDetails/workspaceFileView');
        const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
        const { FileEditorPanel } = await import('@/components/workspaces/files/file/editor/FileEditorPanel');
        const { Modal } = await import('@/modal');
        const originalScopeId = pane.scopeId;
        const fileTab = createWorkspaceFileDetailsTab('alpha.txt', undefined, undefined, { view: 'changes' });
        await act(async () => workspace.navigationForTab(instanceKey).replace(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([fileTab], fileTab.key),
        })}`));
        await measure();
        await vi.waitFor(() => expect(screen.findAllByType(FilePageHeader)[0]?.props.edit?.kind).toBe('edit'));
        await act(async () => { screen.findAllByType(FilePageHeader)[0]!.props.edit.onPress(); });
        await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
        expect(screen.findAllByType(FileEditorPanel)[0]?.props.value).toBe(fileText);
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState['file:alpha.txt']).mode).toBe('edit');
        expect(parseSessionPaneUrlState(buildActiveDetailsRouteParams(pane.scopeState!.details.tabs,
            pane.scopeState!.details.activeTabKey, pane.scopeState!.details.tabState))?.details).toMatchObject({ view: 'edit' });
        expect(pane.scopeId).toBe(originalScopeId);
        await screen.pressByTestIdAsync('session-cockpit-tab-chat');
        await measure();
        await act(async () => {
            fixture.storage.getState().applySessions([{ ...fixture.session, active: true, activeAt: Date.now(),
                thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress' }]);
            fixture.storage.getState().applyMessages('s1', [{ id: 'watch-edit', localId: null, createdAt: Date.now(),
                role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'watch-patch', name: 'Patch',
                    input: { changes: [{ path: '/tmp/repo/alpha.txt', kind: { type: 'update' },
                        diff: '@@ -1 +1 @@\n-before\n+after' }] }, description: null, uuid: 'watch-edit-uuid', parentUUID: null }] }]);
        });
        await vi.waitFor(async () => {
            await measure();
            expect(screen.findHostByTestId('session-phone-track-watch-capsule-action')).not.toBeNull();
        });
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState['file:alpha.txt']).mode).toBe('edit');
        expect(pane.scopeId).toBe(originalScopeId);
        vi.mocked(Modal.alertAsync).mockClear();
        await screen.pressByTestIdAsync('session-phone-track-watch-capsule-action');
        await flushHookEffects({ cycles: 20 });
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect.soft(readWorkspaceFileView(pane.scopeState?.details.tabState['file:alpha.txt']).mode).toBe('edit');
        expect.soft(pane.scopeId).toBe(originalScopeId);
        expect.soft(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
        expect.soft(screen.findAllByType(FileEditorPanel)[0]?.props.value).toBe(fileText);
        expect(pane.scopeState?.details.activeTabKey).toBe('file:alpha.txt');
        expect(screen.findHostByTestId('session-cockpit-scene:tabs')).not.toBeNull();
        expect.soft(Modal.alertAsync).not.toHaveBeenCalled();
        // A later write must still reach the Session's retained pane, not a resource destination
        // with no foreground Session driver. This is the same admitted Action used by Track.
        const { invokeWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { present: false, tabId: instanceKey, file: {
            target: { kind: 'session', sessionId: 's1', serverId: fixture.home.id }, path: 'alpha.txt',
        } } })).toEqual({ ok: true });
        await screen.unmount();
        return;
    }
    const sourceLifetime = watch ? screen.findAllByType(SessionViewerSourceAccountScopeProvider)
        .map(provider => provider.props.accountLifetime).find(lifetime => lifetime?.isCurrent()) : null;
    if (watch) {
        expect(sourceLifetime?.isCurrent()).toBe(true);
        // Phone Watch uses this real registered adapter; the header opener is desktop-only.
        await act(async () => expect(readSessionPresentationAdapterAtAddress({ serverId: fixture.home.id, sessionId: 's1' })
            ?.apply({ kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'applied' }));
        expect(screen.findHostByTestId('session-viewer-sticky')).not.toBeNull();
        const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
        // The external navigator delivers the source-bound Details destination.
        await act(async () => { workspace.navigationForTab(originalInstanceKey).replace(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([tab], tab.key),
        })}`); });
    } else {
        expect(screen.tree.findAllByType(SessionCockpitShell).map(node => node.props.surface)).toEqual(['git']);
        await vi.waitFor(async () => {
            await measure();
            expect(screen.findHostByTestId('session-rightpanel-git-walkthrough')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('session-rightpanel-git-walkthrough');
    }
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    const detailsUrl = new URL(route.href, 'https://happier.test');
    expect(instanceKey).toBe(originalInstanceKey);
    expect(detailsUrl.pathname).toBe('/session/s1/details');
    expect(detailsUrl.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(detailsUrl.searchParams))?.details).toMatchObject({
        kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'walkthrough',
    });
    expect(selectedTab().target).toMatchObject({ kind: 'sessionDetails', params: {
        details: 'scmReview', comparison: 'workingTree', view: 'walkthrough',
    } });
    expect(screen.findHostByTestId('scm-comparison-phone-back')).toBeNull();
    // A phone presents hosted Details as its Session cockpit's File scene, beside the cockpit's one Chat composer.
    expect(screen.findHostByTestId('session-cockpit-route-screen')).not.toBeNull();
    expect(screen.findHostByTestId('session-cockpit-scene:tabs')).not.toBeNull();
    if (watch) expect(sourceLifetime?.isCurrent()).toBe(true);
    observingReturn = true;
    await closeComparisonTabFromMenu(screen);
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    expect(selectedTab().target).toMatchObject({ kind: 'session', params: { mobileSurface: 'chat' } });
    expect(screen.findHostByTestId('agent-input-composer')).not.toBeNull();
    expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
    expect(screen.findHostByTestId('session-cockpit-scene:git')).toBeNull();
    expect(screen.findHostByTestId('session-viewer-sticky') !== null).toBe(watch);
    if (watch) expect(screen.findAllByType(SessionViewerSourceAccountScopeProvider)
        .some(provider => provider.props.accountLifetime === sourceLifetime)).toBe(true);
    expect(pane.scopeState?.right.isOpen).toBe(false);
    // The returned destination must never receive an open Git presentation:
    // web's pane URL writer can publish that first snapshot before Chat effects.
    expect(returnedRightPresentations.length).toBeGreaterThan(0);
    expect(returnedRightPresentations).not.toContain(true);
    // The Git opener retains a pane tab; direct Details selection is URL-owned.
    if (!watch) expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    if (entry === 'viewer') {
        const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
        await act(async () => { workspace.navigationForTab(originalInstanceKey).replace(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([tab], tab.key),
        })}`); });
        // The external navigator can re-admit the File scene after Details was
        // presented. It must select its source context, not an older File context.
        await act(async () => { workspace.navigationForTab(originalInstanceKey).replace(`/session/s1?${new URLSearchParams({
            serverId: fixture.home.id, mobileSurface: 'tabs',
        })}`); });
        expect(instanceKey).toBe(originalInstanceKey);
        expect(pane.scopeState?.details.activeTabKey).toBe(tab.key);
        expect(workspace.state.tabs['stale-file-context'].target.params.path).toBe('old-settings.ts');
    }
    await screen.unmount();
    if (watch) expect(sourceLifetime?.isCurrent()).toBe(false);
});

it.each((['classic', 'cockpit', 'hosted'] as const).flatMap(experience =>
    (['back', 'composer'] as const).map(trigger => ({ experience, trigger }))))('returns from the full $experience phone Details route through $trigger to its qualified Session when history leads Home', async ({ experience, trigger }) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    fixture = await createSessionFilesViewFixture({ serverUrl: `https://phone-${experience}.test`, rootPath: '/tmp/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: experience === 'classic' ? 'classic' : 'cockpit' });
    // Admit a hydrated, fresh workspace in the real store; preceding route
    // cases share this Home but must not lend this provider an old layout.
    fixture.storage.setState({ isDataReady: true });
    replacePersistentUiStateForTest(workspaceLayoutsState, {});
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { usePersistSessionLastMobileSurface } = await import('@/sync/domains/state/storage');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { useReviewComposerHandoff } = await import('@/components/sessions/reviews/comments/useReviewComposerHandoff');
    const { writeExistingSessionDraft, getSessionComposerDraftSnapshot, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), id: 's1', serverId: fixture.home.id };
    route.href = '/session/s1/details';
    let instanceKey: string | null = null;
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let persistSurface!: ReturnType<typeof usePersistSessionLastMobileSurface>;
    let handoff!: () => void;
    function Probe() {
        const scopeId = createSessionPaneScopeId('s1', fixture.home.id, instanceKey);
        pane = useAppPaneScope(scopeId);
        handoff = useReviewComposerHandoff(scopeId);
        persistSurface = usePersistSessionLastMobileSurface();
        return null;
    }
    const body = <><Probe /><SessionDetailsDestinationBody /></>;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const selectedWorkspaceTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    const detailsHref = `/session/s1/details?${new URLSearchParams(route.params)}`;
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        {experience === 'hosted' ? <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedWorkspaceTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target);
            if (!href) throw new Error('The production workspace target must have a route');
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target} pathname={new URL(href, 'https://happier.test').pathname}
                focused visible phone navigation={navigation.navigationForTab(selected.id)}>
                <Probe />{selected.target.kind === 'sessionDetails' ? <SessionDetailsDestinationBody /> : <SessionDestinationBody />}
            </DestinationInstanceHost>;
        }}</WorkspaceProvider> : body}<MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const originalInstanceKey = instanceKey;
    if (instanceKey) await act(async () => {
        pane.openDetailsTab(tab, { intent: 'pinned' });
        pane.openRight({ tabId: 'git' });
    });
    await flushHookEffects({ cycles: 20 });
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await flushHookEffects({ cycles: 20 });
    expect(screen.findHostByTestId('scm-comparison-phone-back')).toBeNull();
    expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    await act(async () => persistSurface('s1', 'tabs', fixture.home.id));
    route.replace.mockClear();
    route.back.mockClear();
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the restored Home Account');
    // A bare Ask supplies only routing; it must survive the real Session
    // composer mounting, just like a suggested question with authored text.
    const question = experience === 'hosted' ? '' : 'Why preserve this selection?';
    const recipient = { mode: 'scm_diff_summary', recipient: { kind: 'execution_run', runId: 'generator' },
        target: { cwd: '/tmp/repo', resultId: 'reading', expectedRevision: 2, stopIds: ['selection'] } };
    if (trigger === 'composer') {
        await act(async () => {
            writeExistingSessionDraft({ scope, sessionId: 's1', patch: { ...(question ? { text: question } : {}), routing: { recipient } } });
            handoff();
        });
    } else if (screen.findHostByTestId('session-details-close')) {
        // A full-screen route lends its ✕ to the comparison header; the cockpit closes from the header's ⋯.
        await screen.pressByTestIdAsync('session-details-close');
    } else await closeComparisonTabFromMenu(screen);
    await flushHookEffects({ cycles: 20 });
    const url = new URL(route.href, 'https://happier.test');
    expect(url.pathname).toBe('/session/s1');
    expect(url.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details).toBeUndefined();
    expect(url.searchParams.get('mobileSurface')).toBe('chat');
    if (trigger === 'composer') {
        const draft = getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 's1' });
        expect(draft?.composer.text.value).toBe(question);
        const target = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document.target;
        expect(target?.kind === 'session' ? target.routing.recipient.value : null).toEqual(recipient);
    }
    if (experience === 'hosted') {
        expect(selectedWorkspaceTab()).toMatchObject({ id: originalInstanceKey, target: { kind: 'session', params: { id: 's1', serverId: fixture.home.id } } });
        expect(screen.tree.findAllByType(SessionDetailsDestinationBody)).toHaveLength(0);
        expect(screen.tree.findAllByType(SessionDestinationBody)).toHaveLength(1);
        expect(screen.findHostByTestId('agent-input-composer')).not.toBeNull();
        if (trigger === 'composer') {
            const { AgentInput } = await import('@/components/sessions/agentInput/AgentInput');
            const chips = screen.tree.findByType(AgentInput).props.extraActionChips;
            expect(chips?.find((chip: import('@/components/sessions/agentInput/agentInputContracts').AgentInputExtraActionChip) => chip.controlId === 'recipient')
                ?.collapsedOptionsPopover?.label).toBe('To: Walkthrough');
        }
        expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
        expect(screen.findHostByTestId('session-cockpit-scene:git')).toBeNull();
        expect(pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => { expect(workspace.openHref(detailsHref, { tabId: originalInstanceKey! })).toBe(true); });
        await flushHookEffects({ cycles: 20 });
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedWorkspaceTab()).toMatchObject({ id: originalInstanceKey, target: { kind: 'sessionDetails' } });
        expect(screen.findHostByTestId('scm-comparison-phone-more')).not.toBeNull();
        expect(screen.findHostByTestId('session-cockpit-scene:tabs')).not.toBeNull();
    }
    // Hosted Details uses its destination selection; its retained pane remains
    // available when the workspace switches back to the Session destination.
    expect(pane.scopeState?.details.isOpen).toBe(false);
    expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    await screen.unmount();
});

it('presents a Computer window tab on the phone Details surface through the Session viewer source authority', async () => {
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-computer-tab.test', rootPath: '/tmp/repo', rpc: () => undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    const { createComputerScreenDetailsTab } = await import('@/components/computer/computerScreenDetailsTab');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createRetainedPresentationSlotsStore, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const tab = createComputerScreenDetailsTab({ machineId: 'machine-1', title: 'Computer' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: fixture.home.id };
    route.href = '/session/s1/details';
    const slots = createRetainedPresentationSlotsStore();
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Probe() { pane = useAppPaneScope('session:s1'); return null; }
    const screen = await fixture.render(<RetainedPresentationSlotsProvider store={slots}><MainAppTabStateProvider>
        <SessionCockpitChromeRegistryProvider><Probe />
            <SessionCockpitShell sessionId="s1" scopeId="session:s1" surface="tabs" routeServerId={fixture.home.id}
                terminalTabAvailable={false} /><MobileBottomChromeHost />
        </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></RetainedPresentationSlotsProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned' }));
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    // The tab's body is the retained Computer source: without the Session's account authority the
    // surface binds nothing and the phone shows a blank page.
    expect(slots.getPortalSnapshot().some(entry => entry.slotId.endsWith(':viewer:computer') && entry.visible)).toBe(true);
    await screen.unmount();
});

it('selects Chat from a retained Computer Details destination without replacing its workspace identity', async () => {
    const { Platform } = await import('react-native');
    const platform = Platform.OS;
    Object.assign(Platform, { OS: 'web' });
    onTestFinished(() => { Object.assign(Platform, { OS: platform }); });
    fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: () => undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    fixture.storage.setState({ isDataReady: true });
    replacePersistentUiStateForTest(workspaceLayoutsState, {});
    const { createComputerScreenDetailsTab } = await import('@/components/computer/computerScreenDetailsTab');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    route.params = { id: 's1', serverId: fixture.home.id, mobileSurface: 'chat' };
    route.href = `/session/s1?${new URLSearchParams(route.params)}`;
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    const browser = await installBrowserRuntimeForTests({ url: `https://route.test${route.href}` });
    onTestFinished(() => browser.restore());
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let instanceKey = '';
    const selectedTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    function Probe() {
        pane = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, instanceKey));
        return null;
    }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target)!;
            const pathname = new URL(href, 'https://route.test').pathname;
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target} pathname={pathname} focused visible phone
                navigation={navigation.navigationForTab(selected.id)}>
                <Probe /><WorkspaceDestinationBody target={selected.target} pathname={pathname}
                    renderSession={() => <SessionDestinationBody />} renderSessionDetails={() => <SessionDetailsDestinationBody />} />
            </DestinationInstanceHost>;
        }}</WorkspaceProvider><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    try {
        await measure();
        await flushHookEffects({ cycles: 20 });
        const originalId = selectedTab().id;
        const tab = createComputerScreenDetailsTab({ machineId: 'machine-1', title: 'Computer' });
        await act(async () => {
            pane.openDetailsTab(tab, { intent: 'pinned' });
            const navigation = workspace.navigationForTab(originalId);
            if (!navigation.setParams) throw new Error('Expected workspace navigation to support route params');
            navigation.setParams(buildActiveDetailsRouteParams([tab], tab.key));
        });
        await act(async () => { workspace.openHref(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([tab], tab.key),
        })}`, { tabId: originalId }); });
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedTab()).toMatchObject({ id: originalId, target: { kind: 'sessionDetails' } });
        await screen.pressByTestIdAsync('session-cockpit-tab-chat');
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedTab()).toMatchObject({ id: originalId, target: { kind: 'session', params: { mobileSurface: 'chat' } } });
        expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
        expect(screen.findHostByTestId('session-details-screen')).toBeNull();
    } finally { await screen.unmount(); Object.assign(Platform, { OS: platform }); }
});

it.each(['tabs', 'git', 'git-review', 'empty', 'file-tree', 'file-recent'] as const)('keeps the Session tab route when opening phone Details through %s', async (entry) => {
    // Owner ruling 2026-10-31: the cockpit's Tabs button opens or focuses the chosen Details page as its own rail tab;
    // the Session tab keeps its identity and route, so at wide it still shows its cockpit. A phone web workspace.
    const { Platform } = await import('react-native');
    const platform = Platform.OS;
    Object.assign(Platform, { OS: 'web' });
    onTestFinished(() => { Object.assign(Platform, { OS: platform }); });
    const fileText = 'phone destination file body\n';
    const read = entry === 'file-tree' || entry === 'file-recent'
        ? await (await import('@/dev/testkit/harness/externalActionAccountHttpBoundary'))
            .createExternalActionAccountHttpBoundary({ serverUrl: 'https://phone-intents.test', serverIdentityId: 'srv_phone_intents',
                accountId: 'alice', machineId: 'm1', tokenEpoch: 0, actionId: 'daemon.filesystem.readFile',
                execute: () => ({ success: true, content: Buffer.from(fileText).toString('base64') }) }) : null;
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo', capabilities: { readDiffFile: true }, entries: [{
        path: 'alpha.txt', kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }] });
    const { ScmComparisonSchema } = await import('@happier-dev/protocol/scm/comparison');
    const { ScmComparisonCaptureInputSchema } = await import('@happier-dev/protocol/scm/diffSummary');
    const diff = '--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1 @@\n-before\n+after\n';
    const captured = ScmComparisonSchema.parse({ id: 'e'.repeat(64), source: { kind: 'session', sessionId: 's1' },
        repository: { rootPath: '/tmp/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
            path: 'alpha.txt', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            occurrences: [{ id: 'phone-hunk', alias: 'phone-hunk', path: 'alpha.txt', position: 0, layer: 'combined',
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            evidence: { state: 'available', unifiedDiff: diff },
        }] } });
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-intents.test', rootPath: '/tmp/repo',
        // Every case uses the same advertised Home identity, including those without a file read.
        serverIdentityId: 'srv_phone_intents', rpc: request => {
            if (request.method === 'scm.diffSummary.capture') {
                const source = ScmComparisonCaptureInputSchema.parse(request.payload).source;
                const comparison = { ...captured, source, id: (source.kind === 'session' ? 'e' : 'd').repeat(64) };
                return { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
            }
            return request.method === 'scm.status.snapshot' ? { success: true, snapshot }
                : request.method === 'scm.diff.file' ? { success: true, diff }
                    : { success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(fileText) };
        },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (read && parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read?.handle(parsed, init) ?? (parsed.pathname === '/v1/kv/bulk'
                ? Response.json({ values: [] }) : Response.json({}, { status: 404 }));
        },
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    fixture.storage.setState({ isDataReady: true });
    replacePersistentUiStateForTest(workspaceLayoutsState, {});
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { useWorkspaceFileOpener } = await import('@/components/workspaces/files/useWorkspaceFileOpener');
    if (entry === 'file-recent') {
        const { recentWorkspaceFilesState } = await import('@/sync/domains/state/filePaneUiState');
        const { recentWorkspaceFilesKey } = await import('@/sync/domains/workspaces/files/recentWorkspaceFiles');
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const key = recentWorkspaceFilesKey({ serverId: fixture.scope.serverId, accountId: 'alice' }, buildWorkspaceCacheKey(fixture.scope));
        recentWorkspaceFilesState.set(key, ['recent.txt']);
        onTestFinished(() => recentWorkspaceFilesState.remove(key));
    }
    const gitEntry = entry === 'git' || entry === 'git-review';
    route.params = { id: 's1', serverId: fixture.home.id, mobileSurface: gitEntry ? 'git' : 'chat' };
    if (gitEntry) route.params.right = 'git';
    route.href = `/session/s1?${new URLSearchParams(route.params)}`;
    route.replace.mockClear();
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    const browser = await installBrowserRuntimeForTests({ url: `https://happier.test${route.href}` });
    onTestFinished(() => browser.restore());
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let workspace!: WorkspaceNavigationContextValue;
    let pane: ReturnType<typeof useAppPaneScope> | null = null;
    let sessionTabId = '';
    let openFile!: ReturnType<typeof useWorkspaceFileOpener>['open'];
    let focusedPane: ReturnType<typeof useAppPaneScope> | null = null;
    const selectedTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    function Probe(props: Readonly<{ tabId: string }>) {
        openFile = useWorkspaceFileOpener().open;
        const scope = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, props.tabId));
        focusedPane = scope;
        if (props.tabId === sessionTabId) pane = scope;
        return null;
    }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <WorkspaceProvider enabled={false} phone catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedTab();
            if (!sessionTabId) sessionTabId = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target)!;
            const pathname = new URL(href, 'https://happier.test').pathname;
            return <DestinationInstanceHost key={selected.id} tabId={selected.id} ref={selected.target} pathname={pathname} focused visible phone
                navigation={navigation.navigationForTab(selected.id)}>
                <Probe tabId={selected.id} /><WorkspaceDestinationBody target={selected.target} pathname={pathname}
                    renderSession={() => <SessionDestinationBody />} renderSessionDetails={() => <SessionDetailsDestinationBody />} />
            </DestinationInstanceHost>;
        }}</WorkspaceProvider><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    const settle = async () => { await measure(); await flushHookEffects({ cycles: 20 }); };
    const bodyEvidence = () => JSON.stringify({ target: selectedTab().target, details: focusedPane?.scopeState?.details,
        visible: screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && /file|review|details|empty|loading|skeleton/.test(node.props.testID)).map(node => node.props.testID),
    });
    // The Tabs button ("Open files") sits in the cockpit bar's More by default; both call the bar's surface press.
    const pressTabs = async () => {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const more = screen.tree.find(node => node.type === DropdownMenu
            && (node.props.items as { id: string }[]).some(item => item.id === 'tabs'));
        await act(async () => { (more.props.onSelect as (id: string) => void)('tabs'); });
        await settle();
    };
    try {
        await settle();
        const originalTarget = workspace.state.tabs[sessionTabId].target;
        if (entry === 'file-tree' || entry === 'file-recent') {
            if (entry === 'file-recent') await pressTabs();
            const sessionTarget = workspace.state.tabs[sessionTabId].target;
            if (entry === 'file-recent') await screen.pressByTestIdAsync('pane-empty-editor-file-recent.txt');
            else await act(async () => {
                expect(await openFile({ kind: 'session', sessionId: 's1', serverId: fixture.home.id, path: 'alpha.txt' })).toBe(true);
            });
            const afterOpen = { target: selectedTab().target, href: window.location.href };
            await settle();
            await vi.waitFor(() => expect(selectedTab().target.kind, JSON.stringify({ afterOpen,
                selected: selectedTab().target, href: window.location.href,
                tabs: Object.values(workspace.state.tabs).map(tab => tab.target),
            })).toBe('sessionDetails'));
            expect(parseSessionPaneUrlState(selectedTab().target.params)?.details).toMatchObject({ kind: 'file', path: entry === 'file-recent' ? 'recent.txt' : 'alpha.txt' });
            expect(screen.findHostByTestId('session-details-panel-root')).not.toBeNull();
            if (entry === 'file-tree') {
                await vi.waitFor(() => expect(screen.findHostByTestId('file-review-bar'), bodyEvidence()).not.toBeNull());
                // The review bar owns the phone's bottom edge (eec87f780ab). The header owns
                // reading modes and folds them into its menu when its measured controls do not fit.
                await measure();
                if (!screen.findHostByTestId('file-details-view-mode:file')) {
                    await screen.pressByTestIdAsync('file-details-header.menu.trigger');
                }
                await vi.waitFor(async () => {
                    expect(screen.findHostByTestId('file-details-view-mode:file'), bodyEvidence()).not.toBeNull();
                    expect(screen.findHostByTestId('file-details-view-mode:diff'), bodyEvidence()).not.toBeNull();
                });
                await screen.pressByTestIdAsync('file-details-view-mode:file');
                await settle();
            }
            await vi.waitFor(() => expect(screen.findHostByTestId('file-details-scroll'), bodyEvidence()).not.toBeNull());
            expect(workspace.state.tabs[sessionTabId].target).toEqual(sessionTarget);
            return;
        }
        if (entry === 'git-review') {
            const sessionTarget = workspace.state.tabs[sessionTabId].target;
            await vi.waitFor(() => expect(screen.findHostByTestId('session-rightpanel-git-open-review')).not.toBeNull());
            await screen.pressByTestIdAsync('session-rightpanel-git-open-review');
            await settle();
            expect(selectedTab().target.kind).toBe('sessionDetails');
            expect(parseSessionPaneUrlState(selectedTab().target.params)?.details).toMatchObject({ kind: 'scmReview' });
            expect(screen.findHostByTestId('session-details-panel-root')).not.toBeNull();
            await vi.waitFor(async () => {
                await measure();
                expect(screen.findHostByTestId('scm-comparison-phone-scope'), bodyEvidence()).not.toBeNull();
            });
            expect(workspace.state.tabs[sessionTabId].target).toEqual(sessionTarget);
            return;
        }
        if (entry === 'empty') {
            expect(pane!.scopeState?.details.tabs ?? []).toEqual([]);
            const tabCount = Object.keys(workspace.state.tabs).length;
            await pressTabs();
            expect(selectedTab().id).toBe(sessionTabId);
            expect(workspace.state.tabs[sessionTabId].target).toEqual(originalTarget);
            expect(Object.keys(workspace.state.tabs)).toHaveLength(tabCount);
            expect(screen.findHostByTestId('session-cockpit-scene:tabs')).not.toBeNull();
            return;
        }
        const walkthrough = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending' }, view: 'walkthrough' });
        // The pane holds the walkthrough while the Session shows Chat (as after leaving its page for Chat).
        if (entry === 'tabs') {
            await act(async () => { pane!.openDetailsTab(walkthrough, { intent: 'pinned', present: false }); });
            await act(async () => { pane!.closeDetails(); });
        }
        await settle();
        if (entry === 'tabs') {
            await screen.pressByTestIdAsync('session-cockpit-tab-chat');
            await settle();
        }
        expect(pane!.scopeState?.details.tabs.map(tab => tab.key) ?? []).toEqual(entry === 'tabs' ? [walkthrough.key] : []);
        expect(screen.findHostByTestId(`session-cockpit-scene:${entry === 'git' ? 'git' : 'chat'}`)).not.toBeNull();
        const sessionTarget = workspace.state.tabs[sessionTabId].target;
        expect(sessionTarget).toMatchObject({ kind: 'session' });

        const openPage = async () => {
            if (entry === 'tabs') return pressTabs();
            await vi.waitFor(async () => {
                await measure();
                expect(screen.findHostByTestId('session-rightpanel-git-walkthrough')).not.toBeNull();
            });
            await screen.pressByTestIdAsync('session-rightpanel-git-walkthrough');
            await settle();
        };
        await openPage();
        const opened = selectedTab();
        expect(opened.id).not.toBe(sessionTabId);
        expect(opened.target.kind).toBe('sessionDetails');
        if (entry === 'git') expect(pane!.scopeState?.details.tabs ?? []).toEqual([]);
        expect(parseSessionPaneUrlState(opened.target.params)?.details).toMatchObject({
            kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'walkthrough',
        });
        // The Session tab is unchanged: the same identity and route, and its pane still holds the page.
        expect(workspace.state.tabs[sessionTabId].target).toEqual(sessionTarget);

        // Pressing Tabs again from the Session tab focuses the same rail tab.
        const tabCount = Object.keys(workspace.state.tabs).length;
        await act(async () => { workspace.activateTab(workspace.state.focusedGroupId, sessionTabId); });
        await settle();
        await openPage();
        expect(selectedTab().id).toBe(opened.id);
        expect(Object.keys(workspace.state.tabs)).toHaveLength(tabCount);
        expect(workspace.state.tabs[sessionTabId].target).toEqual(sessionTarget);

        // Closing the rail tab returns to the Session tab, still on its cockpit.
        await act(async () => { workspace.phone!.closeTab(opened.id); });
        await settle();
        await vi.waitFor(() => expect(selectedTab().id).toBe(sessionTabId));
        expect(workspace.state.tabs[opened.id]).toBeUndefined();
        expect(workspace.state.tabs[sessionTabId].target).toEqual(sessionTarget);
    } finally { await screen.unmount(); }
});


it.each([
    { safeAreaPadding: undefined, initiallyFocused: true },
    { safeAreaPadding: false, initiallyFocused: true },
    { safeAreaPadding: undefined, initiallyFocused: false },
    { safeAreaPadding: false, initiallyFocused: false },
])('acquires a fullscreen file only while its retained scene is focused: %o', async ({ safeAreaPadding, initiallyFocused }) => {
    fixture = await createSessionFilesViewFixture({ rootPath: '/work/artifacts', serverIdentityId: 'srv_fullscreen_file_activity',
        rpc: request => request.method === 'daemon.filesystem.readFile'
            ? { success: true, content: Buffer.from('fullscreen report').toString('base64') }
            : request.method === 'statFile' ? { success: true, exists: true, kind: 'file', sizeBytes: 17 }
                : { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' },
    });
    fixture.setSnapshot(null);
    fixture.storage.setState({ isDataReady: true });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    let pane!: ReturnType<typeof useAppPaneScope>;
    let focus!: React.Dispatch<React.SetStateAction<boolean>>;
    function Scene() {
        const [focused, setFocused] = React.useState(initiallyFocused);
        focus = setFocused;
        pane = useAppPaneScope('session:s1');
        return <Focus.Provider value={focused}><SessionCockpitSurfaceScreen catalog={mountedCatalog}
            sessionId="s1" scopeId="session:s1" surface="tabs" routeServerId={fixture.scope.serverId}
            safeAreaPadding={safeAreaPadding} /></Focus.Provider>;
    }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <Scene />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const tab = createSessionFileDetailsTab({ path: 'report.md', view: 'view' });
    if (!tab) throw new Error('Expected file tab');
    await act(async () => { pane.openDetailsTab(tab, { intent: 'pinned' });
        if (initiallyFocused) pane.closeDetails();
    });
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await flushHookEffects({ cycles: 20 });
    const reads = () => fixture.requests.filter(request => request.method === 'daemon.filesystem.readFile');
    if (!initiallyFocused) {
        expect(reads()).toEqual([]);
        await act(async () => focus(true));
        await measure();
    }
    await vi.waitFor(() => expect(reads().map(request => request.payload)).toContainEqual(
        expect.objectContaining({ path: '/work/artifacts/report.md' })));
    await screen.unmount();
});
