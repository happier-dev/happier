import type { AppPaneContextValue } from '../panes/AppPaneContext';
import { setActiveUnsavedChangesGuard, clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { AppPaneProvider, useAppPaneContext } from '../panes/AppPaneProvider';
import { invokeWorkspaceAction } from './workspaceActionRuntime';
import { createPluginUiResourceProjection } from '@/dev/testkit/fixtures/pluginUiResourceProjection';
import { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { requestOpenResource } from '@/utils/url/openResource';
/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WorkspaceProvider } from './WorkspaceProvider';
import { AppRailSurface } from '@/components/navigation/shell/appRail/AppRail';
import { buildAppRailEntries } from '@/components/navigation/shell/appRail/appRailModel';
import { hrefForDestinationRef, resolveCompactAppDestinations, useActivateAppDestination } from '../destinations/compactAppDestinationCatalog';
import { openInWorkspace } from './useWorkspaceOpenActions';
import { SidebarMachinesPopoverContent } from '@/components/navigation/shell/sidebarFooter/SidebarMachinesPopoverContent';
import { WorkflowsColumn } from '@/components/workflows/column/WorkflowsColumn';
import { SettingsSessionsBehaviorSection } from '@/components/settings/SettingsSessionsBehaviorSection';
import { useRouter } from './destinationRoute';

// Only transport and platform boundaries are replaced; the rail, list rows,
// destination routers, workspace provider and tab-open owner execute unchanged.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows', params: {}, router: { push: routerPush } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@legendapp/list/react-native', async importOriginal =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module);

const searchRuntime = { open: () => {}, buildCommands: () => [] };
function TestAuth({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={boundary?.credentials ?? null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
let baseline = storage.getState();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | undefined;
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
beforeEach(async () => {
    baseline = storage.getState();
    webLocks = installWebLockManagerMock();
    singleton = await loadSyncSingletonForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'http://workspace-open.test', scope: 'tab' });
    const waiting = createWorkflowRunSummaryFixture({ id: 'run-waiting', state: 'running', ownerAccountId: 'account-a', startedBy: 'user', attentionRequired: true, invocationAttentionRequired: true });
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'account-a', fixtureResponse: async actionId => {
        if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
        if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [waiting], metadataByRunId: { [waiting.id]: { kind: 'available', value: { title: 'Prepare the release' } } } } };
        return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
    } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    await sync.resumeSync('server-reachable');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ settingsScope: storage.getState().profileScope, settingsVersion: 1,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true }, sessionListLayoutV1: 'projects' },
        sessionListIndexByServerId: { [boundary.serverId]: null }, sessionListRowsByServerId: {},
        workflowRunListWindows: {}, workflowRunsById: {} });
    boundary.prime();
});
afterEach(async () => {
    standardCleanup();
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    await boundary?.dispose(); boundary = undefined;
    singleton?.dispose(); singleton = undefined;
    routerPush.mockReset(); storage.setState(baseline);
    webLocks?.restore(); webLocks = undefined;
});

