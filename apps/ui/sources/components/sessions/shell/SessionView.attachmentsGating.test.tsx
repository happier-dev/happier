import 'fake-indexeddb/auto';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { readServerEnabledBit, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import { readComposerText } from '@/dev/testkit/readComposerText';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const goalRequests: Array<{ method: string; params: unknown }> = [];
const attachmentTransfers = new Map<string, { path: string; sizeBytes: number }>();
let attachmentRecipientPublicKey = '';
const abortRequests: Array<{ method: string; params: unknown }> = [];
let abortAcknowledgement: Promise<void> = Promise.resolve();
let releaseAbortAcknowledgement: (() => void) | undefined;
const agentInventory = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed attachment-gating RPC envelope');
    }
    const request = { method: payload.method, params: payload.params };
    const method = request.method.slice(request.method.indexOf(':') + 1);
    // The external daemon boundary accepts the real Session carrier's strict
    // request. Availability, Account routing, draft intake and encryption stay real.
    if (request.method === `s1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`) {
      const init = SessionAttachmentUploadInitRequestV1Schema.parse(request.params);
      if (typeof init.sizeBytes !== 'number') throw new Error('Expected finite attachment size');
      const uploadId = `attachment-upload-${attachmentTransfers.size}`;
      attachmentTransfers.set(uploadId, { path: `.happier/uploads/messages/${String(init.messageLocalId)}/${init.relativePath ?? String(init.fileName)}`,
        sizeBytes: init.sizeBytes });
      return { ok: true, result: { success: true, uploadId, chunkSizeBytes: 1024, recipientPublicKeyBase64: attachmentRecipientPublicKey } };
    }
    if (request.method === `s1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`) return { ok: true, result: { success: true } };
    if (request.method === `s1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE}`) {
      const params = request.params;
      if (!params || typeof params !== 'object' || !('uploadId' in params) || typeof params.uploadId !== 'string') throw new Error('Expected attachment upload id');
      const uploaded = attachmentTransfers.get(params.uploadId);
      if (!uploaded) throw new Error('Attachment upload was not prepared');
      return { ok: true, result: { success: true, ...uploaded, sha256: 'fixture-daemon-sha256',
        attachmentHandle: { v: 1, sessionId: 's1', id: `handle-${params.uploadId}` } } };
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { ok: true, result: agentInventory.capabilities };
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { ok: true,
      result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: agentInventory.projection }),
    };
    if (request.method === `s1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`) {
      goalRequests.push({ method: request.method, params: request.params });
      return { ok: true, result: { ok: true } };
    }
    if (request.method !== 's1:abort') return { ok: false, error: 'Daemon method unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    abortRequests.push({ method: request.method, params: request.params });
    await abortAcknowledgement;
    return { ok: true, result: null };
  });
});
let sessionHomeId: string;
let otherHomeId: string;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

const sessionState: { session: Session } = { session: createSessionFixture({ id: 's1' }) };

const attachmentsTransferAvailableState = vi.hoisted(() => ({ value: true }));
const attachmentsFeatureScopeState = vi.hoisted(() => ({ enabledForServerId: null as string | null }));
const modalAlertSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
      Dimensions: {
        get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
      },
      useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    });
});
vi.mock('react-native-keyboard-controller', async () =>
  (await import('@/dev/testkit/mocks/keyboardController')).createKeyboardControllerModuleMock());
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
      },
    }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { push: vi.fn(), back: vi.fn() },
      pathname: '/',
    }).module;
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

vi.mock('@happier-dev/iroh-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/iroh-native')>(),
  getOptionalHappierIrohNativeModule: () => ({
    getAvailability: () => ({ available: attachmentsTransferAvailableState.value }),
    startMachineTunnel: vi.fn(async () => { throw new Error('Availability must not open a tunnel'); }),
    stopMachineTunnel: vi.fn(async () => undefined),
  }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => createReactNavigationNativeMock());

const featureEnabledState: Record<string, boolean> = {
  voice: false,
  'files.reviewComments': false,
  'execution.runs': false,
  'attachments.uploads': false,
};

