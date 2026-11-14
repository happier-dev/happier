// Cross-app composition keeps the real daemon/server path in this test without
// adding their source and package-local aliases to the UI compiler program.
import * as React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, invokeTestInstanceHandler, renderHook, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { encodeBase64 } from '@/encryption/base64';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control';
import { BrowserContextItemV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { BrowserEventBatchV1Schema, BrowserEventV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { BrowserAutomationActionResultV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { MachineLiveStreamDecodedEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context/managedChromiumAnnotationProvider';
import { useBrowserAnnotationController } from '@/components/browser/annotation/useBrowserAnnotationController';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DaemonMachineLiveStreamRelayStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { MachineLiveStreamRelayAuthorizationV1Schema, MachineLiveStreamSourceAdmissionV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SocketRpcSessionBrowserAuthorizationContextSchema, type SocketRpcSessionBrowserAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { createMachineLiveStreamRelayAuthorizationSigningInputV1, MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { openMachineLiveStreamEnvelopeV1, sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import tweetnacl from 'tweetnacl';
import { selectBrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber, type BrowserSidecarCdpControlTransport } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapter';
import { createBrowserSidecarCdpControlAdapterFactory } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapterFactory';
import { createBrowserAutomationDaemonService } from '../../../../../cli/src/daemon/browser/automation/service';
import { createBrowserAutomationCdpAdapter } from '../../../../../cli/src/daemon/browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../../../../../cli/src/daemon/browser/automation/adapters/controlBridge';
import { createBrowserCdpScreencastProducer } from '../../../../../cli/src/daemon/browser/capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../../../../../cli/src/daemon/browser/capture/registration';
import { createMachineLiveStreamCaptureRegistry } from '../../../../../cli/src/daemon/peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../../../../cli/src/daemon/peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamRelayTerminator } from '../../../../../cli/src/daemon/peer/mediation/stream/relay';
import { createProductBrowserSidecarControlAdapterFactory } from '../../../../../cli/src/daemon/browser/sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../../../../../cli/src/daemon/browser/sidecar/launchOwner';
import { createBrowserProfileStore } from '../../../../../cli/src/daemon/browser/profiles/store';
import { createBrowserStoragePartitionOwner } from '../../../../../cli/src/daemon/browser/storage/partitions';
import { createBrowserDaemonControlBroker } from '../../../../../cli/src/daemon/browser/control/broker';
import { RuntimeActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createBrowserDaemonRuntimeActionExecutor } from '../../../../../cli/src/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '../../../../../cli/src/daemon/browser/featureGate';
import { createBrowserDaemonControlRoutes } from '../../../../../cli/src/daemon/browser/control/routes';
import { resolveBrowserRecordingStartContext } from '../../../../../cli/src/daemon/browser/recording/startContext';
import { resolveBrowserRecordingControl } from '../recording/browserRecordingControl';
import { createBrowserRecordingState } from '@/sync/domains/browser/recording';
import { selectBrowserContextComposerAttachments } from '@/sync/domains/browser/context/selectors';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Static cross-app imports also load Socket.IO; keep that external boundary installed from collection.
vi.mock('socket.io-client', async importOriginal => {
    const { createSessionOpsSocketIoClientBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
    return createSessionOpsSocketIoClientBoundary(importOriginal);
});
const clipboardBoundary = vi.hoisted(() => ({ text: '  pasted text\n' }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => clipboardBoundary.text }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createMeasuredImageMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Image: createMeasuredImageMock({ width: 780, height: 493 }) });
});
// Genuine persistence boundary: real server Machine admission evaluates these rows.
vi.mock('../../../../../server/sources/storage/db', async () => {
    const { createMachineAdmissionPersistenceBoundary } = await import('../../../../../server/sources/app/api/testkit/machineAdmissionPersistenceBoundary');
    return { db: createMachineAdmissionPersistenceBoundary(() => home.accountId).db };
});

// Network boundaries only: the machine RPC transport (daemon discovery) and the viewer relay socket.
const boundary = vi.hoisted(() => ({
    views: [] as unknown[],
    sent: [] as unknown[],
    listeners: new Set<(raw: unknown) => void>(),
    requests: [] as unknown[],
    captureResult: null as unknown,
    diagnosticsSnapshot: null as unknown,
    actionDispatch: null as ((actionId: string, input: unknown) => Promise<unknown>) | null,
    discoveryError: null as string | null,
    /** Holds daemon discovery open until released, to observe the wait before it answers. */
    discoveryGate: null as Promise<void> | null,
    watchViews: null as ((input: { payload?: unknown; signal?: AbortSignal }) => Promise<unknown>) | null,
    disconnect: vi.fn(async () => undefined),
    relaySend: null as ((raw: unknown) => void) | null,
    maxFrameBytes: undefined as number | undefined,
    sourceAdmission: null as ((payload: unknown) => Promise<unknown>) | null,
    startRelay: null as ((payload: unknown) => Promise<unknown>) | null,
    sharedViewer: false as false | 'use' | 'manage',
    sessionBrowserAccess: null as SocketRpcSessionBrowserAuthorizationContext | null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string; payload?: unknown; signal?: AbortSignal }) => {
        boundary.requests.push(input);
        if (input.method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT && boundary.sourceAdmission) return boundary.sourceAdmission(input.payload);
        if ((input.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START
            || input.method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START) && boundary.startRelay) return boundary.startRelay(input.payload);
        if (input.method === 'daemon.browser.view.watch' && boundary.watchViews) return boundary.watchViews(input);
        if (input.method === 'daemon.browser.view.list' && boundary.discoveryGate) await boundary.discoveryGate;
        if (input.method === 'daemon.browser.view.list') return boundary.discoveryError
            ? { error: 'Browser prerequisite', errorCode: boundary.discoveryError }
            : { protocolVersion: 1, views: boundary.views };
        if (input.method === 'daemon.browser.context.dispatch') return { protocolVersion: 1, result: boundary.captureResult };
        if (input.method === RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT && boundary.diagnosticsSnapshot) return boundary.diagnosticsSnapshot;
        if (input.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) {
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(input.payload);
            return { protocolVersion: 1, result: { ok: true, streamId: startRequest.streamId } };
        }
        throw new Error('offline');
    },
}));

const webStorage = installLocalStorageMock();
const webLocks = installWebLockManagerMock();
const network = await installSessionOpsNetworkBoundary();
const home = await network.addHome('https://browser-stream.test', 'browser-stream-account');
const serverId = home.id;
// Settle the real lazy transport graph during collection, then await admission below.
await import('@/sync/domains/machines/peer/mediation/stream/productionRoute');
await import('@/sync/domains/machines/peer/mediation/stream/relayStartRpc');
// Load the surface graph during collection, outside the measured frame loop.
const { BrowserSurfaceHost } = await import('../surfaces/BrowserSurfaceHost');
const { BrowserShell } = await import('../BrowserShell');
const { BrowserStreamedTarget } = await import('../adapters/BrowserStreamedTarget');
const { LiveStreamPlayer } = await import('@/components/stream/LiveStreamPlayer');
const { useSessionBrowserContextRuntime } = await import('@/components/sessions/browser/sessionBrowserContextRuntime');
const transferRuntime = await import('@/sync/domains/transfers/runtime/transferRuntime');
afterAll(async () => { await network.dispose(); webLocks.restore(); webStorage.restore(); });

async function waitForStreamAdmission(): Promise<void> {
    await act(async () => {
        await vi.waitFor(() => expect(boundary.requests).toContainEqual(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START,
        })));
    });
    await flushHookEffects();
}

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket', () => ({
    resolveServerScopedMachineLiveStreamRelaySocket: async () => ({
        machineId: 'machine_1',
        viewerId: 'viewer_1',
        socketId: 'tab_1',
        onSocketIdChange: () => () => {},
        sendEnvelope: (envelope: unknown) => { boundary.sent.push(envelope); boundary.relaySend?.(envelope); },
        onEnvelope: (listener: (raw: unknown) => void) => {
            boundary.listeners.add(listener); return () => { boundary.listeners.delete(listener); };
        },
        disconnect: boundary.disconnect,
    }),
}));

const view = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    target: { kind: 'externalUrl', targetId: 't', url: 'http://localhost:5173/login' },
    platform: 'web',
    adapterKind: 'chromiumSidecar',
    engineKind: 'streamedSurface',
    adapterCapabilities: buildBrowserAdapterCapabilities({
        adapterKind: 'chromiumSidecar', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'],
    }),
    currentUrl: 'http://localhost:5173/login', currentUrlExpiresAt: null, pendingUrl: null, title: null, faviconUrl: null,
    loadingState: 'idle', loadingProgress: null, navigationGeneration: 0, canGoBack: false, canGoForward: false,
    securityOrigin: null, lastError: null, openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
} as unknown as BrowserControlViewState;

function daemonView(captureSource?: Record<string, unknown>) {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        sourceId: 'browser-view-key-1',
        target: view.target,
        platform: 'web',
        adapterKind: 'chromiumSidecar',
        events: [BrowserEventV1Schema.parse({ kind: 'viewOpened', eventId: 'daemon-opened', occurredAt: 1,
            browserSessionId: view.browserSessionId, viewId: view.viewId, target: view.target,
            platform: view.platform, adapterKind: view.adapterKind, engineKind: view.engineKind,
            adapterCapabilities: view.adapterCapabilities, currentUrl: view.currentUrl })],
        ...(captureSource ? { captureSource } : {}),
    };
}

