import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
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
const sessionAbortMock = vi.hoisted(() => vi.fn());

installSessionShellCommonModuleMocks({
  featureEnabled: () => ({
    useFeatureEnabled: (featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
      if (featureId === 'attachments.uploads' && attachmentsFeatureScopeState.enabledForServerId != null) {
        return scope?.scopeKind === 'spawn' && scope.serverId === attachmentsFeatureScopeState.enabledForServerId;
      }
      return featureEnabledState[featureId] === true;
    },
  }),
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
  storage: async () =>
    createStorageModuleStub({
      storage: Object.assign(
        (
          selector?: (value: {
            sessions: Record<string, unknown>;
            settings: Record<string, unknown>;
            sessionListViewDataByServerId: Record<string, unknown>;
          }) => unknown,
        ) => {
          const snapshot = { sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} };
          return typeof selector === 'function' ? selector(snapshot) : snapshot;
        },
        {
          getState: () => ({ sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} }),
          getInitialState: () => ({ sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} }),
          setState: () => undefined,
          subscribe: () => () => undefined,
          destroy: () => undefined,
        },
      ),
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ status: 'connected' }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionSubagentSourceMessages: () => [],
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return false;
        if (key === 'acknowledgedCliVersions') return [];
        return null;
      },
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionReviewCommentsDrafts: () => [],
      useSessionUsage: () => null,
      useProfile: () => null,
      useActiveServerAccountScope: () => ({ serverId: 'server-1', accountId: 'account-1' }),
      useSetting: () => null,
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
      useSessionAutomationsEnabledCount: () => 0,
      useOpenApprovalArtifactsForSession: () => [],
      useMachine: () => null,
      useLocalSettingMutable: () => [false, vi.fn()],
      useSettingMutable: () => [null, vi.fn()],
    }),
});

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
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

vi.mock('@/utils/platform/responsive', () => ({
  getDeviceType: () => 'phone',
  useDeviceType: () => 'phone',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
  useDraft: (_sessionId: string, value: string, onChange: (next: string) => void) => ({
    clearDraft: () => onChange(''),
    setDraftValue: (nextValueOrUpdater: string | ((currentValue: string) => string)) => {
      onChange(typeof nextValueOrUpdater === 'function' ? nextValueOrUpdater(value) : nextValueOrUpdater);
    },
    clearDraftForSessionIfCurrentValueMatches: (snapshot: Readonly<{ text: string }>) => {
      if (value !== snapshot.text) return false;
      onChange('');
      return true;
    },
  }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
  subscribeActiveServer: () => () => {},
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    markSessionViewed: async () => {},
    fetchPendingMessages: async () => {},
    publishSessionPermissionModeToMetadata: async () => {},
    publishSessionAcpSessionModeOverrideToMetadata: async () => {},
    publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
    publishSessionModelOverrideToMetadata: async () => {},
    refreshSessions: async () => {},
    onSessionVisible: () => {},
    markSessionLiveTailIntent: () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: {
      getMachineEncryption: () => null,
    },
  },
}));

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

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<any>();
    return {
      ...actual,
      getAgentCore: () => ({
        cli: { detectKey: 'codex' },
        uiConnectedService: { serviceId: null, label: 'Codex', connectRoute: null },
        model: { defaultMode: 'default' },
        resume: { vendorResumeIdField: null },
        sessionModes: { kind: 'none' },
      }),
      resolveAgentIdFromFlavor: () => 'codex',
      DEFAULT_AGENT_ID: 'codex',
    };
});

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

  it('wires attachments when the viewed session server enables uploads', async () => {
    attachmentsFeatureScopeState.enabledForServerId = 'server-2';
    featureEnabledState['attachments.uploads'] = false;
    attachmentsTransferAvailableState.value = true;
    sessionState.session = { ...sessionState.session, serverId: 'server-2' };

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" routeServerId="server-2" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toEqual(expect.any(Function));
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
    expect(modalAlertSpy).toHaveBeenCalledWith('Goal unavailable', 'This backend does not support editable session goals yet.');
  });
});