let browser = await installBrowserRuntimeForTests({ url: 'https://attachments-session.test', userAgent: 'iPhone' });
const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: browser.window.Image });
afterAll(() => {
  if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
  else Reflect.deleteProperty(globalThis, 'Image');
  browser.restore();
});
// Native's runtime singleton and Metro's call-time require bridge stay real.
await loadSyncSingletonForTests();
// Observe the actual detached dispatch; do not replace its work or rejection handling.
const fireAndForgetSpy = vi.spyOn(await import('@/utils/system/fireAndForget'), 'fireAndForget');

// The shared boundary factories must be configured before a storage consumer is imported.
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SessionView } = await import('./SessionView');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { SessionParticipantComposer } = await import('@/components/sessions/participants/composer/SessionParticipantComposer');
const { MINIMUM_CLI_VERSION } = await import('@/utils/system/versionUtils');
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionFileUploadAvailability } = await import('@/components/sessions/files/useSessionFileUploadAvailability');
const { useSessionMachineReachability } = await import('@/components/sessions/model/useSessionMachineReachability');
const { useServerScopedMachine, useSessionRpcAvailabilityState } = await import('@/sync/domains/state/storage');
const { isIrohMachineTransferLifecycleAvailable } = await import('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle');
const { getCachedServerFeaturesSnapshot, getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useServerFeaturesSnapshotForServerId } = await import('@/sync/domains/features/featureDecisionRuntime');
const { useFeatureEnabled } = await import('@/hooks/server/useFeatureEnabled');
const { getFeatureBuildPolicyDecision } = await import('@/sync/domains/features/featureBuildPolicy');
const { isMachineDaemonFiniteTransferApplicationSupported, isMachineDaemonIrohTransferApplicationSupported } = await import('@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState');
const { readCurrentMachineIrohEndpoint } = await import('@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection');
let actualUploadAvailability = false;
let availabilityProbeRenders = 0;
let actualGoalsEnabled = false;
let uploadPrerequisites: Record<string, unknown> = {};
let previousStorageState: ReturnType<typeof storage.getState>;

function serverFeatures(serverId: string) {
  const response = createRootLayoutFeaturesResponse();
  const attachmentsEnabled = attachmentsFeatureScopeState.enabledForServerId === null
    ? featureEnabledState['attachments.uploads'] === true
    : serverId === attachmentsFeatureScopeState.enabledForServerId;
  tryWriteServerEnabledBitInPlace(response, 'attachments.uploads', attachmentsEnabled);
  for (const feature of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
    tryWriteServerEnabledBitInPlace(response, feature, true);
  }
  return response;
}

function TransferAvailabilityProbe() {
  availabilityProbeRenders += 1;
  actualGoalsEnabled = useFeatureEnabled('agents.goals');
  actualUploadAvailability = useSessionFileUploadAvailability('s1', sessionState.session.serverId, 'attachment');
  const reachability = useSessionMachineReachability('s1', sessionState.session.serverId);
  const machine = useServerScopedMachine(sessionState.session.serverId, 'm1');
  const session = useSessionRpcAvailabilityState('s1');
  const scopedFeatures = useServerFeaturesSnapshotForServerId(sessionState.session.serverId);
  uploadPrerequisites = {
    sessionExists: session.sessionExists,
    machinePresent: Boolean(machine),
    machineRpcTargetAvailable: reachability.machineRpcTargetAvailable,
    machineReachability: reachability.machineReachability,
    serverFeaturesStatus: getCachedServerFeaturesSnapshot({ serverId: sessionState.session.serverId })?.status,
    nativeLifecycleAvailable: isIrohMachineTransferLifecycleAvailable(),
    applicationCarrierEligibility: storage.getState().localSettings.homeApplicationCarrierEligibility,
    scopedServerFeaturesStatus: scopedFeatures.status,
    transferFeatureBits: Object.fromEntries((['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const).map(feature => [feature,
      scopedFeatures.status === 'ready' ? readServerEnabledBit(scopedFeatures.features, feature) : null])),
    finiteTransferApplicationSupported: isMachineDaemonFiniteTransferApplicationSupported(machine?.daemonState),
    irohTransferApplicationSupported: isMachineDaemonIrohTransferApplicationSupported(machine?.daemonState),
    acceptedIrohEndpointPresent: Boolean(readCurrentMachineIrohEndpoint({
      capabilities: machine?.operationProtocolCapabilities, revision: machine?.operationProtocolCapabilitiesRevision,
      active: machine?.active, revokedAt: machine?.revokedAt,
    })),
  };
  return null;
}

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0], expectedTransferAvailable?: boolean) {
  storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
    'attachments.uploads': featureEnabledState['attachments.uploads'] === true,
  } });
  for (const serverId of [sessionHomeId, otherHomeId]) {
    home.answer(serverId, '/v1/features', { body: serverFeatures(serverId) });
    home.answer(serverId, '/v1/features/authenticated', { body: serverFeatures(serverId) });
  }
  resetServerFeaturesClientForTests();
  expect((await getServerFeaturesSnapshot({ serverId: sessionState.session.serverId })).status).toBe('ready');
  const { sync } = await import('@/sync/sync');
  // A store row alone is not Home admission after an empty Account snapshot.
  // Exercise the same exact by-ID HTTP owner that the Session route uses.
  const admission = await sync.ensureSessionVisibleForMessageRoute('s1', {
    serverId: sessionState.session.serverId, forceRefresh: true, hydrateMessages: false,
  });
  expect(admission.kind).toBe('available');
  sessionState.session = storage.getState().sessions.s1;
  const screen = await renderCanonicalScreen(<InjectedAuthProvider credentials={account.credentials}>
    <TransferAvailabilityProbe />{element}
  </InjectedAuthProvider>, { createNodeMock: element => Object.assign(
    document.createElement(element.type === 'TextInput' ? 'textarea' : 'div'), {
      setNativeProps() {}, setDropCaret() {}, measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
    }) });
  const metadata = readSessionOwnerMetadataView(sessionState.session);
  const expectsTransferAvailable = expectedTransferAvailable ?? (attachmentsTransferAvailableState.value
    && Boolean(metadata?.machineId && metadata.path));
  await waitForHomeGovernance(() => expect(actualUploadAvailability, JSON.stringify(uploadPrerequisites)).toBe(expectsTransferAvailable));
  return screen;
}

