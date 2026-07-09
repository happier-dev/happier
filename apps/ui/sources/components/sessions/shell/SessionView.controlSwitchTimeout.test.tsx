import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/agents/registry/registryUiBehavior', () => ({
  buildResumeCapabilityOptionsFromUiState: () => ({}),
  buildNewSessionOptionsFromUiState: () => ({}),
  canSelectAgentWithoutDetectedCli: () => false,
  getNewSessionAgentInputExtraActionChips: () => [],
  buildSpawnEnvironmentVariablesFromUiState: () => ({}),
  buildResumeSessionExtrasFromUiState: () => null,
  buildSpawnSessionExtrasFromUiState: () => null,
  buildWakeResumeExtras: () => null,
  getAgentResumeExperimentsFromSettings: () => null,
  getNewSessionPreflightIssues: () => [],
  getNewSessionRelevantInstallableDepKeys: () => [],
  resolveAgentUiBehavior: () => ({}),
  resolveAgentUiBehaviorFromFlavor: () => ({}),
  resolveAgentUiBehaviorFromSessionMetadata: () => ({}),
  supportsDetectedMcpConfigScan: () => false,
  supportsEditableSessionGoals: () => false,
}));
vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const controlSwitchTimeoutMs = 25;

const sessionSwitchSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const agentInputPropsSpy = vi.hoisted(() => vi.fn());
const warningActionBannerPropsSpy = vi.hoisted(() => vi.fn());
const sessionUsageLimitWaitResumeEnableSpy = vi.hoisted(() => vi.fn());
const sessionRunnerRestartSpy = vi.hoisted(() => vi.fn());
const sessionRunnerStatusGetSpy = vi.hoisted(() => vi.fn<() => Promise<unknown | null>>(async () => null));
const cliDetectionState = vi.hoisted(() => ({
  authStatus: {} as Record<string, { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: number } | null>,
}));
const featureGateState = vi.hoisted(() => {
  const enabledFeatureIds = new Set<string>();
  const useFeatureEnabledSpy = vi.fn((featureId: string, scope?: { serverId?: string | null }) => {
    const scopedKey = typeof scope?.serverId === 'string' && scope.serverId.trim().length > 0
      ? `${scope.serverId.trim()}:${featureId}`
      : null;
    return Boolean((scopedKey && enabledFeatureIds.has(scopedKey)) || enabledFeatureIds.has(featureId));
  });
  return { enabledFeatureIds, useFeatureEnabledSpy };
});
const enabledFeatureIds = featureGateState.enabledFeatureIds;
const useFeatureEnabledSpy = featureGateState.useFeatureEnabledSpy;
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
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: createStorageStoreMock({
        sessions: { s1: sessionState.session },
        sessionListIndexByServerId: {},
      }),
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionSubagentSourceMessages: () => [],
      useSessionTranscriptIds: () => ({ ids: ['m1'], isLoaded: true }),
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionReviewCommentsDrafts: () => [],
      useOpenApprovalArtifactsForSession: () => [],
      useEnabledAutomationsCountForSession: () => 0,
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
  useFeatureEnabled: useFeatureEnabledSpy,
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
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineControlTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
  useSessionMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
}));
vi.mock(
  '@/components/sessions/model/useSessionMachineReachability',
  async (importOriginal) => {
    const { createSessionMachineReachabilityModuleMock } = await import('@/dev/testkit/mocks/sessionMachineReachability');
    return createSessionMachineReachabilityModuleMock({
      importOriginal,
      overrides: {
        useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
        useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
      },
    });
  },
);
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
vi.mock('@/sync/ops', async (importOriginal) => {
  const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
  return createSyncOpsModuleMock({
    importOriginal,
    overrides: {
      continueSessionWithReplay: vi.fn(),
      sessionAbort: vi.fn(),
      resumeSession: vi.fn(),
      sessionAttachmentsUploadFile: vi.fn(),
      sessionSwitch: sessionSwitchSpy,
    },
  });
});
vi.mock('@/sync/ops/sessionUsageLimitRecovery', () => ({
  sessionUsageLimitCheckNow: vi.fn(),
  sessionUsageLimitConsumeResetCredit: vi.fn(),
  sessionUsageLimitSwitchAccountNow: vi.fn(),
  sessionUsageLimitWaitResumeCancel: vi.fn(),
  sessionUsageLimitWaitResumeEnable: sessionUsageLimitWaitResumeEnableSpy,
}));
vi.mock('@/sync/ops/sessionRunnerRestart', () => ({
  getSessionRunnerRuntimeStatus: sessionRunnerStatusGetSpy,
  restartSessionRunnerOnCurrentRuntime: sessionRunnerRestartSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => {
    agentInputPropsSpy(props);
    return null;
  },
}));
vi.mock('./view/WarningActionBanner', () => ({
  WarningActionBanner: (props: any) => {
    warningActionBannerPropsSpy(props);
    return React.createElement('WarningActionBanner', props);
  },
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

  async function renderSessionView(options: Readonly<{ routeServerId?: string | null }> = {}) {
    const { SessionView } = await import('./SessionView');
    return renderScreen(
      <SessionView id="s1" routeServerId={options.routeServerId} />,
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

  function getAgentInputProps() {
    const calls = agentInputPropsSpy.mock.calls;
    const props = calls[calls.length - 1]?.[0];
    if (!props) {
      throw new Error('Expected AgentInput props to be captured');
    }
    return props;
  }

  function getWarningActionBannerProps() {
    const calls = warningActionBannerPropsSpy.mock.calls;
    const props = calls[calls.length - 1]?.[0];
    if (!props) {
      throw new Error('Expected WarningActionBanner props to be captured');
    }
    return props;
  }

  function getWarningActionBannerPropsByTestId(testID: string) {
    const props = warningActionBannerPropsSpy.mock.calls
      .map((call) => call[0])
      .find((candidate: { testID?: string }) => candidate?.testID === testID);
    if (!props) {
      throw new Error(`Expected WarningActionBanner props for ${testID}`);
    }
    return props;
  }

  function getUsageLimitStatusBadge() {
    const badge = getAgentInputProps().statusBadges?.find((item: { key?: string }) => item.key === 'usage-limit-recovery');
    if (!badge) {
      throw new Error('Expected usage-limit status badge');
    }
    return badge;
  }

  function getStaleRunnerStatusBadge() {
    const badge = getAgentInputProps().statusBadges?.find((item: { key?: string }) => item.key === 'stale-session-runner');
    if (!badge) {
      throw new Error('Expected stale runner status badge');
    }
    return badge;
  }

  function buildStaleRunnerMetadata() {
    return {
      path: '/repo',
      host: 'host-1',
      machineId: 'm1',
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: {
        v: 1,
        sessionId: 's1',
        machineId: 'm1',
        daemonId: 'd1',
        observedAtMs: 1_700_000_000_000,
        runner: {
          pid: 123,
          runtimeId: 'runner-runtime-old',
          cliVersion: '1.0.0',
          entrypointVersion: 'entry-old',
          processCommandHash: 'hash-old',
          entrypointSource: 'process_command',
          startedBy: 'daemon',
          startingMode: 'remote',
        },
        daemon: {
          cliVersion: '1.1.0',
          startedWithCliVersion: '1.1.0',
          currentEntrypointVersion: 'runner-runtime-new',
          currentEntrypointSource: 'packaged_runtime',
        },
        versionState: 'stale',
        statusSource: 'daemon_tracking',
        plannedRestart: {
          supported: true,
          eligible: true,
          disabledReason: null,
        },
      },
    };
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
    agentInputPropsSpy.mockClear();
    warningActionBannerPropsSpy.mockClear();
    sessionUsageLimitWaitResumeEnableSpy.mockReset();
    sessionRunnerRestartSpy.mockReset();
    sessionRunnerStatusGetSpy.mockReset();
    sessionRunnerStatusGetSpy.mockResolvedValue(null);
    useFeatureEnabledSpy.mockClear();
    enabledFeatureIds.clear();
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

  it('lets the usage-limit status badge collapse and reopen the recovery banner', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    resetSession({
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    const expandedBadge = getUsageLimitStatusBadge();
    expect(expandedBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      onPress: expect.any(Function),
    }));

    await act(async () => {
      expandedBadge.onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
    const collapsedBadge = getUsageLimitStatusBadge();
    expect(collapsedBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      onPress: expect.any(Function),
    }));

    await act(async () => {
      collapsedBadge.onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();

    await screen.unmount();
  });

  it('shows stale runner banner and badge, collapses through the badge, and clears after successful restart', async () => {
    resetSession({
      active: true,
      metadata: buildStaleRunnerMetadata(),
    });
    sessionRunnerRestartSpy.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 's1',
    });

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    expect(getStaleRunnerStatusBadge()).toEqual(expect.objectContaining({
      key: 'stale-session-runner',
      testID: 'session-staleRunner-status-badge',
      onPress: expect.any(Function),
    }));

    await act(async () => {
      getStaleRunnerStatusBadge().onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();

    await act(async () => {
      getStaleRunnerStatusBadge().onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const staleRunnerBanner = getWarningActionBannerPropsByTestId('session-staleRunner-version');
    await act(async () => {
      await staleRunnerBanner.onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionRunnerRestartSpy).toHaveBeenCalledWith({
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'runner-runtime-old',
        }),
      }),
      serverId: 'server-1',
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
    expect(getAgentInputProps().statusBadges?.some((badge: { key?: string }) => badge.key === 'stale-session-runner')).toBe(false);

    await screen.unmount();
  });

  it('keeps stale-runner restart disabled for view-only shared sessions', async () => {
    resetSession({
      active: true,
      accessLevel: 'view',
      metadata: buildStaleRunnerMetadata(),
    });

    const screen = await renderSessionView();
    const staleRunnerBanner = getWarningActionBannerPropsByTestId('session-staleRunner-version');

    expect(staleRunnerBanner.disabled).toBe(true);

    await act(async () => {
      await staleRunnerBanner.onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionRunnerRestartSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session.sharing.noEditPermission');

    await screen.unmount();
  });

  it('shows stale runner banner from daemon status RPC when metadata is not seeded', async () => {
    const staleRuntimeState = (buildStaleRunnerMetadata() as Record<string, unknown>)[SESSION_RUNNER_RUNTIME_METADATA_KEY];
    resetSession({
      active: true,
      serverId: 'server-1',
      metadata: {
        path: '/repo',
        host: 'host-1',
        machineId: 'm1',
      },
    });
    sessionRunnerStatusGetSpy.mockResolvedValueOnce(staleRuntimeState);
    sessionRunnerRestartSpy.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 's1',
    });

    const screen = await renderSessionView({ routeServerId: 'server-1' });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(sessionRunnerStatusGetSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'm1',
      serverId: 'server-1',
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();

    const staleRunnerBanner = getWarningActionBannerPropsByTestId('session-staleRunner-version');
    await act(async () => {
      await staleRunnerBanner.onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionRunnerRestartSpy).toHaveBeenCalledWith({
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'm1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'runner-runtime-old',
        }),
      }),
      serverId: 'server-1',
    });

    await screen.unmount();
  });

  it('keeps usage-limit badge ordering ahead of stale-runner and work-state badges', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    resetSession({
      active: true,
      metadata: buildStaleRunnerMetadata(),
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: Date.now() + 60_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();
    const badgeKeys = getAgentInputProps().statusBadges?.map((badge: { key: string }) => badge.key);

    expect(badgeKeys).toEqual(expect.arrayContaining(['usage-limit-recovery', 'stale-session-runner']));
    expect(badgeKeys.indexOf('usage-limit-recovery')).toBeLessThan(badgeKeys.indexOf('stale-session-runner'));

    await screen.unmount();
  });

  it('clears optimistic usage-limit checking state after a recovery action fails', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    sessionUsageLimitWaitResumeEnableSpy.mockResolvedValueOnce({
      ok: false,
      error: 'temporary control failure',
    });
    resetSession({
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');
    expect(getAgentInputProps().statusBadges).toContainEqual(expect.objectContaining({
      key: 'usage-limit-recovery',
      label: 'session.usageLimitRecovery.status.ready',
    }));

    await act(async () => {
      await getWarningActionBannerProps().onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        issueFingerprint: 'usage-limit:provider:1700000000000',
      }),
      expect.objectContaining({
        serverId: 'server-1',
      }),
    );
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'temporary control failure', undefined);
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');
    expect(getAgentInputProps().statusBadges).toContainEqual(expect.objectContaining({
      key: 'usage-limit-recovery',
      label: 'session.usageLimitRecovery.status.ready',
    }));

    await screen.unmount();
  });

  it('gates usage-limit recovery against the session route server instead of the main selected server', async () => {
    enabledFeatureIds.add('session-server:sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    resetSession({
      serverId: 'session-server',
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView({ routeServerId: 'session-server' });

    expect(useFeatureEnabledSpy).toHaveBeenCalledWith(
      'sessions.usageLimitRecovery',
      expect.objectContaining({ scopeKind: 'spawn', serverId: 'session-server' }),
    );
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');

    await screen.unmount();
  });

  it('does not advertise resume-now for an active reset-elapsed issue when no interrupted work remains', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    resetSession({
      active: true as any,
      latestTurnStatus: 'failed' as any,
      metadata: null,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: 1,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();

    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');
    expect(getAgentInputProps().statusBadges).toContainEqual(expect.objectContaining({
      key: 'usage-limit-recovery',
      label: 'session.usageLimitRecovery.status.ready',
    }));

    await screen.unmount();
  });
});
