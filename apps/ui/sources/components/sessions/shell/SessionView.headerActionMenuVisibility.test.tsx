import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstance, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

type SessionMachineTargetTestValue = { machineId: string; basePath: string } | null;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());
const attachedTerminalState = vi.hoisted(() => ({ available: false, open: vi.fn() }));
const sessionConnectedServicesAuthSwitchSpy = vi.hoisted(() => vi.fn());
const openRightSpy = vi.hoisted(() => vi.fn());
const setRightTabSpy = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string) => SessionMachineTargetTestValue>(() => null),
);
const readMachineControlTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string) => (SessionMachineTargetTestValue & { confidence?: string }) | null>(() => null),
);
const readDisplayMachineTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(input: unknown) => SessionMachineTargetTestValue>(() => null),
);
const resolveSessionWorkspacePresentationSpy = vi.hoisted(() => vi.fn((params: any) => ({
  groupKey: 'workspace',
  workspaceHash: 'hash',
  workspaceKey: 'workspace-key',
  pathKey: params?.target?.basePath ?? '',
  displayPath: params?.target?.basePath ?? '',
  displayTitle: params?.target?.basePath ?? '',
  customLabel: null,
  hasCustomLabel: false,
  machineId: params?.target?.machineId ?? null,
  machine: { id: params?.target?.machineId ?? 'unknown', metadata: null },
  machineLabel: params?.target?.machineId ?? 'unknown',
})));
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
  (globalThis as any).location.href = 'http://localhost/session/s1/previous';
  (globalThis as any).location.pathname = '/session/s1/previous';
}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const keyboardDismissSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android' }));
const responsiveState = vi.hoisted(() => ({ deviceType: 'phone' as 'phone' | 'tablet', isLandscape: false }));
const windowDimensionsState = vi.hoisted(() => ({ width: 800, height: 600 }));
// Multi-pane is ON by default in the app; this suite pinned it off, which made every layout answer
// "no pane here" for the same reason and could not tell a phone apart from a switched-off desktop.
const multiPaneSettingState = vi.hoisted(() => ({ enabled: false as boolean }));
const executionRunsFeatureState = vi.hoisted(() => ({ enabled: false }));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: false, serverId: null as string | null }));
const executionRunsBackendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const sessionMessagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const automationsSupportState = vi.hoisted(() => ({ enabled: false, serverId: null as string | null }));
// The header automations icon is a count badge, so it renders only for a session that actually has
// enabled automations. A fixed zero here made every automations assertion unreachable.
const automationsEnabledCountState = vi.hoisted(() => ({ count: 0 }));
const mobileWorkspaceExperienceState = vi.hoisted(() => ({
  value: undefined as 'classic' | 'cockpit' | undefined,
  setValue: vi.fn(),
}));
const cockpitRegistrationState = vi.hoisted(() => ({
  registration: null as null | Readonly<{
    sessionId: string;
    switchSurface: (surface: 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal') => void;
  }>,
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

vi.mock('react-native-reanimated', () => {
  const Animated = {
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
  };
  return {
    default: Animated,
    ...Animated,
    useAnimatedProps: () => ({}),
    useAnimatedStyle: () => ({}),
  };
});
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
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
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
    openRight: openRightSpy,
    setRightTab: setRightTabSpy,
  }),
}));
vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
  useSessionCockpitChromeRegistration: () => cockpitRegistrationState.registration,
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
vi.mock('@/components/sessions/terminal/openAttachedSessionTerminal', () => ({
  useOpenAttachedSessionTerminal: () => attachedTerminalState,
}));
vi.mock('@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch', () => ({
  useSessionConnectedServicesAuthSwitch: (props: unknown) => {
    sessionConnectedServicesAuthSwitchSpy(props);
    return { connectedServicesAuthChip: null, statusBadges: [] };
  },
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
  useSessionExecutionRunsSupported: (_sessionId: string, scope?: { serverId?: string | null }) =>
    sessionExecutionRunsSupportedState.supported
    && (sessionExecutionRunsSupportedState.serverId == null || scope?.serverId === sessionExecutionRunsSupportedState.serverId),
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => executionRunsBackendsState.backends,
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: (scope?: { serverId?: string | null }) => ({
    enabled: automationsSupportState.enabled
      && (automationsSupportState.serverId == null || scope?.serverId === automationsSupportState.serverId),
  }),
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
  useDraft: () => ({ clearDraft: vi.fn(), setDraftValue: vi.fn() }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineTarget: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
  useSessionMachineControlTarget: (sessionId: string) => readMachineControlTargetForSessionSpy(sessionId),
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
    markSessionLiveTailIntent: () => {},
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
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  resolveMachineTargetForSessionFromState: (_state: unknown, sessionId: string) => readMachineTargetForSessionSpy(sessionId),
  resolveDisplayMachineTargetForSessionFromState: (_state: unknown, input: unknown) => readDisplayMachineTargetForSessionSpy(input),
  readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
  readMachineControlTargetForSession: (sessionId: string) => readMachineControlTargetForSessionSpy(sessionId),
  readDisplayMachineTargetForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input),
  readDisplayMachineIdForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input)?.machineId ?? '',
  readDisplayPathForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input)?.basePath ?? '',
}));
vi.mock('@/sync/domains/session/listing/sessionWorkspacePresentation', () => ({
  resolveSessionWorkspacePresentation: (params: unknown) => resolveSessionWorkspacePresentationSpy(params),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: () => null,
}));
vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

installSessionShellCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const module = await createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      useWindowDimensions: () => ({ width: windowDimensionsState.width, height: windowDimensionsState.height }),
    });
    Object.defineProperty(module.Platform, 'OS', {
      configurable: true,
      get: () => platformState.os,
    });
    module.Platform.select = (spec: Record<string, unknown>) =>
      spec && Object.prototype.hasOwnProperty.call(spec, platformState.os)
        ? (spec as any)[platformState.os]
        : (spec as any).default;
    Object.assign(module.Keyboard, {
      dismiss: keyboardDismissSpy,
    });
    return module;
  },
  unistyles: async () => {
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
  },
  text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
      },
    }).module;
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
      },
    }).module;
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const getStorageStateForTest = () => ({
      sessions: { s1: sessionState.session },
      settings: {},
      sessionListViewDataByServerId: {},
    });
    return createStorageModuleStub({
      storage: Object.assign(
        (selector?: (state: any) => unknown) => {
          const state = getStorageStateForTest();
          return typeof selector === 'function' ? selector(state) : state;
        },
        { getState: getStorageStateForTest },
      ) as any,
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
      useSessionMessages: () => ({ messages: sessionMessagesState.messages, isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionSubagentSourceMessages: () => sessionMessagesState.messages,
      useSessionRpcAvailabilityState: () => ({
        sessionExists: true,
        sessionRpcAvailable: true,
      }),
      useSessionReviewCommentsDrafts: () => [],
      useSessionUsage: () => null,
      useLocalSetting: (key: string) => {
        if (key === 'acknowledgedCliVersions') return {};
        if (key === 'uiMultiPanePanelsEnabled') return multiPaneSettingState.enabled;
        if (key === 'detailsPaneTabsBehavior') return 'preview';
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 520;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        return {};
      },
      useLocalSettingMutable: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') {
          throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
        }
        return [null, vi.fn()];
      },
      useSetting: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperienceState.value;
        return null;
      },
      useSettingMutable: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') {
          return [mobileWorkspaceExperienceState.value ?? null, mobileWorkspaceExperienceState.setValue];
        }
        return [null, vi.fn()];
      },
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
      useSessionAutomationsEnabledCount: () => automationsEnabledCountState.count,
      useOpenApprovalArtifactsForSession: () => [],
    });
  },
});

vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControl: () => false,
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

function findPressableByAccessibilityLabel(screen: RenderScreenResult, label: string) {
  return screen.findAll((node) => (node.type as unknown) === 'Pressable' && node.props?.accessibilityLabel === label)[0];
}

async function renderSessionView(routeServerId?: string) {
  const normalizedRouteServerId = routeServerId?.trim();
  if (normalizedRouteServerId) {
    sessionState.session = {
      ...sessionState.session,
      serverId: normalizedRouteServerId,
    };
  }
  return renderScreen(
    <SessionView id="s1" routeServerId={routeServerId} />,
    {
      wrapper: AppPaneProviderWrapper,
    },
  );
}

