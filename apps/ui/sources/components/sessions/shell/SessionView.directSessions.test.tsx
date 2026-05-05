import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const machineDirectSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineDirectSessionAttachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 })));
const machineDirectSessionDetachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, detached: true })));
const machineDirectSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineDirectSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
const syncRefreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const syncSubmitMessageSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const deleteWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const clearWorkspaceReviewCommentDraftsSpy = vi.hoisted(() => vi.fn());
const setWorkspaceReviewCommentDraftIncludedSpy = vi.hoisted(() => vi.fn());
const publishSessionAcpSessionModeOverrideToMetadataSpy = vi.hoisted(() => vi.fn(async () => {}));
const publishSessionAcpConfigOptionOverrideToMetadataSpy = vi.hoisted(() => vi.fn(async () => {}));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const voiceSurfacePropsSpy = vi.hoisted(() => vi.fn());
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const resolveSessionViewRuntimeDisplayStateSpy = vi.hoisted(() =>
  vi.fn((_input: any) => ({
    localControlState: { canAttach: false },
    transcriptInteraction: { canApprovePermissions: true, permissionDisabledReason: null },
    inactiveUi: { noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true },
    bottomNotice: null,
  })),
);
const preferredServerIdState = vi.hoisted(() => ({
  current: 'server-canonical' as string | null,
}));
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn((sessionId: string) => preferredServerIdState.current));
const sendVoiceSessionComposerTextSpy = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => Promise<
      { ok: true }
      | { ok: false; reason: 'not_voice_session' | 'adapter_unavailable' | 'send_failed'; message?: string }
    >
  >(async (_params: unknown) => ({ ok: false as const, reason: 'not_voice_session' as const })),
);
const resolveVoiceSessionComposerRoutingSpy = vi.hoisted(() => vi.fn((_params: any): any => null));
const featureEnabledState = vi.hoisted(() => ({ voice: false, 'files.reviewComments': false }));
const settingsState = vi.hoisted(() => ({ current: {} as any }));
const settingByKeyState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const sessionUsageState = vi.hoisted(() => ({ current: null as null | {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  contextSize: number;
  timestamp: number;
  contextWindowTokens?: number;
} }));
const participantTargetsState = vi.hoisted(() => ({ current: [] as any[] }));
const reviewCommentDraftsState = vi.hoisted(() => ({ current: [] as any[] }));
const focusState = vi.hoisted(() => ({ current: true }));
const pathnameState = vi.hoisted(() => ({ current: '/session/s1' }));
const storageState = vi.hoisted(() => ({
  sessions: {
    s1: {
      id: 's1',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'offline',
      active: true,
      accessLevel: 'edit',
      canApprovePermissions: false,
      metadata: {
        machineId: 'machine-1',
        host: 'happy-host',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
      agentState: {},
    } as any,
  },
  settings: {} as Record<string, unknown>,
  concurrentSessionListCacheByServerId: {} as Record<string, unknown>,
}));
const recipientStateState = vi.hoisted(() => ({
  current: {
    recipient: null as any,
    setManualRecipient: vi.fn(),
    executionRunDelivery: 'steer_if_supported',
    setExecutionRunDelivery: vi.fn(),
  },
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

const themeColors = vi.hoisted(() => ({
  text: '#000',
  textSecondary: '#666',
  textLink: '#00f',
  surface: '#fff',
  surfaceHigh: '#f5f5f5',
  surfacePressed: '#efefef',
  divider: '#ddd',
  border: '#ddd',
  radio: { active: '#007AFF' },
  button: {
    primary: { background: '#111', tint: '#fff' },
  },
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
  header: { tint: '#000' },
  status: { error: '#f00' },
  shadow: { color: '#000', opacity: 0.2 },
  groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
  box: {
    warning: { background: '#fff4cc', border: '#f0d98a', text: '#000' },
  },
}));

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
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      pathname: () => pathnameState.current,
    }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
      translate: (key: string) => key,
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args) => modalAlertSpy(...args));
    return modalMock.module;
  },
  storage: async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');

    const readLocalSetting = <K extends keyof LocalSettings>(key: K): LocalSettings[K] => {
      if (key === 'acknowledgedCliVersions') return {} as LocalSettings[K];
      if (key === 'uiMultiPanePanelsEnabled') return true as LocalSettings[K];
      if (key === 'detailsPaneTabsBehavior') return 'preview' as LocalSettings[K];
      if (key === 'rightPaneWidthPx') return 360 as LocalSettings[K];
      if (key === 'rightPaneWidthBasisPx') return 1200 as LocalSettings[K];
      if (key === 'detailsPaneWidthPx') return 520 as LocalSettings[K];
      if (key === 'detailsPaneWidthBasisPx') return 1200 as LocalSettings[K];
      return localSettingsDefaults[key];
    };

    const readSetting = <K extends keyof Settings>(key: K): Settings[K] => {
      const override = settingByKeyState.current[key as string];
      return (override ?? settingsDefaults[key]) as Settings[K];
    };

    return createStorageModuleMock({
      importOriginal,
      overrides: {
        storage: createStorageStoreMock(storageState as any),
        useSession: () => storageState.sessions.s1,
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSessionMessages: () => ({ messages: [], isLoaded: true }),
        useSessionTranscriptIds: () => ({ ids: ['m1'], isLoaded: true }),
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
        useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useSessionReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useSessionUsage: () => sessionUsageState.current,
        useLocalSetting: readLocalSetting,
        useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [readLocalSetting(key), vi.fn<(value: LocalSettings[K]) => void>()],
        useSetting: readSetting,
        useSettings: () => ({
          ...settingsDefaults,
          experiments: true,
          featureToggles: {},
          codexBackendMode: 'acp',
          ...settingsState.current,
        }),
        useAutomations: () => [],
        useMachine: () => null,
      },
    });
  },
});

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => focusState.current,
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
  ChatHeaderView: (props: any) => {
    chatHeaderPropsSpy(props);
    return null;
  },
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: (props: any) => {
    chatListPropsSpy(props);
    return React.createElement('ChatList', props);
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
  VoiceSurface: (props: any) => {
    voiceSurfacePropsSpy(props);
    return null;
  },
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureEnabledState[featureId as keyof typeof featureEnabledState] ?? false,
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
vi.mock('@/components/sessions/shell/view/resolveSessionViewRuntimeDisplayState', () => ({
  resolveSessionViewRuntimeDisplayState: (input: any) => resolveSessionViewRuntimeDisplayStateSpy(input),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sessions/model/useSessionMachineReachability')>();

  return {
    ...actual,
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
    useSessionReachableMachineTarget: () => null,
  };
});
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
    publishSessionAcpSessionModeOverrideToMetadata: publishSessionAcpSessionModeOverrideToMetadataSpy,
    publishSessionAcpConfigOptionOverrideToMetadata: publishSessionAcpConfigOptionOverrideToMetadataSpy,
    publishSessionModelOverrideToMetadata: async () => {},
    refreshSessions: async () => {},
    refreshSessionMessages: syncRefreshSessionMessagesSpy,
    onSessionVisible: () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: syncSubmitMessageSpy,
    encryption: { getMachineEncryption: () => null },
    onSessionViewportChange: () => {},
  },
}));
vi.mock('@/sync/ops', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    continueSessionWithReplay: vi.fn(),
    sessionAbort: vi.fn(),
    resumeSession: vi.fn(),
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
  };
});
vi.mock('@/sync/ops/machineDirectSessions', () => ({
  machineDirectSessionStatusGet: machineDirectSessionStatusGetSpy,
  machineDirectSessionAttach: machineDirectSessionAttachSpy,
  machineDirectSessionDetach: machineDirectSessionDetachSpy,
  machineDirectSessionTakeover: machineDirectSessionTakeoverSpy,
  machineDirectSessionTakeoverPersist: machineDirectSessionTakeoverPersistSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: (...args: unknown[]) => createDefaultActionExecutorMock(...args),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', { testID: 'session-agent-input', ...props }),
}));
vi.mock('@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog', () => ({
  showDirectSessionTakeoverDialog: showDirectSessionTakeoverDialogSpy,
}));
vi.mock('@/voice/binding/sendVoiceSessionComposerText', () => ({
  sendVoiceSessionComposerText: (params: any) => sendVoiceSessionComposerTextSpy(params),
}));
vi.mock('@/voice/binding/voiceSessionComposerRouting', () => ({
  resolveVoiceSessionComposerRouting: (params: any) => resolveVoiceSessionComposerRoutingSpy(params),
}));
vi.mock('@/components/sessions/agentInput/routing/useSessionRecipientState', () => ({
  useSessionRecipientState: () => recipientStateState.current,
}));
vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
  resolveSessionTargetServerId: () => {
    throw new Error('legacy session target resolver should not be used in SessionView');
  },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () => preferredServerIdState.current,
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
  useSessionSubagents: () => ({ subagents: [], participantTargets: participantTargetsState.current, sidechainIds: [] }),
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
  };
});
vi.mock('@/sync/domains/session/resolveWorkspaceScopeForSession', () => ({
  resolveWorkspaceScopeForSession: () => ({ serverId: 'server-canonical', machineId: 'machine-1', rootPath: '/tmp' }),
  useWorkspaceScopeForSession: () => ({ serverId: 'server-canonical', machineId: 'machine-1', rootPath: '/tmp' }),
}));

