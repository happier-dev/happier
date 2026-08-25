import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createLiveStorageStoreMock, createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
let authCredentials: any = { token: 't', secret: 's' };
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));

const attachmentsTransferAvailableState = vi.hoisted(() => ({ value: true }));
const attachmentsFeatureScopeState = vi.hoisted(() => ({ enabledForServerId: null as string | null }));
const executeSessionComposerResolutionMock = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const resolveSessionComposerSendMock = vi.hoisted(() => vi.fn(() => ({ kind: 'noop' })));
const supportsEditableSessionGoalsMock = vi.hoisted(() => vi.fn(() => false));
const sessionAbortMock = vi.hoisted(() => vi.fn());

installSessionShellCommonModuleMocks({
  reactNative: async () =>
    createReactNativeWebMock({
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
    supportsEditableSessionGoals: supportsEditableSessionGoalsMock,
  }),
  storage: async () =>
    createStorageModuleStub({
      storage: createLiveStorageStoreMock(() => ({
        sessions: { s1: sessionState.session },
        settings: settingsDefaults,
        sessionListIndexByServerId: {},
      })),
      useSession: () => sessionState.session,
      useSessionMachineId: () => sessionState.session.metadata?.machineId ?? null,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ status: 'connected' }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionSubagentSourceMessages: () => [],
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useOpenApprovalArtifactsForSession: () => [],
      useEnabledAutomationsCountForSession: () => 0,
      useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return false;
        if (key === 'acknowledgedCliVersions') return [];
        return null;
      },
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionReviewCommentsDrafts: () => [],
      useSessionUsage: () => null,
      useSetting: () => null,
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
      useMachine: () => null,
      useLocalSettingMutable: () => [false, vi.fn()],
      useSettingMutable: () => [null, vi.fn()],
    }),
});

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
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: authCredentials }),
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

vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
  useSessionFileUploadAvailability: () => attachmentsTransferAvailableState.value,
}));

const featureEnabledState: Record<string, boolean> = {
  voice: false,
  'files.reviewComments': false,
  'execution.runs': false,
  'attachments.uploads': false,
};
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
    if (featureId === 'attachments.uploads' && attachmentsFeatureScopeState.enabledForServerId != null) {
      return scope?.scopeKind === 'spawn' && scope.serverId === attachmentsFeatureScopeState.enabledForServerId;
    }
    return featureEnabledState[featureId] === true;
  },
}));

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
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock(
  '@/components/sessions/model/useSessionMachineReachability',
  async (importOriginal) => {
    const {
      createReachableSessionMachineReachability,
      createSessionMachineReachabilityModuleMock,
    } = await import('@/dev/testkit/mocks/sessionMachineReachability');
    return createSessionMachineReachabilityModuleMock({
      importOriginal,
      overrides: {
        useSessionMachineReachability: createReachableSessionMachineReachability,
        useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
      },
    });
  },
);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
  subscribeActiveServer: () => () => {},
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/sync/sync', async () => {
  const { createAcceptedExternalSessionTailCursorSyncBoundary } = await import('@/dev/testkit/mocks/sync');
  return {
    sync: {
      ...createAcceptedExternalSessionTailCursorSyncBoundary(),
      markSessionViewed: async () => {},
      fetchPendingMessages: async () => {},
      publishSessionPermissionModeToMetadata: async () => {},
      publishSessionAcpSessionModeOverrideToMetadata: async () => {},
      publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
      publishSessionModelOverrideToMetadata: async () => {},
      refreshSessions: async () => {},
      onSessionVisible: () => {},
      sendMessage: async () => {},
      enqueuePendingMessage: async () => {},
      submitMessage: async () => {},
      encryption: {
        getMachineEncryption: () => null,
      },
    },
  };
});

