import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from './sessionPaneScopeId';

// Only the native SDK/router and actual Home HTTP/Socket transport are
// substituted. Session lookup, projection, pane reducer and launch owners run real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const sessionId = 'standalone-session-sidebar';
const pluginId = 'acme.standalone-sidebar';
const destination = { pluginId, localId: 'notes' };
const destinationBinding = normalizePluginUiDestinationBindingV1({
    pluginId, destinationId: destination.localId, rendererId: 'notes-renderer',
    container: 'rightSidebarTab', target: { kind: 'session' },
});
if (!destinationBinding) throw new Error('Canonical destination schema refused the Session sidebar fixture');
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId,
    scopeId: ({ serverId }) => createSessionPaneScopeId(sessionId, serverId),
    request: async (url, init) => (init?.method ?? 'GET') === 'GET' && new URL(String(url)).pathname === '/v1/machines/m1'
        ? Response.json({ machine: { id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } })
        : null,
    configureSocket: socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            socket.id = 'standalone-sidebar-socket';
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
            if (event !== 'rpc-call') throw new Error(`Unexpected sidebar transport event: ${event}`);
            const request = z.object({ method: z.string() }).passthrough().parse(payload);
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
                return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                    protocolVersion: 1,
                    projection: createProjection(destinationBinding, destination.localId),
                }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});

// Install the actual transport before loading the real sidebar graph.
const { SessionRightPanel } = await import('./SessionRightPanel');
const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
const { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider,
    PluginSurfacePaneLaunchScope, useRegisterPluginSurfaceDestinationNavigationOwner } =
    await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { APP_PANE_SCOPE_ID, useAppScopeRightSidebarDestinationHandler } = await import('@/components/appShell/rightSidebar/appScopeRightSidebarNavigation');
const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { readPluginUiProjectionEntryExecutionOrigin, unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');

function createProjection(binding: NonNullable<typeof destinationBinding>, descriptorId: string) {
    return PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
        pluginUi: { family: 'pluginUi', entriesById: { [descriptorId]: {
            id: descriptorId, pluginId, occurrenceId: 'notes-install', contributionKind: 'surfacePlacement',
            descriptorId, binding, target: binding.target,
            renderer: { kind: 'declarative', contributionId: 'notes-renderer' },
            display: { developerFallback: 'Notes' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            serverIdentityId: runtime.serverIdentityId,
            materializationRef: { pluginId, machineId: 'm1', materializationId: 'notes-install' },
            headerActions: [],
        } } },
    } });
}

function AppSidebarOwner(props: Readonly<{ binding: ReturnType<typeof createPluginSurfaceDestinationNavigationBinding> }>) {
    const handler = useAppScopeRightSidebarDestinationHandler();
    const owner = React.useMemo(() => ({ container: 'rightSidebarTab' as const, handler }), [handler]);
    useRegisterPluginSurfaceDestinationNavigationOwner(owner, props.binding);
    return null;
}

beforeEach(async () => {
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: 0 })], false, { sourceServerId: runtime.serverId });
    const session = createSessionFixture({ id: sessionId, serverId: runtime.serverId });
    storage.getState().applySessions([{ ...session, metadata: { ...session.metadata, machineId: 'm1' } }]);
});

