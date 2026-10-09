import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createBuiltinPaneDestination, type SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import { ProjectDefinitionInspectInputSchema, ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const device = vi.hoisted(() => ({ phone: false, native: false }));
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: device.phone ? 390 : 1440, height: device.phone ? 844 : 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({
        Platform: { get OS() { return device.native ? 'ios' : 'web'; }, isPad: false,
            select: (values: Record<string, unknown>) => values[device.native ? 'ios' : 'web'] ?? values.default },
        useWindowDimensions: dimensions,
        Dimensions: { get: dimensions },
    });
});
const PLUGIN_ID = 'acme.review';
const DESTINATION_ID = 'project-review-panel';
const TAB_ID = `plugin:${PLUGIN_ID}:${DESTINATION_ID}`;
const PLUGIN_DESTINATION = {
    kind: 'plugin', destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
} satisfies SelectedPaneDestinationV1;
let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 4, familiesById: {} });
let deferred: ReturnType<typeof createDeferred<ReturnType<typeof PluginProjectionV2Schema.parse>>> | null = null;
const projectionTransportTrace: string[] = [];
const inspectedWorkspaces: unknown[] = [];
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ serverId }) => buildProjectPaneScopeId('wr_1', serverId),
    request: async (url, init) => {
        const method = init?.method ?? 'GET';
        const pathname = new URL(String(url)).pathname;
        projectionTransportTrace.push(`HTTP ${method} ${pathname}`);
        if (method === 'GET' && pathname === '/v1/machines') {
            return Response.json([createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' })]);
        }
        if (method === 'GET' && pathname === '/v1/machines/m1') {
            return Response.json({ machine: { id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        return null;
    },
    configureSocket: socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
            projectionTransportTrace.push('Socket connect');
            socket.connected = true; socket.id = 'project-viewer-socket';
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'disconnect').mockImplementation(() => {
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
            return socket;
        });
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error(`Unexpected Project transport event: ${event}`);
            const request = z.object({ method: z.string(), params: z.unknown() }).passthrough().parse(payload);
            projectionTransportTrace.push(`Socket ${event} ${request.method}`);
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
                return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                    protocolVersion: 1, projection: deferred ? await deferred.promise : projection,
                }) };
            }
            if (request.method.endsWith(':daemon.projects.inspect.v1')) {
                const inspection = ProjectDefinitionInspectInputSchema.parse(request.params);
                inspectedWorkspaces.push(inspection.workspace);
                return { ok: true, result: ProjectDefinitionInspectOutputSchema.parse({
                    definition: { basis: { kind: 'absent' }, document: null },
                    detection: { entries: [{ source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'check' }, usage: 'script' }],
                        environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
                }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});
const { ProjectRightPanel } = await import('./ProjectRightPanel');
const { ProjectTerminalSurface } = await import('./surfaces/ProjectTerminalSurface');

function createProjection(pluginId = PLUGIN_ID, destinationId = DESTINATION_ID) {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId, destinationId, rendererId: 'project-panel-renderer', container: 'rightSidebarTab', target: { kind: 'project' },
    });
    if (!binding) throw new Error('Expected canonical Project sidebar destination');
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 4, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            [destinationId]: {
                id: destinationId, pluginId, occurrenceId: pluginId + '#1',
                contributionKind: 'surfacePlacement', descriptorId: destinationId, binding, target: binding.target,
                renderer: { kind: 'declarative', contributionId: 'project-panel-renderer' },
                display: { developerFallback: 'Review' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                serverIdentityId: runtime.serverIdentityId,
                materializationRef: { pluginId, machineId: 'm1', materializationId: 'project-review-install-a' },
                headerActions: [],
            },
        } } },
    });
}
beforeEach(async () => {
    device.phone = false; device.native = false; deferred = null;
    projectionTransportTrace.length = 0;
    inspectedWorkspaces.length = 0;
    projection = createProjection();
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    // With no observed heartbeat, the canonical presence owner uses the active bit.
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: 0 })]);
});
function panelProps() {
    return { workspaceRef: { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 },
        scopeId: buildProjectPaneScopeId('wr_1', runtime.serverId), activeRootPath: '/repo', onSelectRootPath: () => {} };
}
async function mount(destination: SelectedPaneDestinationV1 = createBuiltinPaneDestination('services')) {
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => runtime.pane.selectRightDestination(destination));
    await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} /></runtime.Wrapper>));
    await flushHookEffects({ cycles: 30 });
    return screen;
}
async function pluginHost(screen: Awaited<ReturnType<typeof mount>>) {
    const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
    return screen.tree.findByType(PluginSurfacePlacementHost);
}
describe('ProjectRightPanel right-sidebar registry tabs', () => {
    it('retains a real Project Terminal pane across accepted checkout loss without launching a guessed target', async () => {
            const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const checkout = { ...panelProps().workspaceRef, id: 'feature-checkout', projectKey: 'project-anchor', rootPath: '/repo/feature' };
        const base = { ...panelProps().workspaceRef, projectKey: 'project-anchor' };
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: [base, checkout], relationships: [], organizations: [], revisionsByPhysicalKey: createProjectAccountRowsFixture(scope, { workspaceRefs: [base, checkout] }).revisionsByPhysicalKey });
        const screen = await mount(createBuiltinPaneDestination('terminal'));
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} workspaceRef={base} activeRootPath={checkout.rootPath} /></runtime.Wrapper>));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('project-rightpanel-tab:terminal')).not.toBeNull();
        expect(screen.findHostByTestId('project-terminal-workspace-root')).not.toBeNull();
        expect(screen.tree.findByType(ProjectTerminalSurface).props.workspace).toEqual({ serverId: runtime.serverId,
            workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath });
        const retainedRight = runtime.pane.scopeState?.right;
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} workspaceRef={base} activeRootPath="/repo/unaccepted" /></runtime.Wrapper>));
        expect(screen.findHostByTestId('project-rightpanel-tab:terminal')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-terminal')).not.toBeNull();
        expect(screen.findHostByTestId('project-terminal-workspace-root')).toBeNull();
        expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
        expect(projectionTransportTrace.some(entry => entry.includes('daemon.terminal.ensure'))).toBe(false);
    });
    it('shows Scripts unavailable rather than inventing an unaccepted checkout target', async () => {
        const screen = await mount(createBuiltinPaneDestination('scripts'));
        expect(screen.findHostByTestId('project-rightpanel-tab:scripts')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-scripts-unavailable')).not.toBeNull();
        expect(inspectedWorkspaces).toEqual([]);
    });
    it('renders the real Scripts inspection for the accepted selected checkout and retains it while hiding its page launcher', async () => {
        const restoreLoader = await installRealActionExecutorModuleLoader();
        try {
                    const scope = { serverId: runtime.serverId, accountId: 'account-a' };
            const base = { ...panelProps().workspaceRef, projectKey: 'project-anchor' };
            const checkout = { ...base, id: 'feature-checkout', rootPath: '/repo/feature' };
            storage.getState().activateProjectAccountRowsScope(scope);
            storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                workspaceRefs: [base, checkout], relationships: [], organizations: [], revisionsByPhysicalKey: createProjectAccountRowsFixture(scope, { workspaceRefs: [base, checkout] }).revisionsByPhysicalKey });
            const screen = await mount(createBuiltinPaneDestination('scripts'));
            await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} workspaceRef={base} activeRootPath={checkout.rootPath} activePage="overview" /></runtime.Wrapper>));
            await flushHookEffects({ cycles: 30 });
            expect(screen.findHostByTestId('project-rightpanel-tab:scripts')).not.toBeNull();
            expect(screen.findHostByTestId('project-rightpanel-scripts.detected:0')).not.toBeNull();
            expect(inspectedWorkspaces).toContainEqual({ serverId: runtime.serverId, workspaceId: checkout.id,
                machineId: checkout.machineId, rootPath: checkout.rootPath });
            const retainedRight = runtime.pane.scopeState?.right;
            await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} workspaceRef={base} activeRootPath={checkout.rootPath} activePage="scripts" /></runtime.Wrapper>));
            expect(screen.findHostByTestId('project-rightpanel-tab:scripts')).toBeNull();
            expect(screen.findHostByTestId('project-rightpanel-scripts.detected:0')).not.toBeNull();
            expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
        } finally { restoreLoader(); }
    });
    it('keeps Browser available alongside Services on a larger web device', async () => {
        const { ProjectRightPanelServicesView } = await import('./services/ProjectRightPanelServicesView');
        const screen = await mount();
        expect(screen.findHostByTestId('project-rightpanel-tab:browser')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-browser')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-tab:services')).not.toBeNull();
        expect(screen.tree.findAllByType(ProjectRightPanelServicesView)).toHaveLength(1);
    });
    it('retains Changes companion selection and state while hiding only its matching page launcher', async () => {
            const screen = await mount(createBuiltinPaneDestination('git'));
        await act(async () => runtime.pane.setRightTabState('git', { selectedPath: 'src/main.ts' }));
        const retainedRight = runtime.pane.scopeState?.right;
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} activePage="changes" /></runtime.Wrapper>));
        expect(screen.findHostByTestId('project-rightpanel-tab:git')).toBeNull();
        for (const tabId of ['files', 'browser', 'services']) {
            expect(screen.findHostByTestId(`project-rightpanel-tab:${tabId}`)).not.toBeNull();
        }
        expect(screen.findHostByTestId('project-rightpanel-surface-git')).not.toBeNull();
        expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} activePage="overview" /></runtime.Wrapper>));
        expect(screen.findHostByTestId('project-rightpanel-tab:git')).not.toBeNull();
        expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
    });
    it('projects Files page suppression through the desktop rail without replacing the companion selection', async () => {
        const { ProjectRightSidebarProvider, ProjectRightSidebarRail } = await import('./ProjectRightPanel');
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.openRight({ tabId: 'files' }));
        const retainedRight = runtime.pane.scopeState?.right;
        const rail = (activePage: 'code' | 'overview') => <runtime.Wrapper>
            <ProjectRightSidebarProvider {...panelProps()} activePage={activePage}><ProjectRightSidebarRail /></ProjectRightSidebarProvider>
        </runtime.Wrapper>;
        await act(async () => screen.update(rail('code')));
        expect(screen.findHostByTestId('project-rightpanel-action:files')).toBeNull();
        for (const tabId of ['git', 'browser', 'services']) {
            expect(screen.findHostByTestId(`project-rightpanel-action:${tabId}`)).not.toBeNull();
        }
        expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
        await act(async () => screen.update(rail('overview')));
        expect(screen.findHostByTestId('project-rightpanel-action:files')).not.toBeNull();
        expect(runtime.pane.scopeState?.right).toEqual(retainedRight);
    });
    it('keeps Browser and Services available on phone', async () => {
        device.phone = true;
        const screen = await mount(createBuiltinPaneDestination('browser'));
        expect(screen.findHostByTestId('project-rightpanel-tab:browser')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-tab:services')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-browser')).not.toBeNull();
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('browser');
    });
    it('keeps Browser qualified to the selected Home and checkout across Project page switches', async () => {
            const { BrowserScopedWorkspace } = await import('@/components/browser/surfaces/BrowserScopedWorkspace');
        const screen = await mount(createBuiltinPaneDestination('browser'));
        const browserScopeId = screen.tree.findByType(BrowserScopedWorkspace).props.scopeId;
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel
            {...panelProps()} activeRootPath="/repo/worktrees/feature" activePage="code"
        /></runtime.Wrapper>));
        expect(screen.tree.findByType(BrowserScopedWorkspace).props.scope).toEqual({
            kind: 'workspace', workspaceRefId: 'wr_1', serverId: runtime.serverId,
            machineId: 'm1', rootPath: '/repo/worktrees/feature',
        });
        device.phone = true;
        await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel
            {...panelProps()} activeRootPath="/repo/worktrees/feature" activePage="services"
        /></runtime.Wrapper>));
        expect(screen.tree.findByType(BrowserScopedWorkspace).props.scopeId).toBe(browserScopeId);
        expect(screen.tree.findByType(BrowserScopedWorkspace).props.scope.rootPath).toBe('/repo/worktrees/feature');
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('browser');
    });
    it('omits redundant header controls when the canonical host rail is visible', async () => {
            const { PaneActionRailContext } = await import('@/components/appShell/panes/PaneActionRailContext');
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.openRight({ tabId: 'services' }));
        await act(async () => screen.update(<runtime.Wrapper><PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000 }}>
            <ProjectRightPanel {...panelProps()} onRequestClose={() => {}} />
        </PaneActionRailContext.Provider></runtime.Wrapper>));
        expect(screen.findHostByTestId('project-rightpanel-tab:services')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-services')).not.toBeNull();
    });
    it('keeps the plugin action rail usable while its panel body is closed', async () => {
        const { createHappierSocket } = await import('@happier-dev/sync-client');
        const boundary = createHappierSocket({ endpoint: 'https://session-pane.test', token: 'socket-boundary-precondition', clientType: 'user-scoped' });
        try {
            expect(vi.isMockFunction(boundary.socket.connect), 'Happier Socket must consume the configured SDK network boundary').toBe(true);
        } finally {
            await boundary.transport.destroy();
        }
        const { ProjectRightSidebarProvider, ProjectRightSidebarRail } = await import('./ProjectRightPanel');
        const screen = await renderScreen(<runtime.Wrapper><ProjectRightSidebarProvider {...panelProps()}>
            <ProjectRightSidebarRail />
        </ProjectRightSidebarProvider></runtime.Wrapper>);
        await flushHookEffects({ cycles: 30 });
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { isServerReachabilityNetworkAllowed, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const state = storage.getState();
        const machine = state.machines.m1;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const demandQualification = {
            endpointStatus: state.endpointStatus, endpointReason: state.endpointReason,
            machinePresent: Boolean(machine), machineOnline: machine ? isMachineOnline(machine) : false,
            accountScope: lifetime?.scope ?? null, accountCurrent: lifetime?.isCurrent() ?? null,
            networkAllowed: isServerReachabilityNetworkAllowed(),
            reachability: peekServerReachabilityState('https://session-pane.test'),
        };
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'm1', serverId: runtime.serverId }),
            `Projection qualification: ${JSON.stringify(demandQualification)}; transport: ${JSON.stringify(projectionTransportTrace)}`,
        ).toMatchObject({ kind: 'ready', inputs: { pluginProjectionV2: { generation: 4 } } });
        expect(screen.findHostByTestId('project-right-panel-root')).toBeNull();
        await screen.pressByTestIdAsync(`project-rightpanel-action:${TAB_ID}`);
        expect(runtime.pane.scopeState?.right).toMatchObject({
            isOpen: true, activeTabId: null, selectedDestination: {
                kind: 'plugin', destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
            },
        });
    });
    it('mounts the workspace-scoped plugin and resolves qualified opens through its real current origin', async () => {
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
            const global = normalizePluginUiProjection(createProjection('acme.global', 'global-project-panel'));
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID } }));
        await act(async () => screen.update(<runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: global, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: 'machine-global', serverId: 'server-global', platform: 'web',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
        }}><ProjectRightPanel {...panelProps()} /></AppShellPluginUiProjectionValueProvider></runtime.Wrapper>));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('project-rightpanel-tab:plugin:acme.global:global-project-panel')).toBeNull();
        expect(screen.findHostByTestId(`project-rightpanel-tab:${TAB_ID}`)).not.toBeNull();
        const host = await pluginHost(screen);
        expect(host.props).toMatchObject({ machineId: 'm1', serverId: runtime.serverId });
        await act(async () => {
            await expect(host.props.binding.openSurface({
                destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID }, input: { source: 'review-header' },
            })).resolves.toEqual({ ok: true });
        });
        expect(runtime.pane.scopeState?.right.selectedDestination).toMatchObject({
            kind: 'plugin', destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
        });
    });
    it('retains a restored qualified selection while the real describe is establishing', async () => {
        deferred = createDeferred();
        const screen = await mount(PLUGIN_DESTINATION);
        expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(PLUGIN_DESTINATION);
        expect(screen.findHostByTestId('project-rightpanel-surface-git')).toBeNull();
        await act(async () => deferred?.resolve(projection));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId(`project-rightpanel-tab:${TAB_ID}`)).not.toBeNull();
        expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(PLUGIN_DESTINATION);
    });
    it('keeps the admitted offline projection visible but denies interaction', async () => {
        const screen = await mount(PLUGIN_DESTINATION);
        expect((await pluginHost(screen)).props.projectionInteractionEnabled).toBe(true);
        const machine = storage.getState().machines.m1;
        if (!machine) throw new Error('Expected the current Project Machine');
        const expiresAt = readMachineStatusNextRefreshAtMs(machine, Date.now());
        if (expiresAt === null) throw new Error('Expected a current Machine heartbeat');
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(expiresAt);
            await act(async () => storage.getState().applyMachines([{ ...machine, seq: machine.seq + 1, active: false, updatedAt: expiresAt }]));
            await flushHookEffects();
            const host = await pluginHost(screen);
            expect(host.props.projectionInteractionEnabled).toBe(false);
            await act(async () => {
                await expect(host.props.binding.openSurface({
                    destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
                })).resolves.toMatchObject({ ok: false, code: 'unavailable' });
            });
            expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(PLUGIN_DESTINATION);
            await screen.unmount();
        } finally { vi.useRealTimers(); }
    });
    it('keeps a restored desktop Project destination as a native-phone tombstone', async () => {
        device.phone = true; device.native = true;
        const screen = await mount(PLUGIN_DESTINATION);
        const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        expect(screen.findHostByTestId(`project-rightpanel-tab:${TAB_ID}`)).toBeNull();
        expect(screen.tree.findAllByType(PluginSurfacePlacementHost)).toHaveLength(0);
        const mountedDiagnostics = screen.findAllByType<typeof PluginReactNativeUnavailable>(PluginReactNativeUnavailable)
            .map(node => node.props.diagnostics);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('@/components/plugins/reactNative/hostRuntimeIdentity');
        const { resolveHostedWebFrameCapability } = await import('@/components/plugins/hostedWeb/hostedWebFrameCapability');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const machine = storage.getState().machines.m1;
        const qualification = {
            endpointStatus: storage.getState().endpointStatus,
            endpointReason: storage.getState().endpointReason,
            machinePresent: !!machine,
            machineOnline: !!machine && isMachineOnline(machine),
            accountScope: lifetime?.scope ?? null,
            accountCurrent: lifetime?.isCurrent() ?? false,
            projectionCache: readCachedDaemonMergedProjectionCacheEntry({ serverId: runtime.serverId, machineId: 'm1' }),
            nativeRuntimeIdentity: resolveNativeReactNativeHostRuntimeIdentity(),
            hostedFrameCapability: await resolveHostedWebFrameCapability(),
        };
        expect(screen.findHostByTestId('plugin-rn-ui-unavailable-diagnostic-plugin_destination_unavailable'),
            `Mounted tombstone diagnostics: ${JSON.stringify(mountedDiagnostics)}; qualification: ${JSON.stringify(qualification)}; transport: ${JSON.stringify(projectionTransportTrace)}`).not.toBeNull();
        expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(PLUGIN_DESTINATION);
    });
});
