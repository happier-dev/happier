import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const goalRequests: Array<{ method: string; params: unknown }> = [];
const abortRequests: Array<{ method: string; params: unknown }> = [];
let abortAcknowledgement: Promise<void> = Promise.resolve();
installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    const request = payload as { method: string; params: unknown };
    if (request.method === `s1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`) {
      goalRequests.push({ method: request.method, params: request.params });
      return { ok: true, result: { ok: true } };
    }
    if (request.method !== 's1:abort') throw new Error(`Unexpected attachment-gating RPC: ${request.method}`);
    abortRequests.push({ method: request.method, params: request.params });
    await abortAcknowledgement;
    return { ok: true, result: null };
  });
});
let sessionHomeId: string;
let otherHomeId: string;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionPresentationBridge', () => ({
  SessionCompanionPresentationBridge: () => null,
}));
vi.mock('@/components/sessions/companion/SessionCompanionHost', () => ({
  SessionCompanionHost: () => null,
}));
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
  SessionBoardControllerProvider: ({ children }: React.PropsWithChildren) => children,
  useMountedSessionBoardController: () => null,
}));


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    serverId: 'server-1',
    metadata: {
      machineId: 'm1',
      flavor: 'codex',
      version: '0.0.0',
      path: '/tmp',
      homeDir: '/tmp',
    },
    accessLevel: 'edit',
    access: { level: 'edit', capabilities: { readTranscript: true, submitAgentInput: true } },
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));

const attachmentsTransferAvailableState = vi.hoisted(() => ({ value: true }));
const attachmentsFeatureScopeState = vi.hoisted(() => ({ enabledForServerId: null as string | null }));
const modalAlertSpy = vi.hoisted(() => vi.fn());

installSessionShellCommonModuleMocks({
  reactNative: async () =>
    createReactNativeWebMock({
      Platform: { OS: 'ios' },
      AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove() {} })) },
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      Easing: {
        bezier: vi.fn(() => ({})),
      },
      Animated: {
        View: 'Animated.View',
        Value: class {
          private _v: number;

          constructor(v: number) {
            this._v = v;
          }

          // Minimal stub for Animated.Value used by MultiPaneHost.
          interpolate() {
            return this;
          }
        },
        timing: () => ({
          start: (cb?: any) => cb?.({ finished: true }),
        }),
      },
      AccessibilityInfo: {
        isReduceMotionEnabled: vi.fn(async () => false),
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      },
      Dimensions: {
        get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
      },
      useWindowDimensions: () => ({ width: 1200, height: 800 }),
      Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) =>
          spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
      },
    }),
  unistyles: async () =>
    createUnistylesMock(),
  text: async () => createTextModuleMock({ translate: (key) => key }),
  modal: async () =>
    createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
      },
    }).module,
  router: async () =>
    createExpoRouterMock({
      router: { push: vi.fn(), back: vi.fn() },
      pathname: '/',
    }).module,
  registryUiBehavior: async () => ({
    buildResumeCapabilityOptionsFromUiState: () => ({}),
    buildNewSessionOptionsFromUiState: () => ({}),
    canSelectAgentWithoutDetectedCli: () => false,
    getNewSessionAgentInputExtraActionChips: () => [],
    buildSpawnEnvironmentVariablesFromUiState: () => ({}),
    buildResumeSessionExtrasFromUiState: () => ({}),
    buildSpawnSessionExtrasFromUiState: () => ({}),
    buildWakeResumeExtras: () => ({}),
    getAgentResumeExperimentsFromSettings: () => ({ enabled: true, switches: {} }),
    getNewSessionPreflightIssues: () => [],
    getNewSessionRelevantInstallableDepKeys: () => [],
    resolveAgentUiBehavior: () => ({}),
    resolveAgentUiBehaviorFromFlavor: () => ({}),
    resolveAgentUiBehaviorFromSessionMetadata: () => ({}),
  }),
  storage: async (importOriginal) => importOriginal(),
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

vi.mock('@react-navigation/native', () => ({
  ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
  SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

const featureEnabledState: Record<string, boolean> = {
  voice: false,
  'files.reviewComments': false,
  'execution.runs': false,
  'attachments.uploads': false,
};
vi.mock('@/utils/platform/responsive', () => ({
  getDeviceType: () => 'phone',
  useDeviceType: () => 'phone',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));

vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));



vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', props),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
  useResumeCapabilityOptions: () => ({}),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canResumeSessionWithOptions: () => true,
  getAgentVendorResumeId: () => '',
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useMachineCapabilitiesCache: () => ({ state: { status: 'loaded', snapshot: { response: { results: [] } } } }),
    prefetchMachineCapabilities: vi.fn(),
    getMachineCapabilitiesSnapshot: vi.fn(),
  };
});
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useSessionStatus: () => ({ statusText: '', statusColor: '#000', statusDotColor: '#000' }),
    shouldShowAbortButtonForSessionState: () => false,
    getSessionAvatarId: () => '1',
    getSessionName: () => 'Session',
    listPendingPermissionRequests: () => [],
    listPendingUserActionRequests: () => [],
    formatPathRelativeToHome: () => '',
    getSessionSubtitle: () => '',
  };
});
vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));
vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => void p,
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
  chooseSubmitMode: () => 'direct',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
  shouldRenderChatTimelineForSession: () => true,
}));
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
  supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/ops/sessionSwitch', () => ({
  sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
  countEnabledAutomationDefinitionsLinkedToSession: () => 0,
}));

