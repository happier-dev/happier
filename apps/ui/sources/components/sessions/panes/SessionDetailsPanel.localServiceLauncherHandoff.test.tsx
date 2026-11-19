import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The navigation SDK owns focus events; both compositions below are visible Session hosts.
vi.mock('@react-navigation/native', async () => (
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock()
));
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DaemonLocalServicePreviewSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { LocalServiceLauncherSnapshot } from '@/sync/domains/local/services/launch';

import { createSessionFixture, createMachineFixture, createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }));
installSessionDetailsPanelCommonModuleMocks({ reactNative: async () => (
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => viewport,
    })
) });
// Cold Sync transformation belongs to collection, not the Account restore hook's deadline.
await loadSyncSingletonForTests();
const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
function RegisteredSessionDetails(props: React.ComponentProps<typeof SessionDetailsPanel>) {
    useRegisterSessionPaneDriver(props.sessionId, props.routeServerId, undefined, { scopeId: props.scopeId });
    return <SessionDetailsPanel {...props} />;
}
const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
const { SessionCockpitSurfaceScreen } = await import('@/components/workspaceCockpit/session/SessionCockpitSurfaceScreen');
const { resolveSessionCockpitMobileCatalog } = await import('@/components/workspaceCockpit/session/sessionCockpitMobileCatalog');
const { resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } = await import('@/sync/domains/local/services/launch/sharedStore');
const { getLocalServicePreviewState, resetLocalServicePreviewStoreForTests } = await import('@/sync/domains/local/services/preview/sharedStore');
const serviceMethods: string[] = [];
const serviceRequests: Array<{ method: string; input: unknown }> = [];
let inventoryRead = createDeferred<void>();
let reopenService = false;
let accessUnavailable = false;
let firstStart = false;
let nativeRunning = false;
let offlineMachine: ReturnType<typeof createMachineFixture> | null = null;
let startReply = createDeferred<void>();
const firstStartTargetId = 'project-service:first-web';
const firstStartSnapshot = (): LocalServiceLauncherSnapshot => ({ v: 1 as const, machineId: 'machine-a', sessionId: 'session-a',
    updatedAt: nativeRunning ? 4_000 : 3_000, targets: [{
        id: firstStartTargetId, source: 'managed_service' as const, machineId: 'machine-a', sessionId: 'session-a',
        title: 'Declared web', confidence: 'high' as const, state: 'available' as const,
        workspace: { serverId: runtime.serverId, machineId: 'machine-a', workspaceId: 'checkout-a', rootPath: '/repo' },
        declaration: { workspaceRefId: 'checkout-a', selection: { kind: 'manifest' as const, name: 'web' } },
        actions: nativeRunning ? ['open_preview' as const] : ['start' as const],
        ...(nativeRunning ? { sourceClass: { kind: 'managed_service' as const, managedServiceId: 'first-web' },
            serviceState: 'running' as const, browserTarget: serviceTarget } : {}),
    }] });
const serviceTarget = { kind: 'localServicePreview', targetId: 'preview-reopen', machineId: 'machine-a', sessionId: 'session-a',
    display: { title: 'Reopen service', addressLabel: 'localhost:5173' } } as const;
const serviceResource = { previewId: serviceTarget.targetId, machineId: 'machine-a', sessionId: 'session-a',
    owner: { kind: 'session', id: 'session-a' }, browserTarget: serviceTarget,
    target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
    display: serviceTarget.display, originMode: 'host' } as const;
const servicePreview = { previewId: serviceTarget.targetId, resource: serviceResource,
    accessUrl: 'https://service.preview.test/', expiresAt: null, diagnostics: [] };
const currentServicePreview = () => accessUnavailable ? { ...servicePreview, accessUrl: null,
    accessUnavailableReasonCode: 'preview_private_route_unavailable' as const } : servicePreview;
