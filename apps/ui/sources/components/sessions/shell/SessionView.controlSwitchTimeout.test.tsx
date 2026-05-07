import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const controlSwitchTimeoutMs = 25;

const sessionSwitchSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const cliDetectionState = vi.hoisted(() => ({
  authStatus: {} as Record<string, { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: number } | null>,
}));
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
  Octicons: 'Octicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const themeColors = {
  text: '#000',
  textSecondary: '#666',
  textLink: '#00f',
  surface: '#fff',
  surfaceHigh: '#f5f5f5',
  divider: '#ddd',
  border: '#ddd',
  indigo: '#5856D6',
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
  input: { background: '#f5f5f5', placeholder: '#999' },
  radio: { active: '#007AFF' },
  header: { tint: '#000' },
  status: { error: '#f00' },
  shadow: { color: '#000', opacity: 0.2 },
  groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
  box: {
    warning: { background: '#fff4cc', border: '#f0d98a', text: '#000' },
  },
};

installSessionShellCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      useWindowDimensions: () => ({ width: 1200, height: 800 }),
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: themeColors,
    });
  },
  text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
      translate: (key: string) => key,
    }),
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args) => modalAlertSpy(...args));
    return modalMock.module;
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: { getState: () => ({ sessions: { s1: sessionState.session }, settings: {}, sessionListViewDataByServerId: {} }) },
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: ['m1'], isLoaded: true }),
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionReviewCommentsDrafts: () => [],
      useSessionUsage: () => null,
      useLocalSetting: (key: string) => {
        if (key === 'acknowledgedCliVersions') return {};
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'detailsPaneTabsBehavior') return 'preview';
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 520;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        if (key === 'sessionsRightPaneDefaultOpen') return false;
        return null;
      },
      useLocalSettingMutable: () => [null, vi.fn()],
      useSetting: () => null,
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
      useMachine: () => null,
    });
  },
});

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: any) =>
    React.createElement(
      'AgentContentView',
      props,
      React.createElement(React.Fragment, null, props.content ?? null, props.input ?? null),
    ),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    openRight: vi.fn(),
    setRightTab: vi.fn(),
    closeRight: vi.fn(),
    openDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    pinDetailsTab: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
    setRightTabState: vi.fn(),
    scopeState: { right: { isOpen: false, activeTabId: null, tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } },
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: (props: any) => {
    chatListPropsSpy(props);
    return React.createElement('ChatList', { ...props, testID: 'transcript-chat-list' });
  },
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => React.createElement('EmptyMessages'),
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
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));
vi.mock('@/hooks/auth/useCLIDetection', () => ({
  useCLIDetection: () => ({
    available: {},
    login: {},
    authStatus: cliDetectionState.authStatus,
    resolvedPath: {},
    resolutionSource: {},
    tmux: null,
    isDetecting: false,
    timestamp: 1,
    refresh: vi.fn(),
  }),
}));
vi.mock('@/utils/platform/responsive', () => ({
  getDeviceType: () => 'tablet',
  useDeviceType: () => 'tablet',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => true,
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
  subscribeActiveServer: (listener: (active: any) => void) => {
    listener({ serverId: 'server-1' });
    return () => {};
  },
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
    onSessionVisible: () => () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: { getMachineEncryption: () => null },
    onSessionViewportChange: () => {},
  },
}));
vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: vi.fn(),
  sessionAbort: vi.fn(),
  resumeSession: vi.fn(),
  sessionAttachmentsUploadFile: vi.fn(),
  sessionSwitch: sessionSwitchSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: () => null,
}));

vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
  };
});

