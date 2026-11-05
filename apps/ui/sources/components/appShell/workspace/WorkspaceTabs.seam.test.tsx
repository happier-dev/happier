/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClosedTabsListOutputSchema } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { createSessionFixture, installBrowserStorageLockBoundary, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { workspaceFileDetailsTabKey } from '../panes/details/fileDetailsTab';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import type { DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { clearActiveUnsavedChangesGuard, registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

const route = vi.hoisted(() => ({ pathname: '/session/named/info', params: { id: 'named' } as Record<string, string>, platform: 'web' as 'web' | 'ios' }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Expo supplies a local module and local params for each retained native scene.
const NativeSceneContext = React.createContext<Readonly<{ contextKey: string; params: Record<string, string> }> | null>(null);
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const module = await createReactNativeWebMock();
    Object.defineProperty(module.Platform, 'OS', { configurable: true, get: () => route.platform });
    module.Platform.select = values => values[route.platform] ?? values.default;
    return module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({ pathname: () => route.pathname, params: () => route.params }).module;
    return { ...module, useLocalSearchParams: () => React.useContext(NativeSceneContext)?.params ?? module.useLocalSearchParams() };
});
vi.mock('expo-router/build/Route', () => ({ useRouteNode: () => React.useContext(NativeSceneContext) }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Locale loading is a platform boundary; this navigation seam does not test translation assets.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
// Portal placement and native measurement are platform boundaries; the tab menus remain real.
vi.mock('@/components/ui/popover', async importOriginal => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
// This journey does not render Markdown; importing the vendor's DOM stream SDK must stay cold.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in workspace tab seam'); },
}));

let restoreBrowserLocks: (() => void) | undefined;
let disposeHome: (() => Promise<void>) | undefined;
let disconnectHome: (() => Promise<unknown>) | undefined;
const loadWorkspaceProduction = () => Promise.all([
    import('./WorkspaceProvider'), import('./WorkspaceNavigationContext'), import('./DestinationInstanceHost'), import('./titleBar/WorkspaceTitleBar'),
    import('./titleBar/workspaceBarGeometry'), import('@/keyboard/KeyboardShortcutProvider'),
    import('../panes/AppPaneProvider'), import('@/app/(app)/session/[id]/info'),
    import('../destinations/compactAppDestinationCatalog'), import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'),
    import('../panes/AppPaneScopeHost'), import('@/components/sessions/panes/useRegisterSessionPaneDriver'),
    import('@/components/sessions/panes/SessionRightPanel'), import('../plugins/AppShellPluginUiProjection'),
    import('../rightSidebar/appScopeRightSidebarNavigation'), import('@/dev/testkit/fixtures/pluginDeclarativeModelFixture'),
    import('../../../../../../packages/plugins/inspector/src/manifest'), import('@happier-dev/protocol'),
    import('@happier-dev/protocol/plugins/ui'), import('@/sync/domains/plugins/ui/projection'),
    import('../panes/hooks/useAppPaneScope'), import('@/sync/domains/scope/activeServerAccountScope'),
    import('@/sync/domains/plugins/ui/projectionUnion'),
    import('@/components/sessions/shell/view/useSessionViewBootstrap'),
    import('@/components/sessions/panes/url/sessionPaneUrlState'),
    import('@/components/sessions/plugins/useSessionPluginRuntime'),
    import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1'),
    import('@/sync/domains/plugins/availability/projection'),
]);
// Load the real route graph during collection, outside the behavior/hook deadline.
const production = await (async () => {
    const warmLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const warmHomes = await serveActionHomes({ homes: [{ key: 'warm', serverUrl: 'https://workspace-import.test', accountId: 'alice', currentAccount: true }], route: () => undefined });
    let warmDisconnect: (() => Promise<unknown>) | undefined;
    try {
        warmDisconnect = await warmHomes.restoreActiveConnection();
        return await loadWorkspaceProduction();
    } finally {
        try { await warmDisconnect?.(); }
        finally { await warmHomes.dispose(); warmLocks(); }
    }
})();
afterEach(async () => {
    route.platform = 'web'; route.pathname = '/session/named/info'; route.params = { id: 'named' };
    standardCleanup();
    clearActiveUnsavedChangesGuard();
    try { await disconnectHome?.(); }
    finally { await disposeHome?.(); restoreBrowserLocks?.(); vi.restoreAllMocks(); }
});

describe('workspace tabs production composition', () => {
    it.each([false, true])('retains an external app sidebar in the Inspector binding family through Session Search A to B to A (peer establishing: %s)', async peerEstablishing => {
        const fixturePluginId = 'acme.sidebar-continuity';
        const serverIdentityId = 'srv_sidebar_fixture';
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-sidebar.test',
            accountId: 'alice', serverIdentityId, currentAccount: true }], route: () => undefined });
        disposeHome = homes.dispose;
        disconnectHome = await homes.restoreActiveConnection();
        const [{ WorkspaceProvider }, , { DestinationInstanceHost }, , , { KeyboardShortcutProvider }, { AppPaneProvider }, ,
            catalogModule, , { AppPaneScopeHost }, { useRegisterSessionPaneDriver },
            { SessionRightSidebarProvider, SessionRightPanel }, { AppShellPluginUiProjectionValueProvider },
            { useOpenAppRightSidebarTab }, { createPluginDeclarativeModelFixture }, inspector,
            { PluginProjectionV2Schema }, { normalizePluginUiDestinationBindingV1 },
            { normalizePluginUiProjection }, { useAppPaneScope }, { captureActiveServerAccountScopeLifetime },
            { unionPluginUiProjections, readPluginUiContributionOrigin }, { useSessionViewBootstrap },
            { parseSessionPaneUrlState }, { createSessionPaneSurfaceScope }, { PluginMachineExecutionOriginV1Schema },
            { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection }] = production;
        const { storage } = await import('@/sync/domains/state/storage');
        const initial = storage.getState();
        const scope = initial.profileScope!;
        const sessionA = 'reviewer-a';
        const sessionB = 'reviewer-b';
        const sessionC = 'reviewer-c';
        const sessionD = 'reviewer-d';
        storage.setState({ isDataReady: true });
        storage.getState().applyLocalSettings({ appPaneScopesV1: {}, sessionsRightPaneDefaultOpen: false,
            uiMultiPanePanelsEnabled: true }, { persist: false });
        storage.getState().applySessions([sessionA, sessionB, sessionC, sessionD].map(id => createSessionFixture({ id, serverId: scope.serverId })));
        const view = inspector.INSPECTOR_UI.views.find(candidate => candidate.id === inspector.INSPECTOR_APP_SURFACE_ID);
        if (!view || view.container !== 'rightSidebarTab' || view.target.kind !== 'app') throw new Error('Inspector must retain its canonical app sidebar binding');
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: fixturePluginId,
            destinationId: view.id, rendererId: inspector.INSPECTOR_RENDERER_ID, container: view.container, target: view.target });
        if (!binding) throw new Error('Inspector destination must be admitted by the public registry');
        const occurrenceId = 'inspector-sidebar-fixture#1';
        // This external, actionless package uses the actual Inspector's binding/scope family,
        // not its activation or renderer. Real Inspector content/navigation remains INT's live gate.
        const model = createPluginDeclarativeModelFixture({ pluginId: fixturePluginId,
            localId: inspector.INSPECTOR_RENDERER_ID, occurrenceId,
            document: { version: 1, root: { kind: 'text', text: 'Loaded app sidebar fixture' } } });
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId, materializationRef: {
            pluginId: fixturePluginId, machineId: 'machine-sidebar', materializationId: 'sidebar-fixture-installation' } });
        const normalizedMachineProjection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [fixturePluginId]: { id: fixturePluginId, displayName: 'External sidebar fixture',
                version: '1.0.0', enabled: true, occurrenceId, executionOrigin,
                source: { kind: 'archive', locator: 'sidebar-fixture.zip' },
                sourceCustody: { kind: 'managed', immutableGenerationId: 'sidebar-fixture-archive', installSource: 'archive' },
                immutableGenerationId: 'sidebar-fixture-archive', declaresContributionPoints: false } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                inspector: { id: 'inspector', pluginId: fixturePluginId, occurrenceId, executionOrigin,
                    contributionKind: 'surfacePlacement', descriptorId: view.id, binding, target: binding.target,
                    renderer: { kind: 'declarative', contributionId: inspector.INSPECTOR_RENDERER_ID, model },
                    display: { developerFallback: view.title.fallback },
                    availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [] },
            } } } }), 'web');
        // As in the Host's actionless installed-page fixture, this is an admitted normalized
        // package fact consistent with the empty Action/point maps, not a claimed wire derivation.
        const machineProjection = Object.freeze({ ...normalizedMachineProjection, installedPackagesById: Object.freeze({
            ...normalizedMachineProjection.installedPackagesById,
            [fixturePluginId]: Object.freeze({ ...normalizedMachineProjection.installedPackagesById[fixturePluginId]!,
                declaredExecution: Object.freeze({ daemonActions: false, contributionPoints: false }) }),
        }) }) satisfies typeof normalizedMachineProjection;
        expect(machineProjection.installedPackagesById[fixturePluginId]?.declaredExecution)
            .toEqual({ daemonActions: false, contributionPoints: false });
        const union = unionPluginUiProjections([
            { machineId: 'machine-sidebar', serverId: scope.serverId, serverIdentityId, projection: machineProjection,
                phase: 'current', interactionEnabled: true, selectableExecutionOrigins: [executionOrigin] },
            ...(peerEstablishing ? [{ machineId: 'machine-pending', serverId: scope.serverId, projection: null,
                phase: 'establishing' as const, interactionEnabled: false }] : []),
        ], new Map([[fixturePluginId, executionOrigin]]));
        const projection = union.pluginUiProjection;
        if (!projection) throw new Error('The current Inspector declaration must survive the real App union');
        expect(union.hasEstablishingMembers).toBe(peerEstablishing);
        expect(readPluginUiContributionOrigin(Object.values(projection.surfacePlacementsById)[0])?.phase).toBe('current');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        // A real loaded absence observation settles this external Machine requester without
        // inventing Account custody or a ready-Machine policy. The Host owns no-point synthesis.
        replacePluginAccountAvailabilityProjection({ scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const runtime = { pluginUiProjection: machineProjection, pluginBrowserProjection: null, accountLifetime,
            phase: 'current' as const, interactionEnabled: true, machineId: 'machine-sidebar', serverId: scope.serverId, platform: 'web' as const };
        const shell = { ...runtime, pluginUiProjection: projection, phase: union.phase,
            hasEstablishingMembers: union.hasEstablishingMembers,
            clientExecutableActivation: { status: 'ready' as const },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
        let navigation!: WorkspaceNavigationContextValue;
        let pane!: ReturnType<typeof useAppPaneScope>;
        let openInspector!: ReturnType<typeof useOpenAppRightSidebarTab>;
        let currentSession = '';
        function SessionPane({ sessionId }: Readonly<{ sessionId: string }>) {
            currentSession = sessionId;
            const scopeId = useRegisterSessionPaneDriver(sessionId, scope.serverId, undefined, runtime);
            const paneSurfaceScope = React.useMemo(() => createSessionPaneSurfaceScope(sessionId, runtime), [sessionId]);
            const current = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            pane = useSessionViewBootstrap({ sessionId, serverId: scope.serverId, paneScopeId: scopeId,
                paneUrlState: parseSessionPaneUrlState(current.target.params), multiPaneEnabled: true,
                sessionsRightPaneDefaultOpen: false, deviceType: 'tablet', sessionPath: null,
                sessionAccepted: true, surfaceFocused: true, surfaceVisible: true, routeAnchor: true,
                paneUrlSyncRouteActive: true }).pane;
            openInspector = useOpenAppRightSidebarTab();
            return <SessionRightSidebarProvider sessionId={sessionId} scopeId={scopeId}
                paneSurfaceScope={paneSurfaceScope}>
                <AppPaneScopeHost scopeId={scopeId} main={<React.Fragment />} />
            </SessionRightSidebarProvider>;
        }
        route.pathname = `/session/${sessionA}`;
        route.params = { id: sessionA, serverId: scope.serverId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${encodeURIComponent(scope.serverId)}`);
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false } });
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><AppPaneProvider>
            <AppShellPluginUiProjectionValueProvider value={shell}>
                <WorkspaceProvider enabled catalog={catalog}>{owner => {
                    navigation = owner;
                    const current = owner.state.tabs[owner.state.groups[owner.state.focusedGroupId].activeTabId];
                    return current.target.kind === 'session' ? <DestinationInstanceHost key={current.id}
                        tabId={current.id} ref={current.target} pathname={`/session/${current.target.params.id}`}
                        focused visible navigation={owner.navigationForTab(current.id)}>
                        <SessionPane sessionId={current.target.params.id} />
                    </DestinationInstanceHost> : null;
                }}</WorkspaceProvider>
            </AppShellPluginUiProjectionValueProvider>
        </AppPaneProvider></KeyboardShortcutProvider>);
        try {
            await vi.waitFor(() => expect(currentSession).toBe(sessionA));
            await act(async () => openInspector({ pluginId: fixturePluginId, localId: view.id }));
            await vi.waitFor(() => expect(screen.getTextContent(),
                `Initial physical Host refusal: ${String(screen.findByTestId('plugin-rn-ui-unavailable')?.props.diagnosticCode ?? 'none')}`)
                .toContain('Loaded app sidebar fixture'));
            expect(screen.findAllByType(SessionRightPanel)).toHaveLength(1);
            for (const sessionId of [sessionB, sessionA]) {
                await act(async () => { expect(navigation.openHref(`/session/${sessionId}?serverId=${encodeURIComponent(scope.serverId)}`)).toBe(true); });
                await vi.waitFor(() => expect(currentSession).toBe(sessionId));
                expect(pane.scopeState?.right.isOpen, `Session ${sessionId} must retain the app sidebar region`).toBe(true);
                expect(pane.scopeState?.right.selectedDestination).toMatchObject({ kind: 'plugin',
                    destination: { pluginId: fixturePluginId, localId: view.id } });
                await vi.waitFor(() => expect(screen.getTextContent()).toContain('Loaded app sidebar fixture'));
                expect(screen.findAllByType(SessionRightPanel)).toHaveLength(1);
            }
            // Retained destinations own their explicit state: a later incoming App panel
            // must not reopen a deliberately closed B or replace B's selected built-in.
            const retainCurrent = () => {
                const state = navigation.state;
                const retain = navigation.navigationForTab(state.groups[state.focusedGroupId].activeTabId).retainCurrent;
                if (!retain) throw new Error('The registered destination navigation must support retaining its current tab');
                retain();
            };
            await act(async () => retainCurrent());
            const { invokeWorkspaceAction } = await import('./workspaceActionRuntime');
            await act(async () => { expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: {
                href: `/session/${sessionB}?serverId=${encodeURIComponent(scope.serverId)}`, mode: 'preview',
            } })).toMatchObject({ ok: true }); });
            await vi.waitFor(() => expect(currentSession).toBe(sessionB));
            expect(pane.scopeState?.right.isOpen, 'Direct Action preview uses the same App panel continuity owner').toBe(true);
            await act(async () => { retainCurrent(); pane.selectRightDestination({ kind: 'builtin', id: 'info' }); pane.closeRight(); });
            for (const sessionId of [sessionA, sessionB]) {
                await act(async () => { navigation.openHref(`/session/${sessionId}?serverId=${encodeURIComponent(scope.serverId)}`); });
                await vi.waitFor(() => expect(currentSession).toBe(sessionId));
            }
            expect(pane.scopeState?.right.isOpen).toBe(false);
            expect(pane.scopeState?.right.selectedDestination).toEqual({ kind: 'builtin', id: 'info' });
            await act(async () => { navigation.openHref(`/session/${sessionA}?serverId=${encodeURIComponent(scope.serverId)}`); });
            await vi.waitFor(() => expect(currentSession).toBe(sessionA));
            expect(pane.scopeState?.right.isOpen).toBe(true);
            await act(async () => { navigation.openHref(`/session/${sessionC}?serverId=${encodeURIComponent(scope.serverId)}`, { mode: 'newTab' }); });
            await vi.waitFor(() => expect(currentSession).toBe(sessionC));
            expect(pane.scopeState?.right.isOpen, 'An explicit independent tab does not inherit another pane selection').toBe(false);
            expect(pane.scopeState?.right.selectedDestination).toBeNull();
            await act(async () => { navigation.openHref(`/session/${sessionA}?serverId=${encodeURIComponent(scope.serverId)}`); });
            await vi.waitFor(() => expect(currentSession).toBe(sessionA));
            // The persisted selection grammar can carry an instance key which its current
            // singleton binding refuses. Navigation must not rehabilitate it by dropping the key.
            await act(async () => pane.selectRightDestination({ kind: 'plugin',
                destination: { pluginId: fixturePluginId, localId: view.id }, instanceKey: 'legacy:sidebar-copy' }));
            expect(pane.scopeState?.right.selectedDestination).toMatchObject({ instanceKey: 'legacy:sidebar-copy' });
            expect(screen.getTextContent()).not.toContain('Loaded app sidebar fixture');
            await act(async () => { navigation.openHref(`/session/${sessionD}?serverId=${encodeURIComponent(scope.serverId)}`); });
            await vi.waitFor(() => expect(currentSession).toBe(sessionD));
            expect(pane.scopeState?.right.isOpen, 'Invalid source intent must not seed a new Session sidebar').toBe(false);
            expect(pane.scopeState?.right.selectedDestination).toBeNull();
        } finally { await screen.unmount(); clearPluginAccountAvailabilityProjection(); storage.setState(initial, true); }
    });

    it.each(['web', 'ios'] as const)('positions a Track file in the foreground Session pane without presenting on %s', async platform => {
        route.platform = platform;
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-track-file.test',
            accountId: 'alice', currentAccount: true }], route: () => undefined });
        disposeHome = homes.dispose; disconnectHome = await homes.restoreActiveConnection();
        const [{ storage }, { useWorkspaceFileOpener }, { useRegisterSessionPaneDriver }, { useAppPaneScope },
            { PanePresentationProvider }, { useAppPaneContext }, { router }, { normalizeActionsSettingsV1 },
            { useSessionViewBootstrap }, { parseSessionPaneUrlState }, { useSessionTrack }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/components/workspaces/files/useWorkspaceFileOpener'),
            import('@/components/sessions/panes/useRegisterSessionPaneDriver'), import('../panes/hooks/useAppPaneScope'),
            import('../panes/panePresentation'), import('../panes/AppPaneProvider'), import('expo-router'),
            import('@happier-dev/protocol/actions/actionSettings'),
            import('@/components/sessions/shell/view/useSessionViewBootstrap'), import('@/components/sessions/panes/url/sessionPaneUrlState'),
            import('@/components/sessions/files/track/SessionTrack'),
        ]);
        const initial = storage.getState();
        const scope = initial.profileScope!;
        storage.setState({ isDataReady: true });
        storage.getState().applySessions([createSessionFixture({ id: 'tracked', serverId: scope.serverId })]);
        route.pathname = '/session/tracked'; route.params = { id: 'tracked', serverId: scope.serverId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${encodeURIComponent(scope.serverId)}`);
        const [{ WorkspaceProvider }, , { DestinationInstanceHost }, , , , { AppPaneProvider }, , catalogModule] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false } });
        let opener!: ReturnType<typeof useWorkspaceFileOpener>;
        let pane!: ReturnType<typeof useAppPaneScope>;
        let paneContext!: ReturnType<typeof useAppPaneContext>;
        let navigation!: WorkspaceNavigationContextValue;
        let track!: ReturnType<typeof useSessionTrack>;
        const presentations: unknown[] = [];
        const placedFiles: string[] = [];
        const foregroundInput = document.createElement('input');
        function TrackEntry() {
            const scopeId = useRegisterSessionPaneDriver('tracked', scope.serverId);
            const currentTab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            pane = useSessionViewBootstrap({ sessionId: 'tracked', serverId: scope.serverId, paneScopeId: scopeId,
                paneUrlState: parseSessionPaneUrlState(currentTab.target.params), multiPaneEnabled: true,
                sessionsRightPaneDefaultOpen: false, deviceType: platform === 'web' ? 'desktop' : 'phone',
                sessionPath: '/repo', sessionAccepted: true, surfaceFocused: true, surfaceVisible: true,
                routeAnchor: true, paneUrlSyncRouteActive: true }).pane;
            paneContext = useAppPaneContext();
            track = useSessionTrack({ scopeId, sessionAddress: { serverId: scope.serverId, sessionId: 'tracked' },
                workspaceRoot: '/repo', active: true });
            opener = useWorkspaceFileOpener(); return null;
        }
        const screen = await renderScreen(<PanePresentationProvider value={intent => { presentations.push(intent); }}><AppPaneProvider>
            <WorkspaceProvider enabled={platform === 'web'} phone={platform === 'ios'} catalog={catalog}>{owner => {
                navigation = owner;
                const current = owner.state.tabs[owner.state.groups[owner.state.focusedGroupId].activeTabId];
                return platform === 'web' ? <DestinationInstanceHost tabId={current.id} ref={current.target}
                    pathname={route.pathname} focused visible navigation={owner.navigationForTab(current.id)}><TrackEntry /></DestinationInstanceHost> : <TrackEntry />;
            }}</WorkspaceProvider></AppPaneProvider></PanePresentationProvider>);
        try {
            if (platform === 'web') document.body.appendChild(foregroundInput);
            const { invokeWorkspaceAction } = await import('./workspaceActionRuntime');
            await vi.waitFor(async () => { await act(async () => {});
                expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: true });
                expect(paneContext.getDriver(pane.scopeId)).toMatchObject({ scopeId: pane.scopeId }); });
            const otherInstanceScopeId = pane.scopeId;
            const otherInstanceOpen = opener.open;
            if (platform === 'web') {
                await act(async () => { navigation.dispatch({ type: 'openTab', groupId: navigation.state.focusedGroupId,
                    tab: { id: 'tracked-second-view', pinned: false, preview: false,
                        target: { kind: 'session', params: { id: 'tracked', serverId: scope.serverId } } } }); });
                await vi.waitFor(async () => { await act(async () => {});
                    expect(pane.scopeId).not.toBe(otherInstanceScopeId);
                    expect(paneContext.getDriver(pane.scopeId)).toMatchObject({ scopeId: pane.scopeId }); });
            }
            const before = navigation.state;
            const href = window.location.href;
            if (platform === 'web') foregroundInput.focus();
            const pushes = vi.mocked(router.push).mock.calls.length;
            const replacements = vi.mocked(router.replace).mock.calls.length;
            const anchor = { kind: 'fileLine' as const, startLine: 14 };
            let opened: boolean | null = false;
            await act(async () => { opened = await opener.open({ kind: 'session', sessionId: 'tracked', serverId: scope.serverId,
                path: 'main.ts' }, { intent: 'preview', present: false, anchor, anchorSource: 'file', onOpened: () => placedFiles.push('main.ts'), origin: {
                    transcript: { sessionAddress: { serverId: scope.serverId, sessionId: 'tracked' }, routeMessageId: 'local:track', filePath: 'main.ts' },
                } }); });
            expect(opened).toBe(true);
            expect(placedFiles).toEqual(['main.ts']);
            const tab = pane.scopeState?.details.tabs.find(candidate => candidate.key === 'file:main.ts');
            expect(tab).toMatchObject({ isPreview: true, resource: { kind: 'file', path: 'main.ts', anchor } });
            expect(pane.scopeState?.details.activeTabKey).toBe('file:main.ts');
            if (platform === 'web') expect(paneContext.state.scopes[otherInstanceScopeId]?.details.tabsByKey['file:main.ts']).toBeUndefined();
            expect(navigation.state.focusedGroupId).toBe(before.focusedGroupId);
            expect(navigation.state.groups[before.focusedGroupId].activeTabId).toBe(before.groups[before.focusedGroupId].activeTabId);
            expect(Object.keys(navigation.state.tabs)).toEqual(Object.keys(before.tabs));
            if (platform === 'web') {
                await vi.waitFor(async () => { await act(async () => {});
                    const current = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
                    expect(current.target.params).toMatchObject({ details: 'file', path: 'main.ts', startLine: '14' }); });
                expect(window.location.pathname).toBe(new URL(href).pathname);
            } else {
                expect(navigation.state).toBe(before);
                expect(window.location.href).toBe(href);
                expect(vi.mocked(router.replace).mock.calls).toHaveLength(replacements);
            }
            expect(vi.mocked(router.push).mock.calls).toHaveLength(pushes);
            expect(presentations).toEqual([]);
            if (platform === 'web') expect(document.activeElement).toBe(foregroundInput);
            expect(paneContext.overlayFocusReturnOwner.takeDetailsTabReturn(pane.scopeId, 'file:main.ts', platform === 'web' ? 'pane' : 'route')).toBeNull();
            const afterSilentOpen = navigation.state;
            if (platform === 'web') {
                await act(async () => { opened = await otherInstanceOpen({ kind: 'session', sessionId: 'tracked', serverId: scope.serverId,
                    path: 'stale-instance.ts' }, { intent: 'preview', present: false }); });
                expect(opened).toBe(false);
                expect(navigation.state).toBe(afterSilentOpen);
                expect(pane.scopeState?.details.activeTabKey).toBe('file:main.ts');
            }
            for (const target of [
                { kind: 'session' as const, sessionId: 'another-session', serverId: scope.serverId, path: 'wrong.ts' },
                { kind: 'session' as const, sessionId: 'tracked', serverId: 'another-home', path: 'wrong.ts' },
                { kind: 'project' as const, workspaceRefId: 'another-project', serverId: scope.serverId, path: 'wrong.ts' },
            ]) {
                await act(async () => { opened = await opener.open(target, { intent: 'preview', present: false }); });
                expect(opened).toBe(false);
                expect(pane.scopeState?.details.activeTabKey).toBe('file:main.ts');
                expect(navigation.state).toBe(afterSilentOpen);
            }
            const beforeTracking = navigation.state;
            const trackingPushes = vi.mocked(router.push).mock.calls.length;
            const trackingReplacements = vi.mocked(router.replace).mock.calls.length;
            const trackingHref = window.location.href;
            await act(async () => {
                storage.getState().applyLocalSettings({ filesTrackAgentEdits: true });
                storage.getState().applySessions([createSessionFixture({ id: 'tracked', serverId: scope.serverId,
                    active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
                    metadata: { path: '/repo', machineId: 'machine-1', host: 'test' } })]);
                storage.getState().applyMessages('tracked', [{
                    id: 'track-provider-call', localId: null, createdAt: Date.now(), role: 'agent', isSidechain: false,
                    content: [{ type: 'tool-call', id: 'track-write', name: 'Write',
                        input: { file_path: '/repo/tracked.ts', content: 'hello' },
                        description: null, uuid: 'track-call-uuid', parentUUID: null }],
                }]);
            });
            await vi.waitFor(async () => { await act(async () => {});
                expect(pane.scopeState?.details.activeTabKey).toBe(workspaceFileDetailsTabKey('tracked.ts', '/repo')); });
            expect(track).toMatchObject({ enabled: true, paused: false, target: { path: 'tracked.ts' } });
            expect(pane.scopeState?.details.tabs.find(candidate => candidate.key === workspaceFileDetailsTabKey('tracked.ts', '/repo'))).toMatchObject({ isPreview: true, isPinned: false });
            expect(navigation.state.focusedGroupId).toBe(beforeTracking.focusedGroupId);
            expect(navigation.state.groups[beforeTracking.focusedGroupId].activeTabId).toBe(beforeTracking.groups[beforeTracking.focusedGroupId].activeTabId);
            expect(Object.keys(navigation.state.tabs)).toEqual(Object.keys(beforeTracking.tabs));
            expect(vi.mocked(router.push).mock.calls).toHaveLength(trackingPushes);
            expect(presentations).toEqual([]);
            if (platform === 'web') expect(document.activeElement).toBe(foregroundInput);
            else {
                expect(vi.mocked(router.replace).mock.calls).toHaveLength(trackingReplacements);
                expect(window.location.href).toBe(trackingHref);
            }
            await act(async () => { storage.getState().applyMessages('tracked', [{
                id: 'track-provider-result', localId: null, createdAt: Date.now() + 1, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-result', tool_use_id: 'track-write', content: 'written', is_error: false,
                    uuid: 'track-result-uuid', parentUUID: null }],
            }]); });
            expect(track.target).toBeNull();
            const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'workspace.tabs.open': { disabledSurfaces: ['ui'] } } }) };
            homes.replaceAccountSettings('home', { settings, version: 2 });
            await act(async () => { storage.getState().applySettingsForScope(scope, settings, 2); });
            await act(async () => { opened = await opener.open({ kind: 'session', sessionId: 'tracked', serverId: scope.serverId,
                path: 'blocked.ts' }, { intent: 'preview', present: false, onOpened: () => placedFiles.push('blocked.ts') }); });
            expect(opened).toBe(false);
            expect(placedFiles).toEqual(['main.ts']);
            expect(pane.scopeState?.details.activeTabKey).toBe(workspaceFileDetailsTabKey('tracked.ts', '/repo'));
        } finally { await screen.unmount(); foregroundInput.remove(); storage.setState(initial, true); }
    });
    it.each(['web', 'ios'] as const)('opens a qualified Project file through useOpenProject and keeps Find private on %s', async platform => {
        route.platform = platform; route.pathname = '/search'; route.params = {};
        window.history.replaceState(null, '', '/search');
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-open-project-file.test',
            accountId: 'alice', currentAccount: true }], route: () => undefined });
        disposeHome = homes.dispose; disconnectHome = await homes.restoreActiveConnection();
        const [{ storage }, { useOpenProject }, { applyProjectAccountRowsFixture }, { useAppPaneContext }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/components/projects/useOpenProject'),
            import('@/dev/testkit/fixtures/projectAccountRows'), import('../panes/AppPaneProvider'),
        ]);
        const initial = storage.getState();
        const scope = initial.profileScope!;
        route.pathname = '/projects/shared-project/overview';
        route.params = { workspaceRefId: 'shared-project', serverId: scope.serverId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${encodeURIComponent(scope.serverId)}`);
        storage.setState({ isDataReady: true });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [
            { id: 'shared-project', serverId: scope.serverId, machineId: 'studio', rootPath: '/repo', label: null, createdAtMs: 1 },
            { id: 'shared-project', serverId: 'other-home', machineId: 'other-machine', rootPath: '/other', label: null, createdAtMs: 1 },
        ] });
        const [{ WorkspaceProvider }, , , , , , { AppPaneProvider }, , catalogModule] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false } });
        let openProject!: ReturnType<typeof useOpenProject>;
        let pane!: ReturnType<typeof useAppPaneContext>;
        let navigation!: WorkspaceNavigationContextValue;
        function ProjectFileEntry() { openProject = useOpenProject(); pane = useAppPaneContext(); return null; }
        const screen = await renderScreen(<AppPaneProvider><WorkspaceProvider enabled={platform === 'web'} phone={platform === 'ios'} catalog={catalog}>
            {owner => { navigation = owner; return <ProjectFileEntry />; }}
        </WorkspaceProvider></AppPaneProvider>);
        const anchor = { kind: 'range' as const, filePath: 'src/entry.ts', startLine: 4, endLine: 9 };
        const find = { query: 'private needle 🦦', options: { matchCase: true, regex: false },
            target: { kind: 'file' as const, path: anchor.filePath, anchor } };
        try {
            const { invokeWorkspaceAction } = await import('./workspaceActionRuntime');
            await vi.waitFor(async () => { await act(async () => {});
                expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: true });
                expect(pane.fileFindSeedAccountBindings.get(scope.serverId)?.isCurrent()).toBe(true); });
            let opened: boolean | null = false;
            await act(async () => { opened = await openProject('shared-project', { serverId: scope.serverId,
                activeRootPath: '/repo/feature', initialResource: { kind: 'file', path: anchor.filePath, anchor, anchorSource: 'diff', find } }); });
            expect(opened).toBe(true);
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            expect(tab.target).toMatchObject({ kind: 'project', params: { workspaceRefId: 'shared-project', serverId: scope.serverId,
                activeRootPath: '/repo/feature', initialFile: anchor.filePath, source: 'diff', anchor: 'range', startLine: '4', endLine: '9', fileOpenAs: 'pinned' } });
            expect(JSON.stringify(tab.target)).not.toContain(find.query);
            expect(pane.fileFindSeedHandoff.peekCurrent({ host: 'project', id: 'shared-project',
                scope: { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo/feature' }, path: anchor.filePath })).toEqual(find);
        } finally { await screen.unmount(); storage.setState(initial, true); }
    });
    it('does not claim a file open or capture its origin while accepting a pending Action approval', async () => {
        route.pathname = '/search'; route.params = {};
        window.history.replaceState(null, '', '/search');
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-file-approval.test', accountId: 'alice', currentAccount: true }], route: request => artifacts.handle(request.path, {
                method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            }) ?? undefined });
        disposeHome = homes.dispose; disconnectHome = await homes.restoreActiveConnection();
        const [{ storage }, { useWorkspaceFileOpener }, { useAppPaneContext }, { createSessionPaneScopeId }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/components/workspaces/files/useWorkspaceFileOpener'),
            import('../panes/AppPaneProvider'), import('@/components/sessions/panes/sessionPaneScopeId'),
        ]);
        const initial = storage.getState();
        const scope = initial.profileScope!;
        storage.setState({ isDataReady: true });
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: scope.serverId })]);
        route.pathname = '/session/s1'; route.params = { id: 's1', serverId: scope.serverId };
        window.history.replaceState(null, '', `/session/s1?serverId=${scope.serverId}`);
        const [{ WorkspaceProvider }, , , , , , { AppPaneProvider }, , catalogModule] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false,
        } });
        let fileOpener!: ReturnType<typeof useWorkspaceFileOpener>;
        let pane!: ReturnType<typeof useAppPaneContext>;
        let navigation!: WorkspaceNavigationContextValue;
        function FileLink() { fileOpener = useWorkspaceFileOpener(); pane = useAppPaneContext(); return null; }
        const screen = await renderScreen(<AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>
            {owner => { navigation = owner; return <FileLink />; }}
        </WorkspaceProvider></AppPaneProvider>);
        try {
            await vi.waitFor(async () => { await act(async () => {}); expect(fileOpener.canOpen).toBe(true); });
            const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                'workspace.tabs.open': { approvalRequiredSurfaces: ['ui'] },
            } }) };
            homes.replaceAccountSettings('home', { settings, version: 2 });
            await act(async () => { storage.getState().applySettingsForScope(scope, settings, 2); });
            let opened: boolean | null | undefined;
            await act(async () => { opened = await fileOpener.open({ kind: 'session', sessionId: 's1', serverId: scope.serverId, path: 'src/a.ts' }, {
                origin: { transcript: { sessionAddress: { serverId: scope.serverId, sessionId: 's1' }, routeMessageId: 'local:m1', filePath: 'src/a.ts' } },
            }); });
            expect(artifacts.list()).toHaveLength(1);
            expect(opened).toBe(true);
            const scopeId = createSessionPaneScopeId('s1', scope.serverId);
            expect(pane.overlayFocusReturnOwner.takeDetailsTabReturn(scopeId, 'file:src/a.ts', 'pane')).toBeNull();
            await vi.waitFor(async () => { await act(async () => {});
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'inbox', params: {
                    serverId: scope.serverId, workspacePathname: `/inbox/approvals/${artifacts.list()[0]!.id}`,
                } });
            });
        } finally { await screen.unmount(); storage.setState(initial, true); }
    });

    it.each(['web', 'ios'] as const)('opens a Project file from full Search through the workspace owner on %s', async platform => {
        route.platform = platform; route.pathname = '/search'; route.params = {};
        window.history.replaceState(null, '', '/search');
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-search-file.test', serverIdentityId: 'srv_workspace_search',
            accountId: 'alice', currentAccount: true }], route: () => undefined });
        disposeHome = homes.dispose; disconnectHome = await homes.restoreActiveConnection();
        const [{ storage }, { useOpenProject }, { activateUniversalSearchResult }, { applyProjectAccountRowsFixture },
            { useAppPaneContext }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/components/projects/useOpenProject'),
            import('@/components/appShell/search/activateUniversalSearchResult'), import('@/dev/testkit/fixtures/projectAccountRows'),
            import('../panes/AppPaneProvider'),
        ]);
        const initial = storage.getState();
        const scope = storage.getState().profileScope!;
        route.pathname = '/projects/riverside/overview';
        route.params = { workspaceRefId: 'riverside', serverId: scope.serverId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${encodeURIComponent(scope.serverId)}`);
        storage.setState({ isDataReady: true });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'riverside', serverId: scope.serverId,
            machineId: 'studio', rootPath: '/repo', label: null, createdAtMs: 1 }] });
        const session = createSessionFixture({ id: 'search-session', serverId: scope.serverId });
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata, host: session.metadata?.host ?? 'studio', path: '/repo', machineId: 'studio' } }]);
        const [{ WorkspaceProvider }, , , , , , { AppPaneProvider }, , catalogModule] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false } });
        let openProject!: ReturnType<typeof useOpenProject>;
        const { useWorkspaceFileOpener } = await import('@/components/workspaces/files/useWorkspaceFileOpener');
        let openFile!: ReturnType<typeof useWorkspaceFileOpener>['open'];
        let pane!: ReturnType<typeof useAppPaneContext>;
        let navigation!: WorkspaceNavigationContextValue;
        function SearchActivation() { openProject = useOpenProject(); openFile = useWorkspaceFileOpener().open; pane = useAppPaneContext(); return null; }
        const screen = await renderScreen(<AppPaneProvider><WorkspaceProvider enabled={platform === 'web'} phone={platform === 'ios'} catalog={catalog}>
            {owner => { navigation = owner; return <SearchActivation />; }}
        </WorkspaceProvider></AppPaneProvider>);
        const find = { query: '🦦', options: { matchCase: false, regex: false },
            target: { kind: 'file' as const, path: 'riverside.txt', anchor: { kind: 'fileLine' as const, startLine: 2 } } };
        try {
            // Capture the real typed refusal before the search adapter reduces it to unavailable.
            const { invokeWorkspaceAction } = await import('./workspaceActionRuntime');
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: true });
            await vi.waitFor(async () => { await act(async () => {});
                expect(pane.fileFindSeedAccountBindings.get(scope.serverId)?.isCurrent()).toBe(true); });
            let result: Awaited<ReturnType<typeof activateUniversalSearchResult>> | undefined;
            await act(async () => { result = await activateUniversalSearchResult({ kind: 'workspaceFile', path: 'riverside.txt',
                serverId: scope.serverId, accountId: scope.accountId, sessionId: null,
                workspaceRefId: 'riverside', scope: { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo' },
                anchor: { kind: 'fileLine', startLine: 2 }, find }, { openProject, openFile,
                navigateToSession: () => { throw new Error('A Project hit must not open a Session'); },
                push: () => { throw new Error('A Project hit must use its canonical owner'); } }); });
            expect(result).toEqual({ ok: true });
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            expect(tab.target).toMatchObject({ kind: 'project', params: { workspaceRefId: 'riverside', initialFile: 'riverside.txt',
                anchor: 'fileLine', startLine: '2' } });
            expect(JSON.stringify(tab.target)).not.toContain(find.query);
            expect(pane.fileFindSeedHandoff.peekCurrent({ host: 'project', id: 'riverside',
                scope: { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo' }, path: 'riverside.txt' })).toEqual(find);
            const sessionFind = { ...find, target: { ...find.target, path: 'session.txt' } };
            await act(async () => { result = await activateUniversalSearchResult({ kind: 'workspaceFile', path: 'session.txt',
                serverId: null, accountId: scope.accountId, sessionId: session.id, workspaceRefId: null,
                scope: { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo' }, anchor: find.target.anchor, find: sessionFind }, {
                openProject, openFile, navigateToSession: () => { throw new Error('A Session file must use the file Action'); },
                push: () => { throw new Error('A Session file must use its canonical owner'); },
            }); });
            expect(result).toEqual({ ok: true });
            const sessionTab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            expect(sessionTab.target).toMatchObject({ kind: 'session', params: { id: session.id, serverId: scope.serverId,
                details: 'file', path: 'session.txt', anchor: 'fileLine', startLine: '2' } });
            expect(JSON.stringify(sessionTab.target)).not.toContain(sessionFind.query);
            expect(pane.fileFindSeedHandoff.peekCurrent({ host: 'session', id: session.id,
                scope: { serverId: scope.serverId, machineId: 'studio', rootPath: '/repo' }, path: 'session.txt' })).toEqual(sessionFind);
        } finally { await screen.unmount(); storage.setState(initial, true); }
    });

    it.each(['phone close', 'unavailable phone tab', 'pane keyboard'] as const)('routes %s through disabled, required and waived Action policy while retaining dirty work', async entry => {
        const phone = entry !== 'pane keyboard';
        route.platform = phone ? 'ios' : 'web'; route.pathname = phone ? '/all-tabs' : '/settings'; route.params = {};
        window.history.replaceState(null, '', route.pathname);
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://workspace-close-${entry.replaceAll(' ', '-')}.test`, accountId: 'alice', currentAccount: true,
            settings: { keyboardShortcutsV2Enabled: true } }], route: request => artifacts.handle(request.path, {
                method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            }) ?? undefined });
        disposeHome = homes.dispose; disconnectHome = await homes.restoreActiveConnection();
        const [{ storage }, stateModule, persistenceModule, { PhoneOpenTabsRail }, { WorkspaceShell }, { normalizeActionsSettingsV1 }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('./workspaceState'), import('./workspacePersistence'),
            import('./PhoneOpenTabsRail'), import('./WorkspaceShell'), import('@happier-dev/protocol/actions/actionSettings'),
        ]);
        const initial = storage.getState();
        const { Modal } = await import('@/modal');
        const { router } = await import('expo-router');
        const scope = storage.getState().profileScope;
        if (!scope) throw new Error('The close journey requires the applied Account');
        if (entry === 'phone close') {
            route.pathname = '/session/pinned'; route.params = { serverId: scope.serverId };
        }
        const [{ WorkspaceProvider }, , , , , { KeyboardShortcutProvider }, { AppPaneProvider }, , catalogModule] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const target: DestinationRef = entry === 'phone close'
            ? { kind: 'session', params: { id: 'pinned', serverId: scope.serverId } }
            : { kind: 'removed-plugin', params: { id: 'pinned' } };
        let saved = stateModule.createWorkspaceState({ id: 'pinned-close', target, pinned: !phone, preview: false });
        saved = stateModule.reduceWorkspaceState(saved, { type: 'openTab', groupId: saved.focusedGroupId,
            tab: { id: 'other-close', target: { kind: 'removed-plugin', params: { id: 'other' } }, pinned: false, preview: false } });
        saved = stateModule.reduceWorkspaceState(saved, { type: 'activateTab', groupId: saved.focusedGroupId, tabId: 'pinned-close' });
        storage.setState({ isDataReady: true, localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: {
            [persistenceModule.workspaceLayoutScopeKey({ ...scope, windowId: 'main' })]: persistenceModule.serializeWorkspaceLayout(saved),
        } } });
        if (!phone) window.sessionStorage.setItem('happier.workspace.windowIdV1', 'main');
        let navigation!: WorkspaceNavigationContextValue;
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><AppPaneProvider>
            <WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{owner => {
                navigation = owner;
                return phone ? <PhoneOpenTabsRail /> : <WorkspaceShell catalog={catalog} />;
            }}</WorkspaceProvider>
        </AppPaneProvider></KeyboardShortcutProvider>);
        const trigger = async () => {
            if (entry === 'phone close') await act(async () => { navigation.phone?.activateTab('pinned-close'); });
            if (entry === 'unavailable phone tab') vi.mocked(Modal.alert).mockClear();
            await act(async () => {
                if (entry === 'pane keyboard') {
                    const key = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', altKey: true, bubbles: true, cancelable: true });
                    window.dispatchEvent(key);
                    expect(key.defaultPrevented).toBe(true);
                } else screen.pressByTestId(entry === 'phone close' ? 'phone-rail-tab-close-pinned-close' : 'phone-rail-tab-pinned-close');
            });
            if (entry === 'unavailable phone tab') {
                const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
                expect(buttons).toHaveLength(2);
                expect(navigation.state.tabs['pinned-close']).toBeDefined();
                await act(async () => { buttons?.find(button => button.onPress)?.onPress?.(); });
            }
        };
        const policy = async (choice: 'disabled' | 'require' | 'waive', version: number) => {
            const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'workspace.tabs.close': choice === 'disabled' ? { enabled: false } : choice === 'require' ? { approvalRequiredSurfaces: ['ui'] } : {} },
                ...(choice === 'waive' ? { approvalWaivedSurfaces: { 'workspace.tabs.close': ['ui'] } } : {}),
            }) };
            homes.replaceAccountSettings('home', { settings, version });
            await act(async () => { storage.getState().applySettingsForScope(scope, settings, version); });
        };
        let unregisterGuard: (() => void) | undefined;
        try {
            await policy('disabled', 2);
            vi.mocked(Modal.alertAsync).mockClear();
            vi.mocked(Modal.alert).mockClear();
            vi.mocked(router.push).mockClear();
            await trigger();
            expect(navigation.state.tabs['pinned-close']).toBeDefined();
            expect(navigation.state.tabs['other-close']).toBeDefined();
            // An explicitly disabled Action has its canonical Off notice, not a generic failure.
            // An unavailable tab first asks whether to close, then presents that same notice.
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledTimes(entry === 'unavailable phone tab' ? 2 : 1));
            const openActionSettings = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.onPress)?.onPress;
            expect(openActionSettings).toBeTypeOf('function');
            await act(async () => { openActionSettings?.(); });
            expect(router.push).toHaveBeenCalledWith('/settings/actions/workspace.tabs.close');
            expect(artifacts.list()).toHaveLength(0);
            await policy('require', 3);
            await trigger();
            await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
            expect(navigation.state.tabs['pinned-close']).toBeDefined();
            expect(navigation.state.tabs['other-close']).toBeDefined();
            await policy('waive', 4);
            vi.mocked(Modal.confirm).mockClear();
            const decision = vi.fn(async () => 'keepEditing' as const);
            unregisterGuard = registerMountedTabUnsavedChangesGuard('pinned-close', {
                isDirtyRef: { current: true }, requestDecision: decision, tag: 'workspace-close-journey',
            });
            await trigger();
            await vi.waitFor(() => expect(decision).toHaveBeenCalled());
            expect(navigation.state.tabs['pinned-close']).toBeDefined();
            expect(navigation.state.tabs['other-close']).toBeDefined();
            unregisterGuard();
            await trigger();
            await vi.waitFor(async () => { await act(async () => {}); expect(navigation.state.tabs['pinned-close']).toBeUndefined(); });
            expect(artifacts.list()).toHaveLength(1);
            expect(Modal.confirm).not.toHaveBeenCalled();
            if (phone) expect(navigation.state.tabs['other-close']).toBeDefined();
            else expect(navigation.state.tabs['other-close']).toBeUndefined();
        } finally { unregisterGuard?.(); await screen.unmount(); storage.setState(initial, true); }
    });
    it('names the real native Session info route in the phone rail and switcher and follows its rename', async () => {
        route.platform = 'ios';
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-phone-title.test', accountId: 'alice', currentAccount: true }], route: () => undefined });
        disposeHome = homes.dispose;
        disconnectHome = await homes.restoreActiveConnection();
        const { storage } = await import('@/sync/domains/state/storage');
        const initial = storage.getState();
        const homeId = homes.homes.home!.id;
        route.params = { id: 'named', serverId: homeId };
        const named = (title: string) => {
            const session = createSessionFixture({ id: 'named', serverId: homeId });
            return { ...session, metadata: { ...session.metadata!, summary: { text: title, updatedAt: 1 } } };
        };
        storage.setState({ isDataReady: true });
        storage.getState().applySessions([named('Native workspace identity')]);
        const other = createSessionFixture({ id: 'other', serverId: homeId });
        storage.getState().applySessions([{ ...other, metadata: { ...other.metadata!, summary: { text: 'Foreground stays other', updatedAt: 1 } } }]);
        const [{ WorkspaceProvider }, { AppPaneProvider }, { default: SessionInfoRoute }, catalogModule,
            stateModule, persistenceModule, { PhoneOpenTabsRail }, { useSessionSwitcher }, { InjectedAuthProvider }, { TokenStorage }] = await Promise.all([
            import('./WorkspaceProvider'), import('../panes/AppPaneProvider'), import('@/app/(app)/session/[id]/info'),
            import('../destinations/compactAppDestinationCatalog'), import('./workspaceState'), import('./workspacePersistence'),
            import('./PhoneOpenTabsRail'), import('@/components/navigation/mobile/chrome/lateralSwipe/useSessionSwitcher'),
            import('@/auth/context/AuthContext'), import('@/auth/storage/tokenStorage'),
        ]);
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const target = catalogModule.resolveDestinationRefFromHref(catalog, `${route.pathname}?serverId=${homeId}`);
        if (!target) throw new Error('Session info must be workspace-admitted');
        let saved = stateModule.createWorkspaceState({ id: 'native-info', target, pinned: false, preview: false });
        const otherTarget = catalogModule.resolveDestinationRefFromHref(catalog, `/session/other/info?serverId=${homeId}`);
        if (!otherTarget) throw new Error('The other native scene must be workspace-admitted');
        saved = stateModule.reduceWorkspaceState(saved, { type: 'openTab', groupId: saved.focusedGroupId,
            tab: { id: 'native-other', target: otherTarget, pinned: false, preview: false } });
        saved = stateModule.reduceWorkspaceState(saved, { type: 'activateTab', groupId: saved.focusedGroupId, tabId: 'native-info' });
        const scope = storage.getState().profileScope;
        if (!scope) throw new Error('Native title journey requires the restored Account scope');
        storage.setState({ localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: {
            [persistenceModule.workspaceLayoutScopeKey({ ...scope, windowId: 'main' })]: persistenceModule.serializeWorkspaceLayout(saved),
        } } });
        let navigation!: WorkspaceNavigationContextValue;
        function Switcher() {
            const switcher = useSessionSwitcher({ sessionId: null, serverId: homeId });
            return React.createElement('NativeTitleSwitcher', { switcher });
        }
        const namedScene = { contextKey: './(app)/session/[id]/info.tsx', params: { id: 'named', serverId: homeId } };
        const otherScene = { contextKey: namedScene.contextKey, params: { id: 'other', serverId: homeId } };
        const credentials = await TokenStorage.getCredentialsForServerUrl(homes.homes.home!.serverUrl);
        const element = () => <InjectedAuthProvider credentials={credentials}><AppPaneProvider><WorkspaceProvider enabled={false} phone catalog={catalog}>{owner => {
            navigation = owner;
            return <>
                <NativeSceneContext.Provider value={namedScene}><SessionInfoRoute /></NativeSceneContext.Provider>
                {route.pathname === '/session/other/info' ? <NativeSceneContext.Provider value={otherScene}><SessionInfoRoute /></NativeSceneContext.Provider> : null}
                <PhoneOpenTabsRail /><Switcher />
            </>;
        }}</WorkspaceProvider></AppPaneProvider></InjectedAuthProvider>;
        const screen = await renderScreen(element());
        const railTitles = () => screen.findByTestId('phone-open-tabs-rail')?.findAll((node: { type: unknown; props: Record<string, unknown> }) => typeof node.type === 'string' && typeof node.props.children === 'string').map(node => node.props.children);
        const switcherTitles = () => (screen.root.findByType('NativeTitleSwitcher').props.switcher as ReturnType<typeof useSessionSwitcher>).prepare().rows.up.map(row => row.title);
        try {
            expect(navigation.active).toBe(false);
            expect(navigation.phone?.onTab).toBe(true);
            expect(navigation.state.tabs['native-info']?.target).toMatchObject({ kind: 'sessions', params: { workspacePathname: '/session/named/info' } });
            expect(screen.findHostByTestId('session-info-screen')).not.toBeNull();
            expect(railTitles()).toContain('Native workspace identity');
            expect(switcherTitles()).toContain('Native workspace identity');
            await act(async () => { storage.getState().applySessions([named('Native identity renamed')]); });
            expect(railTitles()).toContain('Native identity renamed');
            expect(railTitles()).not.toContain('Native workspace identity');
            expect(switcherTitles()).toContain('Native identity renamed');
            expect(switcherTitles()).not.toContain('Native workspace identity');
            await act(async () => { navigation.phone?.activateTab('native-other'); });
            route.pathname = '/session/other/info'; route.params = otherScene.params;
            await screen.update(element());
            await act(async () => { storage.getState().applySessions([named('Inactive native identity renamed')]); });
            expect(railTitles()).toContain('Inactive native identity renamed');
            expect(railTitles()).toContain('Foreground stays other');
            expect(switcherTitles()).toContain('Inactive native identity renamed');
            expect(switcherTitles()).toContain('Foreground stays other');
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
        }
    });
    it('names a real Session route live and shares bulk-close Actions, menus and registered shortcuts', async () => {
        restoreBrowserLocks = installBrowserStorageLockBoundary();
        installDisconnectedServerSocketBoundary();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-seam.test', accountId: 'alice', currentAccount: true,
            settings: { keyboardShortcutsV2Enabled: true } }], route: () => undefined });
        disposeHome = homes.dispose;
        disconnectHome = await homes.restoreActiveConnection();
        const { storage } = await import('@/sync/domains/state/storage');
        const initial = storage.getState();
        const homeId = homes.homes.home!.id;
        route.params = { id: 'named', serverId: homeId };
        window.history.replaceState(null, '', `${route.pathname}?serverId=${homeId}`);
        const named = (title: string) => {
            const session = createSessionFixture({ id: 'named', serverId: homeId });
            return { ...session, metadata: { ...session.metadata!, summary: { text: title, updatedAt: 1 } } };
        };
        storage.setState({ isDataReady: true });
        storage.getState().applySessions([named('Fix workspace tabs')]);
        const [{ WorkspaceProvider }, , { DestinationInstanceHost }, { WorkspaceTitleBar }, geometryModule,
            { KeyboardShortcutProvider }, { AppPaneProvider }, { default: SessionInfoRoute }, catalogModule,
            { createFrontDoorActionExecute }] = production;
        const catalog = catalogModule.resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const geometry = geometryModule.createWorkspaceBarGeometry();
        geometry.setGroupFrame('group:1', { x: 220, width: 1000 });
        let navigation!: WorkspaceNavigationContextValue;
        const [{ InjectedAuthProvider }, { TokenStorage }] = await Promise.all([
            import('@/auth/context/AuthContext'), import('@/auth/storage/tokenStorage'),
        ]);
        const credentials = await TokenStorage.getCredentialsForServerUrl(homes.homes.home!.serverUrl);
        const element = () => <InjectedAuthProvider credentials={credentials}><KeyboardShortcutProvider handlers={{}}><AppPaneProvider>
            <WorkspaceProvider enabled catalog={catalog}>{owner => {
                navigation = owner;
                const detail = Object.values(owner.state.tabs).find(tab => tab.target.params.id === 'named' && tab.target.kind !== 'session');
                const detailActive = detail?.id === owner.state.groups[owner.state.focusedGroupId]?.activeTabId;
                return <geometryModule.WorkspaceBarGeometryContext.Provider value={geometry}>
                    <WorkspaceTitleBar catalog={catalog} clusterEndPx={200} stripHeightPx={40} />
                    {detail ? <DestinationInstanceHost tabId={detail.id} ref={detail.target} pathname={route.pathname}
                        focused={detailActive} visible={detailActive} navigation={owner.navigationForTab(detail.id)}><SessionInfoRoute /></DestinationInstanceHost> : null}
                </geometryModule.WorkspaceBarGeometryContext.Provider>;
            }}</WorkspaceProvider>
        </AppPaneProvider></KeyboardShortcutProvider></InjectedAuthProvider>;
        const renderOptions: RenderWithAppProvidersOptions = {
            createNodeMock: element => element.props.testID === 'workspace-title-bar'
                ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 1440, 800) } : null,
        };
        const screen = await renderScreen(element(), renderOptions);
        const execute = createFrontDoorActionExecute();
        const action = async (actionId: Parameters<typeof execute>[0], input: unknown) => {
            let result!: Awaited<ReturnType<typeof execute>>;
            await act(async () => { result = await execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: homeId, expectedAccountId: 'alice' }); });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.errorCode);
            return result.result;
        };
        const group = () => navigation.state.groups[navigation.state.focusedGroupId]!;
        const open = async (href: string) => {
            await action('workspace.tabs.open', { href, mode: 'newTab' });
            return group().activeTabId;
        };
        const settle = async (assertion: () => void) => {
            await vi.waitFor(async () => { await act(async () => {}); assertion(); });
        };
        const choose = async (tabId: string, command: string) => {
            const tab = screen.findAllByTestId(`workspace-tab-${tabId}`).find(node => typeof node.props.onLongPress === 'function');
            await act(async () => { invokeTestInstanceHandler(tab, 'onLongPress', {}); });
            await screen.pressByTestIdAsync(command);
        };
        try {
            expect(navigation.active).toBe(true);
            expect(screen.findHostByTestId('session-info-screen')).not.toBeNull();
            const sessionTab = group().activeTabId;
            const label = () => screen.findByTestId(`workspace-tab-${sessionTab}`)?.findAll((node: { type: unknown; props: Record<string, unknown> }) => typeof node.type === 'string' && typeof node.props.children === 'string')
                .map(node => node.props.children);
            expect(label()).toContain('Fix workspace tabs');
            await act(async () => { storage.getState().applySessions([named('Workspace tabs renamed')]); });
            expect(label()).toContain('Workspace tabs renamed');
            expect(label()).not.toContain('Fix workspace tabs');
            await action('workspace.tabs.pin', { tabId: sessionTab, pinned: true });
            const middle = await open(`/session/middle?serverId=${homeId}`);
            const right = await open(`/session/right?serverId=${homeId}`);
            await action('workspace.tabs.close_right', { tabId: middle });
            expect(navigation.state.tabs[right]).toBeUndefined();
            expect(navigation.state.tabs[middle]).toBeDefined();
            const menuRight = await open(`/session/menu-right?serverId=${homeId}`);
            await choose(middle, 'workspace-tab-menu-close-right');
            await settle(() => { expect(navigation.state.tabs[menuRight]).toBeUndefined(); });
            await action('workspace.tabs.close_all', {});
            expect(group().tabIds).toEqual([sessionTab]);
            await open(`/session/menu-all?serverId=${homeId}`);
            await screen.pressByTestIdAsync('workspace-overflow-group_1');
            await settle(() => { expect(screen.findByTestId('workspace-overflow-close-all')).not.toBeNull(); });
            await screen.pressByTestIdAsync('workspace-overflow-close-all');
            await settle(() => { expect(group().tabIds).toEqual([sessionTab]); });
            await open(`/session/keyboard-all?serverId=${homeId}`);
            expect(storage.getState().settings.keyboardShortcutsV2Enabled).toBe(true);
            const closeAllKey = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
            await act(async () => {
                window.dispatchEvent(closeAllKey);
            });
            expect(closeAllKey.defaultPrevented).toBe(true);
            await settle(() => { expect(group().tabIds).toEqual([sessionTab]); });
            await action('workspace.tabs.close', { tabId: sessionTab });
            expect(navigation.state.tabs[sessionTab]).toBeUndefined();
            const closed = WorkspaceClosedTabsListOutputSchema.parse(await action('workspace.tabs.closed.list', {}));
            expect(closed.tabs.find(tab => tab.id === sessionTab)?.title).toBe('Workspace tabs renamed');
            await action('workspace.tabs.reopen', { tabId: sessionTab });
            await action('workspace.tabs.pin', { tabId: sessionTab, pinned: false });
            expect(label()).toContain('Workspace tabs renamed');
            // The same front door loses workspace Actions when the production mount retires.
            await screen.unmount();
            expect(await execute('workspace.tabs.close_all', {}, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: homeId, expectedAccountId: 'alice' }))
                .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
        }
    });
});
