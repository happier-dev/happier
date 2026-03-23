import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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
    createUnistylesMock({
      theme: {
        dark: false,
        colors: {
          text: '#000',
          textSecondary: '#666',
          textLink: '#00f',
          surface: '#fff',
          surfaceHigh: '#f5f5f5',
          surfaceSelected: '#eef4ff',
          divider: '#ddd',
          border: '#ddd',
          indigo: '#5856D6',
          radio: { active: '#007AFF' },
          accent: {
            blue: '#007AFF',
            green: '#34C759',
            orange: '#FF9500',
            yellow: '#FFCC00',
            red: '#FF3B30',
            indigo: '#5856D6',
            purple: '#AF52DE',
          },
          modal: { border: '#ddd' },
          input: { background: '#f5f5f5' },
          header: { tint: '#000' },
          status: { error: '#f00' },
          shadow: { color: '#000', opacity: 0.2 },
          groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
        },
      },
    }),
  text: async () => createTextModuleMock({ translate: (key) => key }),
  modal: async () =>
    createModalModuleMock({
      spies: {
        alert: vi.fn(),
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
      storage: { getState: () => ({ sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} }) },
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ status: 'connected' }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return false;
        if (key === 'editorFocusModeEnabled') return false;
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

const featureEnabledState: Record<string, boolean> = {
  voice: false,
  'files.reviewComments': false,
  'execution.runs': false,
  'attachments.uploads': false,
};
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/utils/platform/responsive', () => ({
  getDeviceType: () => 'phone',
  useDeviceType: () => 'phone',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
  useDraft: () => ({ clearDraft: vi.fn() }),
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
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: {
      getMachineEncryption: () => null,
    },
  },
}));

vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: vi.fn(),
  sessionAbort: vi.fn(),
  resumeSession: vi.fn(),
  sessionAttachmentsUploadFile: vi.fn(),
}));

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
  resolveSessionComposerSend: async () => ({ kind: 'noop' }),
}));
vi.mock('@/sync/domains/input/slashCommands/executeSessionComposerResolution', () => ({
  executeSessionComposerResolution: vi.fn(),
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
  chooseSubmitMode: () => 'direct',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
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
  it('does not wire drag/drop/paste attachments when attachments.uploads is disabled', async () => {
    featureEnabledState['attachments.uploads'] = false;

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>)).tree;

    const agentInput = tree.findByType('AgentInput' as any);
    expect(agentInput.props.onAttachmentsAdded).toBeUndefined();
  });
});