describe('SessionView (control switch timeout)', () => {
  const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
    <AppPaneProvider>{children ?? null}</AppPaneProvider>
  );

  function resetSession(overrides: Partial<ReturnType<typeof createSessionFixture>> = {}) {
    Object.assign(sessionState.session, createSessionFixture({
      id: 's1',
      metadata: null,
      accessLevel: 'edit',
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
      ...overrides,
    }));
  }

  async function renderSessionView() {
    const { SessionView } = await import('./SessionView');
    return renderScreen(
      <SessionView id="s1" />,
      {
        wrapper: AppPaneProviderWrapper,
      },
    );
  }

  function getChatListProps() {
    const calls = chatListPropsSpy.mock.calls;
    const chatListProps = calls[calls.length - 1]?.[0];
    if (!chatListProps) {
      throw new Error('Expected ChatList props to be captured');
    }
    return chatListProps;
  }

  async function waitForControlSwitchTimeout() {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, controlSwitchTimeoutMs + 25);
      });
    });
  }

  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    resetSession();
    sessionSwitchSpy.mockResolvedValue(true);
    modalAlertSpy.mockClear();
    chatListPropsSpy.mockClear();
    cliDetectionState.authStatus = {
      claude: {
        state: 'logged_in',
        checkedAt: 1,
      },
    };
    process.env.EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS = String(controlSwitchTimeoutMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env.EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS;
  });

  it('keeps local-control UI hidden and clears remote switching state after a timeout when controlledByUser never updates', async () => {
    sessionSwitchSpy.mockImplementationOnce(() => new Promise(() => {}));
    await renderSessionView();
    const chatList = getChatListProps();
    expect(chatList.controlSwitchTo).toBeNull();
    expect(typeof chatList.onRequestSwitchToRemote).toBe('function');

    act(() => {
      chatList.onRequestSwitchToRemote();
    });

    expect(getChatListProps().controlSwitchTo).toBe('remote');

    await waitForControlSwitchTimeout();
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(getChatListProps().controlSwitchTo).toBeNull();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.failedToSwitchControl');
  });

  it('does not surface app-side switch-to-local for attachable exclusive local-control sessions in remote mode', async () => {
    Object.assign(sessionState.session, {
      agentState: {
        controlledByUser: false,
        localControl: {
          attached: false,
          topology: 'exclusive',
          remoteWritable: true,
          canAttach: true,
          canDetach: false,
        },
      },
    });

    const screen = await renderSessionView();
    const chatList = getChatListProps();
    // Remote -> local takeover must remain terminal-driven. The app can switch local
    // sessions back to remote, but it must not expose a transcript button/handler that
    // tries to launch local terminal control from the UI.
    expect(chatList.onRequestSwitchToLocal).toBeUndefined();
    expect(chatList.controlSwitchTo).toBeNull();
    expect(sessionSwitchSpy).not.toHaveBeenCalledWith('s1', 'local');

    await screen.unmount();
  });

  it('hides switch-to-remote when the local Claude CLI is logged out', async () => {
    Object.assign(sessionState.session, {
      metadata: {
        machineId: 'machine-1',
        host: 'mac-mini',
      },
    });
    cliDetectionState.authStatus = {
      claude: {
        state: 'logged_out',
        checkedAt: 1,
      },
    };

    const screen = await renderSessionView();
    const chatList = getChatListProps();

    expect(chatList.onRequestSwitchToRemote).toBeUndefined();

    await screen.unmount();
  });

  it('shows only one failure alert when a timed-out switch later fails', async () => {
    let rejectSwitch: ((reason?: unknown) => void) | undefined;
    sessionSwitchSpy.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSwitch = reject;
        }),
    );

    const screen = await renderSessionView();
    const chatList = getChatListProps();
    act(() => {
      chatList.onRequestSwitchToRemote();
    });

    await waitForControlSwitchTimeout();
    await flushHookEffects({ cycles: 1, turns: 1 });

    const rejectPendingSwitch = rejectSwitch;
    if (rejectPendingSwitch === undefined) {
      throw new Error('Expected pending session switch rejection handler');
    }
    rejectPendingSwitch(new Error('slow failure'));
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.failedToSwitchControl');

    await screen.unmount();
  });
});