describe('SessionRightPanel standalone navigation authority', () => {
    it('opens its exact Session destination through the real sidebar owner when nested under an app navigation binding', async () => {
        const screen = await renderScreen(<runtime.Wrapper />);
        try {
            const scopeId = createSessionPaneScopeId(sessionId, runtime.serverId);
            const lifetime = captureActiveServerAccountScopeLifetime();
            expect(lifetime?.isCurrent()).toBe(true);
            // This is the same target/no-scoped-facts binding shape supplied by AppShell.
            const appBinding = createPluginSurfaceDestinationNavigationBinding({
                targetKind: 'app', placements: [], accountLifetime: lifetime,
            });
            await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination }));
            await screen.update(<runtime.Wrapper>
                <PluginSurfaceDestinationNavigationBindingProvider binding={appBinding}>
                    <SessionRightPanel sessionId={sessionId} scopeId={scopeId} presentation="screen" />
                </PluginSurfaceDestinationNavigationBindingProvider>
            </runtime.Wrapper>);
            await vi.waitFor(() => expect(screen.findByType(PluginSurfacePlacementHost)?.props.binding?.openSurface).toBeTypeOf('function'));
            const host = screen.findByType(PluginSurfacePlacementHost);
            expect(host.props).toMatchObject({ sessionId, serverId: runtime.serverId, machineId: 'm1' });
            const input = { addressedTo: 'exact-session-sidebar' };
            await act(async () => {
                expect(await host.props.binding.openSurface({ destination, input })).toEqual({ ok: true });
            });
            expect(runtime.pane.scopeState?.right.selectedDestination).toEqual({ kind: 'plugin', destination });
            expect(screen.findByType(PluginSurfacePlacementHost).props.launchInput).toEqual(input);
        } finally {
            await screen.unmount();
        }
    });

    it('preserves app destination delegation to the real enclosing sidebar owner', async () => {
        const screen = await renderScreen(<runtime.Wrapper />);
        try {
            const observed: { state: ReturnType<typeof useAppPaneContext>['state'] | null } = { state: null };
            function PaneStateObserver() {
                observed.state = useAppPaneContext().state;
                return null;
            }
            const scopeId = createSessionPaneScopeId(sessionId, runtime.serverId);
            const lifetime = captureActiveServerAccountScopeLifetime();
            expect(lifetime?.isCurrent()).toBe(true);
            const appDestination = { pluginId, localId: 'app-notes' };
            const appDestinationBinding = normalizePluginUiDestinationBindingV1({
                pluginId, destinationId: appDestination.localId, rendererId: 'notes-renderer',
                container: 'rightSidebarTab', target: { kind: 'app' },
            });
            if (!appDestinationBinding) throw new Error('Canonical destination schema refused the app neighbor');
            const appProjection = normalizePluginUiProjection(createProjection(appDestinationBinding, appDestination.localId));
            const producer = Object.values(appProjection.surfacePlacementsById)[0];
            const origin = readPluginUiProjectionEntryExecutionOrigin(producer);
            if (!origin) throw new Error('The app neighbor has no producer-stamped execution origin');
            const union = unionPluginUiProjections([{
                machineId: 'm1', serverId: runtime.serverId, projection: appProjection,
                phase: 'current', interactionEnabled: true,
            }], new Map([[pluginId, origin]]));
            const placements = Object.values(union.pluginUiProjection?.surfacePlacementsById ?? {});
            expect(placements).toHaveLength(1);
            const appBinding = createPluginSurfaceDestinationNavigationBinding({
                targetKind: 'app', placements, accountLifetime: lifetime,
            });
            await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination }));
            await screen.update(<runtime.Wrapper>
                <PaneStateObserver />
                <PluginSurfacePaneLaunchScope accountLifetime={lifetime}>
                    <PluginSurfaceDestinationNavigationBindingProvider binding={appBinding}>
                        <AppSidebarOwner binding={appBinding} />
                        <SessionRightPanel sessionId={sessionId} scopeId={scopeId} presentation="screen" />
                    </PluginSurfaceDestinationNavigationBindingProvider>
                </PluginSurfacePaneLaunchScope>
            </runtime.Wrapper>);
            await vi.waitFor(() => expect(screen.findByType(PluginSurfacePlacementHost)?.props.binding?.openSurface).toBeTypeOf('function'));
            const openSurface = screen.findByType(PluginSurfacePlacementHost).props.binding.openSurface;
            await act(async () => {
                expect(await openSurface({ destination: appDestination, input: { addressedTo: 'app-sidebar' } })).toEqual({ ok: true });
            });
            expect(observed.state?.scopes[APP_PANE_SCOPE_ID]?.right.selectedDestination).toEqual({ kind: 'plugin', destination: appDestination });
        } finally {
            await screen.unmount();
        }
    });
});