const previewSnapshot = () => ({ v: 1, machineId: 'machine-a', generatedAt: 3_000, refreshState: 'idle',
    resources: [serviceResource], previews: [currentServicePreview()], diagnostics: [] });
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-a',
    features: () => createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, viewTargets: { enabled: true } } } }),
    request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (reopenService && path === '/v1/local-services/preview/preview-reopen/access') {
            if (accessUnavailable) return Response.json({ error: 'preview_private_route_unavailable' }, { status: 503 });
            const { LocalServicePreviewServerAccessV1Schema } = await import('@happier-dev/protocol/local/services/preview/nativeDirect');
            return Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                previewId: serviceTarget.targetId, machineId: serviceTarget.machineId, accessUrl: servicePreview.accessUrl,
                expiresAt: Date.now() + 60_000 }));
        }
        if (reopenService && path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'browser.workspace.open': ['ui'] } },
        } } });
        if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a',
            ...(offlineMachine ? { machine: offlineMachine } : {}) })]);
        return createPlainMachineReadHttpResponseFixture(path, init, 'account-a', offlineMachine ?? undefined);
    },
    rpc: async (method, _input, machineId) => {
    if (method.includes('localServices.')) serviceMethods.push(method);
    if (method.includes('localServices.')) serviceRequests.push({ method, input: _input });
    if (firstStart && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
        await startReply.promise;
        return { protocolVersion: 1, machineId, targetId: firstStartTargetId, status: 'succeeded', snapshot: firstStartSnapshot() };
    }
    if (firstStart && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return {
        protocolVersion: 1, snapshot: firstStartSnapshot(),
    };
    if (reopenService && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE) return {
        protocolVersion: 1, status: 'existing', preview: currentServicePreview(), snapshot: previewSnapshot(),
    };
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT) return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({
        protocolVersion: 1, snapshot: reopenService ? previewSnapshot()
            : { v: 1, machineId, generatedAt: 3_000, refreshState: 'idle', resources: [], previews: [], diagnostics: [] },
    });
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return {
        protocolVersion: 1, snapshot: { v: 1, machineId, sessionId: 'session-a', updatedAt: 3_000, targets: reopenService ? [{
            id: 'inventory:reopen-service', source: 'inventory_entry', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'reopen-service' },
            machineId, sessionId: 'session-a', title: 'Reopen service', confidence: 'high', state: 'available', actions: [], browserTarget: serviceTarget,
        }] : [] },
    };
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT
        || method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        await inventoryRead.promise;
        return {
        protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 3_000, refreshState: 'idle', entries: [], diagnostics: [] },
        };
    }
    throw new RpcError('Unsupported fixture RPC', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
} });
beforeEach(() => {
    Object.assign(viewport, { width: 1440, height: 1000 });
    reopenService = false;
    accessUnavailable = false;
    firstStart = false;
    nativeRunning = false;
    offlineMachine = null;
    startReply = createDeferred<void>();
    serviceMethods.length = 0;
    serviceRequests.length = 0;
    inventoryRead = createDeferred<void>();
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
    resetLocalServicePreviewStoreForTests();
});