function createTransferMachine() {
  return createMachineFixture({ id: 'm1', kind: 'persistent', active: true, activeAt: Date.now(), revokedAt: null,
    operationProtocolCapabilitiesRevision: 1,
    operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
      finiteTransferRpc: { protocolVersions: [1] },
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48128'] },
    }),
    daemonState: MachinePublishedDaemonStateV1Schema.parse({ status: 'running', transfer: { supported: { import: true, export: true },
      listenerClasses: { loopback_http: { enabled: true, configured: true, active: false }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
      lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
    } }),
  });
}

function createTransferMachineRow() {
  const machine = createTransferMachine();
  return {
    ...createPlainMachineRowFixture({ id: machine.id, accountId: 'u1' }),
    activeAt: machine.activeAt,
    metadata: encodePlainMachineStoredContent(machine.metadata),
    daemonState: encodePlainMachineStoredContent(machine.daemonState),
    operationProtocolCapabilities: machine.operationProtocolCapabilities,
    operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
  };
}

function applySessionFixture() {
  storage.getState().applySessions([sessionState.session]);
  storage.getState().applyMachines([createTransferMachine()], true, { sourceServerId: sessionState.session.serverId, sourceAccountId: 'u1' });
}

async function sendComposerAndWaitForTerminal(input: renderer.ReactTestInstance) {
  const before = fireAndForgetSpy.mock.calls.length;
  await renderer.act(async () => {
    await input.props.onSend();
    const dispatch = fireAndForgetSpy.mock.calls.slice(before).find(([, options]) => options?.tag === 'SessionView.composer.dispatch')?.[0];
    if (!dispatch) throw new Error('Expected the actual composer dispatch promise');
    await dispatch;
  });
}