describe('useBrowserStreamedSurfaceRuntime', () => {
    it('rediscovers the Session view when its Machine recovers, without reads for unrelated recovery', async () => {
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const { clearMachineRequestReachabilityForMachine } = await import('@/sync/domains/machines/reachability/machineReachability');
        boundary.discoveryError = 'request_failed';
        let state = createBrowserControlState();
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            browserSessionId: view.browserSessionId, view: state.viewsById[view.viewId] ?? null,
            machineId: 'machine_1', serverId,
            onBrowserEvent: event => { state = applyBrowserControlEvent(state, event); },
        }));
        try {
            await flushHookEffects();
            const requests = boundary.requests.length;
            await act(async () => { clearMachineRequestReachabilityForMachine({ serverId, accountId: home.accountId }, 'other'); });
            await flushHookEffects();
            expect(boundary.requests).toHaveLength(requests);
            boundary.discoveryError = null;
            boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
                supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
            await act(async () => { clearMachineRequestReachabilityForMachine({ serverId, accountId: home.accountId }, 'machine_1'); });
            await flushHookEffects();
            expect(state.viewsById[view.viewId]).toMatchObject({ engineKind: 'streamedSurface' });
        } finally { await hook.unmount(); }
    });
    it('rehydrates the daemon view after a launchpad host resets its empty seed', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const render = (surfaceKey: string) => <BrowserSurfaceHost
            browserSessionId="launchpad" platform="web" surfaceKey={surfaceKey}
            initialBrowserState={createBrowserControlState()}
            pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: 'machine_1', serverId }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true }} />;
        const screen = await renderScreen(render('resolving'));
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(screen.findByType(BrowserShell).props.state.viewsById[view.viewId]).toBeDefined();
            await screen.update(render('resolved'));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(screen.findByType(BrowserShell).props.state.viewsById[view.viewId]).toMatchObject({
                browserSessionId: view.browserSessionId, engineKind: 'streamedSurface',
            });
        } finally { await screen.unmount(); }
    });
    it('adopts daemon-opened views through scoped change push and releases hidden observation without polling', async () => {
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const broker = createBrowserDaemonControlBroker();
        const transport = { openPage: async () => ({ targetId: 'push-page', sessionId: 'push-cdp' }),
            dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}) };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'push-session', sidecarId: 'push-sidecar', transport });
        const unrelated = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'other-session', sidecarId: 'other-sidecar', transport });
        broker.registerAdapter(adapter);
        broker.registerAdapter(unrelated);
        let active = 0;
        const snapshot = () => broker.listViews('push-session').map(view => ({ ...view, captureSource: {
            v: 1, sourceId: view.sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
            inputMode: 'shared', sidebands: [], health: { status: 'available' },
        } }));
        boundary.views = [];
        boundary.watchViews = async ({ payload, signal }) => {
            const request = payload as { browserSessionId: string; knownViewIds: string[] };
            expect(request.browserSessionId).toBe('push-session');
            active += 1;
            try {
                await broker.watchViews({ ...request, signal });
                return { protocolVersion: 1, views: snapshot() };
            } finally { active -= 1; }
        };
        let state = createBrowserControlState();
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => useBrowserStreamedSurfaceRuntime({
            browserSessionId: 'push-session', view: null, machineId: 'machine_1', serverId, enabled,
            onBrowserEvent: event => { state = applyBrowserControlEvent(state, event); },
        }), { initialProps: { enabled: true } });
        try {
            await flushHookEffects();
            const requestsBefore = boundary.requests.length;
            await unrelated.dispatchCommand({ kind: 'openView', commandId: 'unrelated-open', browserSessionId: 'other-session',
                viewId: 'other-view', platform: 'web', target: { kind: 'externalUrl', targetId: 'other', url: 'https://other.test' } });
            await flushHookEffects();
            expect(boundary.requests).toHaveLength(requestsBefore);
            await act(async () => { await adapter.dispatchCommand({ kind: 'openView', commandId: 'approved-open',
                browserSessionId: 'push-session', viewId: 'approved-view', platform: 'web',
                target: { kind: 'externalUrl', targetId: 'approved', url: 'https://approved.test' } }); });
            await flushHookEffects();
            expect(state.viewsById['approved-view']).toMatchObject({ browserSessionId: 'push-session', engineKind: 'streamedSurface' });
            expect(active).toBe(1);
            expect(boundary.requests).toContainEqual(expect.objectContaining({ method: RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH,
                machineId: 'machine_1', serverId, accountId: home.accountId, operationTimeoutMs: null }));
            expect(boundary.requests.filter(request => (request as { method: string }).method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST)).toHaveLength(1);
            expect(boundary.requests.filter(request => (request as { method: string }).method === 'daemon.browser.view.watch')).toHaveLength(2);
            await hook.rerender({ enabled: false });
            await flushHookEffects();
            expect(active).toBe(0);
            const requestsWhileHidden = boundary.requests.length;
            await adapter.dispatchCommand({ kind: 'closeView', commandId: 'hidden-close', browserSessionId: 'push-session', viewId: 'approved-view' });
            await flushHookEffects();
            expect(boundary.requests).toHaveLength(requestsWhileHidden);
        } finally { await hook.unmount(); boundary.watchViews = null; adapter.dispose(); unrelated.dispose(); }
    });
    beforeEach(async () => {
        network.resetRequests();
        await network.addHome(home.serverUrl, home.accountId);
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/profile') {
                const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
                return Response.json(AccountProfileSchema.parse({ id: home.accountId }));
            }
            if (path !== '/v2/sessions/read-batch' && /^\/v2\/sessions\/[^/]+$/.test(path)) {
                const { createSessionAccessFixture, createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
                return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
                    id: decodeURIComponent(path.slice('/v2/sessions/'.length)), metadataLayoutVersion: 1,
                    metadata: null, ownerMetadataView: null, access: createSessionAccessFixture('edit'),
                })));
            }
            if (path === '/v1/machines/read-batch') {
                const { createMachineReadBatchResponseFixture, createPlainMachineRowFixture,
                    createPlainSharedMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
                return createMachineReadBatchResponseFixture(init?.body, id => boundary.sharedViewer
                    ? createPlainSharedMachineRowFixture({ id, custodianAccountId: 'machine-owner', role: boundary.sharedViewer })
                    : createPlainMachineRowFixture({ id, accountId: home.accountId }));
            }
            if (boundary.actionDispatch && /^\/v1\/actions\/browser\.(goBack|goForward|reload|stop|navigate)$/.test(path)) {
                const { ExternalActionRequestEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                return Response.json({ v: 1, actionId: path.slice('/v1/actions/'.length), requestId: envelope.requestId,
                    execution: { ok: true, result: await boundary.actionDispatch(path.slice('/v1/actions/'.length), envelope.input) } });
            }
            if (path === '/v1/features') {
                const base = createRootLayoutFeaturesResponse();
                return Response.json(createRootLayoutFeaturesResponse({
                    features: { machines: { ...base.features.machines, enabled: true,
                        liveStream: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: true } } },
                        ...(boundary.actionDispatch ? { browser: { enabled: true, internal: { enabled: true },
                            sidecar: { enabled: true }, viewTargets: { enabled: true }, diagnostics: { enabled: true } } } : {}) },
                    capabilities: { machines: { ...base.capabilities.machines,
                        liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
                }));
            }
            if (path !== '/v1/machines/peer/mediation/route-grants') return null;
            const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
            if (boundary.sharedViewer && !request.sourceAdmission) return Response.json({ ok: false, reasonCode: 'route_unavailable' });
            const admittedSource = request.sourceAdmission ? MachineLiveStreamSourceAdmissionV1Schema.parse(request.sourceAdmission) : null;
            const scope = DirectRouteGrantScopeV1Schema.parse(request.scope);
            if (scope.kind !== 'live_stream') throw new Error('Expected a live-stream grant');
            const { kind: _kind, ...streamScope } = scope;
            const now = Date.now();
            return Response.json({ ok: true, relayAuthorization: MachineLiveStreamRelayAuthorizationV1Schema.parse({
                payload: { v: boundary.sharedViewer ? 2 : 1, grantId: `grant:${scope.streamId}`, accountId: admittedSource?.payload.accountId ?? home.accountId,
                    ...(boundary.sharedViewer ? { viewerAccountId: home.accountId, sourceMachineInstallationId: 'installation',
                        personalSourceAdmission: admittedSource?.payload.liveStreamSourceAdmission } : {}),
                    ...(boundary.sessionBrowserAccess ? { sessionBrowserAccess: boundary.sessionBrowserAccess } : {}),
                    sourceMachineId: request.machineId, targetMachineId: request.targetMachineId,
                    flowKind: 'live_stream', routeKind: 'server_relay', ...streamScope,
                    ...(boundary.maxFrameBytes ? { maxFrameBytes: boundary.maxFrameBytes } : {}),
                    viewerSocketId: request.viewerSocketId, codecId: request.codecId, viewerCodecs: request.viewerCodecs,
                    iat: now, exp: now + DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream,
                    aud: 'happier-live-stream-relay-authorization' },
                signature: { keyId: 'network-boundary', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
            }) });
        });
        boundary.views = [];
        boundary.sent = [];
        boundary.listeners.clear();
        boundary.requests = [];
        boundary.captureResult = null;
        boundary.diagnosticsSnapshot = null;
        boundary.actionDispatch = null;
        boundary.discoveryError = null;
        boundary.discoveryGate = null;
        boundary.disconnect.mockClear();
        boundary.relaySend = null;
        boundary.maxFrameBytes = undefined;
        boundary.sourceAdmission = null;
        boundary.startRelay = null;
        boundary.sharedViewer = false;
        boundary.sessionBrowserAccess = null;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine_1', storageMode: 'plain' })],
            false, { sourceServerId: serverId });
    });

    it('renders the advertised daemon source when opened through the canonical workspace target', async () => {
        const { BrowserDaemonViewV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
        const { resolveBrowserDaemonStreamTarget } = await import('@/sync/domains/browser/store');
        const { resolveBrowserViewTargetOpen } = await import('../surfaces/openBrowserTargetInWorkspace');
        const { applyOpenDetailsTab, createEmptyPaneDetailsState } = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceReducer');
        const { readBrowserViewDetailsResource } = await import('../surfaces/browserSurfaceDetailsTabModel');
        const candidate = BrowserDaemonViewV1Schema.parse(daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } }));
        boundary.views = [candidate];
        const target = resolveBrowserDaemonStreamTarget(candidate);
        if (!target) throw new Error('Daemon source missing');
        const opened = resolveBrowserViewTargetOpen({ scope: 'sessionDetails', platform: 'web',
            browserFeatureDecision: { featureId: 'browser', state: 'enabled', blockedBy: null,
                blockerCode: 'none', diagnostics: [], evaluatedAt: 1, scope: { scopeKind: 'runtime' } },
        }, target);
        const openedView = opened.seededState.viewsById[opened.viewId];
        if (!openedView) throw new Error('Workspace view missing');
        const restored = readBrowserViewDetailsResource(JSON.parse(JSON.stringify(opened.tab.resource)));
        expect(restored).toMatchObject({ browserSessionId: candidate.browserSessionId, viewId: candidate.viewId, target });
        const firstOpen = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab: opened.tab, openAs: 'default' });
        const reopened = resolveBrowserViewTargetOpen({ scope: 'sessionDetails', platform: 'web' }, target);
        const secondOpen = applyOpenDetailsTab(firstOpen, { tab: reopened.tab, openAs: 'default' });
        expect(Object.values(secondOpen.tabsByKey)).toHaveLength(1);
        expect(secondOpen.tabsByKey[opened.tab.key]?.resource).toEqual(restored);
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view: openedView, machineId: 'machine_1', serverId }));
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(boundary.requests).toContainEqual(expect.objectContaining({
                method: RPC_METHODS.DAEMON_BROWSER_VIEW_LIST,
                payload: { machineId: 'machine_1', browserSessionId: candidate.browserSessionId },
            }));
            await waitForStreamAdmission();
            const streamId = hook.getCurrent()?.input?.streamId;
            expect(hook.getCurrent()?.input?.sourceId).toBe(candidate.sourceId);
            if (!streamId) throw new Error('Workspace source was not admitted');
            const bytes = new Uint8Array([1, 2, 3]);
            const envelope: MachineLiveStreamRelayEnvelopeV1 = { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1, timestampMs: 1,
                    codecId: 'image.mjpeg', payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                    payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } };
            await act(async () => { for (const listener of boundary.listeners) listener(envelope); });
            expect(hook.getCurrent()?.playerState?.lastFrameUrl).toBeTruthy();
            expect(openedView).toMatchObject({ browserSessionId: candidate.browserSessionId, viewId: candidate.viewId });
        } finally { await hook.unmount(); }
    });

    it.each(['web', 'android'] as const)('retains the daemon source when opened with scoped presentation defaults (%s)', async platform => {
        const { BrowserDaemonViewV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
        const { resolveBrowserDaemonStreamTarget, openBrowserTarget, createBrowserViewState } = await import('@/sync/domains/browser/store');
        const { resolveBrowserViewTargetReplacementTab } = await import('../surfaces/openBrowserTargetInWorkspace');
        const candidate = BrowserDaemonViewV1Schema.parse(daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } }));
        boundary.views = [candidate];
        const target = resolveBrowserDaemonStreamTarget(candidate);
        if (!target) throw new Error('Daemon source missing');
        const replacement = resolveBrowserViewTargetReplacementTab({ target,
            browserSessionId: 'scoped-presentation', viewId: 'presentation-view' });
        expect(replacement.resource).toMatchObject({ browserSessionId: candidate.browserSessionId, viewId: candidate.viewId });
        const opened = openBrowserTarget(createBrowserViewState(), target, {
            platform, browserSessionId: 'scoped-presentation', viewId: 'presentation-view',
        });
        const openedView = opened.viewsById[candidate.viewId];
        expect(openedView).toMatchObject({ browserSessionId: candidate.browserSessionId });
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view: openedView, machineId: 'machine_1', serverId }));
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            expect(hook.getCurrent()?.input?.sourceId).toBe(candidate.sourceId);
        } finally { await hook.unmount(); }
    });

    it('retains the managed-browser prerequisite for the surface and clears it after a successful retry', async () => {
        boundary.discoveryError = 'managed_package_missing';
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()).toMatchObject({ unavailableReason: 'managed_package_missing', connecting: false, playerState: null });
        expect(boundary.requests.some(request => (request as { method: string }).method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)).toBe(false);
        boundary.discoveryError = null;
        await act(async () => { hook.getCurrent()?.onRetry?.(); });
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()?.unavailableReason).toBeUndefined();
        await hook.unmount();
    });

    it('reports the managed-browser prerequisite before any view exists, so an empty Session Browser can explain it', async () => {
        boundary.discoveryError = 'managed_package_missing';
        boundary.watchViews = async () => ({ error: 'Unknown method', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId,
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()).toMatchObject({ unavailableReason: 'managed_package_missing', playerState: null });
        const reads = boundary.requests.length;
        await flushHookEffects();
        expect(boundary.requests).toHaveLength(reads);
        expect(boundary.requests.filter(request => (request as { method: string }).method === RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH)).toHaveLength(1);
        await hook.unmount();
        boundary.watchViews = null;
    });

    it('reports the typed first open before any view exists, and keeps Connecting for a dispatched open until discovery settles', async () => {
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const preparing = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId, firstUse: { kind: 'preparing' },
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(preparing.getCurrent()).toMatchObject({ firstUse: 'preparing', playerState: null });
        await preparing.unmount();

        // An open still running past provisioning is Connecting, and the page it names reaches the chrome.
        const connecting = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId,
            firstUse: { kind: 'connecting', targetUrl: 'http://localhost:5173/login' },
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(connecting.getCurrent()).toMatchObject({ firstUse: 'opening', firstUseTargetUrl: 'http://localhost:5173/login' });
        await connecting.unmount();

        const failed = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId, firstUse: { kind: 'sandboxUnavailable' },
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(failed.getCurrent()).toMatchObject({ firstUse: 'sandboxUnavailable' });
        await failed.unmount();

        // The open went through: its page is Connecting while discovery looks, and the state ends once it settles.
        let release!: () => void;
        boundary.discoveryGate = new Promise<void>((resolve) => { release = resolve; });
        const dispatched = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId, firstUse: { kind: 'dispatched' },
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(dispatched.getCurrent()).toMatchObject({ firstUse: 'opening' });
        boundary.discoveryGate = null;
        release();
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(dispatched.getCurrent()).toBeNull();
        await dispatched.unmount();
    });

    it('stays silent without a view when discovery succeeds or fails for any other reason', async () => {
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const quiet = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId,
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(quiet.getCurrent()).toBeNull();
        await quiet.unmount();
        boundary.discoveryError = 'request_failed';
        const failed = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId,
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(failed.getCurrent()).toBeNull();
        await failed.unmount();
    });

    it.each([
        { role: 'owner', browserOwner: 'self' },
        { role: 'use', browserOwner: 'self' },
        { role: 'manage', browserOwner: 'foreign' },
        { role: 'use', browserOwner: 'foreign' },
        { role: 'use', browserOwner: 'other-guest' },
    ] as const)('streams only the admitted $role viewer’s accessible $browserOwner Session profile', async ({ role, browserOwner }) => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-recording-profile-'));
        const profiles = createBrowserProfileStore({ storageRootDirectory: directory,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: directory }) });
        const cdpListeners = new Set<BrowserSidecarCdpEventSubscriber>();
        let captureStarted = false;
        const factory = createProductBrowserSidecarControlAdapterFactory({ platform: 'linux', profileStore: profiles,
            readSessionAccountId: (sessionId: string) => sessionId === view.browserSessionId
                ? browserOwner === 'self' ? home.accountId : browserOwner === 'foreign' ? 'machine-owner' : 'other-guest'
                : null,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                // Only the Chromium process and its CDP connection are system boundaries.
                spawnProcess: () => {
                    const child = new EventEmitter();
                    const stderr = new EventEmitter();
                    queueMicrotask(() => stderr.emit('data', 'DevTools listening on ws://127.0.0.1:9444/devtools/browser/test\n'));
                    return Object.assign(child, { pid: 123, stderr, stdio: [null, null, null, new PassThrough(), new PassThrough()],
                        kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
                },
                connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'page', sessionId: 'cdp' }),
                    dispatchPageCommand: async ({ method }) => { if (method === 'Page.startScreencast') captureStarted = true; return {}; },
                    dispatchBrowserCommand: async () => ({ success: true }),
                    subscribeCdpEvents: listener => { cdpListeners.add(listener); return () => { cdpListeners.delete(listener); }; } } }),
            }) });
        const runtime = await factory({ machineId: 'machine_1', readMachineMemory: () => ({ reported: true,
            totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedBytes: 0,
            pressure: { level: 'calm', source: 'none' } }) });
        if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed runtime unavailable');
        const registry = createMachineLiveStreamCaptureRegistry();
        const producer = createBrowserCdpScreencastProducer({ contextCapture: runtime.contextCapture });
        const registration = registerBrowserLiveCapture({ registry, contextCapture: runtime.contextCapture, producer, automation: () => null });
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(runtime.adapter);
        const routes = createBrowserDaemonControlRoutes({ broker, captureRegistry: registry });
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine_1', storageMode: 'plain',
            ...(role !== 'owner' ? { isShared: true, access: { custodian: { accountId: 'machine-owner', displayName: 'Owner' },
                role, resourceMode: 'plain', accessState: 'ready' } } : {}),
        })], false, { sourceServerId: serverId });
        const { MachineInstallationIdentityV1Schema } = await import('@happier-dev/protocol/machines/identity/installationIdentity');
        const keys = tweetnacl.sign.keyPair();
        const installation = MachineInstallationIdentityV1Schema.parse({ version: 1, installationId: 'installation', createdAt: 0,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const admission = { machineId: 'machine_1', installationId: 'installation', actorAccountId: home.accountId,
            custodianAccountId: 'machine-owner', role: role === 'owner' ? 'manage' as const : role, encryptionMode: 'plain' as const };
        const identityStore = await import('../../../../../cli/src/daemon/identity/store');
        // Substitute the installed identity's filesystem read, never its signing or RPC owners.
        const installationRead = vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
        const { ApiMachineClient } = await import('../../../../../cli/src/api/apiMachine');
        const { RpcHandlerManager } = await import('../../../../../cli/src/api/rpc/RpcHandlerManager');
        const client = new ApiMachineClient(home.token, { id: 'machine_1', encryptionMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined,
            { resolveCurrentServerIdentityId: () => serverId });
        const rpc: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (!(rpc instanceof RpcHandlerManager)) throw new Error('Machine RPC owner missing');
        const rpcContext = { verifiedPeerAuthority: 'present_user' as const,
            // The Machine RPC network boundary supplies its completed ingress admission.
            // Real HTTP admission and grant verification are composed in the server SQLite test.
            admissionResult: { ok: true as const },
            rpcContext: { machineAdmission: admission, verifyMachineAdmissionCurrent: async () => true } };
        boundary.sourceAdmission = payload => rpc.invokeLocal(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT, payload, rpcContext);
        client.replaceDevicesRoleRoutes({ browserControl: routes });
        boundary.sharedViewer = role === 'owner' ? false : role;
        const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_1', nowMs: Date.now,
            accountId: 'machine-owner', sourceMachineInstallationId: 'installation',
            resolveRelayAuthorizationTrustRoots: () => [{ keyId: 'viewer-test', publicKey: installation.publicKey }],
            captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry),
            emitEnvelope: envelope => { for (const listener of boundary.listeners) listener(envelope); } });
        client.registerLiveStreamRelayRoutes(relay);
        boundary.startRelay = async payload => {
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(payload);
            // The HTTP boundary returns the grant; the production daemon still verifies its signature.
            if (startRequest.authorization) startRequest.authorization.signature = { keyId: 'viewer-test', alg: 'Ed25519',
                valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(
                    startRequest.authorization.payload)), keys.secretKey)).toString('base64url') };
            return rpc.invokeLocal(startRequest.authorization?.payload.v === 2
                ? RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START : RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START,
                { protocolVersion: 1, machineId: 'machine_1', startRequest }, rpcContext);
        };
        let unmount: (() => Promise<void>) | undefined;
        try {
            const opened = await routes.dispatchCommand({ kind: 'openView', commandId: 'action-open', browserSessionId: view.browserSessionId,
                viewId: view.viewId, platform: 'web', target: view.target, focus: true });
            expect(opened).toMatchObject({ status: 'dispatched' });
            boundary.views = [...routes.listViews(view.browserSessionId)];
            const profile = profiles.listProfiles()[0];
            if (!profile) throw new Error('Managed profile missing');
            const { recordingCapabilities } = resolveBrowserRecordingStartContext({ hasCdpScreencast: true,
                hasFrameEncoder: true, hasNativeViewCapture: false, hasLiveStreamCaptureRegistry: false })({
                browserSessionId: view.browserSessionId, viewId: view.viewId, profileId: profile.profileId,
                targetKind: 'externalUrl', adapterKind: 'chromiumSidecar', renderEngineKind: 'streamedSurface',
                captureKind: 'cdpScreencast', fidelity: 'cdp', navigationGeneration: 0,
                mimeType: 'video/webm', retentionClass: 'preSend' });
            const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
            const hook = await renderHook(() => {
                const [state, setState] = React.useState(createBrowserControlState);
                const activeView = state.viewsById[view.viewId] ?? null;
                const picture = useBrowserStreamedSurfaceRuntime({ view: activeView, browserSessionId: view.browserSessionId,
                    machineId: 'machine_1', serverId,
                    onBrowserEvent: event => setState(previous => applyBrowserControlEvent(previous, event)) });
                const control = resolveBrowserRecordingControl({ view: activeView,
                    profileId: state.sessionsById[view.browserSessionId]?.profileId ?? null,
                    state: createBrowserRecordingState(), recordingCapabilities, enabled: true });
                return { state, control, picture };
            });
            unmount = () => hook.unmount();
            await flushHookEffects({ cycles: 6, turns: 6 });
            if (role === 'use' && browserOwner !== 'self') {
                // A guest can present a known/stale source id directly. The mounted viewer must
                // fail admission even when discovery previously supplied that exact source.
                await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().picture?.playerState?.diagnostic?.reasonCode)
                    .toBe('capture_source_denied')); });
                expect(captureStarted).toBe(false);
                expect(boundary.requests).not.toContainEqual(expect.objectContaining({
                    method: RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START,
                }));
                expect(routes.listViews(view.browserSessionId, { machineAdmission: admission })).toEqual([]);
                expect(await routes.dispatchCommand({ kind: 'navigate', commandId: 'foreign-drive',
                    browserSessionId: view.browserSessionId, viewId: view.viewId, url: 'https://attacker.test/' },
                    { machineAdmission: admission })).toMatchObject({ status: 'failed', error: { code: 'profile_policy_denied' } });
                return;
            }
            await act(async () => { await vi.waitFor(() => expect(boundary.requests).toContainEqual(expect.objectContaining({
                method: role === 'owner' ? RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START : RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START,
            }))); });
            await act(async () => { await vi.waitFor(() => expect(captureStarted,
                JSON.stringify(hook.getCurrent().picture?.playerState)).toBe(true)); });
            await act(async () => { for (const listener of cdpListeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp',
                params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } }); });
            await flushHookEffects();
            expect(hook.getCurrent().picture?.playerState?.lastFrameUrl).toBeTruthy();
            if (role !== 'owner') {
                await profiles.registerPersistentProfile({ profileId: 'owner-login', storageMode: 'user',
                    owner: { kind: 'user', id: 'machine-owner' }, cleanupOnSessionClose: false });
                const privateView = { browserSessionId: 'owner-private-browser', viewId: 'private-view' };
                expect(await routes.dispatchCommand({ kind: 'openView', commandId: 'owner-open', ...privateView,
                    platform: 'web', target: view.target, profileId: 'owner-login' })).toMatchObject({ status: 'dispatched' });
                expect(await boundary.sourceAdmission?.({ protocolVersion: 1, machineId: 'machine_1',
                    sourceId: browserViewKey(privateView), streamFamily: 'browser.streamed' }))
                    .toMatchObject({ result: { ok: role === 'manage', ...(role === 'use' ? { reasonCode: 'capture_source_denied' } : {}) } });
            }
            expect(hook.getCurrent().state.sessionsById[view.browserSessionId]?.profileId).toBe(profile.profileId);
            expect(hook.getCurrent().control.unavailable).toBeNull();
            expect(hook.getCurrent().control.startRequest).toMatchObject({ profileId: profile.profileId,
                adapterKind: 'chromiumSidecar', captureKind: 'cdpScreencast', mimeType: 'video/webm' });
            expect(opened.status === 'dispatched' && opened.events).toContainEqual(expect.objectContaining({
                kind: 'sessionCreated', profileId: profile.profileId, browserSessionId: view.browserSessionId }));
        } finally {
            await unmount?.();
            registration.dispose();
            await relay.dispose();
            await runtime.dispose?.();
            await client.shutdown();
            installationRead.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('discovers the session Chromium view on web and retains its annotation capture route before a view is seeded', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        boundary.captureResult = BrowserContextItemV1Schema.parse({ v: 1, kind: 'browserScreenshot',
            contextId: 'captured', sourceViewId: 'view_1', sourceAdapterKind: 'chromiumSidecar', fidelity: 'cdp',
            capturedAtMs: 1, navigationGeneration: 0, lifecycleState: 'available', redactionLevel: 'none',
            viewport: { width: 400, height: 300 },
            media: { mediaId: 'capture_1', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4,
                file: { sessionId: 'browser_session_1', storage: 'daemon', path: 'images/capture.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } } });
        const captureProvider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId,
            machineHappyHomeDir: '/machine-home' });
        // Only the pixel transfer and browser URL APIs are replaced; the Session host, Action
        // executor, managed capture provider and shared frozen-draft owner remain real.
        const download = vi.spyOn(transferRuntime, 'downloadDaemonWorkspaceFileToDestination').mockImplementation(async ({ destination }) => {
            await destination.writeBytes(new Uint8Array([137, 80, 78, 71]));
            await destination.close();
            return { ok: true };
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unseeded-browser');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const accountScope = { serverId, accountId: home.accountId };
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        let unmount: (() => Promise<void>) | undefined;
        try {
            const hook = await renderHook(() => {
                const [state, setState] = React.useState(createBrowserControlState);
                const activeView = state.viewsById.view_1 ?? null;
                useBrowserStreamedSurfaceRuntime({ view: activeView, machineId: 'machine_1', serverId,
                    browserSessionId: 'browser_session_1',
                    onBrowserEvent: event => setState(previous => applyBrowserControlEvent(previous, event)) });
                const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 'session_1', accountScope,
                    attachmentsUploadsEnabled: true, annotationCaptureProvider: captureProvider });
                if (!runtime) throw new Error('Session browser context missing');
                const annotation = useBrowserAnnotationController({ activeView,
                    activeViewNavigationKey: activeView ? `${activeView.viewId}:${activeView.navigationGeneration}` : '',
                    browserContext: { ...runtime.browserShellContext, managedAnnotationCaptureProvider: true } });
                return { state, context: runtime.state, annotation };
            });
            unmount = () => hook.unmount();
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(hook.getCurrent().state.viewsById.view_1).toMatchObject({ browserSessionId: 'browser_session_1', adapterKind: 'chromiumSidecar',
                target: { kind: 'streamedBrowser', streamId: 'browser-view-key-1' }, engineKind: 'streamedSurface',
                adapterCapabilities: { supportsStreamingDisplay: true, navigation: { canNavigate: true } } });
            expect(boundary.requests).toContainEqual(expect.objectContaining({
                payload: { machineId: 'machine_1', browserSessionId: 'browser_session_1' },
            }));
            expect(hook.getCurrent().annotation.captureCapability).toEqual({ available: true, fidelity: 'cdp' });
            await act(async () => { hook.getCurrent().annotation.start(); });
            await waitForTestEvent(hook.subscribe, () => hook.getCurrent().annotation, annotation => !annotation.capturePending);
            expect(hook.getCurrent().annotation.editorActive).toBe(true);
            expect(hook.getCurrent().annotation.draft).toMatchObject({ source: {
                uri: 'data:image/png;base64,iVBORw==', width: 800, height: 600, scale: 2,
            }, document: { image: { width: 800, height: 600, scale: 2 }, marks: [] } });
            // Starting freezes once; only Attach may flatten/upload and append composer context.
            expect(hook.getCurrent().context.attachmentOrder).toHaveLength(0);
            expect(download).toHaveBeenCalledOnce();
            expect(download).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine_1', serverId, rootPath: '/machine-home' }));
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:unseeded-browser');
            expect(boundary.requests).toContainEqual(expect.objectContaining({ method: 'daemon.browser.context.dispatch',
                payload: expect.objectContaining({ machineId: 'machine_1', actionId: 'browser.context.captureScreenshot',
                    input: expect.objectContaining({ browserSessionId: 'browser_session_1', viewId: 'view_1' }) }) }));
            expect(boundary.requests.filter(request => (request as { method: string }).method === 'daemon.browser.context.dispatch')).toHaveLength(1);
            await act(async () => { hook.getCurrent().annotation.cancel(); });
            await waitForTestEvent(hook.subscribe, () => hook.getCurrent().annotation, annotation => !annotation.editorActive);
            expect(hook.getCurrent().annotation.editorActive).toBe(false);
            expect(hook.getCurrent().annotation.draft).toBeNull();
        } finally {
            await unmount?.();
            download.mockRestore();
            createObjectURL.mockRestore();
            revokeObjectURL.mockRestore();
        }
    });

    it('reports the agent\'s browser unavailable when the daemon has no capture source for the view (never guessed)', async () => {
        boundary.views = [daemonView()];
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()).toMatchObject({ connecting: false, playerState: null, input: null });
    });

    it('opens the exact discovered source and routes viewer input back to it as sideband controls', async () => {
        boundary.views = [daemonView({
            v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
            inputMode: 'shared', sidebands: [], health: { status: 'available' },
        })];
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId }));
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();

        const input = hook.getCurrent()?.input;
        expect(input).toMatchObject({ sourceId: 'browser-view-key-1' });
        expect(input?.streamId).toContain('browser-view-key-1');
        await act(async () => {
            input?.send({ v: 1, streamId: input.streamId, sourceId: input.sourceId, eventId: 'e1', kind: 'tap', x: 0.5, y: 0.5 });
        });
        expect(boundary.sent).toContainEqual(expect.objectContaining({
            sourceMachineId: 'machine_1',
            viewerSocketId: 'tab_1',
            message: { kind: 'sideband_control', control: expect.objectContaining({ kind: 'tap', sourceId: 'browser-view-key-1' }) },
        }));
    });

    it.each(['view', 'edit'] as const)('uses the shared Session capability for Browser controls while keeping frames (%s)', async level => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createSessionFixture, createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        storage.getState().applySessions([createSessionFixture({ id: view.browserSessionId, serverId,
            metadataLayoutVersion: 1, metadata: null, ownerMetadataView: null,
            access: createSessionAccessFixture(level) })]);
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const state = { ...createBrowserControlState(), viewsById: { [view.viewId]: view } };
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web"
            initialBrowserState={state} testID="shared-browser"
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: 'machine_1', serverId }} />);
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const picture = screen.findByType(BrowserStreamedTarget).props.runtime;
            if (level === 'view') expect(picture.input).toBeNull();
            else expect(picture.input).toMatchObject({ sourceId: 'browser-view-key-1' });
            expect(screen.findByTestId('shared-browser-reload')?.props.disabled).toBe(level === 'view');
            if (level === 'view') expect(screen.findByTestId('shared-browser-viewport')).toBeNull();
            const streamId = (boundary.requests.find(request => (request as { method: string }).method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) as {
                payload: { startRequest: { streamId: string } } }).payload.startRequest.streamId;
            await act(async () => {
                const envelope: MachineLiveStreamRelayEnvelopeV1 = { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                    message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1, timestampMs: 1,
                        codecId: 'image.mjpeg', payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                        payloadBase64: 'AQID', payloadSizeBytes: 3 } } };
                for (const listener of boundary.listeners) listener(envelope);
            });
            expect(screen.findByType(LiveStreamPlayer).props.state.lastFrameUrl).toBeTruthy();
        } finally { await screen.unmount(); }
    });

    it.each(['view', 'edit'] as const)('uses the shared Session capability to discover and stream without a Machine target or grant (%s)', async level => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createSessionFixture, createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        storage.getState().applyMachines([], true, { sourceServerId: serverId });
        storage.getState().applySessions([createSessionFixture({ id: view.browserSessionId, serverId,
            metadataLayoutVersion: 1, metadata: null, ownerMetadataView: null,
            access: createSessionAccessFixture(level) })]);
        boundary.sharedViewer = 'use';
        boundary.sessionBrowserAccess = SocketRpcSessionBrowserAuthorizationContextSchema.parse({
            kind: 'session.browser', sessionId: view.browserSessionId, actorAccountId: home.accountId,
            custodianAccountId: 'machine-owner', machineId: 'machine_1', installationId: 'installation',
            effectiveAccess: { v: 1, level, sources: [{ kind: 'direct', shareId: 'browser-share' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
                    grants: [{ accessLevel: level, canApprovePermissions: false }] }) },
        });
        const source = { v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } };
        network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST) return {
                protocolVersion: 1, machineId: 'machine_1', views: [daemonView(source)],
            };
            if (request.method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT) return {
                protocolVersion: 1, result: { ok: true, sourceAdmission: {
                    payload: { version: 1, machineId: 'machine_1', installationId: 'installation', accountId: 'machine-owner',
                        liveStreamSourceAdmission: { homeServerIdentityId: serverId, actorAccountId: home.accountId,
                            streamFamily: 'browser.streamed', sourceId: source.sourceId, sourceOccurrenceId: 'occurrence',
                            sessionBrowserSessionId: view.browserSessionId } },
                    proof: { version: 1, algorithm: 'ed25519', signature: Buffer.alloc(64, 1).toString('base64url') },
                } },
            };
            if (request.method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START) {
                const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.payload);
                return { protocolVersion: 1, result: { ok: true, streamId: startRequest.streamId } };
            }
            if (request.method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH) {
                const { DaemonBrowserControlDispatchRequestV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
                const { command } = DaemonBrowserControlDispatchRequestV1Schema.parse(request.payload);
                return { protocolVersion: 1, result: { v: 1, commandId: command.commandId, status: 'dispatched',
                    adapterKind: 'chromiumSidecar', events: [] } };
            }
            return { error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
        const { useBrowserDaemonControlTransport } = await import('@/sync/domains/browser/control');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const initialBrowserState = { ...createBrowserControlState(), viewsById: { [view.viewId]: view } };
        function SharedBrowser() {
            const sendDaemonCommand = useBrowserDaemonControlTransport({ sessionId: view.browserSessionId, serverId });
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            if (!binding) return null;
            return <BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web" testID="shared-session-browser"
                initialBrowserState={initialBrowserState}
                pluginAccountLifetime={binding}
                sendDaemonCommand={sendDaemonCommand}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
                pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: null, serverId }} />;
        }
        const screen = await renderScreen(<SharedBrowser />);
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await network.waitForRpcRequest(request => request.method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST
                && request.targetId === view.browserSessionId);
            const started = await network.waitForRpcRequest(request => request.method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START);
            await flushHookEffects();
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(started.payload);
            const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse({ v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                message: { kind: 'frame', frame: { v: 1, streamId: startRequest.streamId, sequence: 1, timestampMs: 1,
                    codecId: 'image.mjpeg', payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } } });
            await act(async () => { for (const listener of boundary.listeners) listener(envelope); });
            expect(screen.findByType(LiveStreamPlayer).props.state.lastFrameUrl).toBeTruthy();
            const picture = screen.findByType(BrowserStreamedTarget).props.runtime;
            if (level === 'view') expect(picture.input).toBeNull();
            else {
                expect(picture.input).toMatchObject({ sourceId: source.sourceId });
                await screen.pressByTestId('shared-session-browser-reload');
                const dispatched = await network.waitForRpcRequest(request => request.method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH);
                expect(dispatched.payload).toMatchObject({ command: { kind: 'reload',
                    browserSessionId: view.browserSessionId, viewId: view.viewId } });
            }
            expect(network.requests.every(request => request.targetId === view.browserSessionId)).toBe(true);
            expect(boundary.requests).toEqual([]);
            expect(network.httpRequests.some(request => new URL(request.url).pathname.startsWith('/v1/machines/')
                && !request.url.endsWith('/route-grants'))).toBe(false);
        } finally { await screen.unmount(); }
    });

    it.each(['inline', 'retained'] as const)('keeps frame updates below the Browser shell while the real player advances (%s)', async presentation => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const { RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const host = <BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web"
            initialBrowserState={createBrowserControlState()}
            keepAliveAboveRouter={presentation === 'retained'} presentationSlotId="perf-stream"
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: 'machine_1', serverId }} />;
        const screen = await renderScreen(<RetainedPresentationSlotsProvider>{host}</RetainedPresentationSlotsProvider>, {
            // Native layout must place the retained picture before presentation
            // demand can subscribe to its capture source through the real binder.
            createNodeMock: element => element.props.testID === 'browser-keepalive-placeholder-perf-stream'
                ? { measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 780, 493) }
                : null,
        });
        if (presentation === 'retained') await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-perf-stream'), 'onLayout');
        });
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();
        const streamId: string = screen.findByType(BrowserStreamedTarget).props.runtime.input.streamId;
        const deliver = async (sequence: number) => act(async () => {
            const bytes = new Uint8Array([sequence, 2, 3]);
            const envelope: MachineLiveStreamRelayEnvelopeV1 = { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                message: { kind: 'frame', frame: { v: 1, streamId, sequence, timestampMs: sequence,
                    codecId: 'image.mjpeg', payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                    payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } };
            for (const listener of boundary.listeners) listener(envelope);
        });
        await deliver(1);
        const shellInputs = new Set([screen.findByType(BrowserShell).props]);
        const pictures = new Set([screen.findByType(LiveStreamPlayer).props.state.lastFrameUrl]);
        for (let sequence = 2; sequence <= 21; sequence += 1) {
            await deliver(sequence);
            shellInputs.add(screen.findByType(BrowserShell).props);
            pictures.add(screen.findByType(LiveStreamPlayer).props.state.lastFrameUrl);
        }
        console.info('PERF-1 twenty-frame propagation', { shellInputVersions: shellInputs.size, pictures: pictures.size });
        expect(pictures.size).toBe(21);
        expect(shellInputs.size).toBe(1);
        await screen.update(<RetainedPresentationSlotsProvider />);
        expect(boundary.listeners.size).toBe(0);
        await screen.unmount();
        expect(boundary.listeners.size).toBe(0);
    });

    it('ingests exact-view controller and closed metadata through one socket subscriber without decoding it as pixels', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        let state = { ...createBrowserControlState(), viewsById: { [view.viewId]: view } };
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId,
            onBrowserEvent: event => { state = applyBrowserControlEvent(state, event); } }));
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();
        const streamId = hook.getCurrent()?.input?.streamId;
        expect(streamId).toBeTruthy();
        if (!streamId) return;
        expect(boundary.listeners.size).toBe(1); // Required single-subscription contract, not a wiring count.
        const before = hook.getCurrent()?.playerState;
        const controller = { kind: 'controllerChanged', eventId: 'human', occurredAt: 1, browserSessionId: view.browserSessionId,
            viewId: view.viewId, navigationGeneration: 0,
            state: { browserSessionId: view.browserSessionId, viewId: view.viewId, controller: 'human', controlEpoch: 3 } };
        const hints = { viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
            viewerInput: { controlling: true, controlEpoch: 3 },
            editableTarget: { editable: true, inputMode: 'email', multiline: false, secret: false } };
        const metadata = (events: readonly unknown[], targetStreamId = streamId,
            viewerHints: Record<string, unknown> = hints): MachineLiveStreamRelayEnvelopeV1 => {
            const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events, ...viewerHints }));
            return { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1', message: { kind: 'frame', frame: {
                v: 1, streamId: targetStreamId, sequence: 1, timestampMs: 1, codecId: 'image.mjpeg', payloadKind: 'metadata',
                payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength,
            } } };
        };
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([controller], 'foreign-stream')); });
        expect(state.viewsById[view.viewId].automationController).toBeUndefined();
        expect(hook.getCurrent()?.input).not.toMatchObject(hints);
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([controller])); });
        expect(state.viewsById[view.viewId].automationController).toMatchObject({ controller: 'human', controlEpoch: 3 });
        expect(hook.getCurrent()?.input).toMatchObject(hints);
        expect(hook.getCurrent()?.playerState).toBe(before);
        // Equal geometry can still change the deliberate mode shown in the toolbar.
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([], streamId,
            { ...hints, viewport: { ...hints.viewport, emulation: { kind: 'preset', presetId: 'phone' } } })); });
        expect(hook.getCurrent()?.input?.viewport?.emulation).toEqual({ kind: 'preset', presetId: 'phone' });
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([], streamId,
            { ...hints, viewport: { ...hints.viewport, emulation: { kind: 'fitViewer' } } })); });
        expect(hook.getCurrent()?.input?.viewport?.emulation).toEqual({ kind: 'fitViewer' });
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([controller], streamId,
            { viewerInput: { controlling: false, controlEpoch: 4 }, viewport: hints.viewport })); });
        expect(hook.getCurrent()?.input?.editableTarget).toBeNull();
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([{ kind: 'viewClosed', eventId: 'close', occurredAt: 2,
            browserSessionId: view.browserSessionId, viewId: view.viewId }])); });
        expect(state.viewsById[view.viewId]).toBeUndefined();
        await hook.unmount();
        expect(boundary.listeners.size).toBe(0);
    });

    it.each(['target-destroyed', 'capture-terminal-first', 'capture-unavailable', 'discovery-failed'] as const)('returns workspace selection only for a removed popup after native capture termination (%s)', async closePath => {
        const removed = closePath === 'target-destroyed' || closePath === 'capture-terminal-first';
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        let rejectFrameAck: ((error: Error) => void) | undefined;
        const created = await createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: view.browserSessionId, sidecarId: 'popup-sidecar',
            pipe: { readable: new PassThrough(), writable: new PassThrough() },
            connectTransport: async () => ({ transport: {
                openPage: async () => ({ targetId: 'popup-target', sessionId: 'popup-cdp' }),
                dispatchPageCommand: async command => {
                    if (closePath !== 'target-destroyed' && command.method === 'Page.screencastFrameAck') {
                        return await new Promise((_, reject) => { rejectFrameAck = reject; });
                    }
                    return {};
                },
                dispatchBrowserCommand: async () => ({ success: true }),
                subscribeCdpEvents: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            } }),
        })({ machineId: 'machine_1' });
        if (!created.ok || !created.contextCapture) throw new Error('Missing popup CDP owner');
        const producer = createBrowserCdpScreencastProducer({ contextCapture: created.contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture: created.contextCapture, producer, automation: () => null });
        const produced: MachineLiveStreamRelayEnvelopeV1[] = [];
        const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_1', nowMs: Date.now,
            captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), emitEnvelope: envelope => {
                produced.push(envelope);
                for (const listener of boundary.listeners) listener(envelope);
            } });
        const child = { browserSessionId: view.browserSessionId, viewId: 'popup' };
        await created.adapter.dispatchCommand({ kind: 'openView', commandId: 'open-popup', focus: true,
            ...child, platform: 'web', target: view.target });
        const childSource = registry.resolve({ sourceId: browserViewKey(child) });
        if (!childSource.ok) throw new Error('Missing popup capture source');
        const { createBrowserWorkspaceOpeningFixture } = await import('@/dev/testkit/fixtures/browserWorkspaceOpening');
        const { applyCloseDetailsTab, applyOpenDetailsTab, createEmptyPaneDetailsState } = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceReducer');
        const { resolveBrowserViewTargetOpenTab } = await import('../surfaces/openBrowserTargetInWorkspace');
        const parentTab = resolveBrowserViewTargetOpenTab({ scope: 'sessionDetails', platform: 'web' }, view.target).tab;
        let details = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab: parentTab, openAs: 'pinned' });
        let openedTabs = 0;
        let discoveryReadsWhenClosed: number | undefined;
        const discoveryReadCount = () => boundary.requests.filter(request => typeof request === 'object' && request !== null
            && 'method' in request && request.method === 'daemon.browser.view.list').length;
        const opener = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web',
            browserFeatureDecision: { featureId: 'browser', state: 'enabled', blockedBy: null,
                blockerCode: 'none', diagnostics: [], evaluatedAt: 1, scope: { scopeKind: 'runtime' } },
            openDetailsTab: tab => { openedTabs++; details = applyOpenDetailsTab(details, { tab, openAs: 'pinned' }); } });
        const source = { v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } };
        boundary.views = [daemonView(source)];
        const parentOpened = BrowserEventV1Schema.parse({ kind: 'viewOpened', browserSessionId: view.browserSessionId,
            viewId: view.viewId, eventId: 'parent-open', occurredAt: 1, platform: 'web', adapterKind: 'chromiumSidecar',
            engineKind: 'streamedSurface', target: view.target, adapterCapabilities: view.adapterCapabilities });
        const initialBrowserState = applyBrowserControlEvent(createBrowserControlState(), parentOpened);
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web"
            initialBrowserState={initialBrowserState}
            pluginBrowserActionContext={{ machineId: 'machine_1', serverId, sessionId: 'session_1' }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            onOpenTarget={opener.open} testID="popup-host" />);
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const start = boundary.requests.find((request): request is { method: string; payload: unknown } =>
                typeof request === 'object' && request !== null && 'method' in request && request.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START);
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(start?.payload);
            const parent = daemonView(source);
            const opened = { ...parentOpened, viewId: 'popup', openerViewId: view.viewId,
                eventId: 'popup-open', currentUrl: 'https://example.test/popup' };
            const popupView = { ...parent, ...child, sourceId: browserViewKey(child), events: [opened],
                captureSource: childSource.source.capabilities };
            boundary.views = [parent, popupView];
            const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events: [opened] }));
            await act(async () => {
                for (const listener of boundary.listeners) listener({ v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                    message: { kind: 'frame', frame: { v: 1, streamId: startRequest.streamId, sequence: 1, timestampMs: 1,
                        codecId: 'image.mjpeg', payloadKind: 'metadata', payloadEncoding: 'binary_base64',
                        payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } });
            });
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(openedTabs).toBe(1);
            const group = details.groupsById[details.focusedGroupId!];
            const tab = details.tabsByKey[group.activeTabKey!];
            expect(tab.key).not.toBe(parentTab.key);
            expect(group.tabKeys).toEqual([parentTab.key, tab.key]);
            expect(tab.resource).toMatchObject({ browserSessionId: view.browserSessionId, viewId: 'popup',
                target: { kind: 'streamedBrowser', streamId: browserViewKey(child), daemonView: child } });
            expect(boundary.requests.filter(request => typeof request === 'object' && request !== null
                && 'method' in request && request.method === 'daemon.browser.view.list')).toHaveLength(2);
            await screen.update(<BrowserSurfaceHost key="popup" browserSessionId={view.browserSessionId} platform="web"
                initialBrowserState={applyBrowserControlEvent(createBrowserControlState(), opened)}
                pluginBrowserActionContext={{ machineId: 'machine_1', serverId, sessionId: 'session_1' }}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
                onOpenTarget={opener.open} onCloseTab={() => {
                    discoveryReadsWhenClosed = discoveryReadCount();
                    details = applyCloseDetailsTab(details, tab.key);
                }}
                testID="popup-host" />);
            await flushHookEffects({ cycles: 6, turns: 6 });
            const popupStart = boundary.requests.filter((request): request is { method: string; payload: unknown } =>
                typeof request === 'object' && request !== null && 'method' in request
                && request.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START).at(-1);
            const popupStream = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(popupStart?.payload).startRequest.streamId;
            expect(popupStream).not.toBe(startRequest.streamId);
            boundary.relaySend = raw => { relay.applyControl(MachineLiveStreamDecodedEnvelopeV1Schema.parse(raw)); };
            await act(async () => {
                expect(await relay.start(DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(popupStart?.payload).startRequest, 'present_user'))
                    .toMatchObject({ ok: true });
            });
            const discoveryReadsBeforeClose = discoveryReadCount();
            boundary.views = closePath === 'capture-unavailable' ? [parent, { ...popupView, captureSource: undefined }] : [parent];
            if (closePath === 'discovery-failed') boundary.discoveryError = 'request_failed';
            await act(async () => {
                if (closePath !== 'target-destroyed') {
                    for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'popup-cdp',
                        params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
                    if (!rejectFrameAck) throw new Error('Missing native frame acknowledgement');
                    rejectFrameAck(new Error('Target closed'));
                    await Promise.resolve(); await Promise.resolve();
                }
                // Chromium reports window.close() through Target.targetDestroyed. Do not inject
                // viewClosed into the UI: real capture/relay teardown determines what survives.
                if (removed) for (const listener of [...listeners]) listener({ method: 'Target.targetDestroyed', params: { targetId: 'popup-target' } });
            });
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(produced).toContainEqual(expect.objectContaining({ message: { kind: 'receipt', receipt: expect.objectContaining({
                reasonCode: 'capture_source_unavailable', terminal: true,
            }) } }));
            const closeMetadata = produced.flatMap(envelope => {
                if (envelope.message.kind !== 'frame' || envelope.message.frame.payloadKind !== 'metadata') return [];
                return BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8')))
                    .events.filter(event => event.kind === 'viewClosed');
            });
            expect(closeMetadata).toHaveLength(closePath === 'target-destroyed' ? 1 : 0);
            if (removed) expect(details.tabsByKey[tab.key]).toBeUndefined();
            else expect(details.tabsByKey[tab.key]).toBeDefined();
            expect(details.groupsById[details.focusedGroupId!].activeTabKey).toBe(removed ? parentTab.key : tab.key);
            expect(details.tabsByKey[parentTab.key]).toBeDefined();
            if (closePath !== 'target-destroyed') {
                // One reconciliation decides closure. Selecting the opener can then discover its
                // own source; retained/error tabs must not keep retrying the unavailable capture.
                expect(removed ? discoveryReadsWhenClosed : discoveryReadCount()).toBe(discoveryReadsBeforeClose + 1);
            }
        } finally {
            boundary.relaySend = null;
            await screen.unmount(); opener.dispose(); await relay.dispose(); registration.dispose(); await producer.dispose(); await created.dispose?.();
        }
    });

    it.each([
        { retainedDuplicate: false, refused: false },
        { retainedDuplicate: true, refused: false },
        { retainedDuplicate: false, refused: true },
    ])('saves binary downloads or surfaces their typed refusal through files.save (duplicate: $retainedDuplicate, refused: $refused)', async ({ retainedDuplicate, refused }) => {
        const actionHome = await network.addHome(home.serverUrl, home.accountId, { serverIdentityId: 'srv_browser_stream' });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        await restoreServerAccountForTest({ serverUrl: home.serverUrl, serverIdentityId: 'srv_browser_stream',
            credentials: { token: actionHome.token }, request: network.request });
        boundary.maxFrameBytes = 8000;
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const blobs: Blob[] = [];
        const click = vi.fn();
        const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('expected Blob');
            blobs.push(blob); return 'blob:download';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.stubGlobal('document', { createElement: () => ({ click, style: {}, remove() {} }),
            getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} } });
        const { BrowserPageInteractions } = await import('./BrowserPageInteractions');
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        const opened = BrowserEventV1Schema.parse({ kind: 'viewOpened', eventId: 'download-open', occurredAt: 1,
            browserSessionId: view.browserSessionId, viewId: view.viewId, target: view.target,
            platform: view.platform, adapterKind: view.adapterKind, engineKind: view.engineKind,
            adapterCapabilities: view.adapterCapabilities, currentUrl: view.currentUrl });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web"
            initialBrowserState={applyBrowserControlEvent(createBrowserControlState(), opened)}
            pluginBrowserActionContext={{ machineId: 'machine_1', serverId, sessionId: 'session_1' }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }} />);
        let hidden: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const start = boundary.requests.find((request): request is { method: string; payload: unknown } =>
                typeof request === 'object' && request !== null && 'method' in request && request.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START);
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(start?.payload);
            const streamId = startRequest.streamId;
            let sequence = 1;
            await act(async () => {
                for (const listener of boundary.listeners) listener({ v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                    message: { kind: 'frame', frame: { v: 1, streamId, sequence: sequence++, timestampMs: 1,
                        codecId: 'image.mjpeg', payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                        payloadBase64: encodeBase64(new Uint8Array([1, 2, 3])), payloadSizeBytes: 3 } } });
            });
            const deliver = (batch: Record<string, unknown>) => {
                const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events: [], ...batch }));
                for (const listener of boundary.listeners) listener({ v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                    message: { kind: 'frame', frame: { v: 1, streamId, sequence: sequence++, timestampMs: 1, codecId: 'image.mjpeg',
                        payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } });
            };
            await act(async () => deliver({ viewerInput: { controlling: true, controlEpoch: 3 }, interactionState: {
                dialog: null, fileChooser: null, downloads: [{ downloadId: 'binary', name: 'binary.dat', state: 'completed', receivedBytes: 6, totalBytes: 6 }] } }));
            const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
            const requested: number[] = [];
            boundary.relaySend = raw => {
                const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse(raw);
                if (envelope.message.kind !== 'sideband_control' || envelope.message.control.kind !== 'browser_input') return;
                const { event, eventId } = envelope.message.control;
                if (event.kind !== 'download') return;
                requested.push(event.byteLength);
                if (refused) {
                    deliver({ inputResult: BrowserAutomationActionResultV1Schema.parse({ v: 1, automationRequestId: eventId, status: 'failed',
                        errorCode: 'owner_disconnected', durationMs: 1, adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true,
                        navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 3, controlEpochAfter: 3 }) });
                    return;
                }
                // The source can return a shorter range to account for its metadata overhead.
                const chunk = bytes.slice(event.offset, event.offset + 2);
                deliver({ inputResult: BrowserAutomationActionResultV1Schema.parse({ v: 1, automationRequestId: eventId, status: 'succeeded',
                    durationMs: 1, adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true,
                    navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 3, controlEpochAfter: 3,
                    interactionResult: { kind: 'download', downloadId: 'binary', name: 'binary.dat', offset: event.offset,
                        dataBase64: encodeBase64(chunk), eof: event.offset + chunk.length === bytes.length } }) });
            };
            const interactions = screen.findByType(BrowserPageInteractions);
            expect(interactions.props.onSaveDownload).toBeTypeOf('function');
            if (retainedDuplicate) {
                hidden = await renderScreen(<BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web" visible={false}
                    initialBrowserState={applyBrowserControlEvent(createBrowserControlState(), opened)}
                    pluginBrowserActionContext={{ machineId: 'machine_1', serverId, sessionId: 'session_1' }}
                    policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }} />);
                await flushHookEffects();
            }
            await screen.pressByTestIdAsync(`${interactions.props.testID}-downloads-binary-save`);
            if (refused) {
                expect(requested).toEqual([8000]);
                expect(click).not.toHaveBeenCalled();
                expect(alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('owner_disconnected'),
                    expect.arrayContaining([expect.objectContaining({ onPress: expect.any(Function) })]));
                const { t } = await import('@/text');
                const details = alert.mock.calls[0]?.[2]?.find(button => button.text === t('approvals.technicalDetails'));
                expect(details?.onPress).toBeTypeOf('function');
                await act(async () => { details?.onPress?.(); });
                expect(alert).toHaveBeenLastCalledWith(t('approvals.technicalDetails'), expect.any(String));
                const technicalDetails = JSON.parse(alert.mock.calls.at(-1)![1]!);
                expect(technicalDetails).toMatchObject({ code: 'owner_disconnected' });
                return;
            }
            expect(requested).toEqual([8000, 8000, 8000]);
            expect(click).toHaveBeenCalledOnce();
            expect(blobs).toHaveLength(1);
            expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
        } finally { await hidden?.unmount(); await screen.unmount(); alert.mockRestore(); createUrl.mockRestore(); revoke.mockRestore(); vi.unstubAllGlobals(); }
    });

    it('relays controlling-viewer copy, cut and paste through clipboard input and the system clipboard', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const written: string[] = [];
        class HostClipboardItem { constructor(readonly content: Record<string, Promise<Blob>>) {} }
        vi.stubGlobal('ClipboardItem', HostClipboardItem);
        vi.stubGlobal('navigator', { clipboard: { write: async (items: HostClipboardItem[]) => {
            written.push(await (await items[0].content['text/plain']).text());
        } } });
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId }));
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const streamId = hook.getCurrent()?.input?.streamId;
            if (!streamId) throw new Error('stream missing');
            let sequence = 1;
            const deliver = (batch: Record<string, unknown>) => {
                const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events: [], ...batch }));
                for (const listener of boundary.listeners) listener({ v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                    message: { kind: 'frame', frame: { v: 1, streamId, sequence: sequence++, timestampMs: 1, codecId: 'image.mjpeg',
                        payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } });
            };
            await act(async () => deliver({ viewerInput: { controlling: false, controlEpoch: 3 } }));
            expect(hook.getCurrent()?.input?.clipboardShortcut).toBeUndefined();
            await act(async () => deliver({ viewerInput: { controlling: true, controlEpoch: 3 } }));
            const events: unknown[] = [];
            boundary.relaySend = raw => {
                const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse(raw);
                if (envelope.message.kind !== 'sideband_control' || envelope.message.control.kind !== 'browser_input') return;
                const { event, eventId } = envelope.message.control;
                events.push(event);
                deliver({ inputResult: BrowserAutomationActionResultV1Schema.parse({ v: 1, automationRequestId: eventId,
                    status: 'succeeded', durationMs: 1, adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true,
                    navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 3, controlEpochAfter: 3,
                    ...(event.kind === 'clipboard' && event.action !== 'paste' ? { interactionResult: { kind: 'clipboard', text: `  ${event.action}\n` } } : {}) }) });
            };
            for (const action of ['copy', 'cut', 'paste'] as const) await act(async () => {
                hook.getCurrent()?.input?.clipboardShortcut?.(action);
                await flushHookEffects();
            });
            expect(events).toEqual([
                expect.objectContaining({ kind: 'clipboard', action: 'copy' }),
                expect.objectContaining({ kind: 'clipboard', action: 'cut' }),
                expect.objectContaining({ kind: 'clipboard', action: 'paste', text: clipboardBoundary.text }),
            ]);
            expect(written).toEqual(['  copy\n', '  cut\n']);
        } finally { await hook.unmount(); vi.unstubAllGlobals(); }
    });

    it('exposes the human interaction state and answers it on browser_input at the admitted control epoch', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId }));
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();
        const streamId = hook.getCurrent()?.input?.streamId;
        if (!streamId) throw new Error('stream not admitted');
        // Before the daemon projects an epoch there is nothing to answer with.
        expect(hook.getCurrent()?.input?.sendInput).toBeUndefined();
        const deliver = async (batch: Record<string, unknown>) => act(async () => {
            const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events: [], ...batch }));
            const envelope: MachineLiveStreamRelayEnvelopeV1 = { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1',
                message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1, timestampMs: 1, codecId: 'image.mjpeg',
                    payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes),
                    payloadSizeBytes: bytes.byteLength } } };
            for (const listener of boundary.listeners) listener(envelope);
        });
        const interactionState = { dialog: { dialogId: 'd1', type: 'confirm', message: 'Discard the draft?' },
            fileChooser: null, downloads: [{ downloadId: 'dl1', name: 'report.pdf', state: 'inProgress', receivedBytes: 10, totalBytes: 40 }] };
        await deliver({ viewerInput: { controlling: false, controlEpoch: 3 }, interactionState });
        expect(hook.getCurrent()?.input?.interaction).toEqual(interactionState);
        expect(hook.getCurrent()?.input?.saveDownload).toBeTypeOf('function');
        // A later batch without interaction state keeps the last one (it is latest-wins, not per batch).
        const kept = hook.getCurrent()?.input?.interaction;
        await deliver({ viewerInput: { controlling: false, controlEpoch: 3 } });
        expect(hook.getCurrent()?.input?.interaction).toBe(kept);

        await act(async () => { hook.getCurrent()?.input?.sendInput?.({ kind: 'dialog', dialogId: 'd1', accept: true }); });
        expect(boundary.sent).toContainEqual(expect.objectContaining({ message: { kind: 'sideband_control', control: expect.objectContaining({
            kind: 'browser_input', sourceId: 'browser-view-key-1', streamId, controlEpoch: 3,
            event: expect.objectContaining({ kind: 'dialog', target: 'page', dialogId: 'd1', accept: true, sequence: expect.any(Number) }),
        }) } }));
        await hook.unmount();
    });

    it('does nothing for views the app renders itself', async () => {
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: { ...view, adapterKind: 'externalUrl', engineKind: 'webIframe' } as BrowserControlViewState,
            machineId: 'machine_1',
            serverId,
        }));
        expect(hook.getCurrent()).toBeNull();
    });

    it.each(['hover', 'wheel', 'modifiers', 'alert', 'confirm', 'prompt'] as const)('delivers viewer %s through the real input layer and stream runtime to CDP', async kind => {
        const frames: FrameRequestCallback[] = [];
        if (kind === 'hover') {
            vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
            vi.stubGlobal('cancelAnimationFrame', () => {});
        }
        // The renderer's native node is an OS boundary. Keep actual event subscription/dispatch.
        const wheelTarget = Object.assign(new EventTarget(), { focus() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 }) });
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
        let openDialog = false;
        let finishDialogClick: (() => void) | undefined;
        const emit = (method: string, params: Record<string, unknown>) => {
            for (const listener of [...listeners]) listener({ method, sessionId: 'cdp-page', params });
        };
        // Only Chromium/CDP and the file/network boundaries above are substituted.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: (typeof commands)[number]) => {
                commands.push(command);
                if (command.method === 'Runtime.evaluate') return { result: { value: 'complete' } };
                if (openDialog && command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mouseReleased') {
                    openDialog = false;
                    emit('Page.javascriptDialogOpening', { type: kind, message: 'A page question', defaultPrompt: 'guest' });
                    // Real Chromium keeps dispatchMouseEvent pending until the dialog is answered.
                    await new Promise<void>(resolve => { finishDialogClick = resolve; });
                }
                if (command.method === 'Page.handleJavaScriptDialog') { finishDialogClick?.(); emit('Page.javascriptDialogClosed', {}); }
                return {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        };
        const created = await createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar',
            endpointSource: { kind: 'devtoolsStderr', stderr: 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/test' },
            connectTransport: async () => ({ transport }) })({ machineId: 'machine_1' });
        if (!created.ok || !created.contextCapture) throw new Error('Missing CDP owner');
        const contextCapture = created.contextCapture;
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter: created.adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_1', nowMs: Date.now,
            captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), emitEnvelope: envelope => {
                for (const listener of boundary.listeners) listener(envelope);
            } });
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        function Probe() {
            const runtime = useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId });
            return <BrowserStreamedTarget runtime={runtime} agentName="Agent" testID="input-contract" />;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await created.adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true,
                browserSessionId: view.browserSessionId, viewId: view.viewId, platform: 'web', target: view.target });
            const sourceId = browserViewKey(view);
            const source = registry.resolve({ sourceId });
            if (!source.ok) throw new Error('Missing capture');
            boundary.views = [{ ...daemonView(source.source.capabilities), sourceId }];
            boundary.relaySend = raw => { relay.applyControl(MachineLiveStreamDecodedEnvelopeV1Schema.parse(raw)); };
            screen = await renderScreen(<Probe />, { createNodeMock: element =>
                element.props.testID === 'input-contract-input-capture' ? wheelTarget : null });
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const call = boundary.requests.find(request => (request as { method: string }).method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START);
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse((call as { payload: unknown }).payload);
            await act(async () => { expect(await relay.start(startRequest, 'present_user')).toMatchObject({ ok: true }); });
            await act(async () => { emit('Page.screencastFrame', { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } }); });
            await act(async () => { screen?.findHostByTestId('input-contract-live')?.props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } }); });
            const capture = () => screen!.findHostByTestId('input-contract-input-capture')!;
            const click = async () => act(async () => {
                capture().props.onFocus();
                capture().props.onResponderGrant({ nativeEvent: { locationX: 400, locationY: 200, timestamp: 1 } });
                capture().props.onResponderRelease({ nativeEvent: { locationX: 400, locationY: 200, timestamp: 2 } });
            });
            const hover = () => wheelTarget.dispatchEvent(Object.assign(new Event('pointermove'),
                { clientX: 100, clientY: 100, pointerType: 'mouse', buttons: 0 }));
            if (kind === 'hover') {
                await act(async () => {
                    hover();
                    for (const frame of frames.splice(0)) frame(0);
                });
                expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toEqual([]);
                expect(automation.getStatus(view).controller).not.toBe('human');
            }
            await click();
            await vi.waitFor(() => expect(automation.getStatus(view).controller).toBe('human'));
            await flushHookEffects();
            commands.length = 0;
            if (kind === 'hover') {
                await act(async () => { hover(); hover(); });
                // Advance a browser frame, including work scheduled by the real player and status UI.
                await act(async () => { for (const frame of frames.splice(0)) frame(0); });
                await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')
                    .map(command => command.params)).toEqual([{ type: 'mouseMoved', x: 50, y: 50 }]));
            } else if (kind === 'wheel') {
                const wheel = Object.assign(new Event('wheel', { cancelable: true }),
                    { clientX: 400, clientY: 200, deltaX: 12, deltaY: 420, deltaMode: 0 });
                await act(async () => { wheelTarget.dispatchEvent(wheel); });
                expect(wheel.defaultPrevented).toBe(true);
                await vi.waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent',
                    params: expect.objectContaining({ type: 'mouseWheel', x: 200, y: 100, deltaX: 12, deltaY: 420 }) })));
            } else if (kind === 'modifiers') {
                await act(async () => capture().props.onKeyDown({ key: 'a', ctrlKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} }));
                await vi.waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ method: 'Input.dispatchKeyEvent',
                    params: expect.objectContaining({ type: 'keyDown', key: 'a', modifiers: 10 }) })));
                expect(commands.some(command => command.method === 'Input.insertText')).toBe(false);
            } else {
                openDialog = true;
                await click();
                // Single taps wait for the shared double-tap recognizer before reaching Chromium.
                await vi.waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent',
                    params: expect.objectContaining({ type: 'mouseReleased' }) })));
                await flushHookEffects({ cycles: 4, turns: 4 });
                expect(commands.filter(command => command.method === 'Page.handleJavaScriptDialog')).toEqual([]);
                expect(screen.findHostByTestId('input-contract-interaction-dialog')).not.toBeNull();
                if (kind === 'prompt') await act(async () => screen!.changeTextByTestId('input-contract-interaction-dialog-input', 'chosen answer'));
                await screen.pressByTestIdAsync('input-contract-interaction-dialog-ok');
                await vi.waitFor(() => expect(commands).toContainEqual(expect.objectContaining({ method: 'Page.handleJavaScriptDialog',
                    params: { accept: true, ...(kind === 'prompt' ? { promptText: 'chosen answer' } : {}) } })));
            }
        } finally {
            if (kind === 'hover') vi.unstubAllGlobals();
            finishDialogClick?.();
            boundary.relaySend = null;
            await screen?.unmount(); await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); await created.dispose?.();
        }
    });

    it('delivers three static-page clicks and their terminal metadata through registration, relay and viewer to the cursor', async () => {
        const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const target = { x: 0.5, y: 0.25, width: 0.2, height: 0.1 };
        // Only Chromium and the existing network boundaries are substituted. Target publication,
        // controller snapshots, capture/relay, metadata ingestion, reducer, selector and cursor are real.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async (command: { method: string; params?: Record<string, unknown> }) => {
                if (command.method === 'Runtime.evaluate') return { result: { value: { x: 200, y: 50, activeTarget: target } } };
                if (command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mouseReleased') {
                    await new Promise(resolve => setTimeout(resolve, 15));
                }
                return {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
                listeners.add(listener); return () => { listeners.delete(listener); };
            },
        };
        const identity = { browserSessionId: view.browserSessionId, viewId: view.viewId };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: identity.browserSessionId, sidecarId: 'sidecar', transport });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            getNavigationState: adapter.getNavigationState, subscribeCdpEvents: transport.subscribeCdpEvents,
            subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture }),
        }) });
        const producer = createBrowserCdpScreencastProducer({ contextCapture });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
        const produced: MachineLiveStreamRelayEnvelopeV1[] = [];
        const { machineLiveStreamRelayHandler } = await import('../../../../../server/sources/app/api/socket/machineLiveStreamRelayHandler');
        const { createFakeSocket, getSocketHandler } = await import('../../../../../server/sources/app/api/testkit/socketHarness');
        const { TEST_MACHINE_INSTALLATION_ID } = await import('../../../../../server/sources/app/api/testkit/machineAdmissionPersistenceBoundary');
        const sourceSocket = createFakeSocket({ id: 'static-page-source' });
        sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine_1', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID };
        const viewerSocket = createFakeSocket({ id: 'tab_1' });
        viewerSocket.data = { clientType: 'user-scoped' };
        const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
        let transit = Promise.resolve();
        const enqueue = (work: () => Promise<void>) => { transit = transit.then(work); };
        const flushTransit = async () => {
            let pending: Promise<void>;
            do { pending = transit; await pending; } while (pending !== transit);
        };
        let holdAcks = false;
        const acks: unknown[] = [];
        const relayContext = {
            resolveAccountEncryptionMode: async () => 'plain' as const,
            serverRoutedLiveStreamEnabled: true,
            relayCaps: {},
            relayAuthorizationTrustRoots: [{ keyId: 'static-page-key', publicKeyBase64Url: Buffer.from(signingKey.publicKey).toString('base64url') }],
            verifyViewerSocketOwnership: async ({ accountId }: { accountId: string }) => accountId === home.accountId,
            io: { to: (room: string) => ({ emit: (_event: string, wire: unknown) => {
                enqueue(async () => {
                    const decoded = await openMachineLiveStreamEnvelopeV1(wire, { mode: 'plain' });
                    if (!decoded.ok) throw new Error(decoded.code);
                    if (room === 'tab_1') for (const listener of boundary.listeners) listener(decoded.value);
                    else relay.applyControl(decoded.value);
                });
            } }) },
        };
        machineLiveStreamRelayHandler(home.accountId, sourceSocket as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], relayContext);
        machineLiveStreamRelayHandler(home.accountId, viewerSocket as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], relayContext);
        const sendFromSource = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
        const sendFromViewer = getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
        boundary.relaySend = raw => {
            const message = (raw as MachineLiveStreamRelayEnvelopeV1).message;
            if (message.kind !== 'control' || message.control.kind !== 'ack') return;
            if (holdAcks) acks.push(raw);
            else enqueue(async () => { await sendFromViewer(raw); });
        };
        const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_1',
            captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), nowMs: Date.now,
            emitEnvelope: envelope => {
                produced.push(envelope);
                enqueue(async () => {
                    const sealed = await sealMachineLiveStreamEnvelopeV1(envelope, { mode: 'plain' });
                    if (!sealed.ok) throw new Error(sealed.code);
                    await sendFromSource(sealed.value);
                });
            } });
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const { BrowserAgentCursor } = await import('../copresence/BrowserAgentCursor');
        const selectedTargets: Array<unknown> = [];
        const receivedControllers: Array<unknown> = [];
        let admittedStreamId: string | undefined;
        function Probe() {
            const [state, setState] = React.useState(() => ({ ...createBrowserControlState(), viewsById: { [view.viewId]: view } }));
            const runtime = useBrowserStreamedSurfaceRuntime({ view, machineId: 'machine_1', serverId,
                onBrowserEvent: event => {
                    if (event.kind === 'controllerChanged') receivedControllers.push(event.state);
                    setState(previous => applyBrowserControlEvent(previous, event));
                } });
            admittedStreamId = runtime?.input?.streamId;
            const presence = selectBrowserCopresence({ view, snapshot: null, controllerState: state.viewsById[view.viewId]?.automationController });
            const cursorTarget = presence.kind === 'agent' ? presence.target : null;
            selectedTargets.push(cursorTarget);
            return <BrowserAgentCursor target={cursorTarget} testID="composed-cursor" />;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...identity, platform: 'web', target: view.target });
            const sourceId = browserViewKey(identity);
            const source = registry.resolve({ sourceId });
            if (!source.ok) throw new Error('Browser capture source unavailable');
            boundary.views = [{ ...daemonView(source.source.capabilities), sourceId }];
            screen = await renderScreen(<Probe />);
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            expect(admittedStreamId).toBeTruthy();
            const startCall = boundary.requests.find(request => (request as { method: string }).method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START);
            const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse((startCall as { payload: unknown }).payload);
            if (!startRequest.authorization) throw new Error('Expected server relay authorization');
            const { resolveMachineAdmission } = await import('../../../../../server/sources/app/machines/machineAccess');
            expect(await resolveMachineAdmission({ actorAccountId: home.accountId, machineId: 'machine_1' }))
                .toMatchObject({ kind: 'admitted', installationId: TEST_MACHINE_INSTALLATION_ID });
            startRequest.authorization.signature = { keyId: 'static-page-key', alg: 'Ed25519', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
                Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(startRequest.authorization.payload), 'utf8'), signingKey.secretKey,
            )).toString('base64url') };
            await act(async () => { expect(await relay.start(startRequest, 'present_user')).toEqual({ ok: true, streamId: admittedStreamId }); });
            await act(flushTransit);
            holdAcks = true;
            await act(async () => {
                for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
                    params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
                await flushTransit();
            });
            await act(async () => {
                screen?.findByTestId('composed-cursor')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 200 } } });
            });
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            for (let index = 0; index < 3; index += 1) {
                receivedControllers.length = 0;
                let click: ReturnType<typeof automation.execute> | undefined;
                await act(async () => {
                    click = automation.execute({ v: 1, ...identity, automationRequestId: `static-click-${index}`, requestedBy: 'agent',
                        requesterRef: { kind: 'agent', id: 'agent' }, navigationGeneration: 0, timeoutMs: 10_000,
                        actionKind: 'click', payload: { selector: '#notes' } });
                    await flushTransit();
                });
                expect(receivedControllers).toContainEqual(expect.objectContaining({ activeTarget: target }));
                expect(selectedTargets).toContainEqual(target);
                expect(screen.findHostByTestId('composed-cursor-ring')).not.toBeNull();
                expect(automation.getStatus(identity)).toMatchObject({ activeTarget: target });
                await act(async () => { await vi.advanceTimersByTimeAsync(15); await flushTransit(); });
                expect(await click).toMatchObject({ status: 'succeeded' });
                expect(automation.getStatus(identity).activeTarget).toBeUndefined();
                expect(receivedControllers.at(-1)).toMatchObject({ controller: 'none' });
                expect(selectedTargets.at(-1)).toBeNull();
            }
            // Chromium emitted just one picture; metadata and terminal delivery need no repaint.
            expect(produced.filter(envelope => envelope.message.kind === 'frame'
                && envelope.message.frame.payloadKind === 'image_keyframe')).toHaveLength(1);
            // Settled targets fade at the existing cursor owner; the mounted children survive.
            expect(screen.findHostByTestId('composed-cursor-ring')).not.toBeNull();
            expect(produced.some(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'metadata')).toBe(true);
        } finally {
            vi.useRealTimers();
            holdAcks = false;
            for (const ack of acks) await sendFromViewer(ack);
            await flushTransit();
            boundary.relaySend = null;
            await screen?.unmount(); await relay.dispose(); await flushTransit();
            await getSocketHandler(sourceSocket, 'disconnect')(); await getSocketHandler(viewerSocket, 'disconnect')();
            registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose();
        }
    });

    it('retains daemon facts after refresh, dispatches toolbar navigation and keeps recording and Attach page available', async () => {
        const history = [{ id: 1, url: 'https://browser.test/a' }, { id: 2, url: 'https://browser.test/b' },
            { id: 3, url: 'https://browser.test/c' }];
        const pageCommands: string[] = [];
        const historyEntries: unknown[] = [];
        const navigatedUrls: unknown[] = [];
        let cdpListener: Parameters<BrowserSidecarCdpEventSubscriber>[0] | undefined;
        const transport: BrowserSidecarCdpControlTransport = { openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
                subscribeCdpEvents: listener => { cdpListener = listener; return () => { cdpListener = undefined; }; },
                dispatchBrowserCommand: async () => ({}), dispatchPageCommand: async command => {
                    pageCommands.push(command.method);
                    if (command.method === 'Page.navigate') navigatedUrls.push(command.params?.url);
                    if (command.method === 'Page.navigateToHistoryEntry') historyEntries.push(command.params?.entryId);
                    if (command.method === 'Page.getFrameTree') return { frameTree: { frame: {
                        id: 'frame', loaderId: 'initial', url: history[1]!.url,
                    } } };
                    if (command.method === 'Runtime.evaluate') return { result: { value: 'complete' } };
                    return command.method === 'Page.getNavigationHistory' ? { currentIndex: 1, entries: history } : {};
                } };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'toolbar', transport });
        await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: view.browserSessionId,
            viewId: view.viewId, target: { ...view.target, kind: 'externalUrl', url: history[1]!.url }, platform: 'web' });
        const candidate = adapter.listViews?.(view.browserSessionId)[0];
        if (!candidate) throw new Error('Expected real daemon discovery');
        const discovered = { ...candidate, captureSource: { v: 1, sourceId: candidate.sourceId, sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } };
        boundary.views = [discovered];
        const { DaemonBrowserDiagnosticsSnapshotResponseV1Schema } = await import('@happier-dev/protocol/browser/diagnostics/v1');
        boundary.diagnosticsSnapshot = DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({ protocolVersion: 1,
            snapshot: { v: 1, machineId: 'machine_1', generatedAt: 1, refreshState: 'idle', diagnostics: [], events: [{
                v: 1, eventId: 'daemon-console', browserSessionId: view.browserSessionId, viewId: view.viewId,
                navigationGeneration: 0, capturedAtMs: 1, family: 'console', kind: 'console.entry', fidelity: 'cdp',
                trusted: true, redaction: { level: 'metadataOnly' }, data: { level: 'info', text: 'Daemon console entry' },
            }] } });
        const { BrowserDaemonViewV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
        const { resolveBrowserDaemonStreamTarget } = await import('@/sync/domains/browser/store');
        const { resolveBrowserViewTargetOpen } = await import('../surfaces/openBrowserTargetInWorkspace');
        const target = resolveBrowserDaemonStreamTarget(BrowserDaemonViewV1Schema.parse(discovered));
        if (!target) throw new Error('Expected streamed source');
        const opened = resolveBrowserViewTargetOpen({ scope: 'sessionDetails', platform: 'web' }, target);
        const { recordingCapabilities } = resolveBrowserRecordingStartContext({ hasCdpScreencast: true,
            hasFrameEncoder: true, hasNativeViewCapture: false, hasLiveStreamCaptureRegistry: false })({
            browserSessionId: view.browserSessionId, viewId: view.viewId, profileId: 'profile',
            targetKind: 'streamedBrowser', adapterKind: 'chromiumSidecar', renderEngineKind: 'streamedSurface',
            captureKind: 'cdpScreencast', fidelity: 'cdp', navigationGeneration: 0,
            mimeType: 'video/webm', retentionClass: 'preSend' });
        const recordingControl = (current: BrowserControlViewState) => resolveBrowserRecordingControl({
            view: current, profileId: 'profile', state: createBrowserRecordingState(), recordingCapabilities, enabled: true,
        });
        // Recording admission uses the canonical capture profile for both seeded and hydrated bindings.
        expect(recordingControl(opened.seededState.viewsById[view.viewId]!)).toMatchObject({
            unavailable: null, startRequest: { captureKind: 'cdpScreencast', targetKind: 'streamedBrowser' },
        });
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(adapter);
        const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
            transport: createControlAdapterAutomationTransport({ adapter, contextCapture: {
                transport, resolvePageHandle: adapter.resolvePageHandle, getNavigationState: adapter.getNavigationState,
            } }),
        }), subscribeViewLifecycle: adapter.subscribeViewLifecycle });
        const routes = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
        const gate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } } }),
        }) });
        await gate.refresh();
        const executeDaemonAction = createBrowserDaemonRuntimeActionExecutor({ control: routes, featureGate: gate, ownsAutomationView: broker.ownsView });
        const commands: string[] = [];
        const daemonResults: unknown[] = [];
        boundary.actionDispatch = async (actionId, input) => {
            const { BrowserCommandV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
            const command = BrowserCommandV1Schema.parse(input);
            commands.push(command.kind);
            const result = await executeDaemonAction({ actionId: RuntimeActionIdV1Schema.parse(actionId), input: command,
                context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
            daemonResults.push(result);
            return result;
        };
        const actionHome = await network.addHome(home.serverUrl, home.accountId, { serverIdentityId: 'srv_browser_stream' });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, serverIdentityId: 'srv_browser_stream',
            credentials: { token: actionHome.token }, request: network.request });
        const attachFailures: unknown[] = [];
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountScope = captureActiveServerAccountScopeLifetime()?.scope;
        expect(accountScope?.serverId).toBe(connection.serverId);
        function SessionHost({ visible }: Readonly<{ visible: boolean }>): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 'session_1', accountScope,
                onAttachUnavailable: reason => { attachFailures.push(reason); } });
            return <BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web" visible={visible}
                testID="discovery-toolbar" initialBrowserState={opened.seededState}
                browserContext={runtime?.browserShellContext}
                pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: 'machine_1', serverId }}
                subscribeBrowserEvents={listener => adapter.subscribeBrowserEvents(listener)}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: true, contextEnabled: true }} />;
        }
        const renderHost = (visible: boolean) => <SessionHost visible={visible} />;
        const screen = await renderScreen(renderHost(true));
        try {
            await flushHookEffects({ cycles: 6, turns: 6 });
            await waitForStreamAdmission();
            const beforeRefresh = screen.findByType(BrowserShell).props.state.viewsById[view.viewId];
            expect(beforeRefresh).toMatchObject({ viewId: view.viewId, canGoBack: true, canGoForward: true, loadingState: 'ready' });
            const reads = boundary.requests.filter(request => (request as { method: string }).method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST).length;
            await screen.update(renderHost(false));
            boundary.views = [structuredClone(discovered)];
            await screen.update(renderHost(true));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(boundary.requests.filter(request => (request as { method: string }).method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST)).toHaveLength(reads + 1);
            const afterRefresh = screen.findByType(BrowserShell).props.state.viewsById[view.viewId];
            pageCommands.length = 0;
            for (const button of ['back', 'forward', 'reload']) {
                await act(async () => { await invokeTestInstanceHandler(
                    screen.findHostByTestId(`discovery-toolbar-${button}`)!, 'onPress'); });
                await flushHookEffects();
            }
            await act(async () => cdpListener?.({ method: 'Page.frameStartedLoading', sessionId: 'page', params: { frameId: 'frame' } }));
            await flushHookEffects();
            await act(async () => { await invokeTestInstanceHandler(
                screen.findHostByTestId('discovery-toolbar-stop')!, 'onPress'); });
            await flushHookEffects();
            await act(async () => { await invokeTestInstanceHandler(screen.findHostByTestId('discovery-toolbar-address')!,
                'onChangeText', 'https://browser.test/typed'); });
            await flushHookEffects();
            await act(async () => { await invokeTestInstanceHandler(screen.findHostByTestId('discovery-toolbar-address')!, 'onSubmitEditing'); });
            await flushHookEffects();
            expect(commands, JSON.stringify({ daemonResults, http: network.httpRequests.map(request => ({
                method: request.method, path: new URL(request.url).pathname,
            })) })).toEqual(['goBack', 'goForward', 'reload', 'stop', 'navigate']);
            expect(daemonResults).toEqual(Array.from({ length: 5 }, () => expect.objectContaining({ status: 'dispatched' })));
            expect(navigatedUrls).toEqual(['https://browser.test/typed']);
            expect(historyEntries).toEqual([1, 3]);
            expect(pageCommands.filter(method => method === 'Page.reload')).toHaveLength(1);
            expect(pageCommands.filter(method => method === 'Page.stopLoading')).toHaveLength(1);
            expect(afterRefresh).toBe(beforeRefresh);
            // The same discovered binding that renders the stream must serve the real
            // Attach page button through Account admission and the mounted context owner.
            await screen.pressByTestIdAsync('discovery-toolbar-attach-page');
            await act(async () => { await vi.waitFor(() => {
                expect({ failures: attachFailures,
                    attachments: selectBrowserContextComposerAttachments(screen.findByType(BrowserShell).props.browserContext.state),
                }).toMatchObject({ failures: [], attachments: [{ sourceViewId: view.viewId, state: 'available' }] });
            }); });
            expect(recordingControl(afterRefresh)).toMatchObject({ unavailable: null, startRequest: {
                adapterKind: 'chromiumSidecar', captureKind: 'cdpScreencast', targetKind: 'streamedBrowser', fidelity: 'cdp',
            } });
            const row = screen.findByType(BrowserShell).props.state.viewsById[view.viewId];
            expect(row).toMatchObject({ adapterKind: 'chromiumSidecar', target: { kind: 'streamedBrowser' },
                adapterCapabilities: { supportedTargetKinds: ['externalUrl'],
                    diagnosticsFidelityByFamily: { console: 'cdp', network: 'cdp' }, supportsPopups: true } });
            const { BrowserDiagnosticsDrawer } = await import('../diagnostics/BrowserDiagnosticsDrawer');
            await act(async () => { screen.findByType(BrowserDiagnosticsDrawer).props.handleRef.current.open(); });
            await flushHookEffects();
            expect(Object.values(screen.findByType(BrowserShell).props.browserDiagnostics.eventSource.getState().viewsByKey))
                .toMatchObject([{ events: [{ eventId: 'daemon-console', fidelity: 'cdp' }] }]);
        } finally { await screen.unmount(); automation.dispose(); adapter.dispose(); await connection.dispose(); }
    });

    it('reconciles equal discovery without replay and delivers one changed navigation after re-enable', async () => {
        let listener: BrowserSidecarCdpEventSubscriber | undefined;
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'discovery',
            transport: { openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
                dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
                subscribeCdpEvents: callback => { listener = callback; return () => undefined; } } });
        await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: view.browserSessionId,
            viewId: view.viewId, target: view.target, platform: 'web' });
        const discover = () => { boundary.views = (adapter.listViews?.(view.browserSessionId) ?? []).map(candidate => ({ ...candidate,
            captureSource: { v: 1, sourceId: candidate.sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                inputMode: 'shared', sidebands: [], health: { status: 'available' } } })); };
        discover();
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        let state: ReturnType<typeof createBrowserControlState> = { ...createBrowserControlState(),
            viewsById: { [view.viewId]: view, sibling: { ...view, viewId: 'sibling' } } };
        const delivered: unknown[] = [];
        const hook = await renderHook((props: { refreshKey: string; enabled: boolean }) => useBrowserStreamedSurfaceRuntime({
            view: state.viewsById[view.viewId] ?? null, machineId: 'machine_1', serverId, ...props,
            onBrowserEvent: event => {
                delivered.push(event);
                state = applyBrowserControlEvent(state, event);
            },
        }), { initialProps: { refreshKey: 'initial', enabled: true } });
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();
        const before = state.viewsById[view.viewId];
        const sibling = state.viewsById.sibling;
        delivered.length = 0;
        for (let refresh = 0; refresh < 3; refresh += 1) {
            discover();
            await hook.rerender({ refreshKey: String(refresh), enabled: true });
            await flushHookEffects();
        }
        expect(delivered).toHaveLength(0);
        expect(state.viewsById[view.viewId]).toBe(before);
        let liveEvent: unknown;
        adapter.subscribeBrowserEvents(event => { liveEvent = event; });
        listener?.({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target', title: 'Live change' } } });
        const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events: [liveEvent] }));
        const streamId = hook.getCurrent()?.input?.streamId;
        expect(streamId).toBeTruthy();
        await act(async () => {
            const envelope = { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1', message: { kind: 'frame', frame: {
                v: 1, streamId, sequence: 1, timestampMs: 1, codecId: 'image.mjpeg', payloadKind: 'metadata',
                payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } } };
            for (const receive of boundary.listeners) receive(envelope);
        });
        expect(delivered).toHaveLength(1);
        const liveRow = state.viewsById[view.viewId];
        discover();
        await hook.rerender({ refreshKey: 'after-live', enabled: true });
        await flushHookEffects();
        expect(delivered).toHaveLength(1);
        expect(state.viewsById[view.viewId]).toBe(liveRow);
        await hook.rerender({ refreshKey: 'hidden', enabled: false });
        listener?.({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target', title: 'Changed while hidden' } } });
        discover();
        await hook.rerender({ refreshKey: 'shown', enabled: true });
        await flushHookEffects({ cycles: 6, turns: 6 });
        expect(delivered).toHaveLength(2);
        expect(state.viewsById[view.viewId]?.title).toBe('Changed while hidden');
        expect(state.viewsById.sibling).toBe(sibling);
        await hook.unmount();
        adapter.dispose();
    });

    it('pauses hidden stream subscriptions while retaining the discovered source and socket across show/hide/show', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook((enabled: boolean) => useBrowserStreamedSurfaceRuntime({
            view, machineId: 'machine_1', serverId, enabled,
        }), { initialProps: true });
        await flushHookEffects({ cycles: 6, turns: 6 });
        await waitForStreamAdmission();
        const input = hook.getCurrent()?.input;
        const playerState = hook.getCurrent()?.playerState;
        expect(input?.sourceId).toBe('browser-view-key-1');
        expect(boundary.listeners.size).toBe(1);

        await hook.rerender(false);
        expect(boundary.listeners.size).toBe(0);
        expect(boundary.disconnect).not.toHaveBeenCalled();
        expect(hook.getCurrent()?.input).toBe(input);
        expect(hook.getCurrent()?.playerState).toBe(playerState);

        await hook.rerender(true);
        await flushHookEffects({ cycles: 6, turns: 6 });
        expect(boundary.listeners.size).toBe(1);
        expect(hook.getCurrent()?.input?.streamId).toBe(input?.streamId);
        expect(boundary.disconnect).not.toHaveBeenCalled();
        await hook.unmount();
        expect(boundary.listeners.size).toBe(0);
    });
});
