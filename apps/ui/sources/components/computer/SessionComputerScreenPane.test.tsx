import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayAuthorizationV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { DaemonMachineLiveStreamRelayStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { DaemonComputerActionExecuteRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { SessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';

const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));
const viewerHostRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock, createMeasuredImageMock } = await import('@/dev/testkit/mocks/reactNative');
    // Image measurement is native/browser-owned; the actual stream and picture remain real.
    return createReactNativeWebMock({ Image: createMeasuredImageMock({ width: 800, height: 600 }),
        // Count native host renders without replacing the Computer model, controls or ingestion.
        View: React.forwardRef<unknown, Record<string, unknown>>(function CountedView(props, ref) {
            if (props.testID === 'computer-screen-viewer') viewerHostRenders.count++;
            return React.createElement('View', { ...props, ref });
        }),
        useWindowDimensions: () => viewport });
});

// Resolve the genuine cold graph only after its external network boundary is
// installed. Collection cost is not a Computer owner readiness deadline.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { hrefForDestinationRef } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { resolveSessionRoutePathForSurface } = await import('@/components/workspaceCockpit/session/sessionCockpitState');
const { serializeSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { useDeviceType } = await import('@/utils/platform/responsive');
await import('@/sync/ops/actions/defaultActionExecutor');
await import('./SessionComputerScreenPane');
await import('./ComputerScreenViewer');
await import('@/components/appShell/workspace/DestinationInstanceHost');
await import('@/components/ui/presentation/retainedPresentationSlots');
await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
await import('@/components/sessions/viewer/SessionViewerHost');
await import('@/components/sessions/viewer/SessionViewerStickySlot');

describe('SessionComputerScreenPane retained source', () => {
    let failedOwnerDiagnostic: (() => unknown) | null = null;
    beforeEach(() => { network.resetRequests(); failedOwnerDiagnostic = null; });
    afterEach(context => {
        if (context.task.result?.state === 'fail' && failedOwnerDiagnostic) {
            // Test-only phase evidence distinguishes setup failures from missing retention.
            console.error('Computer pane owner diagnostic', failedOwnerDiagnostic());
        }
    });
    afterAll(async () => { await network.dispose(); });

    it('retains the real Computer body and exact destination scope while parking ordinary read and stream demand', async () => {
        // Only HTTP/Socket.IO and device credentials are replaced; the actual pane,
        // model, control projection, Action executor and stream ingestion remain real.
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { createRetainedPresentationSlotsStore, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
        const { SessionViewerControllerProvider } = await import('@/components/sessions/viewer/SessionViewerControllerProvider');
        const { useOptionalSessionViewerController } = await import('@/components/sessions/viewer/SessionViewerController');
        const { SessionViewerHost } = await import('@/components/sessions/viewer/SessionViewerHost');
        const { SessionViewerStickySlot } = await import('@/components/sessions/viewer/SessionViewerStickySlot');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { useSessionDestinationAccountBinding } = await import('@/components/sessions/viewer/SessionViewerDestinationScope');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const executorModule = await loadVitestModuleForNodeRequire(
            new URL('../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const previousSelection = getActiveServerSnapshot();
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const home = await network.addHome('https://computer-retention.test', 'computer-account');
        const sessionId = 'retained-computer-session';
        const machineId = 'retained-computer-machine';
        const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
        const sourceId = 'computer:retained';
        const initialStatus = createDeferred<void>();
        let selectionRead: ReturnType<typeof createDeferred<void>> | null = null;
        const activeStreams = new Set<string>();
        let streamStarts = 0;
        let delayStart: ReturnType<typeof createDeferred<void>> | null = null;
        let pendingStart: ReturnType<typeof createDeferred<void>> | null = null;
        let allowSocketReconnect = true;
        network.setSocketConfigurator(({ socket }) => {
            const connect = socket.connect.getMockImplementation();
            let connectedOnce = false;
            socket.connect.mockImplementation(() => {
                if (socket.connected) return;
                if (connectedOnce && !allowSocketReconnect) return;
                // Socket.IO assigns its replacement id before publishing connect.
                // Keep that ordering even when the real supervisor dials first.
                socket.id = connectedOnce ? 'socket-reconnected' : 'socket-test';
                connectedOnce = true;
                connect?.();
            });
            socket.emit.mockImplementation((event, payload) => {
                if (event !== MACHINE_LIVE_STREAM_SOCKET_EVENT) return;
                const envelope = MachineLiveStreamRelayEnvelopeV1Schema.parse(payload);
                if (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop') {
                    activeStreams.delete(envelope.message.control.streamId);
                }
            });
        });
        let phase = 'installing the real Home and Machine';
        let readBody: () => unknown = () => null;
        failedOwnerDiagnostic = () => ({ phase, body: readBody(),
            actions: network.requests.flatMap(request => {
                const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                return parsed.success ? [parsed.data.actionId] : [];
            }), http: network.httpRequests.map(request => request.url),
            credentials: network.credentialRequests,
        });
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') {
                const base = createRootLayoutFeaturesResponse();
                return Response.json(createRootLayoutFeaturesResponse({
                    features: { machines: { ...base.features.machines, enabled: true, liveStream: { enabled: true,
                        directPeer: { enabled: false }, serverRouted: { enabled: true } } } },
                    capabilities: { machines: { ...base.capabilities.machines,
                        liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
                }));
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/peer/mediation/route-grants') {
                const body = init && typeof init === 'object' && 'body' in init ? init.body : undefined;
                const raw: unknown = JSON.parse(String(body));
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a relay grant request');
                const request = raw as Readonly<Record<string, unknown>>;
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
            }
            return null;
        });
        network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) {
                const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.payload);
                pendingStart?.resolve();
                if (delayStart) await delayStart.promise;
                if (activeStreams.has(startRequest.streamId)) return { protocolVersion: 1,
                    result: { ok: false, reasonCode: 'duplicate_stream_id' } };
                activeStreams.add(startRequest.streamId);
                streamStarts += 1;
                return { protocolVersion: 1, result: { ok: true, streamId: startRequest.streamId } };
            }
            if (request.method !== RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE) throw new Error(`Unexpected Computer RPC: ${request.method}`);
            const payload = DaemonComputerActionExecuteRequestV1Schema.parse(request.payload);
            expect(payload.sessionId).toBe(sessionId);
            expect(request.targetId).toBe(machineId);
            if (payload.actionId === 'computer.targets.list') return { protocolVersion: 1, result: {
                targets: [{ target }], grants: { capture: 'granted', input: 'granted' },
            } };
            if (payload.actionId === 'computer.target.get') {
                await selectionRead?.promise;
                return { protocolVersion: 1, result: {
                consentGranted: true, selectedTarget: target, sourceId,
                approvalDisplay: { machineDisplayName: 'Retained computer', requiresTargetSelection: false, target: { kind: 'window', title: 'Retained window' } },
            } }; }
            if (payload.actionId === 'computer.control.status') {
                initialStatus.resolve();
                return { protocolVersion: 1, result: {
                    target, sourceId, controller: 'agent', controlEpoch: 1, stopping: false, uncertain: false,
                    grants: { capture: 'granted', input: 'granted' },
                } };
            }
            throw new Error(`Unexpected Computer control: ${payload.actionId}`);
        });
        await setActiveServer({ serverId: home.id });
        storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
        storage.getState().applyProfile({ ...storage.getState().profile, id: home.accountId });
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain', activeAt: Date.now() })], false, { sourceServerId: home.id });
        const sessionFixture = createSessionFixture({ id: sessionId, serverId: home.id, thinking: false });
        const session = { ...sessionFixture, metadata: { ...sessionFixture.metadata!, machineId } };
        storage.getState().applySessions([session]);
        publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.initialize({ endpoint: home.serverUrl, token: home.token, serverId: home.id, generation: 1 }, null);
        phase = 'waiting for the real socket connection';
        const socketReady = createDeferred<void>();
        const stopStatus = apiSocket.onStatusChange(status => { if (status === 'connected') socketReady.resolve(); });
        const stopError = apiSocket.onError(error => { if (error) socketReady.reject(error); });
        try { await socketReady.promise; } finally { stopStatus(); stopError(); }
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        // A retained row and socket reconnect are not a fresh Machine-presence observation.
        observeMachinePresenceForTest({ serverId: home.id, accountId: home.accountId }, [machineId]);
        phase = 'validating the real Action selection';
        // Establish the real parsed selection outcome before presentation work.
        // A refusal from this front door is fixture setup, never retention RED.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const producerDiagnostic = await createFrontDoorActionExecute()('computer.target.get', { machineId }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: sessionId,
            serverId: home.id, expectedAccountId: home.accountId,
        });
        expect(producerDiagnostic, JSON.stringify({ http: network.httpRequests, credentials: network.credentialRequests }))
            .toMatchObject({ ok: true, result: { selectedTarget: target, sourceId } });
        phase = 'mounting the real Computer body';
        const { SessionComputerScreenPane } = await import('./SessionComputerScreenPane');
        const { ComputerScreenViewer } = await import('./ComputerScreenViewer');
        const { ComputerScreenStreamScope } = await import('./ComputerScreenStreamScope');
        const { useRouter } = await import('expo-router');
        const store = createRetainedPresentationSlotsStore();
        const destinationId = 'computer-destination';
        const standaloneDestination = { kind: 'session', params: { id: sessionId, serverId: home.id } } as const;
        const routeParams = { id: sessionId, serverId: home.id,
            ...serializeSessionPaneUrlState({ details: { kind: 'computerScreen', machineId } }) };
        let workspace = createWorkspaceState({ id: destinationId, target: { kind: 'session', params: routeParams }, pinned: false, preview: false });
        const routeListeners = new Set<() => void>();
        const route = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => [],
            getScope: () => ({ serverId: home.id, accountId: home.accountId }),
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
            transport: { commit: () => {} }, createId: () => 'unexpected-computer-destination',
            onChange: () => { for (const listener of routeListeners) listener(); } });
        route.initialize(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: home.id, query: routeParams }));
        const subscribeRoute = (listener: () => void) => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; };
        const readRoute = () => workspace;
        let recordContinuity: (() => void) | null = null;
        let commitPhase = '';
        let phaseCommits = 0;
        const recordCommit = () => {
            if (commitPhase !== phase) { commitPhase = phase; phaseCommits = 0; }
            // Test-only escape from an effect cycle that otherwise starves the runner timeout.
            if (++phaseCommits > 100) throw new Error(`Computer presentation never settles: ${phase}`);
            recordContinuity?.();
        };
        const slotId = `${createSessionPaneScopeId(sessionId, home.id, destinationId)}:viewer:computer`;
        let viewerController: SessionViewerController | null = null;
        function PresenceOwner() {
            viewerController = useOptionalSessionViewerController();
            return null;
        }
        const canPresentSource = () => true;
        const openDocked = () => undefined;
        function SourceAccount(props: React.PropsWithChildren<{ borrowDestination: boolean }>) {
            const binding = useSessionDestinationAccountBinding(sessionId, home.id);
            // Responsive shells borrow the real destination. The distinct-viewer late-start
            // cases below retain their original still-live Account authority across mounts.
            return <SessionViewerSourceAccountScopeProvider accountLifetime={props.borrowDestination ? binding ?? null : accountLifetime}>
                {props.children}
            </SessionViewerSourceAccountScopeProvider>;
        }
        function DetailsAccount(props: React.PropsWithChildren) {
            // Standalone Details currently supplies its panel runtime's credential lifetime.
            // Unmounting that panel retires it, even though the destination remains alive.
            const { binding } = useServerCredentialAccountScopeBinding(home.id);
            return <SessionViewerSourceAccountScopeProvider accountLifetime={binding}>
                {props.children}
            </SessionViewerSourceAccountScopeProvider>;
        }
        type Shell = 'pane' | 'floating' | 'closed' | 'phone' | 'wide' | 'routed';
        function Harness(props: Readonly<{ shell: Shell }>) {
            // The existing Expo test boundary supplies the destination's platform navigation.
            // Keep the real retained destination and approval owners beneath it.
            const navigation = useRouter();
            const device = useDeviceType();
            const currentWorkspace = React.useSyncExternalStore(subscribeRoute, readRoute, readRoute);
            const destination = currentWorkspace.tabs[currentWorkspace.groups[currentWorkspace.focusedGroupId].activeTabId];
            const routed = props.shell === 'routed';
            const details = routed && destination.target.kind === 'sessionDetails';
            React.useEffect(() => {
                if (!routed) return;
                // The real phone chrome's route producer feeds the real workspace URL consumer.
                // Only window dimensions and Expo delivery are platform boundaries here.
                route.acceptUrl(resolveSessionRoutePathForSurface(sessionId, device === 'phone' ? 'tabs' : 'chat', {
                    serverId: home.id, query: routeParams,
                }));
            }, [device, routed]);
            const pane = props.shell === 'pane' ? <>
                <SessionComputerScreenPane key="desktop" sessionId={sessionId} serverId={home.id} machineId={machineId} />
                <SessionViewerStickySlot sessionId={sessionId} serverId={home.id} />
                <SessionViewerHost sessionId={sessionId} serverId={home.id} />
            </>
                : props.shell === 'floating' ? <SessionComputerScreenPane key="phone"
                    sessionId={sessionId} serverId={home.id} machineId={machineId} presentationSlotId={slotId} presentation="viewer" />
                : props.shell === 'phone' || props.shell === 'wide' ? <>
                    <SessionViewerStickySlot sessionId={sessionId} serverId={home.id} />
                    <SessionViewerHost sessionId={sessionId} serverId={home.id} />
                </> : routed ? <React.Fragment key={destination.target.kind}>
                    {destination.target.kind === 'session' ? <>
                        <SessionViewerStickySlot sessionId={sessionId} serverId={home.id} />
                        <SessionViewerHost sessionId={sessionId} serverId={home.id} />
                    </> : null}
                    <PluginSurfaceFocusEligibilityProvider active={details || device !== 'phone'}>
                        <SessionComputerScreenPane sessionId={sessionId} serverId={home.id} machineId={machineId} />
                    </PluginSurfaceFocusEligibilityProvider>
                </React.Fragment> : null;
            const viewerPresentation = <SessionViewerControllerProvider
                key={props.shell === 'phone' || props.shell === 'wide' ? props.shell : 'ordinary-shell'}
                sessionId={sessionId} serverId={home.id}
                phone={props.shell === 'floating' || props.shell === 'phone' || (routed && device === 'phone')}
                canPresentSource={canPresentSource} openDocked={openDocked}>
                <PresenceOwner />
                {pane}
            </SessionViewerControllerProvider>;
            // Details renders inside the real Session chrome too: its pane sees
            // the destination's open viewer state, not an absent controller.
            const presentation = details ? <DetailsAccount>{viewerPresentation}</DetailsAccount> : viewerPresentation;
            // Match production: retention and destination authority outlive responsive shells.
            return <InjectedAuthProvider credentials={{ token: home.token }}><React.Profiler id="computer-route-continuity" onRender={recordCommit}><RetainedPresentationSlotsProvider store={store}>
                <DestinationInstanceHost tabId={routed ? destination.id : destinationId}
                    ref={routed ? destination.target : standaloneDestination}
                    pathname={routed ? hrefForDestinationRef([], destination.target)!.split('?')[0] : `/session/${sessionId}`} focused visible navigation={navigation}>
                <SourceAccount borrowDestination={routed || props.shell === 'phone' || props.shell === 'wide'}>
                    {presentation}
                </SourceAccount>
                </DestinationInstanceHost>
            </RetainedPresentationSlotsProvider></React.Profiler></InjectedAuthProvider>;
        }
        // Window measurement is the native boundary; real phone/wide binders own placement.
        let placeholderSize = { width: 358, height: 224 };
        selectionRead = createDeferred<void>();
        const screen = await renderScreen(<Harness shell="pane" />, {
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(16, 120, placeholderSize.width, placeholderSize.height) }),
        });
        const readStream = () => screen.root.findByType(ComputerScreenStreamScope).props.runtime;
        const measurePicture = async () => { await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(`browser-keepalive-placeholder-${slotId}`)!, 'onLayout', {});
        }); };
        async function waitForMountedStream(): Promise<string> {
            let mountedStreamId = '';
            await vi.waitFor(async () => {
                await flushHookEffects();
                const stream = readStream();
                if (!stream?.input) throw new Error('The remounted Computer stream is not ready');
                mountedStreamId = stream.input.streamId;
                expect(activeStreams.has(mountedStreamId)).toBe(true);
                expect(activeStreams.size).toBe(1);
            });
            return mountedStreamId;
        }
        let lastBody: unknown = null;
        readBody = () => {
            try {
                const body = screen.root.findByType(ComputerScreenViewer);
                lastBody = { shared: body.props.shared, title: body.props.targetTitle,
                    presence: body.props.presence, stream: readStream() !== null,
                    streamDiagnostic: readStream()?.playerState?.diagnostic,
                    player: readStream()?.playerState,
                    input: readStream()?.input?.streamId ?? null,
                    socketId: apiSocket.getSocketId(),
                    sockets: network.socketBoundaries.map(boundary => ({ id: boundary.socket.id, connected: boundary.socket.connected })),
                    slots: store.getPortalSnapshot().map(entry => ({ visible: entry.visible, geometry: entry.geometry })),
                    slotVisible: store.getPortalSnapshot()[0]?.visible,
                    slotWidth: store.getPortalSnapshot()[0]?.geometry?.width,
                    accountScope: accountLifetime?.scope, accountCurrent: accountLifetime?.isCurrent() };
            } catch { /* Preserve the last mounted observation after genuine teardown. */ }
            return lastBody;
        };
        try {
            phase = 'waiting for share selection without asserting that consent ended';
            // The real portal parks demand until its native/browser placeholder is measured.
            await measurePicture();
            await vi.waitFor(() => expect(screen.root.findByType(ComputerScreenViewer).props.machineOnline).toBe(true));
            expect(screen.root.findByType(ComputerScreenViewer).props.selectionPending).toBe(true);
            expect(screen.findByTestId('computer-screen-viewer-not-shared')).toBeNull();
            expect(screen.findByTestId('computer-screen-viewer-connecting')).not.toBeNull();
            await act(async () => { selectionRead!.resolve(); });
            // Physical status completion follows the initial get/list phases;
            // microtask count alone is not an owner readiness predicate.
            phase = 'waiting for mounted get/list/status completion';
            await act(async () => { await initialStatus.promise; });
            await flushHookEffects();
            const body = screen.root.findByType(ComputerScreenViewer);
            expect(body.props.shared, JSON.stringify({ targetTitle: body.props.targetTitle, presence: body.props.presence,
                accountCurrent: accountLifetime?.isCurrent(), producer: producerDiagnostic,
                actions: network.requests.flatMap(request => {
                    const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                    return parsed.success ? [parsed.data.actionId] : [];
                }) })).toBe(true);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(readStream()).not.toBeNull();
            phase = 'waiting for real grant and daemon stream admission';
            await act(async () => { await vi.waitFor(() => expect(activeStreams.size,
                JSON.stringify({ stream: readStream()?.playerState, http: network.httpRequests.map(request => request.url) })).toBe(1)); });
            await flushHookEffects();
            expect(activeStreams.size).toBe(1);
            const streamId = await waitForMountedStream();
            const controlReads = () => network.requests.filter(request => {
                const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                return parsed.success && (parsed.data.actionId === 'computer.target.get' || parsed.data.actionId === 'computer.control.status');
            }).length;
            const readsBeforeFirstFrame = controlReads();
            const firstFrame = await sealMachineLiveStreamEnvelopeV1({
                v: 1, sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId: apiSocket.getSocketId(),
                message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1,
                    timestampMs: 1000, codecId: 'image.frame.v1', payloadKind: 'image_keyframe',
                    payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
            }, { mode: 'plain' });
            if (!firstFrame.ok) throw new Error(firstFrame.code);
            await act(async () => {
                for (const socket of network.socketBoundaries) socket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, firstFrame.value);
            });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(readStream()?.playerState?.lastFrameAtMs).toBe(1000);
            });
            expect(controlReads() - readsBeforeFirstFrame).toBe(0);
            const picture = () => screen.root.findAllByType('Image')
                .filter(image => image.props.testID?.includes('player'))
                .map(image => image.props.source?.uri);
            phase = 'advancing real frames without rerendering the viewer controls';
            await flushHookEffects();
            viewerHostRenders.count = 0;
            for (const [offset, payloadBase64] of ['AgID', 'AwID', 'BAID'].entries()) {
                const previousPicture = picture();
                const nextFrame = await sealMachineLiveStreamEnvelopeV1({
                    v: 1, sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId: apiSocket.getSocketId(),
                    message: { kind: 'frame', frame: { v: 1, streamId, sequence: offset + 2,
                        timestampMs: 1000, codecId: 'image.frame.v1', payloadKind: 'image_keyframe',
                        payloadEncoding: 'binary_base64', payloadBase64, payloadSizeBytes: 3 } },
                }, { mode: 'plain' });
                if (!nextFrame.ok) throw new Error(nextFrame.code);
                await act(async () => {
                    for (const socket of network.socketBoundaries) socket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, nextFrame.value);
                });
                await vi.waitFor(() => expect(picture()).not.toEqual(previousPicture));
                await flushHookEffects();
            }
            console.info('Computer frame render count', JSON.stringify({ frames: 3, viewerHostRenders: viewerHostRenders.count }));
            expect(viewerHostRenders.count).toBe(0);
            const lastPicture = picture();
            expect(lastPicture).toHaveLength(1);
            const reflowSamples: Array<{ placement: string; durationMs: number; pictures: number; starts: number; live: number }> = [];
            const reflow = async (shell: Shell) => {
                const startedAt = performance.now();
                await screen.update(<Harness shell={shell} />);
                await flushHookEffects();
                reflowSamples.push({ placement: shell, durationMs: performance.now() - startedAt,
                    pictures: picture().length, starts: streamStarts, live: activeStreams.size });
            };
            phase = 'checking the retained source slot';
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            const settledSlot = store.getPortalSnapshot();
            await screen.update(<Harness shell="pane" />);
            await flushHookEffects();
            expect(store.getPortalSnapshot() === settledSlot).toBe(true);
            phase = 'keeping the retained body across the real pane/viewer handoff and a short area';
            await act(async () => { viewerController!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
            const layoutHost = async (height: number) => {
                await act(async () => {
                    invokeTestInstanceHandler(screen.findByTestId('session-viewer-host')!, 'onLayout', {
                        nativeEvent: { layout: { x: 0, y: 0, width: 1200, height } },
                    });
                });
            };
            await layoutHost(900);
            for (const [testID, width] of [
                ['session-viewer-source-capsule', 300],
                ['session-viewer-buttons-capsule', 90],
                ['session-viewer-machine', 51],
            ] as const) {
                await act(async () => {
                    invokeTestInstanceHandler(screen.root.find(node => node.props.testID === testID
                        && typeof node.props.onLayout === 'function'), 'onLayout', {
                        nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } },
                    });
                });
            }
            expect(viewerController!.presence.get('computer')).not.toBeNull();
            // A short area shrinks the frame; it never docks the viewer, so the retained body stays put.
            await layoutHost(150);
            expect(viewerController!.state.mode).toBe('floating');
            await layoutHost(900);
            expect(viewerController!.state.mode).toBe('floating');
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(picture()).toEqual(lastPicture);
            await act(async () => { viewerController!.port.apply({ kind: 'viewer.close' }); });
            phase = 'projecting the actual phone breakpoint through the Computer Details route';
            await act(async () => {
                viewerController!.port.apply({ kind: 'viewer.open', source: 'computer' });
                viewerController!.apply({ kind: 'viewer.dock' });
            });
            const transitionPictures: Array<{ pictures: number; visible: boolean; placed: boolean; streamId: string | null; starts: number }> = [];
            recordContinuity = () => {
                const entry = store.getPortalSnapshot().find(entry => entry.slotId === slotId);
                transitionPictures.push({ pictures: picture().length, visible: entry?.visible === true,
                    placed: Boolean(entry?.geometry && entry.geometry.width > 0 && entry.geometry.height > 0),
                    streamId: readStream()?.input?.streamId ?? null,
                    starts: streamStarts });
            };
            await reflow('routed');
            const startsBeforePhone = streamStarts;
            expect(startsBeforePhone).toBe(1);
            viewport.width = 390;
            viewport.height = 844;
            await reflow('routed');
            expect(workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId].target.kind).toBe('sessionDetails');
            expect(store.getPortalSnapshot().find(entry => entry.slotId === slotId)?.visible).toBe(true);
            expect(Object.keys(workspace.tabs)).toEqual([destinationId]);
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(picture()).toEqual(lastPicture);
            expect(readStream()?.input?.streamId).toBe(streamId);
            expect(streamStarts).toBe(startsBeforePhone);
            phase = 'returning from phone Details through the actual Chat route';
            await act(async () => {
                route.acceptUrl(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: home.id, query: routeParams }));
            });
            await reflow('routed');
            expect(workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId].target.kind).toBe('session');
            expect(screen.findByTestId('session-viewer-sticky')).not.toBeNull();
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(readStream()?.input?.streamId).toBe(streamId);
            expect(streamStarts).toBe(startsBeforePhone);
            expect(picture()).toEqual(lastPicture);
            viewport.width = 1440;
            viewport.height = 900;
            await reflow('routed');
            expect(Object.keys(workspace.tabs)).toEqual([destinationId]);
            expect(picture()).toEqual(lastPicture);
            recordContinuity = null;
            expect(transitionPictures.length).toBeGreaterThan(0);
            expect(transitionPictures).toEqual(transitionPictures.map(() => ({
                pictures: 1, visible: true, placed: true, streamId, starts: 1,
            })));
            await act(async () => { viewerController!.port.apply({ kind: 'viewer.close' }); });
            await reflow('floating');
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            // A newly mounted wide frame has no body binder until its first measurement.
            // Exercise that real parking gap, then return without supplying another image.
            await reflow('closed');
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(activeStreams.size).toBe(0);
            const parkedPicture = picture();
            const parkedInput = readStream()?.input;
            const parkedReads = network.requests.length;
            await act(async () => { storage.getState().applySessions([{ ...session, thinking: true }]); });
            await flushHookEffects();
            expect(network.requests).toHaveLength(parkedReads);
            await reflow('pane');
            await measurePicture();
            await waitForMountedStream();
            console.info('Computer retained reflow measurement', JSON.stringify(reflowSamples));
            expect(parkedPicture).toEqual(lastPicture);
            expect(parkedInput).toBeNull();
            expect(picture()).toEqual(lastPicture);
            expect(readStream()?.input?.streamId).toBe(streamId);
            expect(readStream()?.playerState?.lastFrameAtMs).toBe(1000);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            expect(activeStreams.size).toBe(1);
            phase = 'streaming through the actual 390-to-2200 viewer placements';
            const startsBeforeViewports = streamStarts;
            await act(async () => { viewerController!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
            viewport.width = 390;
            viewport.height = 844;
            await reflow('phone');
            expect(screen.findByTestId('session-viewer-sticky')).not.toBeNull();
            expect(picture()).toEqual(lastPicture);
            await measurePicture();
            const placedPicture = () => {
                const entry = store.getPortalSnapshot().find(entry => entry.slotId === slotId);
                expect(entry?.visible).toBe(true);
                expect(entry?.geometry?.width ?? 0).toBeGreaterThan(0);
                expect(entry?.geometry?.height ?? 0).toBeGreaterThan(0);
            };
            placedPicture();
            viewport.width = 2200;
            viewport.height = 1200;
            await reflow('wide');
            expect(screen.findByTestId('session-viewer-host')).not.toBeNull();
            expect(picture()).toEqual(lastPicture);
            placedPicture();
            // The wide frame deliberately waits for layout before it binds its body.
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('session-viewer-host')!, 'onLayout', {
                    nativeEvent: { layout: { x: 0, y: 0, width: 2200, height: 1200 } },
                });
            });
            await waitForMountedStream();
            expect(picture()).toEqual(lastPicture);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            viewport.width = 390;
            viewport.height = 844;
            await reflow('phone');
            placeholderSize = { width: 0, height: 0 };
            await measurePicture();
            placedPicture();
            await waitForMountedStream();
            expect(picture()).toEqual(lastPicture);
            expect(readStream()?.input?.streamId).toBe(streamId);
            expect(activeStreams.size).toBe(1);
            expect(streamStarts).toBe(startsBeforeViewports);
            console.info('Computer viewer placement measurement', JSON.stringify(reflowSamples));
            expect(body.props.targetTitle).toBe('Retained window');
            phase = 'retaining the dock and Chat picture across a real transport identity replacement';
            // Reuse the ordinary controller for both routed presentations, just as
            // the earlier Details/Chat journey; the explicit phone fixture has its own.
            placeholderSize = { width: 358, height: 224 };
            await reflow('pane');
            await measurePicture();
            await act(async () => {
                viewerController!.port.apply({ kind: 'viewer.open', source: 'computer' });
                viewerController!.apply({ kind: 'viewer.dock' });
            });
            viewport.width = 390;
            viewport.height = 844;
            await reflow('routed');
            const startsBeforeReconnect = streamStarts;
            const recoveryPictures: number[] = [];
            recordContinuity = () => { recoveryPictures.push(picture().length); };
            // Engine.IO disconnect/reconnect is the external transport boundary. The
            // Account, retained body, grant, RPC and ingestion owners all stay real.
            await act(async () => {
                allowSocketReconnect = false;
                activeStreams.clear();
                for (const boundary of network.socketBoundaries) {
                    boundary.socket.id = '';
                    boundary.trigger('disconnect', 'transport close');
                }
            });
            await flushHookEffects();
            expect(picture()).toEqual(lastPicture);
            await act(async () => {
                route.acceptUrl(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: home.id, query: routeParams }));
            });
            await reflow('routed');
            expect(picture()).toEqual(lastPicture);
            await measurePicture();
            const connectionRestored = createDeferred<void>();
            const stopReconnectStatus = apiSocket.onStatusChange(status => {
                if (status === 'connected' && apiSocket.getSocketId() === 'socket-reconnected') connectionRestored.resolve();
            });
            try {
                await act(async () => {
                    allowSocketReconnect = true;
                    for (const boundary of network.socketBoundaries) {
                        boundary.socket.connect();
                    }
                    // The active API's managed transport owns readiness; merely
                    // assigning its SDK id does not admit the new connection.
                    await connectionRestored.promise;
                });
            } finally { stopReconnectStatus(); }
            const reconnectedStreamId = await waitForMountedStream();
            expect(reconnectedStreamId).not.toBe(streamId);
            expect(streamStarts).toBe(startsBeforeReconnect + 1);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(readStream()?.playerState?.phase).toBe('reconnecting');
            expect(picture()).toEqual(lastPicture);
            recordContinuity = null;
            expect(recoveryPictures.length).toBeGreaterThan(0);
            expect(recoveryPictures.every(count => count === 1)).toBe(true);
            await act(async () => { viewerController!.port.apply({ kind: 'viewer.close' }); });
            phase = 'replacing a stream subscriber while its daemon admission is pending';
            await screen.update(<Harness shell="closed" />);
            delayStart = createDeferred<void>();
            pendingStart = createDeferred<void>();
            await screen.update(<Harness shell="pane" />);
            await act(async () => { await pendingStart!.promise; });
            // A genuinely new subscriber gets a new id under the same live Account. Destroy its
            // retained source explicitly, rather than retiring destination custody by keying the
            // entire app root (retired authority correctly cannot send a late network Stop).
            await act(async () => { store.removePortalEntry(slotId); });
            await screen.update(<Harness shell="floating" />);
            // This is a genuinely new portal, so its predecessor's geometry is not retained.
            await measurePicture();
            await act(async () => { delayStart!.resolve(); });
            await flushHookEffects();
            const mountedStreamId = await waitForMountedStream();
            expect(mountedStreamId).not.toBe(streamId);
            expect(readStream()?.playerState?.phase).not.toBe('error');
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            const frame = await sealMachineLiveStreamEnvelopeV1({
                v: 1, sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId: apiSocket.getSocketId(),
                message: { kind: 'frame', frame: { v: 1, streamId: mountedStreamId, sequence: 1,
                    timestampMs: 1234, codecId: 'image.frame.v1', payloadKind: 'image_keyframe',
                    payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
            }, { mode: 'plain' });
            expect(frame.ok).toBe(true);
            if (!frame.ok) throw new Error(frame.code);
            await act(async () => {
                for (const socket of network.socketBoundaries) socket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, frame.value);
            });
            await vi.waitFor(async () => {
                await flushHookEffects();
                const player = readStream()?.playerState;
                expect(player?.lastFrameAtMs, JSON.stringify(player)).toBe(1234);
            });
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            await screen.update(<Harness shell="closed" />);
            await flushHookEffects();
            delayStart = null;
            await screen.update(<Harness shell="pane" />);
            await waitForMountedStream();
            phase = 'closing a stream whose daemon start is still settling';
            await screen.update(<Harness shell="closed" />);
            delayStart = createDeferred<void>();
            pendingStart = createDeferred<void>();
            await screen.update(<Harness shell="pane" />);
            await act(async () => { await pendingStart!.promise; });
            await screen.update(<Harness shell="closed" />);
            await screen.update(<Harness shell="pane" />);
            await act(async () => { delayStart!.resolve(); });
            await flushHookEffects();
            await waitForMountedStream();
            await screen.update(<Harness shell="closed" />);
            await flushHookEffects();
            expect(activeStreams.size).toBe(0);
        } finally {
            recordContinuity = null;
            allowSocketReconnect = true;
            selectionRead?.resolve();
            viewport.width = 1440;
            viewport.height = 900;
            delayStart?.resolve();
            readBody();
            await screen.unmount();
            apiSocket.disconnect();
            await setActiveServer({ serverId: previousSelection.serverId });
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
            executorModule.dispose();
        }
    });
});