describe('SessionView attachments gating', () => {
  beforeEach(async () => {
    // The package harness restores Node globals before each case. Install the
    // physical browser port again before Home/Account captures its lifetime.
    browser.restore();
    browser = await installBrowserRuntimeForTests({ url: 'https://attachments-session.test', userAgent: 'iPhone' });
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: browser.window.Image });
    previousStorageState = storage.getState();
    attachmentsTransferAvailableState.value = true;
    attachmentsFeatureScopeState.enabledForServerId = null;
    featureEnabledState['attachments.uploads'] = false;
    actualUploadAvailability = false;
    availabilityProbeRenders = 0;
    actualGoalsEnabled = false;
    uploadPrerequisites = {};
    abortRequests.length = 0;
    goalRequests.length = 0;
    attachmentTransfers.clear();
    attachmentRecipientPublicKey = (await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption'))
      .createTransferRecipientKeyPair().recipientPublicKeyBase64;
    fireAndForgetSpy.mockClear();
    abortAcknowledgement = Promise.resolve();
    releaseAbortAcknowledgement = undefined;
    await home.reset();
    sessionHomeId = await home.addHome({ name: 'Session Home', serverUrl: 'https://attachments-session.test', accountId: 'u1' });
    otherHomeId = await home.addHome({ name: 'Other Home', serverUrl: 'https://attachments-other.test', accountId: 'u1', active: false });
    await loadSyncSingletonForTests();
    const accountHttp = createHomeHubArtifactHttpBoundary('u1');
    account = await restoreServerAccountForTest({
      serverUrl: 'https://attachments-session.test', accountId: 'u1',
      additionalRequestOrigins: ['https://attachments-other.test'],
      request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const requestUrl = new URL(String(url));
        const path = requestUrl.pathname;
        const requestServerId = requestUrl.origin === 'https://attachments-other.test' ? otherHomeId : sessionHomeId;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
          experiments: true,
          featureToggles: {
            'attachments.uploads': featureEnabledState['attachments.uploads'] === true,
          },
        } }, version: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(serverFeatures(requestServerId));
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
          status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        }));
        if (path === '/v1/machines') return Response.json([createTransferMachineRow()]);
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
          return createMachineReadBatchResponseFixture(JSON.parse(String(init.body)), id => id === 'm1' ? createTransferMachineRow() : null);
        }
        if (path === '/v1/machines/m1') return Response.json({ machine: createTransferMachineRow() });
        if (path === '/v2/sessions/s1' && (init?.method ?? 'GET') === 'GET') {
          return Response.json(createPlainSessionByIdResponseFixture(sessionState.session));
        }
        if (path === '/v2/sessions/s1/pending') return Response.json({ pending: [] });
        if (path === '/v1/sessions/s1/messages') return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        return createEmptyAccountBootstrapHttpResponse(path, init) ?? await accountHttp.request(url, init);
      }),
    });
    await waitForHomeGovernance(() => expect(storage.getState()).toMatchObject({
      isDataReady: true, profile: { id: 'u1' },
    }));
    sessionState.session = createSessionFixture({
      id: 's1',
      serverId: sessionHomeId,
      active: true,
      metadata: {
        machineId: 'm1',
        host: 'tester.local',
        flavor: 'codex',
        version: MINIMUM_CLI_VERSION,
        codexSessionId: 'codex-session-1',
        codexBackendMode: 'appServer',
        path: '/tmp',
        homeDir: '/tmp',
      },
      agentState: { controlledByUser: true },
    });
    storage.setState({ isDataReady: true });
    // This native positive-availability fixture opts into the carrier it
    // supplies. A retained standard_only preference disables native Iroh even
    // when the Machine, feature discovery, and native lifecycle are all ready.
    storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: false, homeApplicationCarrierEligibility: 'automatic' }, { persist: false });
    applySessionFixture();
    modalAlertSpy.mockReset();
  });

  afterEach(async () => {
    releaseAbortAcknowledgement?.();
    standardCleanup();
    await account.dispose();
    await home.reset();
    storage.setState(previousStorageState, true);
    vi.unstubAllEnvs();
    browser.restore();
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else Reflect.deleteProperty(globalThis, 'Image');
  });

  it('returns the session abort operation promise from the composer callback', async () => {
    sessionState.session.thinking = true;
    applySessionFixture();
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
      releaseAbortAcknowledgement = resolve;
    });
    abortAcknowledgement = abortPromise;

    const tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType(AgentInput);
    const returnedAbort = agentInput.props.onAbort();

    expect(returnedAbort).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(abortRequests).toEqual([
      { method: 's1:abort', params: { reason: expect.any(String) } },
    ]));

    let settled = false;
    void returnedAbort.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAbort();
    await expect(returnedAbort).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(storage.getState().sessions.s1.thinking).toBe(false);
  });

  it('does not wire drag/drop/paste attachments when attachments.uploads is disabled', async () => {
    attachmentsFeatureScopeState.enabledForServerId = null;
    featureEnabledState['attachments.uploads'] = false;
    attachmentsTransferAvailableState.value = true;

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType(AgentInput);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
    expect((agentInput.props.extraActionChips ?? []).find((chip: AgentInputExtraActionChip) => chip.controlId === 'attachments'))
      .toBeUndefined();
  });

  it.each(['owner', 'edit'] as const)('keeps Attach available for a Ready %s Session without a Machine carrier', async level => {
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = false;
    sessionState.session = createSessionFixture({ ...sessionState.session,
      access: createSessionAccessFixture(level),
      metadata: { ...sessionState.session.metadata!, path: level === 'owner' ? '/' : '/home/happier.guest' },
    });
    applySessionFixture();
    const { sync } = await import('@/sync/sync');
    expect(sync.getSessionAttachmentTransferContext('s1')).toBeUndefined();
    expect(sync.getSessionAttachmentTransferContext('s1', { purpose: 'attachmentUpload',
      target: { serverId: sessionHomeId, accountId: 'u1', sessionId: 's1' },
    })).toBeDefined();
    const { readSessionFileUploadAvailability } = await import('@/components/sessions/files/readSessionFileUploadAvailability');
    expect((await readSessionFileUploadAvailability({ serverId: sessionHomeId, sessionId: 's1' })).uploadAvailable).toBe(true);
    const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>, true);
    const input = screen.tree.findByType(AgentInput);
    expect(input.props.onAttachmentsAdded).toBeTypeOf('function');
    const chip: AgentInputExtraActionChip | undefined = input.props.extraActionChips
      .find((entry: AgentInputExtraActionChip) => entry.controlId === 'attachments');
    expect(chip?.collapsedOptionsPopover?.rootStep).toMatchObject({
      sections: [{ options: expect.arrayContaining([expect.objectContaining({ id: 'add-file', disabled: false })]) }],
    });
  });

  it('fails closed when neither a live Session nor a Machine carrier is available', async () => {
    attachmentsFeatureScopeState.enabledForServerId = null;
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = false;
    sessionState.session.active = false;
    applySessionFixture();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType(AgentInput);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
    // A missing transfer route disables Attach; it must not look like an absent feature.
    const chip: AgentInputExtraActionChip | undefined = (agentInput.props.extraActionChips ?? [])
      .find((entry: AgentInputExtraActionChip) => entry.controlId === 'attachments');
    expect(chip?.collapsedAction?.({ tint: '#000', dismiss: vi.fn(), blurInput: vi.fn(), openCollapsedPopover: vi.fn() }))
      .toMatchObject({ disabled: true, subtitle: 'files.transfers.uploadUnavailable' });
  });

  it('retains the participant Attach control with its recovery reason when both carriers are unavailable', async () => {
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = false;
    sessionState.session.active = false;
    applySessionFixture();
    const screen = await renderScreen(<AppPaneProvider><SessionParticipantComposer
      sessionId="s1" serverId={sessionHomeId} canSendMessages recipient={null}
    /></AppPaneProvider>, false);
    const input = screen.tree.findByType(AgentInput);
    const chip: AgentInputExtraActionChip | undefined = input.props.extraActionChips
      .find((entry: AgentInputExtraActionChip) => entry.controlId === 'attachments');
    expect(chip?.collapsedAction?.({ tint: '#000', dismiss: vi.fn(), blurInput: vi.fn(), openCollapsedPopover: vi.fn() }))
      .toMatchObject({ disabled: true, subtitle: 'files.transfers.uploadUnavailable' });
    expect(input.props.onAttachmentsAdded).toBeUndefined();
  });

  it('uses only the exact live Session, reacts to retirement/recovery, and ignores unrelated Session arrivals', async () => {
    attachmentsTransferAvailableState.value = false;
    await renderScreen(<></>, true);
    const workspace = await renderHook(() => useSessionFileUploadAvailability('s1', sessionHomeId));
    const otherHome = await renderHook(() => useSessionFileUploadAvailability('s1', otherHomeId, 'attachment'));
    expect(workspace.getCurrent()).toBe(false);
    expect(otherHome.getCurrent()).toBe(false);
    const before = availabilityProbeRenders;
    await renderer.act(async () => storage.getState().applySessions([
      createSessionFixture({ id: 'unrelated-session', serverId: sessionHomeId, active: true }),
    ]));
    expect(availabilityProbeRenders - before).toBe(0);
    await renderer.act(async () => storage.getState().applySessions([{ ...sessionState.session, active: false }]));
    await waitForHomeGovernance(() => expect(actualUploadAvailability).toBe(false));
    await renderer.act(async () => storage.getState().applySessions([{ ...sessionState.session, active: true }]));
    await waitForHomeGovernance(() => expect(actualUploadAvailability).toBe(true));
    await workspace.unmount();
    await otherHome.unmount();
  });

  it.each(['main', 'participant'] as const)('eagerly uploads a picked folder through the %s composer Session carrier without a Machine carrier', async surface => {
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = false;
    const screen = await renderScreen(<AppPaneProvider>{surface === 'main'
      ? <SessionView id="s1" />
      : <SessionParticipantComposer sessionId="s1" serverId={sessionHomeId} canSendMessages recipient={null} />
    }</AppPaneProvider>, true);
    const input = screen.tree.findByType(AgentInput);
    expect(input.props.onAttachmentsAdded).toBeTypeOf('function');
    await renderer.act(async () => input.props.onAttachmentsAdded([], { sources: [{ kind: 'folder', name: 'project',
      mimeType: 'inode/directory', entries: [{ relativePath: 'note.txt',
        source: { kind: 'memory', name: 'note.txt', bytes: new Uint8Array([1, 2, 3]) } }],
    }] }));
    await waitForHomeGovernance(() => expect(screen.tree.findByType(AgentInput).props.attachmentRowItems)
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'project', status: 'uploaded' })])));
    expect(screen.tree.findByType(AgentInput).props.hasSendableAttachments).toBe(true);
    expect([...attachmentTransfers.values()].some(transfer => transfer.sizeBytes === 3)).toBe(true);
  });

  it('keeps attachment handlers disabled when session-scoped uploads are not active for the viewed session', async () => {
    attachmentsFeatureScopeState.enabledForServerId = sessionHomeId;
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = true;
    sessionState.session.serverId = otherHomeId;
    applySessionFixture();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" routeServerId={otherHomeId} />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType(AgentInput);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
  });

  it('preserves slash-command alert titles from the command executor', async () => {
    sessionState.session.metadata = { ...sessionState.session.metadata!, agentRuntimeDescriptorV1: { v: 1, agentId: 'codex', provider: { backendMode: 'appServer' } } };
    sessionState.session.agentState = { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } };
    applySessionFixture();
    // This client-only gate has no Account toggle or server bit. Exercise the
    // supported build-policy off switch without replacing the feature decision.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'agents.goals');
    const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>);
    expect(getFeatureBuildPolicyDecision('agents.goals')).toBe('deny');
    expect(actualGoalsEnabled).toBe(false);
    let input = screen.tree.findByType(AgentInput);
    expect((input.props.extraActionChips ?? []).some((chip: { controlId?: string }) => chip.controlId === 'goal')).toBe(false);
    await renderer.act(async () => { input.props.onChangeText('/goal set Ship goal UI'); });
    input = screen.tree.findByType(AgentInput);
    expect(readComposerText(input)).toBe('/goal set Ship goal UI');
    await sendComposerAndWaitForTerminal(input);
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session.workState.unsupportedMessage');
    expect(goalRequests).toEqual([]);
    expect(readComposerText(screen.tree.findByType(AgentInput))).toBe('/goal set Ship goal UI');
  });

  it('submits native goal mutations through the command executor when editable goals are enabled', async () => {
    sessionState.session.metadata = { ...sessionState.session.metadata!, agentRuntimeDescriptorV1: { v: 1, agentId: 'codex', provider: { backendMode: 'appServer' } } };
    sessionState.session.agentState = { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } };
    applySessionFixture();
    const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>);
    expect(getFeatureBuildPolicyDecision('agents.goals')).not.toBe('deny');
    expect(actualGoalsEnabled).toBe(true);
    let input = screen.tree.findByType(AgentInput);
    await waitForHomeGovernance(() => expect((screen.tree.findByType(AgentInput).props.extraActionChips ?? [])
      .some((chip: { controlId?: string }) => chip.controlId === 'goal')).toBe(true));
    await renderer.act(async () => { input.props.onChangeText('/goal set Ship goal UI'); });
    input = screen.tree.findByType(AgentInput);
    await sendComposerAndWaitForTerminal(input);
    expect(goalRequests).toEqual([
      { method: `s1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`, params: { objective: 'Ship goal UI' } },
    ]);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(readComposerText(screen.tree.findByType(AgentInput))).toBe('');
  });
});