describe('workspace open-in-place through real entries', () => {
    it('agent resource open uses the focused Session binding and releases it before app fallback', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const opened: string[] = [];
        const makeNavigation = (targetKind: 'session' | 'app') => {
            const catalog = createPluginUiResourceProjection(true, targetKind);
            // Daemon projection boundary: a resource launch carries its producer's materialization.
            const projection = { ...catalog, surfacePlacementsById: Object.fromEntries(
                Object.entries(catalog.surfacePlacementsById).map(([id, entry]) => [id, { ...entry,
                    executionOrigin: { serverIdentityId: 'srv_resource', materializationRef: {
                        pluginId: entry.pluginId, machineId: 'machine', materializationId: 'forge-occurrence',
                    } },
                }])) };
            const binding = createPluginSurfaceDestinationNavigationBinding({ targetKind, projection,
                placements: selectPluginDestinationSurfacePlacements(projection), accountLifetime: lifetime,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: 'machine', interactionEnabled: true } });
            binding.registerOwner({ container: targetKind === 'session' ? 'detailsTab' : 'appPage',
                handler: () => { opened.push(targetKind); return { ok: true }; } });
            return binding;
        };
        const appNavigation = makeNavigation('app');
        const sessionNavigation = makeNavigation('session');
        let pane: AppPaneContextValue | undefined;
        function FocusedSession() {
            const current = useAppPaneContext();
            pane = current;
            React.useEffect(() => current.registerDriver({ scopeId: 'focused-resource-session',
                get resourceNavigation() { return sessionNavigation; } }), [current.registerDriver]);
            React.useEffect(() => {
                current.dispatch({ type: 'activateScope', scopeId: 'focused-resource-session' });
                return () => current.dispatch({ type: 'releaseScope', scopeId: 'focused-resource-session' });
            }, [current.dispatch]);
            return null;
        }
        storage.setState({ settings: { ...storage.getState().settings, scmResourceOpenLocation: 'happier' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const screen = await renderScreen(<AppPaneProvider><PluginSurfaceDestinationNavigationBindingProvider binding={appNavigation}>
            <WorkspaceProvider enabled catalog={catalog}><FocusedSession /></WorkspaceProvider>
        </PluginSurfaceDestinationNavigationBindingProvider></AppPaneProvider>, { wrapper: TestAuth });
        const resource = { kind: 'pullRequest' as const, url: 'https://forge.example/acme/repo/pull/42' };
        expect(await requestOpenResource(resource, { navigation: sessionNavigation })).toBe(true);
        expect(opened).toEqual(['session']); opened.length = 0;
        const dirty = { current: true };
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: dirty, tag: 'file-editor', requestDecision });
        onTestFinished(() => clearActiveUnsavedChangesGuard());
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { resource } })).toEqual({ ok: true });
        expect(opened).toEqual(['session']); opened.length = 0;
        expect(requestDecision).not.toHaveBeenCalled();
        expect(dirty.current).toBe(true);
        clearActiveUnsavedChangesGuard();
        await act(async () => pane!.dispatch({ type: 'releaseScope', scopeId: 'focused-resource-session' }));
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { resource } })).toEqual({ ok: true });
        expect(opened).toEqual(['app']);
        await screen.unmount();
    });

    it('selects Workflows explicitly from the run settings control (FIN-COMPOSE F17)', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        function SettingsJourney({ navigation }: Readonly<{ navigation: import('./WorkspaceNavigationContext').WorkspaceNavigationContextValue }>) {
            const router = useRouter();
            return <>
                {React.createElement('NavigationJourney', { navigation })}
                <SettingsSessionsBehaviorSection automationsNeedLocalEnablement={false} showAutomations router={router} />
            </>;
        }
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <SettingsJourney navigation={navigation} />}</WorkspaceProvider>, { wrapper: TestAuth });
        const navigation = () => screen.root.findByType('NavigationJourney').props.navigation as import('./WorkspaceNavigationContext').WorkspaceNavigationContextValue;
        await act(async () => { navigation().openHref('/settings/session', { section: true }); });
        await screen.pressByTestIdAsync('settings-workflow-run-settings');
        const { resolveCurrentAppDestination } = await import('../destinations/compactAppDestinationCatalog');
        expect(resolveCurrentAppDestination(catalog, navigation().sectionPathname ?? '/')?.column).toBe('workflows');
        const state = navigation().state;
        expect(hrefForDestinationRef(catalog, state.tabs[state.groups[state.focusedGroupId].activeTabId].target)).toBe('/workflows/settings');
    });

    it('selects the Machines section through the rail popover before opening its details', async () => {
        const scope = storage.getState().profileScope!;
        const machines = ['builder', 'helper'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() }));
        storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('NavigationJourney', { navigation })}
            <SidebarMachinesPopoverContent close={() => {}} maxHeight={600} />
        </>}</WorkspaceProvider>, { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.findByTestId('sidebar-machines-all')).not.toBeNull());
        await screen.pressByTestIdAsync('sidebar-machines-all');
        const navigation = screen.root.findByType('NavigationJourney').props.navigation as import('./WorkspaceNavigationContext').WorkspaceNavigationContextValue;
        const { resolveCurrentAppDestination } = await import('../destinations/compactAppDestinationCatalog');
        expect(resolveCurrentAppDestination(catalog, navigation.sectionPathname ?? '/')?.column).toBe('machines');
        const group = navigation.state.groups[navigation.state.focusedGroupId];
        expect(navigation.state.tabs[group.activeTabId].target.kind).toBe('machines');
        expect(routerPush).not.toHaveBeenCalled();
    });

    it.each(['rail', 'row'] as const)('opens a real %s in place, focuses an existing destination, and reserves new tabs for explicit intent', async entry => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        type Navigation = import('@/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue;
        function Journey({ navigation }: Readonly<{ navigation: Navigation }>) {
            const activate = useActivateAppDestination();
            return <>
                {React.createElement('NavigationJourney', { navigation })}
                <AppRailSurface entries={buildAppRailEntries(catalog)} activeId="workflows" onOpen={activate}
                    renderFooter={item => <View testID={item.id} />} />
                {/* The shell's collection column lives outside a destination instance. */}
                <WorkflowsColumn />
            </>;
        }
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <Journey navigation={navigation} />}</WorkspaceProvider>, { wrapper: TestAuth });
        const navigation = (): Navigation => screen.root.findByType('NavigationJourney').props.navigation;
        const active = () => navigation().state.tabs[navigation().state.groups[navigation().state.focusedGroupId].activeTabId];
        const initial = active().id;
        await act(async () => navigation().dispatch({ type: 'promoteTab', tabId: initial }));
        const count = Object.keys(navigation().state.tabs).length;
        if (entry === 'rail') {
            await screen.pressByTestIdAsync('app-rail:sessions');
            expect(active().target.kind).toBe('sessions');
            expect(active().id).toBe(initial);
            expect(Object.keys(navigation().state.tabs)).toHaveLength(count);
            await screen.pressByTestIdAsync('app-rail:workflows');
        }
        await screen.pressByTestIdAsync('workflows-column:view:runs');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-row:run-waiting')).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-run-row:run-waiting');
        expect(active().target).toMatchObject({ kind: 'workflowRun', params: { runId: 'run-waiting' } });
        expect(active().id).toBe(initial);
        expect(Object.keys(navigation().state.tabs)).toHaveLength(count);
        // An explicit second instance must survive portable-tab normalization too.
        await act(async () => { expect(openInWorkspace(navigation(), '/workflows/runs/run-waiting', 'newTab')).toBe(true); });
        const duplicate = active().id;
        expect(duplicate).not.toBe(initial);
        expect(Object.keys(navigation().state.tabs)).toHaveLength(count + 1);
        await act(async () => navigation().closeTab('group:1', duplicate));
        // The same entry's Open in new tab uses this shared gesture/action owner.
        await act(async () => { expect(openInWorkspace(navigation(), '/workflows', 'newTab')).toBe(true); });
        const workflowsTab = active().id;
        expect(workflowsTab).not.toBe(initial);
        expect(Object.keys(navigation().state.tabs)).toHaveLength(count + 1);
        await act(async () => navigation().activateTab('group:1', initial));
        await screen.pressByTestIdAsync('app-rail:workflows');
        expect(active().id).toBe(workflowsTab);
        expect(Object.keys(navigation().state.tabs)).toHaveLength(count + 1);
        expect(routerPush).not.toHaveBeenCalled();
    });
});