describe('SessionView (direct sessions)', () => {
  async function renderSessionView() {
    const { SessionView } = await import('./SessionView');
    return renderScreen(
      <AppPaneProvider>
        <SessionView id="s1" />
      </AppPaneProvider>,
    );
  }

  async function renderSessionViewAndSettle() {
    const screen = await renderSessionView();
    await settleDirectSessionView();
    return screen;
  }

  async function settleDirectSessionView() {
    await flushHookEffects({ cycles: 1, turns: 2 });
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function findAgentInput(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return screen.findByTestId('session-agent-input') as any;
  }

  beforeEach(() => {
    createDefaultActionExecutorMock.mockReset();
    chatListPropsSpy.mockReset();
    chatHeaderPropsSpy.mockReset();
    voiceSurfacePropsSpy.mockReset();
    featureEnabledState.voice = false;
    featureEnabledState['files.reviewComments'] = false;
    settingsState.current = {};
    settingByKeyState.current = {};
    modalAlertSpy.mockReset();
    syncRefreshSessionMessagesSpy.mockReset();
    syncSubmitMessageSpy.mockReset();
    deleteWorkspaceReviewCommentDraftSpy.mockReset();
    clearWorkspaceReviewCommentDraftsSpy.mockReset();
    setWorkspaceReviewCommentDraftIncludedSpy.mockReset();
    machineDirectSessionTakeoverSpy.mockReset();
    machineDirectSessionTakeoverPersistSpy.mockReset();
    machineDirectSessionStatusGetSpy.mockReset();
    machineDirectSessionAttachSpy.mockClear();
    machineDirectSessionDetachSpy.mockClear();
    showDirectSessionTakeoverDialogSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockResolvedValue({ ok: false, reason: 'not_voice_session' });
    resolveVoiceSessionComposerRoutingSpy.mockReset();
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue(null);
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolveSessionViewRuntimeDisplayStateSpy.mockReset();
    participantTargetsState.current = [];
    sessionUsageState.current = null;
    reviewCommentDraftsState.current = [];
    focusState.current = true;
    pathnameState.current = '/session/s1';
    preferredServerIdState.current = 'server-canonical';
    storageState.sessions.s1 = {
      id: 's1',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'offline',
      active: true,
      accessLevel: 'edit',
      canApprovePermissions: false,
      metadata: {
        machineId: 'machine-1',
        host: 'happy-host',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
      agentState: {},
    };
    storageState.settings = settingsState.current;
    storageState.concurrentSessionListCacheByServerId = {};
    delete (storageState as any).sessionListRenderables;
    delete (storageState as any).machines;
    (storageState as any).deleteWorkspaceReviewCommentDraft = deleteWorkspaceReviewCommentDraftSpy;
    (storageState as any).clearWorkspaceReviewCommentDrafts = clearWorkspaceReviewCommentDraftsSpy;
    (storageState as any).setWorkspaceReviewCommentDraftIncluded = setWorkspaceReviewCommentDraftIncludedSpy;
    recipientStateState.current = {
      recipient: null,
      setManualRecipient: vi.fn(),
      executionRunDelivery: 'steer_if_supported',
      setExecutionRunDelivery: vi.fn(),
    };
    showDirectSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    machineDirectSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      activity: 'running',
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    createDefaultActionExecutorMock.mockReturnValue({
      execute: vi.fn(),
    });
  });

  afterEach(() => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('passes direct takeover footer actions to the transcript when a linked direct session is not yet controlled', async () => {
    const screen = await renderSessionView();

    const latestChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestChatListProps?.directControlFooter).toEqual(expect.objectContaining({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      takeoverInFlight: null,
    }));

    await act(async () => {
      await latestChatListProps.directControlFooter.onRequestTakeOverDirect();
    });

    expect(machineDirectSessionTakeoverSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
    }, { serverId: 'server-canonical' });
    expect(modalAlertSpy).not.toHaveBeenCalled();

    await renderSessionView();

    const rerenderedChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(rerenderedChatListProps?.directControlFooter).toEqual(expect.objectContaining({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      takeoverInFlight: null,
    }));
    expect(rerenderedChatListProps?.directControlFooter).not.toBe(latestChatListProps?.directControlFooter);

  });

  it('does not attach a direct-session lease while the session screen is unfocused', async () => {
    focusState.current = false;

    await renderSessionView();

    expect(machineDirectSessionAttachSpy).not.toHaveBeenCalled();
    expect(machineDirectSessionStatusGetSpy).not.toHaveBeenCalled();
  });

  it('detaches the direct-session lease when the session screen loses focus after mounting', async () => {
    const { SessionView } = await import('./SessionView');
    const screen = await renderSessionView();
    await settleDirectSessionView();

    expect(machineDirectSessionAttachSpy).toHaveBeenCalledTimes(1);
    machineDirectSessionDetachSpy.mockClear();

    focusState.current = false;
    act(() => {
      screen.tree.update(
        <AppPaneProvider>
          <SessionView key="blurred" id="s1" />
        </AppPaneProvider>,
      );
    });
    await settleDirectSessionView();

    expect(machineDirectSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
      leaseId: 'lease-1',
    }, { serverId: 'server-canonical' });
  });

  it('builds the default action executor from the local session target helper', async () => {
    await renderSessionView();

    expect(createDefaultActionExecutorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveServerIdForSessionId: expect.any(Function),
      }),
    );
    const resolveServerIdForSessionId = createDefaultActionExecutorMock.mock.calls[0]?.[0]?.resolveServerIdForSessionId;
    expect(resolveServerIdForSessionId?.('s1')).toBeNull();
  });

  it('passes pending user action requests to AgentInput', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().sessions.s1.agentState = {
      requests: {
        req_question_1: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: {
            questions: [
              {
                header: 'Mode',
                question: 'Should I create files or only inspect files?',
                options: [
                  { label: 'Create', description: 'Create the requested file(s)' },
                  { label: 'Inspect only', description: 'Only inspect/read files' },
                ],
                multiSelect: false,
              },
            ],
          },
          createdAt: 1,
        },
      },
      completedRequests: {},
    } as any;

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.userActionRequests).toEqual([
      expect.objectContaining({
        id: 'req_question_1',
        tool: 'AskUserQuestion',
        kind: 'user_action',
      }),
    ]);
  });

  it('passes live engine control props directly to AgentInput instead of custom agent picker options', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      sessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Think first' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        configOptions: [
          {
            id: 'thinking',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.agentType).toBe('codex');
    expect(agentInput.props.agentPickerOptions).toBeUndefined();
    expect(agentInput.props.agentPickerSelectedOptionId).toBeUndefined();
    expect(agentInput.props.agentPickerApplyLabel).toBeUndefined();
    expect(agentInput.props.metadata).toEqual(session.metadata);
    expect(typeof agentInput.props.onModelModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpSessionModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpConfigOptionChange).toBe('function');

    await act(async () => {
      agentInput.props.onAcpSessionModeChange('plan');
      agentInput.props.onAcpConfigOptionChange('thinking', 'high');
    });

    expect(publishSessionAcpSessionModeOverrideToMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      modeId: 'plan',
    }));
    expect(publishSessionAcpConfigOptionOverrideToMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      configId: 'thinking',
      value: 'high',
    }));
  });

  it('projects the direct-session provider id into the agent input when no canonical agent signal exists', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      machineId: 'machine-1',
      host: 'happy-host',
      version: '0.0.0',
      path: '/tmp',
      homeDir: '/tmp',
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-session-1',
        source: { kind: 'codexHome', home: 'user' },
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.agentType).toBe('codex');
  });

  it('surfaces configured ACP backend titles on the live session agent chip', async () => {
    settingsState.current = {
      acpCatalogSettingsV1: {
        v: 2,
        backends: [{
          id: 'review-bot',
          name: 'review-bot',
          title: 'Review Bot',
          command: 'node',
          args: ['/tmp/review-bot.mjs'],
          env: {},
          auth: { support: 'unsupported' },
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'unknown',
          },
          createdAt: 1,
          updatedAt: 1,
        }],
      },
      backendEnabledByTargetKey: {
        'acpBackend:review-bot': false,
      },
    };
    storageState.settings = settingsState.current;
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      flavor: 'customAcp',
      agent: 'customAcp',
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 1,
        backendId: 'review-bot',
        title: 'Review Bot',
      },
      directSessionV1: {
        v: 1,
        providerId: 'customAcp',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-session-1',
        source: { kind: 'customAcpRuntime', cwd: '/tmp' },
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    // Configured ACP backends are represented as backend targets; the UI keeps the built-in
    // agent placeholder while surfacing the configured backend title on the chip.
    expect(agentInput.props.agentType).toBe('claude');
    expect(agentInput.props.agentLabel).toBe('Review Bot');
    expect(resolveSessionViewRuntimeDisplayStateSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'Review Bot',
    }));
  });

  it('passes live usage context-window telemetry through to AgentInput', async () => {
    sessionUsageState.current = {
      inputTokens: 700,
      outputTokens: 250,
      cacheCreation: 0,
      cacheRead: 200,
      contextSize: 1200,
      timestamp: 1,
      contextWindowTokens: 258400,
    };
    storageState.sessions.s1.latestUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreation: 0,
      cacheRead: 0,
      contextSize: 20,
      timestamp: 1,
      contextWindowTokens: 99999,
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.usageData).toEqual(expect.objectContaining({
      contextSize: 1200,
      contextWindowTokens: 258400,
    }));
  });

  it('falls back to latest session usage context-window telemetry when live usage is unavailable', async () => {
    storageState.sessions.s1.latestUsage = {
      inputTokens: 700,
      outputTokens: 250,
      cacheCreation: 0,
      cacheRead: 200,
      contextSize: 1200,
      timestamp: 1,
      contextWindowTokens: 258400,
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.usageData).toEqual(expect.objectContaining({
      contextSize: 1200,
      contextWindowTokens: 258400,
    }));
  });

  it('prefers the shared live authoring snapshot overrides for permission and model composer props', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.permissionMode = 'acceptEdits';
    session.permissionModeUpdatedAt = 5;
    session.modelMode = 'gpt-4.1';
    session.modelModeUpdatedAt = 5;
    session.metadata = {
      ...session.metadata,
      permissionMode: 'default',
      permissionModeUpdatedAt: 10,
      modelOverrideV1: {
        v: 1,
        updatedAt: 10,
        modelId: 'claude-sonnet-4-5',
      },
      profileId: 'profile-metadata',
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.permissionMode).toBe('default');
    expect(agentInput.props.modelMode).toBe('claude-sonnet-4-5');
    expect(agentInput.props.profileId).toBe('profile-metadata');
  });

  it('passes recipient controls through canonical extra action chips', async () => {
    participantTargetsState.current = [
      {
        key: 'member-1',
        displayLabel: 'Worker',
        recipient: { kind: 'agent_team_member', teamId: 'team-1', memberId: 'member-1' },
      },
      {
        key: 'run-1',
        displayLabel: 'Run 1',
        recipient: { kind: 'execution_run', runId: 'run-1' },
      },
    ];
    recipientStateState.current = {
      recipient: { kind: 'execution_run', runId: 'run-1' },
      setManualRecipient: vi.fn(),
      executionRunDelivery: 'interrupt',
      setExecutionRunDelivery: vi.fn(),
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    const recipientChip = (agentInput.props.extraActionChips ?? []).find((chip: {
      key: string;
      controlId?: string;
      collapsedOptionsPopover?: {
        options?: Array<{ id: string }>;
        selectedOptionId?: string | null;
        onSelect?: (id: string) => void;
      };
    }) => chip.key === 'participants-recipient');

    expect(recipientChip).toEqual(expect.objectContaining({
      key: 'participants-recipient',
      controlId: 'recipient',
    }));
    expect(recipientChip?.collapsedOptionsPopover?.options?.map((option: { id: string }) => option.id)).toEqual([
      'lead',
      'member-1',
      'run-1',
    ]);
    expect(recipientChip?.collapsedOptionsPopover?.selectedOptionId).toBe('run-1');
    expect(typeof recipientChip?.collapsedOptionsPopover?.onSelect).toBe('function');
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).toContain('execution-run-delivery');
  });

  it('promotes review comment drafts into canonical extra control metadata', async () => {
    featureEnabledState['files.reviewComments'] = true;
    reviewCommentDraftsState.current = [
      {
        id: 'draft-1',
        filePath: 'src/demo.ts',
        source: 'file',
        anchor: { kind: 'fileLine', startLine: 12 },
        snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
        body: 'Consider extracting this.',
        createdAt: 1,
      },
    ];

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    const reviewCommentsChip = (agentInput.props.extraActionChips ?? []).find((chip: { key: string }) => chip.key === 'review-comments');

    expect(reviewCommentsChip).toEqual(expect.objectContaining({
      key: 'review-comments',
      controlId: 'reviewComments',
    }));
    expect(typeof reviewCommentsChip?.collapsedAction).toBe('function');
  });

  it('removes only sent workspace review comment drafts after submitting them', async () => {
    featureEnabledState['files.reviewComments'] = true;
    reviewCommentDraftsState.current = [
      {
        id: 'included-draft',
        filePath: 'src/included.ts',
        source: 'file',
        anchor: { kind: 'fileLine', startLine: 12 },
        snapshot: { selectedLines: ['const included = true;'], beforeContext: [], afterContext: [] },
        body: 'Send this comment.',
        createdAt: 1,
      },
      {
        id: 'detached-draft',
        filePath: 'src/detached.ts',
        source: 'file',
        anchor: { kind: 'fileLine', startLine: 24 },
        snapshot: { selectedLines: ['const detached = true;'], beforeContext: [], afterContext: [] },
        body: 'Keep this comment for later.',
        includeInPrompt: false,
        createdAt: 2,
      },
    ];
    (storageState as any).sessionListRenderables = {
      s1: {
        id: 's1',
        metadata: {
          machineId: 'machine-1',
          path: '/tmp',
        },
      },
    };
    (storageState as any).machines = {
      'machine-1': {
        id: 'machine-1',
        active: true,
        metadata: { host: 'happy-host' },
      },
    };
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('Send this comment.'),
      expect.any(String),
      expect.objectContaining({
        happier: expect.objectContaining({
          kind: 'review_comments.v1',
          payload: expect.objectContaining({
            comments: [
              expect.objectContaining({ id: 'included-draft' }),
            ],
          }),
        }),
      }),
    );
    expect(syncSubmitMessageSpy.mock.calls[0]?.[1]).not.toContain('Keep this comment for later.');
    expect(deleteWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith(expect.any(String), 'included-draft');
    expect(deleteWorkspaceReviewCommentDraftSpy).not.toHaveBeenCalledWith(expect.any(String), 'detached-draft');
    expect(clearWorkspaceReviewCommentDraftsSpy).not.toHaveBeenCalled();
  });

	  it('promotes project file link into canonical extra control metadata', async () => {
	    const screen = await renderSessionViewAndSettle();

	    const agentInput = findAgentInput(screen);
	    const linkFileChip = (agentInput.props.extraActionChips ?? []).find((chip: { key: string }) => chip.key === 'project-file-link');

	    expect(linkFileChip).toEqual(expect.objectContaining({
	      key: 'project-file-link',
	      controlId: 'linkedFiles',
	    }));
	    expect(linkFileChip?.collapsedContentPopover).toBeTruthy();
	  });

  it('does not surface delivery controls when live participant routing data is absent', async () => {
    participantTargetsState.current = [];
    recipientStateState.current = {
      recipient: { kind: 'execution_run', runId: 'run-1' },
      setManualRecipient: vi.fn(),
      executionRunDelivery: 'interrupt',
      setExecutionRunDelivery: vi.fn(),
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).not.toContain('participants-recipient');
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).not.toContain('execution-run-delivery');
  });

  it('surfaces delivery controls when live participant routing data resolves to an execution run', async () => {
    participantTargetsState.current = [
      {
        key: 'run-1',
        displayLabel: 'Run 1',
        recipient: { kind: 'execution_run', runId: 'run-1' },
      },
    ];
    recipientStateState.current = {
      recipient: { kind: 'execution_run', runId: 'run-1' },
      setManualRecipient: vi.fn(),
      executionRunDelivery: 'interrupt',
      setExecutionRunDelivery: vi.fn(),
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    const deliveryChip = (agentInput.props.extraActionChips ?? []).find((chip: {
      key: string;
      controlId?: string;
      collapsedOptionsPopover?: {
        label?: string | null;
        options?: Array<{ id: string }>;
        selectedOptionId?: string | null;
        onSelect?: (id: string) => void;
      };
    }) => chip.key === 'execution-run-delivery');

    expect(deliveryChip).toEqual(expect.objectContaining({
      key: 'execution-run-delivery',
      controlId: 'delivery',
    }));
    expect(deliveryChip?.collapsedOptionsPopover?.label).toBe('runs.delivery.cardDelivery');
    expect(deliveryChip?.collapsedOptionsPopover?.options?.map((option: { id: string }) => option.id)).toEqual([
      'prompt',
      'steer_if_supported',
      'interrupt',
    ]);
    expect(deliveryChip?.collapsedOptionsPopover?.selectedOptionId).toBe('interrupt');
    expect(typeof deliveryChip?.collapsedOptionsPopover?.onSelect).toBe('function');
  });

  it('passes storage and provider badges to the session header for direct sessions', async () => {
    await renderSessionViewAndSettle();

    expect(chatHeaderPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      badges: ['sessionsList.storageDirectTab', 'agentInput.agent.codex · happy-host'],
    }));
  });

  it('polls direct session status using the active cadence without forcing transcript refreshes', async () => {
    const previousActivePollMs = process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE;
    process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE = '50';

    try {
      await renderSessionView();

      const initialStatusCallCount = machineDirectSessionStatusGetSpy.mock.calls.length;
      expect(initialStatusCallCount).toBeGreaterThanOrEqual(1);
      expect(syncRefreshSessionMessagesSpy).not.toHaveBeenCalled();

      await act(async () => {
        await sleep(75);
      });
      await flushHookEffects({ cycles: 1, turns: 2 });
      expect(machineDirectSessionStatusGetSpy.mock.calls.length).toBeGreaterThanOrEqual(initialStatusCallCount + 1);
      expect(syncRefreshSessionMessagesSpy).not.toHaveBeenCalled();
    } finally {
      if (previousActivePollMs === undefined) {
        delete process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE;
      } else {
        process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE = previousActivePollMs;
      }
    }
  });

  it('prompts for takeover on send and submits after taking over the direct session', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue this session');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(showDirectSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineDirectSessionTakeoverSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
    }, { serverId: 'server-canonical' });
    expect(syncSubmitMessageSpy).toHaveBeenCalledWith('s1', 'continue this session', undefined, undefined);

  });

  it('keeps the composer text when direct takeover is cancelled from the send prompt', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null, forceStop: false });
    const screen = await renderSessionView();

    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('draft stays here');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(machineDirectSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineDirectSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('draft stays here');

  });

  it('clears the composer immediately while a direct takeover send prompt is still pending', async () => {
    showDirectSessionTakeoverDialogSpy.mockImplementationOnce(
      () => new Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>(() => {}),
    );
    const screen = await renderSessionView();

    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('clear me immediately');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('');
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

  });

  it('passes force-stop through when persisting takeover from the send prompt', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'persisted', forceStop: true });
    machineDirectSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      activity: 'running',
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: true,
      trustedPid: 123,
    });
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('persist this');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(machineDirectSessionTakeoverPersistSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
      forceStop: true,
    }, { serverId: 'server-canonical' });
    expect(syncSubmitMessageSpy).toHaveBeenCalledWith('s1', 'persist this', undefined, undefined);

  });

  it('routes hidden voice conversation sends through the voice session binding helper', async () => {
    sendVoiceSessionComposerTextSpy.mockImplementationOnce(() => new Promise(() => {}) as any);
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue({
      kind: 'adapter_text',
      binding: {
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 'voice-global',
        conversationSessionId: 's1',
        transcriptMode: 'synthetic',
        targetSessionId: null,
        updatedAt: 1,
      },
    });
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue the voice conversation');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(sendVoiceSessionComposerTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationSessionId: 's1',
        text: 'continue the voice conversation',
      }),
    );
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

  });

  it('shows the adapter send error when a hidden voice conversation send fails', async () => {
    sendVoiceSessionComposerTextSpy.mockResolvedValueOnce({
      ok: false,
      reason: 'send_failed',
      message: 'voice_send_failed',
    });
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue({
      kind: 'adapter_text',
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 's1',
        transcriptMode: 'native_session',
        targetSessionId: 'target-s1',
        updatedAt: 1,
      },
    });
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue the voice conversation');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'voice_send_failed');
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

    await act(async () => {
      await screen.unmount();
    });
  });

  it('suppresses local and remote control footers for hidden voice conversation sessions', async () => {
    featureEnabledState.voice = true;
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
      },
    };
    settingByKeyState.current = {
      voice: {
        providerId: 'local_conversation',
      },
    };
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
    };
    session.agentState = {
      ...session.agentState,
      controlledByUser: true,
    };

    const screen = await renderSessionView();

    expect(chatListPropsSpy).toHaveBeenCalled();
    const lastChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(lastChatListProps?.directControlFooter ?? null).toBeNull();
    expect(lastChatListProps?.onRequestSwitchToRemote).toBeUndefined();
    expect(voiceSurfacePropsSpy).not.toHaveBeenCalled();

    await act(async () => {
      await screen.unmount();
    });
  });

  it('suppresses the voice surface for retired hidden voice conversation sessions', async () => {
    featureEnabledState.voice = true;
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
      },
    };
    settingByKeyState.current = {
      voice: {
        providerId: 'local_conversation',
      },
    };
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      ...buildSystemSessionMetadataV1({ key: 'voice_conversation_retired', hidden: true }),
    };

    const screen = await renderSessionView();

    expect(voiceSurfacePropsSpy).not.toHaveBeenCalled();

    await act(async () => {
      await screen.unmount();
    });
  });
});
