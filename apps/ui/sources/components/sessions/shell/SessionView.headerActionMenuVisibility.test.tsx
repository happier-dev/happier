import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android' }));
const responsiveState = vi.hoisted(() => ({ deviceType: 'phone' as 'phone' | 'tablet', isLandscape: false }));
const executionRunsFeatureState = vi.hoisted(() => ({ enabled: false }));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: false }));
const executionRunsBackendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const sessionMessagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const automationsSupportState = vi.hoisted(() => ({ enabled: false }));
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  const module = await createReactNativeWebMock({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
  });
  Object.defineProperty(module.Platform, 'OS', {
    configurable: true,
    get: () => platformState.os,
  });
  module.Platform.select = (spec: Record<string, unknown>) =>
    spec && Object.prototype.hasOwnProperty.call(spec, platformState.os)
      ? (spec as any)[platformState.os]
      : (spec as any).default;
  return module;
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock({
    theme: {
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
  });
});

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: {
      push: routerPushSpy,
      back: vi.fn(),
      replace: vi.fn(),
      setParams: vi.fn(),
    },
  }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
  translate: (key: string) => key,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: () => null,
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'pane-scope-test',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    scopeState: null,
    openRight: vi.fn(),
    setRightTab: vi.fn(),
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: (props: any) => React.createElement('ChatHeaderView', props, props.rightElement ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
  SessionHeaderActionMenu: (props: any) => {
    headerActionMenuSpy(props);
    return React.createElement('SessionHeaderActionMenu');
  },
}));
vi.mock('@/components/ui/icons/DependabotIcon', () => ({
  DependabotIcon: 'DependabotIcon',
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => executionRunsFeatureState.enabled,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
  useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedState.supported,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => executionRunsBackendsState.backends,
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));
vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
  navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => responsiveState.deviceType,
  useHeaderHeight: () => 0,
  useIsLandscape: () => responsiveState.isLandscape,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
  useDraft: () => ({ clearDraft: vi.fn() }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
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
    refreshSessions: async () => {},
    onSessionVisible: () => () => {},
    ensureSidechainMessagesLoaded: async () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: { getMachineEncryption: () => null },
  },
}));
vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: vi.fn(),
  sessionAbort: vi.fn(),
  resumeSession: vi.fn(),
  sessionAttachmentsUploadFile: vi.fn(),
  sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: () => null,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(),
            prompt: vi.fn(),
        },
    }).module;
});
vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => ({ sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} }) },
    useSession: () => sessionState.session,
    useIsDataReady: () => true,
    useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
    useSessionMessages: () => ({ messages: sessionMessagesState.messages, isLoaded: true }),
    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
    useSessionPendingMessages: () => ({ messages: [] }),
    useSessionReviewCommentsDrafts: () => [],
    useSessionUsage: () => null,
    useLocalSetting: (key: string) => {
      if (key === 'acknowledgedCliVersions') return {};
      if (key === 'uiMultiPanePanelsEnabled') return false;
      if (key === 'detailsPaneTabsBehavior') return 'preview';
      if (key === 'rightPaneWidthPx') return 360;
      if (key === 'rightPaneWidthBasisPx') return 1200;
      if (key === 'detailsPaneWidthPx') return 520;
      if (key === 'detailsPaneWidthBasisPx') return 1200;
      return {};
    },
    useLocalSettingMutable: () => [null, vi.fn()],
    useSetting: () => null,
    useSettings: () => ({ experiments: true, featureToggles: {} }),
    useAutomations: () => [],
});
});

vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

const { SessionView } = await import('./SessionView');

const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
  <AppPaneProvider>{children ?? null}</AppPaneProvider>
);

function findPressableByAccessibilityLabel(root: ReactTestInstance, label: string) {
  return root.findAll((node) => (node.type as unknown) === 'Pressable' && node.props?.accessibilityLabel === label)[0];
}

async function renderSessionView() {
  return renderScreen(
    <SessionView id="s1" />,
    {
      wrapper: AppPaneProviderWrapper,
    },
  );
}

describe('SessionView header action menu visibility', () => {
  afterEach(() => {
    standardCleanup();
    sessionState.session = {
      id: 's1',
      metadata: null,
      accessLevel: 'edit',
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
    } as any;
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = false;
    headerActionMenuSpy.mockClear();
    routerPushSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();
  });

  it('hides the open runs button when execution runs are unsupported for the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen.root, 'session.openRuns');

    expect(openRunsButton).toBeUndefined();
  });

  it('routes to session automations through blur-safe navigation', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = true;
    routerPushSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();

    const screen = await renderSessionView();
    const openAutomationsButton = findPressableByAccessibilityLabel(screen.root, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();

    await act(async () => {
      openAutomationsButton!.props.onPress();
    });

    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations');
  });

  it('keeps the open runs button visible when the transcript already contains execution-run signals', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        kind: 'tool-call',
        tool: { name: 'SubAgentRun', input: { runId: 'run_1' }, result: { runId: 'run_1' } },
      },
    ];

    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen.root, 'session.openRuns');

    expect(openRunsButton).toBeDefined();
  });

  it('renders a header subagents button when the transcript contains subagent activity', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        id: 'tool-msg-1',
        kind: 'tool-call',
        createdAt: 1,
        tool: {
          name: 'Task',
          id: 'toolu_task_1',
          input: { name: 'Investigate regression', team_name: 'qa-team', agent_id: 'alpha@qa-team' },
          result: { tool_use_result: { team_name: 'qa-team', agent_id: 'alpha@qa-team', name: 'alpha' } },
          state: 'running',
        },
      },
    ];

    const screen = await renderSessionView();
    const openSubagentsButton = findPressableByAccessibilityLabel(screen.root, 'session.openSubagents');

    expect(openSubagentsButton).toBeDefined();
  });

  it('renders a header subagents button when launch surfaces are available even before any subagents exist', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = {
      codex: {
        available: true,
        intents: ['review', 'plan', 'delegate'],
      },
    };
    sessionMessagesState.messages = [];

    const screen = await renderSessionView();
    const openSubagentsButton = findPressableByAccessibilityLabel(screen.root, 'session.openSubagents');

    expect(openSubagentsButton).toBeDefined();
  });

  it('renders SessionHeaderActionMenu even when automations and execution runs are disabled', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    headerActionMenuSpy.mockClear();
    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
  });

  it('renders a raised landscape back button on Android phones when the top header is hidden', async () => {
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = true;
    const screen = await renderSessionView();
    const landscapeBackButton = screen.findByTestId('session-view-landscape-back-button');

    expect(landscapeBackButton).toBeTruthy();
    expect(landscapeBackButton?.props.hitSlop).toBe(15);
  });
});
