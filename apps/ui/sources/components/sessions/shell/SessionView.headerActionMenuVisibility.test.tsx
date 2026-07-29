import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { flushHookEffects, pressTestInstance, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());
const attachedTerminalState = vi.hoisted(() => ({ available: false, open: vi.fn() }));
const chatHeaderSpy = vi.hoisted(() => vi.fn());
const agentInputSpy = vi.hoisted(() => vi.fn());
const connectedServicesAuthSwitchSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
  (globalThis as any).location.href = 'http://localhost/session/s1/previous';
  (globalThis as any).location.pathname = '/session/s1/previous';
}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const keyboardDismissSpy = vi.hoisted(() => vi.fn());
const ensureSidechainMessagesLoadedSpy = vi.hoisted(() => vi.fn(async () => 'loaded' as const));
const paneOpenRightSpy = vi.hoisted(() => vi.fn());
const paneSetRightTabSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android' }));
const responsiveState = vi.hoisted(() => ({ deviceType: 'phone' as 'phone' | 'tablet', isLandscape: false }));
const windowDimensionsState = vi.hoisted(() => ({ width: 800, height: 600 }));
const executionRunsFeatureState = vi.hoisted(() => ({ enabled: false }));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: false }));
const executionRunsBackendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const sessionMessagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const automationsSupportState = vi.hoisted(() => ({ enabled: false }));
const localSettingsState = vi.hoisted(() => ({
  mobileWorkspaceExperienceV1: 'classic' as 'classic' | 'cockpit',
}));
const sessionMachineControlTargetState = vi.hoisted(() => ({
    target: null as { machineId: string; basePath: string; confidence: 'reachable' | 'metadata_direct' } | null,
}));
const connectedServicesAuthSwitchState = vi.hoisted(() => ({
    restartState: null as null | {
        status: 'restarting' | 'pending_confirmation' | 'failed';
        attemptId: string;
        reason: string;
        startedAtMs: number;
    },
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

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    parsePermissionIntentAlias: () => null,
    resolveAgentIdFromFlavor: () => 'codex',
    resolveAgentIdFromSessionMetadata: () => 'codex',
  };
});

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
    openRight: paneOpenRightSpy,
    setRightTab: paneSetRightTabSpy,
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: (props: any) => {
    chatHeaderSpy(props);
    return React.createElement('ChatHeaderView', props, props.rightElement ?? null);
  },
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
vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));
vi.mock('@/agents/catalog/catalog', () => ({
  AGENT_IDS: ['codex'],
  buildResumeSessionExtrasFromUiState: () => null,
  getAgentCore: () => ({
    cli: { detectKey: 'codex' },
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.codex', connectRoute: null },
    model: { defaultMode: 'default' },
    resume: { vendorResumeIdField: null },
    sessionModes: { kind: 'none' },
  }),
  isAgentId: (value: unknown) => value === 'codex',
  resolveAgentIdFromFlavor: () => 'codex',
}));
vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['codex'],
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
  useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: {} }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canResumeSessionWithOptions: () => true,
}));
vi.mock('@/agents/registry/registryCore', () => ({
  AGENT_IDS: ['codex'],
  CANONICAL_AGENT_IDS: ['codex'],
  DEFAULT_AGENT_ID: 'codex',
  getAgentCore: () => ({
    cli: { detectKey: 'codex' },
    connectedServices: null,
    uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.codex', connectRoute: null },
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
  }),
  isAgentId: (value: unknown) => value === 'codex',
  resolveAgentIdFromFlavor: () => 'codex',
}));
vi.mock('@/agents/catalog/agentUniverse', () => ({
  buildAgentUniverseBackendTargetKey: (providerId: string) => `provider:${providerId}`,
  listAgentUniverseIds: () => ['codex'],
}));
vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
  navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));
