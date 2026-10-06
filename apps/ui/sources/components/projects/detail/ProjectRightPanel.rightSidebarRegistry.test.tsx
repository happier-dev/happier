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

const device = vi.hoisted(() => ({ phone: false, native: false }));
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
let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 4, familiesById: {} });
let deferred: ReturnType<typeof createDeferred<ReturnType<typeof PluginProjectionV2Schema.parse>>> | null = null;
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: 'project:wr_1',
    request: async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET' && new URL(String(url)).pathname === '/v1/machines/m1') {
            return Response.json({ machine: { id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        return null;
    },
    configureSocket: socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
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
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
                return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                    protocolVersion: 1, projection: deferred ? await deferred.promise : projection,
                }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});
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
    projection = createProjection();
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })]);
});
function panelProps() {
    return { workspaceRef: { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 },
        scopeId: 'project:wr_1', activeRootPath: '/repo', onSelectRootPath: () => {} };
}
async function mount(tabId = 'services') {
    const { ProjectRightPanel } = await import('./ProjectRightPanel');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => runtime.pane.openRight({ tabId }));
    await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel {...panelProps()} /></runtime.Wrapper>));
    await flushHookEffects({ cycles: 30 });
    return screen;
}
async function pluginHost(screen: Awaited<ReturnType<typeof mount>>) {
    const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
    return screen.tree.findByType(PluginSurfacePlacementHost);
}
describe('ProjectRightPanel right-sidebar registry tabs', () => {
    it('keeps Services but removes the redundant Browser surface on a larger web device', async () => {
        const { ProjectRightPanelServicesView } = await import('./services/ProjectRightPanelServicesView');
        const screen = await mount();
        expect(screen.findHostByTestId('project-rightpanel-tab:browser')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-browser')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-tab:services')).not.toBeNull();
        expect(screen.tree.findAllByType(ProjectRightPanelServicesView)).toHaveLength(1);
    });
    it('keeps Browser and Services available on phone', async () => {
        device.phone = true;
        const screen = await mount('browser');
        expect(screen.findHostByTestId('project-rightpanel-tab:browser')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-tab:services')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-surface-browser')).not.toBeNull();
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('browser');
    });
    it('omits redundant header controls when the canonical host rail is visible', async () => {
        const { ProjectRightPanel } = await import('./ProjectRightPanel');
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
        const { ProjectRightSidebarProvider, ProjectRightSidebarRail } = await import('./ProjectRightPanel');
        const screen = await renderScreen(<runtime.Wrapper><ProjectRightSidebarProvider {...panelProps()}>
            <ProjectRightSidebarRail />
        </ProjectRightSidebarProvider></runtime.Wrapper>);
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('project-right-panel-root')).toBeNull();
        await screen.pressByTestIdAsync(`project-rightpanel-action:${TAB_ID}`);
        expect(runtime.pane.scopeState?.right).toMatchObject({
            isOpen: true, activeTabId: TAB_ID, selectedDestination: {
                kind: 'plugin', destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
            },
        });
    });
    it('mounts the workspace-scoped plugin and resolves qualified opens through its real current origin', async () => {
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { ProjectRightPanel } = await import('./ProjectRightPanel');
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
        const screen = await mount(TAB_ID);
        expect(runtime.pane.scopeState?.right.activeTabId).toBe(TAB_ID);
        expect(screen.findHostByTestId('project-rightpanel-surface-git')).toBeNull();
        await act(async () => deferred?.resolve(projection));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId(`project-rightpanel-tab:${TAB_ID}`)).not.toBeNull();
        expect(runtime.pane.scopeState?.right.activeTabId).toBe(TAB_ID);
    });
    it('keeps the admitted offline projection visible but denies interaction', async () => {
        const screen = await mount(TAB_ID);
        expect((await pluginHost(screen)).props.projectionInteractionEnabled).toBe(true);
        await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: false, activeAt: Date.now() })]));
        await flushHookEffects();
        const host = await pluginHost(screen);
        expect(host.props.projectionInteractionEnabled).toBe(false);
        await act(async () => {
            await expect(host.props.binding.openSurface({
                destination: { pluginId: PLUGIN_ID, localId: DESTINATION_ID },
            })).resolves.toMatchObject({ ok: false, code: 'unavailable' });
        });
        expect(runtime.pane.scopeState?.right.activeTabId).toBe(TAB_ID);
    });
    it('keeps a restored desktop Project destination as a native-phone tombstone', async () => {
        device.phone = true; device.native = true;
        const screen = await mount(TAB_ID);
        const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
        expect(screen.findHostByTestId(`project-rightpanel-tab:${TAB_ID}`)).toBeNull();
        expect(screen.tree.findAllByType(PluginSurfacePlacementHost)).toHaveLength(0);
        expect(screen.findHostByTestId('plugin-rn-ui-unavailable-diagnostic-plugin_destination_unavailable')).not.toBeNull();
        expect(runtime.pane.scopeState?.right.activeTabId).toBe(TAB_ID);
    });
});