vi.mock('@/sync/ops', async (importOriginal) => {
  const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
  return createSyncOpsModuleMock({
    importOriginal,
    overrides: {
      sessionAbort: (...args: unknown[]) => sessionAbortMock(...args),
      resumeSession: vi.fn(),
      sessionAttachmentsUploadFile: vi.fn(),
    },
  });
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
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

vi.mock('@/agents/catalog/catalog', () => ({
  AGENT_IDS: ['codex'],
  DEFAULT_AGENT_ID: 'codex',
  buildResumeSessionExtrasFromUiState: () => null,
  getAgentCore: () => ({
    cli: { detectKey: 'codex' },
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.codex', connectRoute: null },
    model: { defaultMode: 'default' },
    resume: { vendorResumeIdField: null },
    sessionModes: { kind: 'none' },
  }),
  getAgentResumeExperimentsFromSettings: () => null,
  getNewSessionRelevantInstallableDepKeys: () => [],
  isBundledAgentId: (value: unknown) => value === 'codex',
  resolveAgentIdFromFlavor: () => 'codex',
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
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: resolveSessionComposerSendMock,
}));
vi.mock('@/sync/domains/input/slashCommands/executeSessionComposerResolution', () => ({
  executeSessionComposerResolution: executeSessionComposerResolutionMock,
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
  chooseSubmitMode: () => 'direct',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControl: () => false,
  shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
  supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/ops/sessionSwitch', () => ({
  sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
  countEnabledAutomationsLinkedToSession: () => 0,
}));

const { SessionView } = await import('./SessionView');

describe('SessionView attachments gating', () => {
  beforeEach(() => {
    sessionState.session = {
      id: 's1',
      metadata: null,
      accessLevel: 'edit',
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
    } as any;
    executeSessionComposerResolutionMock.mockReset();
    modalAlertSpy.mockReset();
    resolveSessionComposerSendMock.mockReset();
    resolveSessionComposerSendMock.mockImplementation(() => ({ kind: 'noop' }));
    sessionAbortMock.mockReset();
    supportsEditableSessionGoalsMock.mockReset();
    supportsEditableSessionGoalsMock.mockReturnValue(false);
    featureEnabledState['agents.goals'] = false;
  });

  it('returns the session abort operation promise from the composer callback', async () => {
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    sessionAbortMock.mockReturnValueOnce(abortPromise);

    const tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
    const returnedAbort = agentInput.props.onAbort();

    expect(sessionAbortMock).toHaveBeenCalledWith('s1');
    expect(returnedAbort).toBe(abortPromise);

    let settled = false;
    void returnedAbort.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAbort();
    await expect(returnedAbort).resolves.toBeUndefined();
    expect(settled).toBe(true);
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
    attachmentsFeatureScopeState.enabledForServerId = 'server-1';
    featureEnabledState['attachments.uploads'] = true;
    attachmentsTransferAvailableState.value = true;
    sessionState.session.serverId = 'server-2';

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" routeServerId="server-2" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
  });

  it('preserves slash-command alert titles from the command executor', async () => {
    resolveSessionComposerSendMock.mockReturnValue({ kind: 'goal', command: 'set', objective: 'Ship goal UI' } as any);
    executeSessionComposerResolutionMock.mockImplementation(async (args: any) => {
      args.modalAlert('Goal unavailable', 'This backend does not support editable session goals yet.');
      return true;
    });

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    let agentInput = tree.findByType('AgentInput' as any);
    await renderer.act(async () => {
      agentInput.props.onChangeText('/goal Ship goal UI');
    });
    agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.value).toBe('/goal Ship goal UI');
    await renderer.act(async () => {
      agentInput.props.onSend();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(executeSessionComposerResolutionMock).toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'This backend does not support editable session goals yet.');
  });

  it('passes native goal mutation callbacks to the command executor when editable goals are enabled', async () => {
    featureEnabledState['agents.goals'] = true;
    supportsEditableSessionGoalsMock.mockReturnValue(true);
    sessionState.session.metadata = { flavor: 'codex' };
    resolveSessionComposerSendMock.mockReturnValue({ kind: 'goal', command: 'set', objective: 'Ship goal UI' } as any);
    executeSessionComposerResolutionMock.mockResolvedValue(true);

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    let agentInput = tree.findByType('AgentInput' as any);
    await renderer.act(async () => {
      agentInput.props.onChangeText('/goal Ship goal UI');
    });
    agentInput = tree.findByType('AgentInput' as any);
    await renderer.act(async () => {
      agentInput.props.onSend();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(executeSessionComposerResolutionMock).toHaveBeenCalledTimes(1);
    const [resolutionArgs] = executeSessionComposerResolutionMock.mock.calls[0] as [any];
    expect(typeof resolutionArgs.setSessionGoal).toBe('function');
    expect(typeof resolutionArgs.clearSessionGoal).toBe('function');
  });
});