vi.mock('@/hooks/auth/useCLIDetection', () => ({
  useCLIDetection: () => ({ authStatus: {} }),
}));
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => responsiveState.deviceType,
  useHeaderHeight: () => 0,
  useIsLandscape: () => responsiveState.isLandscape,
  useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
  useSessionReachableMachineTarget: () => null,
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineControlTarget: () => sessionMachineControlTargetState.target,
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
	    ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedSpy,
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
  AgentInput: (props: any) => {
    agentInputSpy(props);
    return null;
  },
}));
vi.mock('@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch', () => ({
  useSessionConnectedServicesAuthSwitch: (props: any) => {
    connectedServicesAuthSwitchSpy(props);
    return { connectedServicesAuthChip: null, statusBadges: [], restartState: connectedServicesAuthSwitchState.restartState };
  },
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
    return createStorageModuleStub({
	      storage: { getState: () => ({ sessions: { s1: sessionState.session }, sessionPending: {}, settings: {}, concurrentSessionListCacheByServerId: {} }) },
	      useSession: () => sessionState.session,
	      useIsDataReady: () => true,
	      useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
      useSessionVisibleReadSeq: () => sessionState.session?.seq ?? 0,
      useSessionMessages: () => ({ messages: sessionMessagesState.messages, isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionSubagentSourceMessages: () => sessionMessagesState.messages,
      useSessionReviewCommentsDrafts: () => [],
      useWorkspaceReviewCommentsDrafts: () => [],
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
      useSetting: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') return localSettingsState.mobileWorkspaceExperienceV1;
        return null;
      },
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
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
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    connectedServicesAuthSwitchState.restartState = null;
    automationsSupportState.enabled = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';
    sessionMachineControlTargetState.target = null;
    keyboardDismissSpy.mockReset();
	    headerActionMenuSpy.mockClear();
	    attachedTerminalState.available = false;
	    attachedTerminalState.open.mockReset();
	    chatHeaderSpy.mockClear();
	    agentInputSpy.mockClear();
    connectedServicesAuthSwitchSpy.mockClear();
    ensureSidechainMessagesLoadedSpy.mockClear();
    paneOpenRightSpy.mockClear();
    paneSetRightTabSpy.mockClear();
	    routerPushSpy.mockReset();
    routerBackSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();
    windowDimensionsState.width = 800;
    windowDimensionsState.height = 600;
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
      writable: true,
      configurable: true,
    });
  });

  it('hides the open runs button when execution runs are unsupported for the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

    expect(openRunsButton).toBeUndefined();
  });

  it('shows neutral background copy in the header without making the composer busy or hiding execution runs', async () => {
    sessionExecutionRunsSupportedState.supported = true;
    sessionState.session = {
      ...sessionState.session,
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: 999_000,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
    };

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-background-activity-status')).toBeDefined();
    expect(findPressableByAccessibilityLabel(screen, 'session.openRuns')).toBeDefined();
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
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();

    pressTestInstance(openAutomationsButton, 'session.openAutomations');

    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations?serverId=server-1');
  });

  it('folds runs and automations buttons into the header action menu when the header is narrow', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();
    const firstHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;

    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');
    expect(openRunsButton).toBeUndefined();
    expect(openAutomationsButton).toBeUndefined();
    expect(openSubagentsButton).toBeUndefined();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(0)?.[0] as any;
    const extraItems = props?.extraItems ?? [];
    const extraIds = extraItems.map((it: any) => it?.id).filter(Boolean);
    expect(extraIds).toContain('header.openRuns');
    expect(extraIds).toContain('header.openAutomations');
    expect(extraIds).toContain('header.openSubagents');

    const firstBadges = firstHeaderProps?.badges;

    sessionState.session = {
      ...sessionState.session,
      metadata: {
        ...sessionState.session.metadata,
        host: 'alternate-host',
      },
    } as any;

    await renderSessionView();

    const rerenderedProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedProps?.extraItems).toBe(extraItems);
    const rerenderedHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderProps?.badges).toEqual(firstBadges);
  });

  it('routes folded runs menu action through the scoped session href', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const handled = props?.onSelectExtraItem?.('header.openRuns');

    expect(handled).toBe(true);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/runs?serverId=server-1');
  });

  it('routes folded automations menu action through the scoped session href', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    automationsSupportState.enabled = true;

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const handled = props?.onSelectExtraItem?.('header.openAutomations');

    expect(handled).toBe(true);
    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations?serverId=server-1');
  });

  it('preserves the visible header props when rerendered with identical session values', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    headerActionMenuSpy.mockClear();
    chatHeaderSpy.mockClear();

    await renderSessionView();
    const firstHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;

    sessionState.session = {
      ...sessionState.session,
      metadata: sessionState.session.metadata,
      updatedAt: (sessionState.session.updatedAt ?? 0) + 1,
    } as any;

    await renderSessionView();

    const rerenderedHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderProps).toMatchObject({
      title: firstHeaderProps?.title,
      subtitle: firstHeaderProps?.subtitle,
      badges: firstHeaderProps?.badges,
      avatarId: firstHeaderProps?.avatarId,
      isConnected: firstHeaderProps?.isConnected,
      flavor: firstHeaderProps?.flavor,
    });
    expect(rerenderedHeaderProps.badges).toBe(firstHeaderProps?.badges);
    expect(rerenderedHeaderProps.rightElement).toBe(firstHeaderProps?.rightElement);
  });

  it('refreshes the header action menu when the mounted session gains a new machine target', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    headerActionMenuSpy.mockClear();
    chatHeaderSpy.mockClear();

    sessionState.session = {
      ...sessionState.session,
      updatedAt: 1,
      metadata: null,
    } as any;

    const screen = await renderSessionView();
    const firstHeaderActionMenuProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(firstHeaderActionMenuProps?.session?.metadata?.machineId ?? null).toBeNull();

    sessionState.session = {
      ...sessionState.session,
      updatedAt: 2,
      metadata: {
        ...(sessionState.session.metadata ?? {}),
        machineId: 'machine-rebound',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
      },
    } as any;

    await screen.update(<SessionView id="s1" jumpToSeq={1} />);

    const rerenderedHeaderActionMenuProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderActionMenuProps?.session?.updatedAt).toBe(2);
    expect(rerenderedHeaderActionMenuProps?.session?.metadata?.machineId).toBe('machine-rebound');
    expect(rerenderedHeaderActionMenuProps?.session).not.toBe(firstHeaderActionMenuProps?.session);
  });

  it('passes the session control target to connected-services auth switching', async () => {
    sessionMachineControlTargetState.target = {
      machineId: 'machine-origin',
      basePath: '/repo/origin',
      confidence: 'metadata_direct',
    };

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 's1',
      machineId: 'machine-origin',
    });
  });

  it('does not pass stale metadata machine id to connected-services auth switching without a control target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'stale-machine',
        path: '/repo/stale',
      },
    } as any;
    sessionMachineControlTargetState.target = null;

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 's1',
      machineId: null,
    });
  });

  it('passes restart-resume switch events to connected-services auth switching and supersedes them with newer session evidence', async () => {
    sessionMessagesState.messages = [{
      id: 'event-1',
      kind: 'agent-event',
      createdAt: 2_000,
      event: {
        type: 'connected-service-account-switch',
        serviceId: 'openai-codex',
        groupId: 'primary',
        fromProfileId: 'work',
        toProfileId: 'backup',
        reason: 'usage_limit',
        mode: 'restart_resume',
      },
    }];

    const screen = await renderSessionView();

    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.intentionalRestartSignals).toEqual([{
      status: 'restarting',
      attemptId: 'connected-service-account-switch:usage_limit:2000',
      reason: 'usage_limit_account_switch',
      startedAtMs: 2_000,
    }]);

    sessionState.session = {
      ...sessionState.session,
      latestReadyEventAt: 2_500,
    } as any;

    await screen.update(<SessionView id="s1" jumpToSeq={1} />);

    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.intentionalRestartSignals).toEqual([]);
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
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

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
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');

	    expect(openSubagentsButton).toBeDefined();
	  });

	  it('does not hydrate discovered sidechains from the session shell or header', async () => {
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
	    await flushHookEffects();

	    expect(openSubagentsButton).toBeDefined();
	    expect(ensureSidechainMessagesLoadedSpy).not.toHaveBeenCalled();
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
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');

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

  it('offers and handles the attached Claude terminal action when supported', async () => {
    attachedTerminalState.available = true;
    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openAttachedClaudeTerminal');
    expect(props?.onSelectExtraItem?.('header.openAttachedClaudeTerminal')).toBe(true);
    expect(attachedTerminalState.open).toHaveBeenCalledTimes(1);
  });

  it('adds an open cockpit menu item on phone when classic mode is active', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';

    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openMobileWorkspaceCockpit');
  });

  it('dismisses the keyboard before opening cockpit from the session header toggle', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(props?.onSelectExtraItem?.('header.openMobileWorkspaceCockpit')).toBe(true);

    expect(keyboardDismissSpy).toHaveBeenCalledTimes(1);
  });

  it('adds an open classic view menu item on phone when cockpit mode is active', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'cockpit';

    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openMobileWorkspaceClassic');
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

  it('disables connected-services auth switching until an in-progress turn reaches terminal projection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 1,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
    } as any;

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.switchingDisabledReason).toBe('active_turn');
  });
});