// The shared boundary factories must be configured before a storage consumer is imported.
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SessionView } = await import('./SessionView');
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionFileUploadAvailability } = await import('@/components/sessions/files/useSessionFileUploadAvailability');
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
let actualUploadAvailability = false;
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
  actualUploadAvailability = useSessionFileUploadAvailability('s1', sessionState.session.serverId, 'attachment');
  return null;
}

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0]) {
  storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
    'attachments.uploads': featureEnabledState['attachments.uploads'] === true,
    'agents.goals': featureEnabledState['agents.goals'] === true,
  } });
  for (const serverId of [sessionHomeId, otherHomeId]) {
    home.answer(serverId, '/v1/features', { body: serverFeatures(serverId) });
    home.answer(serverId, '/v1/features/authenticated', { body: serverFeatures(serverId) });
  }
  resetServerFeaturesClientForTests();
  await getServerFeaturesSnapshot({ serverId: sessionState.session.serverId });
  const screen = await renderCanonicalScreen(<InjectedAuthProvider credentials={account.credentials}>
    <TransferAvailabilityProbe />{element}
  </InjectedAuthProvider>);
  const expectsTransferAvailable = attachmentsTransferAvailableState.value
    && Boolean(sessionState.session.metadata?.machineId && sessionState.session.metadata?.path);
  await vi.waitFor(() => expect(actualUploadAvailability).toBe(expectsTransferAvailable));
  return screen;
}

function applySessionFixture() {
  storage.getState().applySessions([sessionState.session]);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: true, activeAt: Date.now(), revokedAt: null,
    operationProtocolCapabilitiesRevision: 1,
    operationProtocolCapabilities: {
      finiteTransferRpc: { protocolVersions: [1] },
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48128'], relayUrls: [] },
    },
    daemonState: { transfer: { supported: { import: true, export: true },
      listenerClasses: { loopback_http: { enabled: false, configured: false, active: false }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
      lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
    } },
  })], true, { sourceServerId: sessionState.session.serverId });
}

describe('SessionView attachments gating', () => {
  beforeEach(async () => {
    previousStorageState = storage.getState();
    attachmentsTransferAvailableState.value = true;
    attachmentsFeatureScopeState.enabledForServerId = null;
    featureEnabledState['attachments.uploads'] = false;
    actualUploadAvailability = false;
    abortRequests.length = 0;
    goalRequests.length = 0;
    abortAcknowledgement = Promise.resolve();
    await home.reset();
    sessionHomeId = await home.addHome({ name: 'Session Home', serverUrl: 'https://attachments-session.test', accountId: 'u1' });
    otherHomeId = await home.addHome({ name: 'Other Home', serverUrl: 'https://attachments-other.test', accountId: 'u1', active: false });
    await loadSyncSingletonForTests();
    account = await restoreServerAccountForTest({
      serverUrl: 'https://attachments-session.test', accountId: 'u1',
      request: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(serverFeatures(sessionHomeId));
        if (path === '/v2/sessions/s1/pending') return Response.json({ pending: [] });
        if (path === '/v1/sessions/s1/messages') return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        return Response.json({}, { status: 404 });
      },
    });
    sessionState.session = createSessionFixture({
      id: 's1',
      serverId: sessionHomeId,
      active: true,
      metadata: {
        machineId: 'm1',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
      },
      agentState: { controlledByUser: true },
    });
    storage.setState({ isDataReady: true });
    storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: false }, { persist: false });
    applySessionFixture();
    modalAlertSpy.mockReset();
    featureEnabledState['agents.goals'] = false;
  });

  afterEach(async () => {
    standardCleanup();
    await account.dispose();
    await home.reset();
    storage.setState(previousStorageState, true);
  });

  it('returns the session abort operation promise from the composer callback', async () => {
    sessionState.session.thinking = true;
    applySessionFixture();
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    abortAcknowledgement = abortPromise;

    const tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
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

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
  });

  it('fails closed when attachments.uploads is enabled but session file upload availability is false', async () => {
    attachmentsFeatureScopeState.enabledForServerId = null;
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = false;

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
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

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
  });

  it('preserves slash-command alert titles from the command executor', async () => {
    sessionState.session.metadata = { ...sessionState.session.metadata, agentRuntimeDescriptorV1: { v: 1, agentId: 'codex', provider: { backendMode: 'appServer' } } };
    sessionState.session.agentState = { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } };
    applySessionFixture();
    featureEnabledState['agents.goals'] = false;
    const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>);
    let input = screen.tree.findByType('AgentInput' as React.ElementType);
    await renderer.act(async () => { input.props.onChangeText('/goal set Ship goal UI'); });
    input = screen.tree.findByType('AgentInput' as React.ElementType);
    expect(input.props.value).toBe('/goal set Ship goal UI');
    await renderer.act(async () => { await input.props.onSend(); });
    await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session.workState.unsupportedMessage'));
    expect(goalRequests).toEqual([]);
    expect(screen.tree.findByType('AgentInput' as React.ElementType).props.value).toBe('/goal set Ship goal UI');
  });

  it('submits native goal mutations through the command executor when editable goals are enabled', async () => {
    featureEnabledState['agents.goals'] = true;
    sessionState.session.metadata = { ...sessionState.session.metadata, agentRuntimeDescriptorV1: { v: 1, agentId: 'codex', provider: { backendMode: 'appServer' } } };
    sessionState.session.agentState = { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } };
    applySessionFixture();
    const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>);
    let input = screen.tree.findByType('AgentInput' as React.ElementType);
    await renderer.act(async () => { input.props.onChangeText('/goal set Ship goal UI'); });
    input = screen.tree.findByType('AgentInput' as React.ElementType);
    await renderer.act(async () => { await input.props.onSend(); });
    await vi.waitFor(() => expect(goalRequests).toEqual([
      { method: `s1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`, params: { objective: 'Ship goal UI' } },
    ]));
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(screen.tree.findByType('AgentInput' as React.ElementType).props.value).toBe('');
  });
});