function getLastHeaderActionMenuProps(): any {
  const call = headerActionMenuSpy.mock.calls.at(-1);
  if (!call) throw new Error('Expected SessionHeaderActionMenu to render');
  return call[0];
}

function getHeaderExtraItemIds(props: any): string[] {
  return (props?.extraItems ?? []).map((item: any) => item?.id).filter(Boolean);
}

describe('SessionView header action menu visibility', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    sessionExecutionRunsSupportedState.serverId = null;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = false;
    automationsSupportState.serverId = null;
    automationsEnabledCountState.count = 0;
    mobileWorkspaceExperienceState.value = undefined;
    mobileWorkspaceExperienceState.setValue.mockReset();
    cockpitRegistrationState.registration = null;
    keyboardDismissSpy.mockReset();
    openRightSpy.mockReset();
    setRightTabSpy.mockReset();
    headerActionMenuSpy.mockClear();
    attachedTerminalState.available = false;
    attachedTerminalState.open.mockReset();
    sessionConnectedServicesAuthSwitchSpy.mockClear();
    readMachineTargetForSessionSpy.mockReset();
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReset();
    readMachineControlTargetForSessionSpy.mockReturnValue(null);
    readDisplayMachineTargetForSessionSpy.mockReset();
    readDisplayMachineTargetForSessionSpy.mockReturnValue(null);
    resolveSessionWorkspacePresentationSpy.mockClear();
    routerPushSpy.mockReset();
    routerBackSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();
    windowDimensionsState.width = 800;
    windowDimensionsState.height = 600;
    multiPaneSettingState.enabled = false;
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
      writable: true,
      configurable: true,
    });
  });

  it('withholds the runs destination entirely when execution runs are unsupported for the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    const screen = await renderSessionView();

    // Asserted in the folded header, where the runs destination lives: at a width that does not
    // fold, no header surface offers runs at all and the absence would prove nothing.
    expect(findPressableByAccessibilityLabel(screen, 'session.openRuns')).toBeUndefined();
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openRuns');
  });

  it('uses stable display target for workspace presentation instead of live reachable target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-live',
      basePath: '/repo/live',
    });
    readDisplayMachineTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-origin',
      basePath: '/repo/origin',
    });

    await renderSessionView();

    expect(readDisplayMachineTargetForSessionSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      metadata: sessionState.session.metadata,
    });
    expect(resolveSessionWorkspacePresentationSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        machineId: 'machine-origin',
        basePath: '/repo/origin',
      },
    }));
  });

  it('passes a validated session control target to connected-services auth switching', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-origin',
      basePath: '/repo/origin',
      confidence: 'metadata_direct',
    });

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-origin',
    }));
  });

  it('does not pass stale metadata machine id to connected-services auth switching without a control target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReturnValue(null);

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: null,
    }));
  });

  it('does not block connected-services auth switching for stale in-progress projection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 0,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: null,
    };

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      switchingDisabledReason: null,
    }));
  });

  it('does not block connected-services auth switching for detached runtime activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 990_000,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: 995_000,
      runtimeActivityState: 'active',
      runtimeActivityRevision: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 999_000,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: null,
    };

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      switchingDisabledReason: null,
    }));
    vi.useRealTimers();
  });

  it('refreshes connected-services auth switching when only runtime heartbeat freshness changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 0,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: null,
    };

    const screen = await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      switchingDisabledReason: null,
    }));

    sessionState.session = {
      ...sessionState.session,
      serverId: 'server-runtime-refresh',
      latestTurnStatusObservedAt: 1_000_000,
    };
    await screen.update(<SessionView id="s1" routeServerId="server-runtime-refresh" />);

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      switchingDisabledReason: 'active_turn',
    }));
    vi.useRealTimers();
  });

  it('offers the runs destination when the viewed session server supports execution runs', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = true;
    sessionExecutionRunsSupportedState.serverId = 'server-2';
    executionRunsBackendsState.backends = {
      codex: { available: true },
    };

    const screen = await renderSessionView('server-2');

    // Support is resolved against the viewed session's server, not the active one: the mocked hook
    // only answers true for `server-2`, so a wrongly scoped read drops the item.
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openRuns');
    expect(findPressableByAccessibilityLabel(screen, 'session.openRuns')).toBeUndefined();
  });

  it('keeps background activity out of the header without hiding execution runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    windowDimensionsState.width = 420;
    sessionExecutionRunsSupportedState.supported = true;
    sessionState.session = {
      ...sessionState.session,
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: 999_000,
      runtimeActivityState: 'active',
      runtimeActivityRevision: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 999_000,
    };

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-background-activity-status')).toBeNull();
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openRuns');
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
    automationsEnabledCountState.count = 2;
    routerPushSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();

    const screen = await renderSessionView();
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();

    pressTestInstance(openAutomationsButton, 'session.openAutomations');

    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations?serverId=server-1');
  });

  it('shows automations for the viewed session server even when the active server differs', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = true;
    automationsSupportState.serverId = 'server-2';
    automationsEnabledCountState.count = 1;

    const screen = await renderSessionView('server-2');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();
  });

  it('folds runs and automations buttons into the header action menu when the header is narrow', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    // Panes ON: transcript navigation is offered only where the pane it lives in can be drawn, so a
    // switched-off multi-pane setting would withhold it for an unrelated reason.
    multiPaneSettingState.enabled = true;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();

    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');
    expect(openRunsButton).toBeUndefined();
    expect(openAutomationsButton).toBeUndefined();
    expect(openSubagentsButton).toBeUndefined();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(0)?.[0] as any;
    const extraIds = getHeaderExtraItemIds(props);
    expect(extraIds).toContain('header.openRuns');
    expect(extraIds).toContain('header.openAutomations');
    expect(extraIds).toContain('header.openSubagents');
    expect(extraIds).toContain('header.openTranscriptNavigation');
  });

  it('renders a direct transcript navigation header button when header actions are not folded', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 800;
    multiPaneSettingState.enabled = true;

    const screen = await renderSessionView();
    const openNavigationButton = findPressableByAccessibilityLabel(screen, 'session.openTranscriptNavigation');

    expect(openNavigationButton).toBeDefined();
  });

  it('opens the navigation right-panel tab from the folded header action menu', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    multiPaneSettingState.enabled = true;

    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openTranscriptNavigation')).toBe(true);
    expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'navigation' });
    expect(setRightTabSpy).toHaveBeenCalledWith('navigation');
  });

  it('switches to the cockpit navigation surface from the folded header action menu when cockpit owns the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    const switchSurface = vi.fn();
    cockpitRegistrationState.registration = {
      sessionId: 's1',
      switchSurface,
    };

    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openTranscriptNavigation')).toBe(true);
    expect(switchSurface).toHaveBeenCalledWith('navigation');
    expect(openRightSpy).not.toHaveBeenCalled();
    expect(setRightTabSpy).not.toHaveBeenCalled();
  });

  it('keeps folded header action menu items stable across unrelated session header updates', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();
    const firstExtraItems = getLastHeaderActionMenuProps().extraItems;

    headerActionMenuSpy.mockClear();
    sessionState.session = {
      ...sessionState.session,
      thinking: true,
      latestTurnStatus: 'running',
    };
    await screen.update(<SessionView id="s1" />);

    expect(getLastHeaderActionMenuProps().extraItems).toBe(firstExtraItems);
  });

  it('offers switching from default cockpit to classic on phones', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = undefined;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openMobileWorkspaceClassic');
  });

  it('offers switching from explicit classic to cockpit on phones', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = 'classic';

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openMobileWorkspaceCockpit');
  });

  it('does not offer the mobile cockpit toggle on tablets', async () => {
    responsiveState.deviceType = 'tablet';
    mobileWorkspaceExperienceState.value = undefined;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openMobileWorkspaceClassic');
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openMobileWorkspaceCockpit');
  });

  it('updates the mobile workspace experience when the header toggle is selected', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = undefined;
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceClassic')).toBe(true);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('classic');

    standardCleanup();
    headerActionMenuSpy.mockClear();
    mobileWorkspaceExperienceState.setValue.mockReset();
    mobileWorkspaceExperienceState.value = 'classic';
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceCockpit')).toBe(true);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('cockpit');
  });

  it('dismisses the keyboard before opening cockpit from the session header toggle', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = 'classic';
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceCockpit')).toBe(true);

    expect(keyboardDismissSpy).toHaveBeenCalledTimes(1);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('cockpit');
  });

  it('keeps the runs destination available when the transcript already contains execution-run signals', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        kind: 'tool-call',
        tool: { name: 'SubAgentRun', input: { runId: 'run_1' }, result: { runId: 'run_1' } },
      },
    ];

    await renderSessionView();

    // No launchable backend, but the session already ran one: an absent backend list must not
    // withdraw the destination that the transcript proves is populated.
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openRuns');
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
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');

    expect(openSubagentsButton).toBeDefined();
  });

  it('withholds the header subagents indicator before any agent is active while still offering the destination', async () => {
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

    // The icon is a live indicator: `activeCount` is its whole condition, so a session that can
    // launch agents but is running none shows nothing. The destination is not lost — it is a
    // header-menu item, which is where a place to go belongs.
    expect(findPressableByAccessibilityLabel(screen, 'session.openSubagents')).toBeUndefined();

    windowDimensionsState.width = 420;
    await screen.update(<SessionView id="s1" />);

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openSubagents');
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

  it('offers and handles the attached Claude terminal action when supported', async () => {
    attachedTerminalState.available = true;
    await renderSessionView();

    const props = getLastHeaderActionMenuProps();
    expect(getHeaderExtraItemIds(props)).toContain('header.openAttachedClaudeTerminal');
    expect(props.onSelectExtraItem('header.openAttachedClaudeTerminal')).toBe(true);
    expect(attachedTerminalState.open).toHaveBeenCalledTimes(1);
  });

  /**
   * The one reachability cell this whole corridor turns on. Below 520pt the agents GLYPH is folded
   * away, so on a phone this menu item is the ONLY entry point to the roster — and the pane it used
   * to open is structurally hidden there. Two tests asserted the item is OFFERED; nothing ever
   * SELECTED it, so the destination rested on reading a one-line handler.
   */
  it('pushes the agents screen when the folded subagents item is selected on a phone', async () => {
    // A native phone, panes ON: the layout — not a disabled setting — is what has no room for a pane.
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    multiPaneSettingState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openSubagents');
    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openSubagents')).toBe(true);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/agents?serverId=server-1');
    expect(openRightSpy).not.toHaveBeenCalled();
  });

  it('opens the agents tab from the same folded item where the layout can host a right pane', async () => {
    // Same item, same width, same press — web normalizes to `tablet` in the pane host, so a narrow
    // browser window still draws an overlay right pane. If the item pushed a route unconditionally
    // this would fail, which is what makes the phone assertion above mean something.
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    multiPaneSettingState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;

    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openSubagents')).toBe(true);
    expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'agents' });
    expect(setRightTabSpy).toHaveBeenCalledWith('agents');
    expect(routerPushSpy).not.toHaveBeenCalledWith('/session/s1/agents?serverId=server-1');
  });

  it('does not offer transcript navigation on a phone layout that cannot draw the pane it lives in', async () => {
    // Navigation exists only as a right-pane tab or a cockpit surface — there is no screen to fall
    // back to — so on a classic phone the honest answer is no offer, not a dead menu row.
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    multiPaneSettingState.enabled = true;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openTranscriptNavigation');
    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openTranscriptNavigation')).toBe(false);
    expect(openRightSpy).not.toHaveBeenCalled();
  });

  it('renders a raised landscape back button on Android phones when the top header is hidden', async () => {
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = true;
    const screen = await renderSessionView();
    const landscapeBackButton = screen.findByTestId('session-view-landscape-back-button');
    pressTestInstance(landscapeBackButton);

    expect(landscapeBackButton).toBeTruthy();
    expect(landscapeBackButton?.props.hitSlop).toBe(15);
    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).toHaveBeenCalledTimes(1);
  });
});
