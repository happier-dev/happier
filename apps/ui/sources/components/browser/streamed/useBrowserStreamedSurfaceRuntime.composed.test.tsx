// Cross-app composition keeps the real daemon/server path in this test without
// adding their source and package-local aliases to the UI compiler program.
import * as React from 'react';
import { PassThrough } from 'node:stream';
import { BrowserEventBatchV1Schema, BrowserEventV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { MachineLiveStreamDecodedEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { createBrowserSidecarCdpControlAdapterFactory } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapterFactory';
import { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control';
import { BrowserContextItemV1Schema } from '@happier-dev/protocol/browser/context/v1';
import type { BrowserContextCapabilities } from '@happier-dev/protocol';
import { createBrowserContextState } from '@/sync/domains/browser/context/state';
import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context/managedChromiumAnnotationProvider';
import { useBrowserAnnotationController } from '@/components/browser/annotation/useBrowserAnnotationController';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DaemonMachineLiveStreamRelayStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { MachineLiveStreamRelayAuthorizationV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { createMachineLiveStreamRelayAuthorizationSigningInputV1, MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { openMachineLiveStreamEnvelopeV1, sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import tweetnacl from 'tweetnacl';
import { selectBrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../../../../../cli/src/daemon/browser/automation/service';
import { createBrowserAutomationCdpAdapter } from '../../../../../cli/src/daemon/browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../../../../../cli/src/daemon/browser/automation/adapters/controlBridge';
import { createBrowserCdpScreencastProducer } from '../../../../../cli/src/daemon/browser/capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../../../../../cli/src/daemon/browser/capture/registration';
import { createMachineLiveStreamCaptureRegistry } from '../../../../../cli/src/daemon/peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../../../../cli/src/daemon/peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamRelayTerminator } from '../../../../../cli/src/daemon/peer/mediation/stream/relay';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
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
    discoveryError: null as string | null,
    /** Holds daemon discovery open until released, to observe the wait before it answers. */
    discoveryGate: null as Promise<void> | null,
    disconnect: vi.fn(async () => undefined),
    relaySend: null as ((raw: unknown) => void) | null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string; payload?: unknown }) => {
        boundary.requests.push(input);
        if (input.method === 'daemon.browser.view.list' && boundary.discoveryGate) await boundary.discoveryGate;
        if (input.method === 'daemon.browser.view.list') return boundary.discoveryError
            ? { error: 'Browser prerequisite', errorCode: boundary.discoveryError }
            : { protocolVersion: 1, views: boundary.views };
        if (input.method === 'daemon.browser.context.dispatch') return { protocolVersion: 1, result: boundary.captureResult };
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
        events: [],
        ...(captureSource ? { captureSource } : {}),
    };
}

describe('useBrowserStreamedSurfaceRuntime', () => {
    beforeEach(async () => {
        network.resetRequests();
        await network.addHome(home.serverUrl, home.accountId);
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') {
                const base = createRootLayoutFeaturesResponse();
                return Response.json(createRootLayoutFeaturesResponse({
                    features: { machines: { ...base.features.machines, enabled: true,
                        liveStream: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: true } } } },
                    capabilities: { machines: { ...base.capabilities.machines,
                        liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
                }));
            }
            if (path !== '/v1/machines/peer/mediation/route-grants') return null;
            const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const scope = DirectRouteGrantScopeV1Schema.parse(request.scope);
            if (scope.kind !== 'live_stream') throw new Error('Expected a live-stream grant');
            const { kind: _kind, ...streamScope } = scope;
            const now = Date.now();
            return Response.json({ ok: true, relayAuthorization: MachineLiveStreamRelayAuthorizationV1Schema.parse({
                payload: { v: 1, grantId: `grant:${scope.streamId}`, accountId: home.accountId,
                    sourceMachineId: request.machineId, targetMachineId: request.targetMachineId,
                    flowKind: 'live_stream', routeKind: 'server_relay', ...streamScope,
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
        boundary.discoveryError = null;
        boundary.discoveryGate = null;
        boundary.disconnect.mockClear();
        boundary.relaySend = null;
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
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => useBrowserStreamedSurfaceRuntime({
            view: null, browserSessionId: 'browser_session_1', machineId: 'machine_1', serverId,
        }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()).toMatchObject({ unavailableReason: 'managed_package_missing', playerState: null });
        await hook.unmount();
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

    it('discovers the session Chromium view on web and retains its annotation capture route before a view is seeded', async () => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        boundary.captureResult = BrowserContextItemV1Schema.parse({ v: 1, kind: 'browserScreenshot',
            contextId: 'captured', sourceViewId: 'view_1', sourceAdapterKind: 'chromiumSidecar', fidelity: 'cdp',
            capturedAtMs: 1, navigationGeneration: 0, lifecycleState: 'available', redactionLevel: 'none',
            media: { mediaId: 'capture_1', mediaKind: 'image', width: 800, height: 600, sizeBytes: 100,
                file: { sessionId: 'browser_session_1', storage: 'session', path: 'images/capture.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } } });
        const captureProvider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId });
        const contextCapabilities = { enabled: true, available: true,
            supportedContextKinds: ['browserPageReference', 'browserAnnotation'], supportedAdapterKinds: ['chromiumSidecar'],
            screenshot: { supported: true, requiresAttachmentUploads: true }, text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
            disabledReasons: [], policyDeniedReasons: [] } satisfies BrowserContextCapabilities;
        const { useBrowserStreamedSurfaceRuntime } = await import('./useBrowserStreamedSurfaceRuntime');
        const hook = await renderHook(() => {
            const [state, setState] = React.useState(createBrowserControlState);
            const [context, setContext] = React.useState(createBrowserContextState);
            const activeView = state.viewsById.view_1 ?? null;
            useBrowserStreamedSurfaceRuntime({ view: activeView, machineId: 'machine_1', serverId,
                browserSessionId: 'browser_session_1',
                onBrowserEvent: event => setState(previous => applyBrowserControlEvent(previous, event)) });
            const annotation = useBrowserAnnotationController({ activeView,
                activeViewNavigationKey: activeView ? `${activeView.viewId}:${activeView.navigationGeneration}` : '',
                browserContext: { state: context, onStateChange: setContext, contextCapabilities,
                    enabled: true, browserDiagnosticsEnabled: true, attachmentsUploadsEnabled: true,
                    annotationCaptureProvider: captureProvider, managedAnnotationCaptureProvider: true } });
            return { state, context, annotation };
        });
        await flushHookEffects({ cycles: 6, turns: 6 });
        expect(hook.getCurrent().state.viewsById.view_1).toMatchObject({ browserSessionId: 'browser_session_1', adapterKind: 'chromiumSidecar',
            target: { kind: 'streamedBrowser', streamId: 'browser-view-key-1' }, engineKind: 'streamedSurface',
            adapterCapabilities: { supportsStreamingDisplay: true, navigation: { canNavigate: true } } });
        expect(boundary.requests).toContainEqual(expect.objectContaining({
            payload: { machineId: 'machine_1', browserSessionId: 'browser_session_1' },
        }));
        expect(hook.getCurrent().annotation.captureCapability).toEqual({ available: true, fidelity: 'cdp' });
        await act(async () => { hook.getCurrent().annotation.start(); });
        expect(hook.getCurrent().annotation.editorActive).toBe(true);
        await act(async () => { await hook.getCurrent().annotation.capture(); });
        expect(hook.getCurrent().context.attachmentOrder).toHaveLength(1);
        expect(boundary.requests).toContainEqual(expect.objectContaining({ method: 'daemon.browser.context.dispatch',
            payload: expect.objectContaining({ machineId: 'machine_1', actionId: 'browser.context.captureScreenshot',
                input: expect.objectContaining({ browserSessionId: 'browser_session_1', viewId: 'view_1' }) }) }));
        await act(async () => { hook.getCurrent().annotation.cancel(); });
        expect(hook.getCurrent().annotation.editorActive).toBe(false);
        await hook.unmount();
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

    it.each(['inline', 'retained'] as const)('keeps frame updates below the Browser shell while the real player advances (%s)', async presentation => {
        boundary.views = [daemonView({ v: 1, sourceId: 'browser-view-key-1', sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } })];
        const { RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const host = <BrowserSurfaceHost browserSessionId={view.browserSessionId} platform="web"
            initialBrowserState={createBrowserControlState()}
            keepAliveAboveRouter={presentation === 'retained'} presentationSlotId="perf-stream"
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            pluginBrowserActionContext={{ sessionId: view.browserSessionId, machineId: 'machine_1', serverId }} />;
        const screen = await renderScreen(<RetainedPresentationSlotsProvider>{host}</RetainedPresentationSlotsProvider>);
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
        const metadata = (events: readonly unknown[], targetStreamId = streamId): MachineLiveStreamRelayEnvelopeV1 => {
            const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, events }));
            return { v: 1, sourceMachineId: 'machine_1', targetMachineId: 'machine_1', message: { kind: 'frame', frame: {
                v: 1, streamId: targetStreamId, sequence: 1, timestampMs: 1, codecId: 'image.mjpeg', payloadKind: 'metadata',
                payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength,
            } } };
        };
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([controller], 'foreign-stream')); });
        expect(state.viewsById[view.viewId].automationController).toBeUndefined();
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([controller])); });
        expect(state.viewsById[view.viewId].automationController).toMatchObject({ controller: 'human', controlEpoch: 3 });
        expect(hook.getCurrent()?.playerState).toBe(before);
        await act(async () => { for (const listener of boundary.listeners) listener(metadata([{ kind: 'viewClosed', eventId: 'close', occurredAt: 2,
            browserSessionId: view.browserSessionId, viewId: view.viewId }])); });
        expect(state.viewsById[view.viewId]).toBeUndefined();
        await hook.unmount();
        expect(boundary.listeners.size).toBe(0);
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


});