describe('SessionDetailsPanel local service launcher handoff', () => {
    it.each(['route', 'pane'] as const)('retains the offline Session Machine binding in the %s runtime owner', async owner => {
        const { useSessionPluginRuntime } = await import('../plugins/useSessionPluginRuntime');
        const { useOptionalPaneDriverReader } = await import('@/components/appShell/panes/AppPaneProvider');
        let runtimeMachineId: string | null = null;
        let readDriver!: NonNullable<ReturnType<typeof useOptionalPaneDriverReader>>;
        let scopeId = '';
        function RouteOwner() {
            runtimeMachineId = useSessionPluginRuntime({ address: { sessionId: 'session-a', serverId: runtime.serverId } }).machineId;
            return null;
        }
        function PaneOwner() {
            scopeId = useRegisterSessionPaneDriver('session-a', runtime.serverId);
            readDriver = useOptionalPaneDriverReader()!;
            return null;
        }
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now(), presenceProtocolVersion: 1,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio' } });
        offlineMachine = machine;
        storage.getState().applyMachines([machine], false, { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
        storage.getState().applySessions([createSessionFixture({ id: 'session-a', serverId: runtime.serverId,
            metadata: { path: '/repo', host: 'studio', machineId: machine.id } })]);
        const screen = await renderScreen(<runtime.Wrapper>{owner === 'route' ? <RouteOwner /> : <PaneOwner />}</runtime.Wrapper>);
        const readMachineId = () => owner === 'route' ? runtimeMachineId : readDriver(scopeId)?.surfaceScope?.machineId;
        try {
            await expect.poll(readMachineId).toBe(machine.id);
            offlineMachine = { ...machine, active: false, activeAt: Date.now(), updatedAt: Date.now() };
            await act(async () => storage.getState().applyMachines([offlineMachine!], false,
                { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' }));
            await flushHookEffects();
            const { isMachineOnline } = await import('@/sync/domains/machines/reachability/machinePresence');
            expect(isMachineOnline(storage.getState().machines[machine.id]!)).toBe(false);
            expect(readMachineId()).toBe(machine.id);
        } finally { await screen.unmount(); }
    });

    it.each(['pane', 'chat'] as const)('opens an addressed Browser Action from cold %s before Details or Browser mounts', async host => {
        if (host === 'chat') Object.assign(viewport, { width: 390, height: 844 });
        reopenService = true;
        inventoryRead.resolve();
        const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
        const { createSessionPaneScopeId } = await import('./sessionPaneScopeId');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { readRegisteredBrowserRuntimeWorkspaceOpeningAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');
        const { View } = await import('react-native');
        let pane!: ReturnType<typeof useAppPaneScope>;
        let scopeId = '';
        function SessionPane() {
            scopeId = useRegisterSessionPaneDriver('session-a', runtime.serverId);
            pane = useAppPaneScope(scopeId);
            return <AppPaneScopeHost scopeId={scopeId} main={<View testID="cold-session-chat" />} />;
        }
        function ChatSurface() {
            scopeId = createSessionPaneScopeId('session-a', runtime.serverId);
            pane = useAppPaneScope(scopeId);
            return <SessionCockpitSurfaceScreen catalog={resolveSessionCockpitMobileCatalog({ terminalTabAvailable: false })}
                sessionId="session-a" scopeId={scopeId} surface="chat" experience="classic" routeServerId={runtime.serverId} />;
        }
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })],
            false, { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
        storage.getState().applySessions([createSessionFixture({ id: 'session-a', serverId: runtime.serverId,
            metadata: { path: '/repo', host: 'test', machineId: 'machine-a' } })]);
        const screen = await renderScreen(<runtime.Wrapper>{host === 'pane' ? <SessionPane /> : <ChatSurface />}</runtime.Wrapper>);
        try {
            expect(pane.scopeState?.details.tabs ?? []).toHaveLength(0);
            expect(screen.findAllByType(SessionDetailsPanel)).toHaveLength(0);
            expect(screen.findAllByTestId('browser-view-details-surface-address')).toHaveLength(0);
            if (host === 'pane') expect(serviceMethods).toEqual([]);
            await expect.poll(() => readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(runtime.accountScope!, scopeId)).not.toBeNull();
            const producer = readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(runtime.accountScope!, scopeId);
            let result: unknown;
            await act(async () => {
                result = await createFrontDoorActionExecute()('browser.workspace.open', {
                    scopeId, commandId: 'cold-session-browser-open',
                    engineOverride: 'embedded',
                    target: { kind: 'externalUrl', targetId: 'cold-localhost', url: 'http://localhost:5173/' },
                }, { surface: 'ui', authority: 'present_user', serverId: runtime.serverId, expectedAccountId: 'account-a' });
            });
            expect(result).toMatchObject({ ok: true, result: { status: 'dispatched', outcome: 'workspaceTab' } });
            await expect.poll(() => pane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['browser-view']);
            expect(pane.scopeState?.details.tabs[0]).toMatchObject({
                resource: { engineOverride: 'embedded', target: { kind: 'localServicePreview', targetId: serviceTarget.targetId } },
            });
            expect(readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(runtime.accountScope!, scopeId)).toBe(producer);
        } finally { await screen.unmount(); }
        expect(readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(runtime.accountScope!, scopeId)).toBeNull();
    });
    it.each(['pane', 'chat'] as const)('retains the open Services pane through the first declared Start and Running regroup in %s, until explicit Open', async host => {
        firstStart = true;
        reopenService = true;
        inventoryRead.resolve();
        const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
        const { MultiPaneHost } = await import('@/components/ui/panels/MultiPaneHost');
        const { motionTokens } = await import('@/components/ui/motion/motionTokens');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
        const { SessionRightSidebarProvider } = await import('./SessionRightPanel');
        const { View } = await import('react-native');
        const { createSessionPaneScopeId } = await import('./sessionPaneScopeId');
        let pane!: ReturnType<typeof useAppPaneScope>;
        function SessionPane() {
            const scopeId = useRegisterSessionPaneDriver('session-a', runtime.serverId);
            pane = useAppPaneScope(scopeId);
            return <AppPaneScopeHost scopeId={scopeId} main={<View testID="start-retention-chat" />}
                wrapScopeContent={content => <SessionRightSidebarProvider sessionId="session-a" scopeId={scopeId}>{content}</SessionRightSidebarProvider>} />;
        }
        function ChatSurface() {
            const scopeId = createSessionPaneScopeId('session-a', runtime.serverId);
            pane = useAppPaneScope(scopeId);
            return <SessionCockpitSurfaceScreen catalog={resolveSessionCockpitMobileCatalog({ terminalTabAvailable: false })}
                sessionId="session-a" scopeId={scopeId} surface="chat" experience="classic" routeServerId={runtime.serverId} />;
        }
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now(),
            daemonStateVersion: 1, daemonState: { status: 'running', pid: 17, localServices: { v: 1, state: 'ready', runningCount: 0 } } });
        storage.getState().applyMachines([machine], false, { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
        storage.getState().applySessions([createSessionFixture({ id: 'session-a', serverId: runtime.serverId,
            metadata: { path: '/repo', host: 'test', machineId: machine.id } })]);
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'browser.workspace.open': ['ui'] } }) });
        const screen = await renderScreen(<runtime.Wrapper>{host === 'pane' ? <SessionPane /> : <ChatSurface />}</runtime.Wrapper>);
        try {
            await act(async () => pane.openRight({ tabId: 'services' }));
            const rowId = `session-rightpanel-services-row:${firstStartTargetId}`;
            await expect.poll(() => screen.findAllByTestId(`${rowId}-start`).length).toBeGreaterThan(0);
            expect(screen.findByType(MultiPaneHost).props.layout.right).toBe('docked');
            await screen.pressByTestIdAsync(`${rowId}-start`);
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START).length).toBe(1);
            expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'services' });
            await act(async () => {
                nativeRunning = true;
                storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
                    daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 1 } } }], false,
                { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
                startReply.resolve();
            });
            await expect.poll(() => screen.findAllByTestId(`${rowId}-status-running`).length).toBeGreaterThan(0);
            await flushHookEffects({ cycles: 30 });
            await act(async () => { await new Promise(resolve => setTimeout(resolve, motionTokens.durationMs.base)); });
            expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'services' });
            expect(screen.findByType(MultiPaneHost).props.layout.right).toBe('docked');
            expect(pane.scopeState?.details.tabs).toHaveLength(0);
            expect(screen.findAllByType('iframe')).toHaveLength(0);
            expect(serviceMethods).not.toContain(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE);
            await screen.pressByTestIdAsync(`${rowId}-open`);
            await expect.poll(() => pane.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['browser-view']);
        } finally { startReply.resolve(); await screen.unmount(); }
    });
    it.each(['available', 'unavailable', 'available-same-address'] as const)('returns the visible Browser to a Service through the real right-panel row after external navigation (access %s)', async access => {
        reopenService = true;
        inventoryRead.resolve();
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const { EMPTY_PLUGIN_BROWSER_PROJECTION } = await import('@/sync/domains/plugins/browser/targets');
        const paneSurfaceScope = { targetKind: 'session', sessionId: 'session-a', machineId: 'machine-a', serverId: runtime.serverId,
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
            accountLifetime: captureActiveServerAccountScopeLifetime(), platform: 'web', projectionPhase: 'current', interactionEnabled: true } as const;
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId,
            metadata: { path: '/repo', host: 'test', machineId: 'machine-a' } });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })]);
        storage.getState().applySessions([session]);
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'browser.workspace.open': ['ui'] } }) });
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionRightPanel sessionId="session-a" scopeId="session:session-a" paneSurfaceScope={paneSurfaceScope} />
            <RegisteredSessionDetails sessionId="session-a" routeServerId={runtime.serverId} scopeId="session:session-a" paneSurfaceScope={paneSurfaceScope} />
        </runtime.Wrapper>);
        try {
            await act(async () => runtime.pane.openRight({ tabId: 'services' }));
            const openRow = 'session-rightpanel-services-row:inventory:reopen-service-open';
            await expect.poll(() => screen.findAllByTestId(openRow).length).toBeGreaterThan(0);
            await screen.pressByTestIdAsync(openRow);
            expect(runtime.pane.scopeState?.details.tabs).toHaveLength(1);
            await expect.poll(() => screen.findAllByType('iframe').map(frame => frame.props.src)).toContain(servicePreview.accessUrl);
            await act(async () => screen.changeTextByTestId('browser-view-details-surface-address', 'https://example.com/elsewhere'));
            await act(async () => screen.findByTestId('browser-view-details-surface-address')?.props.onSubmitEditing());
            await expect.poll(() => screen.findByType('iframe').props.src).toBe('https://example.com/elsewhere');
            const { BrowserShell } = await import('@/components/browser/BrowserShell');
            if (access === 'available-same-address') {
                await act(async () => screen.changeTextByTestId('browser-view-details-surface-address', servicePreview.accessUrl));
                await act(async () => screen.findByTestId('browser-view-details-surface-address')?.props.onSubmitEditing());
                await expect.poll(() => screen.findByType('iframe').props.src).toBe(servicePreview.accessUrl);
                await act(async () => screen.findByType('iframe').props.onLoad());
                const state: React.ComponentProps<typeof BrowserShell>['state'] = screen.findByType(BrowserShell).props.state;
                expect(Object.values(state.viewsById).map(view => view.target.kind)).toEqual(['externalUrl']);
                expect(Object.values(state.viewsById).map(view => view.pendingUrl)).toEqual([null]);
            }
            const originalTabKey = runtime.pane.scopeState!.details.tabs[0]!.key;
            const previewReads = serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT).length;
            const previewAdmissions = serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE).length;
            accessUnavailable = access === 'unavailable';
            await screen.pressByTestIdAsync(openRow);
            if (accessUnavailable) {
                const { BrowserLocalPreviewElsewhere } = await import('@/components/browser/frame/BrowserLocalPreviewElsewhere');
                await expect.poll(() => screen.findAllByType(BrowserLocalPreviewElsewhere).length).toBe(1);
                expect(screen.findAllByType('iframe')).toHaveLength(0);
            } else await expect.poll(() => screen.findByType('iframe').props.src).toBe(servicePreview.accessUrl);
            const state: React.ComponentProps<typeof BrowserShell>['state'] = screen.findByType(BrowserShell).props.state;
            expect(Object.values(state.viewsById).map(view => view.target.kind)).toEqual(['localServicePreview']);
            expect(runtime.pane.scopeState?.details.tabs.map(tab => tab.key)).toEqual([originalTabKey]);
            expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT)).toHaveLength(previewReads);
            // Each explicit Service open already obtains admission; returning the mounted
            // view must not add another registration or snapshot read of its own.
            expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)).toHaveLength(previewAdmissions + 1);
        } finally { await screen.unmount(); }
    });
    it.each(['session', 'workspace'] as const)('keeps Local-services reads and watches closed for a file-only %s Details owner', async owner => {
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a' })]);
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, machineId: 'machine-a' } }]);
        const screen = await renderScreen(<runtime.Wrapper>{owner === 'session'
            ? <RegisteredSessionDetails sessionId="session-a" routeServerId={runtime.serverId} scopeId="session:session-a" />
            : <WorkspaceDetailsPanel workspaceRef={{ id: 'workspace-a', serverId: runtime.serverId, machineId: 'machine-a',
                rootPath: '/repo', createdAtMs: 1 }} scopeId="session:session-a" />}</runtime.Wrapper>);
        try {
            await act(async () => runtime.pane.openDetailsTab({ key: 'file:a.txt', kind: 'file', title: 'a.txt',
                resource: { kind: 'file', path: 'a.txt' } }, { intent: 'pinned' }));
            await flushHookEffects({ cycles: 40 });
            expect(serviceMethods).toEqual([]);

            const browser = createBrowserLaunchpadDetailsTab();
            await act(async () => runtime.pane.openDetailsTab(browser, { intent: 'pinned' }));
            // Declaration hydration is independent of the inventory scan. A duplicate
            // Browser bootstrap would issue another launcher read before this reply.
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length,
                { message: JSON.stringify(serviceRequests.filter(request => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)) }).toBe(1);
            expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH)).toEqual([]);
            inventoryRead.resolve();
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(1);
            // The first completed inventory scan reconciles that declaration exactly once.
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length).toBe(2);
            await expect.poll(() => getLocalServicePreviewState({ machineId: 'machine-a', serverId: runtime.serverId,
                accountId: runtime.accountScope?.accountId }))
                .toMatchObject({ generatedAt: 3_000, refreshState: 'idle' });
            await act(async () => runtime.pane.setActiveDetailsTab('file:a.txt'));
            await flushHookEffects();
            const hiddenMethods = [...serviceMethods];
            await flushHookEffects();
            expect(serviceMethods).toEqual(hiddenMethods);
            await act(async () => runtime.pane.setActiveDetailsTab(browser.key));
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(2);
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length).toBe(3);
        } finally { inventoryRead.resolve(); await screen.unmount(); }
    });
    it.each([true, false])('honors supplied launcher state and explicit null without ambient reads (rows: %s)', async supplied => {
        const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a' })]);
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, machineId: 'machine-a' } }]);
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 3_000,
            targets: [{
                id: 'inventory:session-browser-feed', source: 'inventory_entry',
                sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'session-browser-feed' },
                machineId: 'machine-a', sessionId: 'session-a', title: 'Session browser feed',
                subtitle: 'localhost:5173', confidence: 'high', state: 'available', actions: [],
                browserTarget: {
                    kind: 'localServicePreview', targetId: 'preview-session-browser-feed',
                    sessionId: 'session-a', machineId: 'machine-a',
                },
            }],
        });
        const screen = await renderScreen(<runtime.Wrapper>
            <RegisteredSessionDetails sessionId="session-a" routeServerId={runtime.serverId}
                scopeId="session:session-a" nowMs={() => 4_000}
                localServiceLauncherState={supplied ? launcherState : null} localServicePreviewState={null} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' }));
        await flushHookEffects();
        if (supplied) expect(screen.getTextContent()).toContain('Session browser feed');
        else expect(screen.getTextContent()).not.toContain('Session browser feed');
        expect(serviceMethods).toEqual([]);
        await screen.unmount();
    });
});
