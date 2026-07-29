import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  buildSystemSessionMetadataV1,
  ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import {
  computeExistingSessionComposerInputMaxHeight,
  computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  clearSessionDraftValuesForSession,
  flushSessionDraftValues,
  readSessionDraftValue,
  resetSessionDraftValueCachesForTests,
  writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));

const machineExternalSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineExternalSessionAttachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 })));
const machineExternalSessionDetachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, detached: true })));
const machineExternalSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineExternalSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
const syncRefreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const syncRefreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
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
const warningActionBannerPropsSpy = vi.hoisted(() => vi.fn());
const showExternalSessionTakeoverDialogSpy = vi.hoisted(() =>
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
const connectedServiceQuotaSnapshotsState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const useConnectedServiceQuotaSnapshotsSpy = vi.hoisted(() => vi.fn());
const providerAccountUsageSnapshotsState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const useProviderAccountUsageSnapshotsSpy = vi.hoisted(() => vi.fn());
const sessionUsageLimitConsumeResetCreditSpy = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  status: 'ready',
})));
const connectedServiceQuotaRecoveryCreditConsumeSpy = vi.hoisted(() => vi.fn(async (params: any) => ({
  ok: true,
  receipt: {
    idempotencyKey: 'test-reset-credit',
    status: 'consumed',
  },
  snapshot: {
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    fetchedAt: 3_000,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    recoveryCredits: { availableCount: 0, credits: [] },
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 20,
      limit: 100,
      unit: 'count',
      utilizationPct: null,
      resetsAt: null,
      status: 'ok',
      details: {},
    }],
  },
})));

vi.mock('./view/WarningActionBanner', () => ({
  WarningActionBanner: (props: any) => {
    warningActionBannerPropsSpy(props);
    return React.createElement('WarningActionBanner', props);
  },
}));
const participantTargetsState = vi.hoisted(() => ({ current: [] as any[] }));
const reviewCommentDraftsState = vi.hoisted(() => ({ current: [] as any[] }));
const sessionMessagesState = vi.hoisted(() => ({ current: [] as any[] }));
const focusState = vi.hoisted(() => ({ current: true }));
const machineReachabilityState = vi.hoisted(() => ({
  current: {
    machineReachable: true,
    machineOnline: true,
    machineRpcTargetAvailable: true,
    machineReachability: 'reachable' as 'reachable' | 'unreachable' | 'unknown',
  },
}));
const pathnameState = vi.hoisted(() => ({ current: '/session/s1' }));
const windowDimensionsState = vi.hoisted(() => ({ current: { width: 1200, height: 800 } }));
const composerKeyboardState = vi.hoisted(() => ({
  availablePanelHeight: undefined as number | undefined,
  keyboardHeight: 0,
}));
const storageState = vi.hoisted(() => ({
  isDataReady: true,
  machines: {} as Record<string, unknown>,
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
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
      agentState: {},
    } as any,
  },
  sessionMessages: {} as Record<string, unknown>,
  sessionPending: {} as Record<string, unknown>,
  sessionListRenderables: {} as Record<string, unknown>,
  sessionTailContiguousFloorSeq: {} as Record<string, unknown>,
  artifacts: {} as Record<string, any>,
  profile: {
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
  } as any,
  settings: {} as Record<string, unknown>,
  concurrentSessionListCacheByServerId: {} as Record<string, unknown>,
}));
const shellStorageStoreState = vi.hoisted(() => ({
  current: null as UseBoundStore<StoreApi<StorageState>> | null,
}));
const recipientStateState = vi.hoisted(() => ({
  current: {
    recipient: null as any,
    setManualRecipient: vi.fn(),
    clearPersistedManualRecipient: vi.fn(),
    executionRunDelivery: 'steer_if_supported',
    setExecutionRunDelivery: vi.fn(),
  },
}));

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
      useWindowDimensions: () => windowDimensionsState.current,
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
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const { listOpenApprovalArtifactsForSession } = await import('@/sync/domains/artifacts/approvalArtifacts');
    const { create } = await import('zustand');
    // Test boundary: this fixture supplies only the StorageState fields consumed by SessionView.
    const shellStorageStore = create<StorageState>(
      () => ({ ...storageState } as unknown as StorageState),
    );
    shellStorageStoreState.current = shellStorageStore;

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
        storage: shellStorageStore,
        useActiveServerAccountScope: () => null,
        useSession: () => storageState.sessions.s1,
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSessionMessages: () => ({ messages: sessionMessagesState.current, isLoaded: true }),
        useSessionTranscriptIds: () => ({ ids: ['m1'], isLoaded: true }),
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
        useArtifacts: () => Object.values(storageState.artifacts),
        useOpenApprovalArtifactsForSession: (sessionId: string | null | undefined) =>
          listOpenApprovalArtifactsForSession(Object.values(storageState.artifacts), String(sessionId ?? '')),
        useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useSessionReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useProfile: () => storageState.profile,
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
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots', () => ({
  useConnectedServiceQuotaSnapshots: (profiles: unknown) => {
    useConnectedServiceQuotaSnapshotsSpy(profiles);
    return {
      snapshotsByKey: connectedServiceQuotaSnapshotsState.current,
      loadingByKey: {},
    };
  },
}));
vi.mock('@/hooks/server/connectedServices/useProviderAccountUsageSnapshots', () => ({
  useProviderAccountUsageSnapshots: (recordIds: unknown) => {
    useProviderAccountUsageSnapshotsSpy(recordIds);
    return {
      snapshotsByRecordId: providerAccountUsageSnapshotsState.current,
      loadingByRecordId: {},
      stateByRecordId: {},
    };
  },
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
    useSessionMachineReachability: () => machineReachabilityState.current,
    useSessionReachableMachineTarget: () => null,
  };
});
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineTarget: () => ({ machineId: 'machine-1', basePath: '/tmp' }),
  useSessionMachineControlTarget: () => ({ machineId: 'machine-1', basePath: '/tmp' }),
}));
vi.mock('@/sync/ops/connectedServiceQuotaRecoveryCredits', () => ({
  connectedServiceQuotaRecoveryCreditConsume: connectedServiceQuotaRecoveryCreditConsumeSpy,
}));
vi.mock('@/sync/ops/sessionUsageLimitRecovery', () => ({
  sessionUsageLimitCheckNow: vi.fn(async () => ({ ok: true, status: 'ready' })),
  sessionUsageLimitConsumeResetCredit: sessionUsageLimitConsumeResetCreditSpy,
  sessionUsageLimitSwitchAccountNow: vi.fn(async () => ({ ok: true, status: 'ready' })),
  sessionUsageLimitWaitResumeCancel: vi.fn(async () => ({ ok: true, status: 'cancelled' })),
  sessionUsageLimitWaitResumeEnable: vi.fn(async () => ({ ok: true, status: 'waiting' })),
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
    publishSessionAcpSessionModeOverrideToMetadata: publishSessionAcpSessionModeOverrideToMetadataSpy,
    publishSessionAcpConfigOptionOverrideToMetadata: publishSessionAcpConfigOptionOverrideToMetadataSpy,
    publishSessionModelOverrideToMetadata: async () => {},
    refreshSessions: syncRefreshSessionsSpy,
    refreshSessionMessages: syncRefreshSessionMessagesSpy,
    getAcceptedExternalSessionTailCursor: () => null,
    subscribeAcceptedExternalSessionTailCursor: () => () => {},
    markSessionLiveTailIntent: () => {},
    onSessionVisible: () => {},
    sendMessage: syncSubmitMessageSpy,
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
vi.mock('@/sync/ops/machineExternalSessions', () => ({
  machineExternalSessionStatusGet: machineExternalSessionStatusGetSpy,
  machineExternalSessionAttach: machineExternalSessionAttachSpy,
  machineExternalSessionDetach: machineExternalSessionDetachSpy,
  machineExternalSessionTakeover: machineExternalSessionTakeoverSpy,
  machineExternalSessionTakeoverPersist: machineExternalSessionTakeoverPersistSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: (...args: unknown[]) => createDefaultActionExecutorMock(...args),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', { testID: 'session-agent-input', ...props }),
}));
vi.mock('@/components/sessions/keyboardAvoidance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sessions/keyboardAvoidance')>();
  return {
    ...actual,
    useComposerAvailablePanelHeight: () => composerKeyboardState.availablePanelHeight,
    useComposerKeyboardLayoutContext: () => ({
      getKeyboardHeight: () => composerKeyboardState.keyboardHeight,
      subscribeKeyboardHeight: (listener: (height: number) => void) => {
        listener(composerKeyboardState.keyboardHeight);
        return () => {};
      },
    }),
  };
});
vi.mock('@/components/sessions/external/takeover/showExternalSessionTakeoverDialog', () => ({
  showExternalSessionTakeoverDialog: showExternalSessionTakeoverDialogSpy,
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

function syncShellStorageStore() {
  const shellStorageStore = shellStorageStoreState.current;
  if (!shellStorageStore) return;
  // Test boundary: preserve the complete mock-store shape while overlaying this file's live fixture.
  shellStorageStore.setState({
    ...shellStorageStore.getState(),
    ...storageState,
    machines: {},
    sessionListRenderables: {},
  } as unknown as StorageState, true);
}

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
    await settleExternalSessionView();
    return screen;
  }

  async function settleExternalSessionView() {
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

  function expectDirectSendProjectionOptions() {
    return expect.objectContaining({
      localId: undefined,
      onLocalPendingProjectionCreated: expect.any(Function),
      profileId: undefined,
    });
  }

  function findWarningActionBannerProps(testID: string) {
    return warningActionBannerPropsSpy.mock.calls
      .map(([props]) => props)
      .find((props) => props?.testID === testID);
  }

  beforeEach(() => {
    createDefaultActionExecutorMock.mockReset();
    chatListPropsSpy.mockReset();
    chatHeaderPropsSpy.mockReset();
    voiceSurfacePropsSpy.mockReset();
    warningActionBannerPropsSpy.mockClear();
    featureEnabledState.voice = false;
    featureEnabledState['files.reviewComments'] = false;
    delete (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'];
    settingsState.current = {};
    settingByKeyState.current = {};
    connectedServiceQuotaSnapshotsState.current = {};
    providerAccountUsageSnapshotsState.current = {};
    composerKeyboardState.availablePanelHeight = undefined;
    composerKeyboardState.keyboardHeight = 0;
    useConnectedServiceQuotaSnapshotsSpy.mockReset();
    useProviderAccountUsageSnapshotsSpy.mockReset();
    sessionUsageLimitConsumeResetCreditSpy.mockClear();
    sessionUsageLimitConsumeResetCreditSpy.mockResolvedValue({ ok: true, status: 'ready' });
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockClear();
    modalAlertSpy.mockReset();
    syncRefreshSessionMessagesSpy.mockReset();
    syncRefreshSessionsSpy.mockReset();
    syncRefreshSessionsSpy.mockImplementation(async () => {
      const session = storageState.sessions.s1 as any;
      if (!session) return;
      session.presence = 'online';
      session.agentStateVersion = 1;
      session.pendingVersion = 2;
    });
    syncSubmitMessageSpy.mockReset();
    syncSubmitMessageSpy.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
    });
    deleteWorkspaceReviewCommentDraftSpy.mockReset();
    clearWorkspaceReviewCommentDraftsSpy.mockReset();
    setWorkspaceReviewCommentDraftIncludedSpy.mockReset();
    machineExternalSessionTakeoverSpy.mockReset();
    machineExternalSessionTakeoverPersistSpy.mockReset();
    machineExternalSessionStatusGetSpy.mockReset();
    machineExternalSessionAttachSpy.mockClear();
    machineExternalSessionDetachSpy.mockClear();
    showExternalSessionTakeoverDialogSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockResolvedValue({ ok: false, reason: 'not_voice_session' });
    resolveVoiceSessionComposerRoutingSpy.mockReset();
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue(null);
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolveSessionViewRuntimeDisplayStateSpy.mockReset();
    participantTargetsState.current = [];
    sessionMessagesState.current = [];
    windowDimensionsState.current = { width: 1200, height: 800 };
    reviewCommentDraftsState.current = [];
    focusState.current = true;
    machineReachabilityState.current = {
      machineReachable: true,
      machineOnline: true,
      machineRpcTargetAvailable: true,
      machineReachability: 'reachable',
    };
    pathnameState.current = '/session/s1';
    preferredServerIdState.current = 'server-canonical';
    storageState.sessions.s1 = {
      id: 's1',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'offline',
      active: true,
      currentStorageState: 'machine_only',
      accessLevel: 'edit',
      canApprovePermissions: false,
      metadata: {
        machineId: 'machine-1',
        host: 'happy-host',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
      agentState: {},
    };
    storageState.settings = settingsState.current;
    storageState.artifacts = {};
    storageState.isDataReady = true;
    storageState.profile = {
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    };
    storageState.concurrentSessionListCacheByServerId = {};
    delete (storageState as any).sessionListRenderables;
    delete (storageState as any).machines;
    (storageState as any).deleteWorkspaceReviewCommentDraft = deleteWorkspaceReviewCommentDraftSpy;
    (storageState as any).clearWorkspaceReviewCommentDrafts = clearWorkspaceReviewCommentDraftsSpy;
    (storageState as any).setWorkspaceReviewCommentDraftIncluded = setWorkspaceReviewCommentDraftIncludedSpy;
    syncShellStorageStore();
    recipientStateState.current = {
      recipient: null,
      setManualRecipient: vi.fn(),
      clearPersistedManualRecipient: vi.fn(),
      executionRunDelivery: 'steer_if_supported',
      setExecutionRunDelivery: vi.fn(),
    };
    resetSessionDraftValueCachesForTests();
    showExternalSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    machineExternalSessionStatusGetSpy.mockResolvedValue({
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

  it('keeps external control footer status conservative and exposes one explicit takeover preflight', async () => {
    await renderSessionView();

    const latestChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestChatListProps?.externalControlFooter).toEqual({
      externalAgentPresentation: {
        state: 'unknown',
        labelKey: 'status.externalStatusUnknown',
        agentLabel: 'Codex',
        machineLabel: 'happy-host',
      },
      statusKnown: false,
      machineOnline: false,
      runnerActive: false,
      trustedPid: null,
      activity: 'unknown',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      takeoverPreflightInFlight: false,
      takeoverInFlight: null,
      onRequestTakeoverPreflight: expect.any(Function),
      materialize: {
        requestEnabled: true,
        inFlight: false,
        onRequest: expect.any(Function),
      },
    });
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();

    await act(async () => {
      await latestChatListProps?.externalControlFooter?.onRequestTakeoverPreflight?.();
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
  });

  it('passes only generic progress presentation to the mounted transcript owner', async () => {
    const session = storageState.sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      externalSessionOperationPresentationV1:
        ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        kind: 'materialize',
        status: 'awaiting_user_resume',
        phase: 'importing',
      }),
    };

    await renderSessionView();

    const latestChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestChatListProps?.session.metadata.externalSessionOperationPresentationV1)
      .toMatchObject({
        operationId: 'operation-1',
        revision: 4,
        status: 'awaiting_user_resume',
      });
    expect(latestChatListProps?.session.metadata.externalSessionOperationV1)
      .toBeUndefined();
    expect(latestChatListProps?.externalControlFooter).toEqual(expect.objectContaining({
      statusKnown: false,
      onRequestTakeoverPreflight: undefined,
      materialize: null,
    }));
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
  });

  it('renders the persistent published-snapshot banner while a linked Agent is offline', async () => {
    const session = storageState.sessions.s1 as any;
    session.currentStorageState = 'snapshot_complete';
    session.publishedThroughServerSeq = 12;
    session.materializedThroughSourceAt = Date.now() - 60_000;
    machineReachabilityState.current = {
      machineReachable: false,
      machineOnline: false,
      machineRpcTargetAvailable: false,
      machineReachability: 'unreachable',
    };

    await renderSessionViewAndSettle();

    expect(findWarningActionBannerProps('session.externalTranscript.snapshot')).toEqual(expect.objectContaining({
      actionLabel: 'externalSessions.sharingUpdateSharedCopy',
      disabled: true,
    }));
  });

  it('updates the published-snapshot banner when the mounted session gains server authority', async () => {
    await renderSessionViewAndSettle();

    expect(findWarningActionBannerProps('session.externalTranscript.snapshot')).toBeUndefined();

    machineReachabilityState.current = {
      machineReachable: false,
      machineOnline: false,
      machineRpcTargetAvailable: false,
      machineReachability: 'unreachable',
    };

    await act(async () => {
      storageState.sessions.s1 = {
        ...storageState.sessions.s1,
        currentStorageState: 'snapshot_complete',
        acceptedThroughServerSeq: 12,
        publishedThroughServerSeq: 12,
        materializedThroughSourceAt: Date.now() - 60_000,
      };
      syncShellStorageStore();
    });
    await settleExternalSessionView();

    expect(findWarningActionBannerProps('session.externalTranscript.snapshot')).toEqual(expect.objectContaining({
      actionLabel: 'externalSessions.sharingUpdateSharedCopy',
      disabled: true,
    }));
  });

  it('does not reinterpret unknown machine reachability as published-snapshot authority', async () => {
    const session = storageState.sessions.s1 as any;
    session.currentStorageState = 'snapshot_complete';
    session.publishedThroughServerSeq = 12;
    session.materializedThroughSourceAt = Date.now() - 60_000;
    machineReachabilityState.current = {
      machineReachable: true,
      machineOnline: false,
      machineRpcTargetAvailable: false,
      machineReachability: 'unknown',
    };

    await renderSessionViewAndSettle();

    expect(findWarningActionBannerProps('session.externalTranscript.snapshot')).toBeUndefined();
  });

  it('uses the existing-session panel-height contract for tall viewports', async () => {
    windowDimensionsState.current = { width: 1200, height: 900 };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.maxPanelHeight).toBe(computeExistingSessionComposerPanelMaxHeight({
      availablePanelHeight: 900,
      viewportHeight: 900,
    }));
  });

  it('uses the existing-session panel-height contract for compact viewports', async () => {
    windowDimensionsState.current = { width: 390, height: 384 };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.maxPanelHeight).toBe(computeExistingSessionComposerPanelMaxHeight({
      availablePanelHeight: 384,
      viewportHeight: 384,
    }));
  });

  it('uses the composer keyboard scaffold budget for existing-session composer caps', async () => {
    windowDimensionsState.current = { width: 390, height: 900 };
    composerKeyboardState.availablePanelHeight = 500;
    composerKeyboardState.keyboardHeight = 320;

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.maxPanelHeight).toBe(computeExistingSessionComposerPanelMaxHeight({
      availablePanelHeight: 500,
      viewportHeight: 900,
    }));
    expect(findAgentInput(screen).props.inputMaxHeight).toBe(computeExistingSessionComposerInputMaxHeight({
      availablePanelHeight: 500,
      keyboardHeight: 320,
      viewportHeight: 900,
    }));
  });

  it('does not attach a direct-session lease while the session screen is unfocused', async () => {
    focusState.current = false;

    await renderSessionView();

    expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
  });

  it('detaches the direct-session lease when the session screen loses focus after mounting', async () => {
    const { SessionView } = await import('./SessionView');
    const screen = await renderSessionView();
    await settleExternalSessionView();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
    machineExternalSessionDetachSpy.mockClear();

    focusState.current = false;
    act(() => {
      screen.tree.update(
        <AppPaneProvider>
          <SessionView key="blurred" id="s1" />
        </AppPaneProvider>,
      );
    });
    await settleExternalSessionView();

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
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

  it('does not pass pending user action requests to AgentInput', async () => {
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
    expect(agentInput.props.userActionRequests).toBeUndefined();
  });

  it('passes pending transcript-backed permission requests to AgentInput', async () => {
    storageState.sessions.s1.agentState = null;
    sessionMessagesState.current = [
      {
        kind: 'tool-call',
        id: 'm-tool-1',
        localId: null,
        createdAt: 2,
        children: [],
        tool: {
          id: 'tool-permission-1',
          name: 'Bash',
          state: 'running',
          input: { command: 'rm -rf /tmp/session-permission-fixture' },
          createdAt: 2,
          startedAt: 2,
          completedAt: null,
          description: 'Remove temporary directory',
          permission: {
            id: 'tool-permission-1',
            status: 'pending',
            kind: 'permission',
          },
        },
      },
    ];

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.sessionId).toBe('s1');
    expect(agentInput.props.permissionRequests).toEqual([
      expect.objectContaining({
        id: 'tool-permission-1',
        tool: 'Bash',
        kind: 'permission',
        arguments: { command: 'rm -rf /tmp/session-permission-fixture' },
      }),
    ]);
  });

  it('passes session-scoped open approval artifacts to AgentInput', async () => {
    storageState.artifacts = {
      'approval-1': {
        id: 'approval-1',
        header: {
          v: 1,
          kind: 'approval_request.v1',
          title: 'Approve',
          approvalStatus: 'open',
          sessionId: 's1',
          actionId: 'session.list',
          approvalSummary: 'List sessions',
        },
        title: 'Approve',
        headerVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
      },
      'approval-other': {
        id: 'approval-other',
        header: {
          v: 1,
          kind: 'approval_request.v1',
          title: 'Approve',
          approvalStatus: 'open',
          sessionId: 's2',
          actionId: 'session.status.get',
          approvalSummary: 'Read status',
        },
        title: 'Approve',
        headerVersion: 1,
        seq: 2,
        createdAt: 2,
        updatedAt: 2,
        isDecrypted: true,
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.approvalRequests).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ id: 'approval-1' }),
        approval: expect.objectContaining({ actionId: 'session.list' }),
      }),
    ]);
  });

  it('passes live engine control props directly to AgentInput instead of custom agent picker options', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      sessionModesV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 1,
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Think first' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'codex',
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

  it('projects the external-session Agent id into the Agent input when no canonical Agent signal exists', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      machineId: 'machine-1',
      host: 'happy-host',
      version: '0.0.0',
      path: '/tmp',
      homeDir: '/tmp',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
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
      externalSessionV1: {
        v: 1,
        agentId: 'customAcp',
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

  it('passes connected-service quota snapshots through to AgentInput provider usage gauge', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/work': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 88,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(useConnectedServiceQuotaSnapshotsSpy).toHaveBeenCalledWith([
      { serviceId: 'openai-codex', profileId: 'work' },
    ]);
    expect(findAgentInput(screen).props.instrumentQuota?.viewModel).toEqual(expect.objectContaining({
      remainingPct: 12,
      ringValueLabel: '12',
    }));
  });

  it('applies connected-service reset credits from the AgentInput provider usage gauge', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/work': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
          availableCount: 1,
          credits: [{
            id: 'reset-credit-1',
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: 9_999_999_999_999,
          }],
        },
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 88,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const agentInput = findAgentInput(screen);

    expect(agentInput.props.instrumentQuota?.viewModel.recoveryCreditSummary).toEqual({
      availableCount: 1,
      nextExpiresAtMs: 9_999_999_999_999,
      providerCreditId: 'reset-credit-1',
    });
    expect(agentInput.props.instrumentQuota?.onRecoveryCreditPress).toEqual(expect.any(Function));

    await act(async () => {
      await agentInput.props.instrumentQuota.onRecoveryCreditPress();
    });

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1,
    });
  });

  it('applies connected-service reset credits from the usage-limit recovery banner', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    (featureEnabledState as Record<string, boolean>)['sessions.usageLimitRecovery'] = true;
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    };
    storageState.sessions.s1.lastRuntimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 2_000,
      agentId: 'codex',
      usageLimit: {
        v: 1,
        resetAtMs: 8_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'manual',
        limitCategory: 'usage_limit',
        quotaSnapshotRef: {
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAtMs: 2_000,
        },
        effectiveMeterId: 'weekly',
        effectiveRemainingPct: 5,
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/work': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
          availableCount: 1,
          credits: [{
            id: 'reset-credit-1',
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: 9_999_999_999_999,
          }],
        },
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 88,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    await renderSessionViewAndSettle();
    const banner = findWarningActionBannerProps('session-usageLimit-recovery');
    const consumeResetCreditAction = banner?.secondaryActions?.find((action: { testID?: string }) =>
      action.testID === 'session-usageLimit-recovery-consumeResetCredit');
    expect(consumeResetCreditAction).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-recovery-consumeResetCredit',
    }));

    await act(async () => {
      await consumeResetCreditAction?.onPress?.();
    });
    await settleExternalSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1000,
    });
    expect(sessionUsageLimitConsumeResetCreditSpy).not.toHaveBeenCalled();
  });

  it('applies connected-service reset credits when runtime usage evidence is selected for the same connected profile', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    };
    storageState.sessions.s1.lastRuntimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 2_000,
      agentId: 'codex',
      usageLimit: {
        v: 1,
        resetAtMs: 8_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'manual',
        limitCategory: 'usage_limit',
        quotaSnapshotRef: {
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAtMs: 2_000,
        },
        effectiveMeterId: 'weekly',
        effectiveRemainingPct: 5,
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/work': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
          availableCount: 1,
          credits: [{
            id: 'reset-credit-1',
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: 9_999_999_999_999,
          }],
        },
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 88,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const agentInput = findAgentInput(screen);

    expect(agentInput.props.instrumentQuota?.viewModel.remainingPct).toBe(5);
    expect(agentInput.props.instrumentQuota?.viewModel.recoveryCreditSummary).toEqual({
      availableCount: 1,
      nextExpiresAtMs: 9_999_999_999_999,
      providerCreditId: 'reset-credit-1',
    });
    expect(agentInput.props.instrumentQuota?.onRecoveryCreditPress).toEqual(expect.any(Function));

    await act(async () => {
      await agentInput.props.instrumentQuota.onRecoveryCreditPress();
    });

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 2000,
    });
  });

  it('suppresses stale provider-account reset credits when the same connected-service snapshot has none', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    (featureEnabledState as Record<string, boolean>)['sessions.usageLimitRecovery'] = true;
    const recordKey = {
      providerId: 'codex',
      accountSubjectId: 'acct_native',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: [recordId],
        updatedAtMs: 2_000,
      },
    };
    storageState.sessions.s1.lastRuntimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 1_000,
      agentId: 'codex',
      usageLimit: {
        v: 1,
        resetAtMs: 8_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'manual',
        limitCategory: 'usage_limit',
        quotaSnapshotRef: {
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAtMs: 2_000,
        },
        effectiveMeterId: 'weekly',
        effectiveRemainingPct: 7,
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/work': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 2_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 93,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };
    providerAccountUsageSnapshotsState.current = {
      [recordId]: {
        v: 1,
        recordId,
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_native' },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
          availableCount: 1,
          credits: [{
            id: 'stale-reset-credit',
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: 9_999_999_999_999,
          }],
        },
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 50,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const usageLimitBanner = findWarningActionBannerProps('session-usageLimit-recovery');

    expect(findAgentInput(screen).props.instrumentQuota?.viewModel.recoveryCreditSummary ?? null).toBeNull();
    expect(findAgentInput(screen).props.instrumentQuota?.onRecoveryCreditPress).toBeUndefined();
    expect(usageLimitBanner?.body).not.toContain('usage reset');
    expect(usageLimitBanner?.secondaryActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ testID: 'session-usageLimit-recovery-consumeResetCredit' }),
    ]));
  });

  it('does not surface provider-account reset credits for connected-service-bound sessions without a source-backed quota view', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    const recordKey = {
      providerId: 'codex',
      accountSubjectId: 'acct_connected',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: [recordId],
        updatedAtMs: 2_000,
      },
    };
    connectedServiceQuotaSnapshotsState.current = {};
    providerAccountUsageSnapshotsState.current = {
      [recordId]: {
        v: 1,
        recordId,
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_connected' },
        observedAtMs: 2_000,
        fetchedAtMs: 2_000,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Plus',
        accountLabel: 'connected@example.com',
        recoveryCredits: {
          availableCount: 1,
          credits: [{
            id: 'reset-credit-1',
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: 9_999_999_999_999,
          }],
        },
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 41,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const agentInput = findAgentInput(screen);

    expect(useConnectedServiceQuotaSnapshotsSpy).toHaveBeenCalledWith([
      { serviceId: 'openai-codex', profileId: 'work' },
    ]);
    expect(agentInput.props.instrumentQuota).toBeNull();
  });

  it('passes native runtime quota evidence through to AgentInput without connected-service selection', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    storageState.sessions.s1.lastRuntimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 1_000,
      agentId: 'claude',
      usageLimit: {
        v: 1,
        resetAtMs: 3_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        limitCategory: 'usage_limit',
        effectiveMeterId: 'five_hour',
        effectiveRemainingPct: 12,
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(useConnectedServiceQuotaSnapshotsSpy).toHaveBeenCalledWith([]);
    expect(findAgentInput(screen).props.instrumentQuota?.viewModel).toEqual(expect.objectContaining({
      remainingPct: 12,
      ringValueLabel: '12',
    }));
  });

  it('passes canonical provider-account usage snapshots through to AgentInput without connected-service selection', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    const recordKey = {
      providerId: 'codex',
      accountSubjectId: 'acct_native',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: [recordId],
        updatedAtMs: 2_000,
      },
    };
    providerAccountUsageSnapshotsState.current = {
      [recordId]: {
        v: 1,
        recordId,
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_native' },
        observedAtMs: 2_000,
        fetchedAtMs: 2_000,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Plus',
        accountLabel: 'native@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 41,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(useConnectedServiceQuotaSnapshotsSpy).toHaveBeenCalledWith([]);
    expect(useProviderAccountUsageSnapshotsSpy).toHaveBeenCalledWith([recordId]);
    expect(findAgentInput(screen).props.instrumentQuota?.viewModel).toEqual(expect.objectContaining({
      remainingPct: 59,
      ringValueLabel: '59',
      activeAccountDisplayLabel: 'native@example.com',
    }));
  });

  it('ignores canonical provider-account usage snapshots from a different provider', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    const recordKey = {
      providerId: 'claude',
      accountSubjectId: 'acct_claude',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: [recordId],
        updatedAtMs: 2_000,
      },
    };
    providerAccountUsageSnapshotsState.current = {
      [recordId]: {
        v: 1,
        recordId,
        recordKey,
        providerId: 'claude',
        accountSubject: { kind: 'providerSubject', id: 'acct_claude' },
        observedAtMs: 2_000,
        fetchedAtMs: 2_000,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Max',
        accountLabel: 'claude@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 95,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'warning',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(useProviderAccountUsageSnapshotsSpy).toHaveBeenCalledWith([recordId]);
    expect(findAgentInput(screen).props.instrumentQuota).toBeNull();
  });

  it('uses the active group profile for provider usage when the binding stores only a group id', async () => {
    (featureEnabledState as Record<string, boolean>)['connectedServices.quotas'] = true;
    storageState.profile = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'active-profile', status: 'connected' },
          { profileId: 'backup-profile', status: 'connected' },
        ],
        groups: [{
          groupId: 'happier',
          activeProfileId: 'active-profile',
          memberProfileIds: ['active-profile', 'backup-profile'],
        }],
      }],
    };
    storageState.sessions.s1.metadata = {
      ...storageState.sessions.s1.metadata,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
        },
      },
    };
    connectedServiceQuotaSnapshotsState.current = {
      'openai-codex/active-profile': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active-profile',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 35,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(useConnectedServiceQuotaSnapshotsSpy).toHaveBeenCalledWith([
      { serviceId: 'openai-codex', profileId: 'active-profile' },
    ]);
    expect(findAgentInput(screen).props.instrumentQuota?.viewModel).toEqual(expect.objectContaining({
      remainingPct: 65,
      ringValueLabel: '65',
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
      clearPersistedManualRecipient: vi.fn(),
      executionRunDelivery: 'interrupt',
      setExecutionRunDelivery: vi.fn(),
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    const recipientChip = (agentInput.props.extraActionChips ?? []).find((chip: {
      key: string;
      controlId?: string;
      collapsedOptionsPopover?: {
        presentation?: 'picker' | 'list';
        rootStep?: { sections: ReadonlyArray<{ kind: 'static' | 'dynamic'; options?: ReadonlyArray<{ id: string }> }> };
        selectedOptionId?: string | null;
        onSelect?: (id: string) => void;
      };
    }) => chip.key === 'participants-recipient');

    expect(recipientChip).toEqual(expect.objectContaining({
      key: 'participants-recipient',
      controlId: 'recipient',
    }));
    expect(recipientChip?.collapsedOptionsPopover?.presentation).toBe('list');
    const recipientFirstSection = recipientChip?.collapsedOptionsPopover?.rootStep?.sections?.[0];
    const recipientOptions = recipientFirstSection?.kind === 'static'
      ? recipientFirstSection.options ?? []
      : [];
    expect(recipientOptions.map((option: { id: string }) => option.id)).toEqual([
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
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

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
      expectDirectSendProjectionOptions(),
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
      clearPersistedManualRecipient: vi.fn(),
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
      clearPersistedManualRecipient: vi.fn(),
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
        presentation?: 'picker' | 'list';
        rootStep?: { sections: ReadonlyArray<{ kind: 'static' | 'dynamic'; options?: ReadonlyArray<{ id: string }> }> };
        selectedOptionId?: string | null;
        onSelect?: (id: string) => void;
      };
    }) => chip.key === 'execution-run-delivery');

    expect(deliveryChip).toEqual(expect.objectContaining({
      key: 'execution-run-delivery',
      controlId: 'delivery',
    }));
    expect(deliveryChip?.collapsedOptionsPopover?.label).toBe('runs.delivery.cardDelivery');
    expect(deliveryChip?.collapsedOptionsPopover?.presentation).toBe('list');
    const deliveryFirstSection = deliveryChip?.collapsedOptionsPopover?.rootStep?.sections?.[0];
    const deliveryOptions = deliveryFirstSection?.kind === 'static'
      ? deliveryFirstSection.options ?? []
      : [];
    expect(deliveryOptions.map((option: { id: string }) => option.id)).toEqual([
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
      badges: ['sessionsList.storageExternalFilter', 'agentInput.agent.codex · happy-host'],
    }));
  });

  it('consumes pushed external-Agent status without recurring status or transcript refreshes', async () => {
    (storageState.sessions.s1 as any).metadata.externalAgentObservationV1 = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
        source: {
          kind: 'codex.home',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      status: 'working',
      observedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    await renderSessionViewAndSettle();

    expect(chatHeaderPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      isConnected: false,
    }));
    const latestHeaderProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
    const externalStatus = React.Children.toArray(latestHeaderProps?.rightElement?.props?.children)
      .find((child: any) => child?.props?.testID === 'session-header-external-agent-status-working') as any;
    expect(externalStatus?.props?.accessibilityLabel).toBe('status.workingExternally');
    expect(chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter)
      .toEqual(expect.objectContaining({
        statusKnown: false,
        externalAgentPresentation: {
          state: 'working',
          labelKey: 'status.workingExternally',
          agentLabel: 'Codex',
          machineLabel: 'happy-host',
        },
      }));
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(syncRefreshSessionMessagesSpy).not.toHaveBeenCalled();

    await act(async () => {
      await sleep(75);
    });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(syncRefreshSessionMessagesSpy).not.toHaveBeenCalled();
  });

  it('locally expires pushed external-Agent footer status without a status RPC', async () => {
    await import('./SessionView');
    (storageState.sessions.s1 as any).metadata.externalAgentObservationV1 = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
        source: {
          kind: 'codex.home',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      status: 'waiting',
      observedAtMs: Date.now(),
      expiresAtMs: Date.now() + 500,
    };

    await renderSessionViewAndSettle();

    expect(chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter)
      .toEqual(expect.objectContaining({
        externalAgentPresentation: expect.objectContaining({
          state: 'waiting',
          labelKey: 'status.needsInputExternally',
        }),
      }));
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    await act(async () => {
      await sleep(550);
    });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter)
      .toEqual(expect.objectContaining({
        externalAgentPresentation: expect.objectContaining({
          state: 'unknown',
          labelKey: 'status.externalStatusUnknown',
        }),
      }));
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
  });

  it('does not present managed-runtime status for malformed external-link metadata', async () => {
    (storageState.sessions.s1 as any).metadata.externalSessionV1 = { v: 1 };
    (storageState.sessions.s1 as any).metadata.externalAgentObservationV1 = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: { pluginId: 'happier.codex', localId: 'codex' },
        source: { kind: 'codex.home', contractVersion: 1 },
      },
      linkGeneration: 'link-generation-1',
      status: 'working',
      observedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    await renderSessionViewAndSettle();

    const latestHeaderProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
    const externalStatus = React.Children.toArray(latestHeaderProps?.rightElement?.props?.children)
      .find((child: any) => child?.props?.testID?.startsWith('session-header-external-agent-status-'));
    expect(externalStatus).toBeUndefined();
  });

  it('presents an expired pushed external-Agent observation as honest unknown', async () => {
    (storageState.sessions.s1 as any).metadata.externalAgentObservationV1 = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
        source: {
          kind: 'codex.home',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      status: 'working',
      observedAtMs: Date.now() - 10_000,
      expiresAtMs: Date.now() - 1,
    };

    await renderSessionViewAndSettle();

    const latestHeaderProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
    const externalStatus = React.Children.toArray(latestHeaderProps?.rightElement?.props?.children)
      .find((child: any) => child?.props?.testID === 'session-header-external-agent-status-unknown') as any;
    expect(externalStatus?.props?.accessibilityLabel).toBe('status.externalStatusUnknown');
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
  });

  it('prompts for takeover on send and submits after taking over the direct session', async () => {
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });
    writeSessionDraftValue(null, 's1', 'routing.recipient', { kind: 'execution_run', runId: 'run-1' });
    writeSessionDraftValue(null, 's1', 'routing.executionRunDelivery', 'interrupt');
    flushSessionDraftValues(null);
    const screen = await renderSessionView();
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue this session');
      agentInput.props.onStructuredInputMentionsChange?.([{
        kind: 'skill',
        tokenText: 'continue',
        start: 0,
        end: 8,
        name: 'continue',
      }]);
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
    }, { serverId: 'server-canonical' });
    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      's1',
      'continue this session',
      undefined,
      undefined,
      expectDirectSendProjectionOptions(),
    );
    expect(readSessionDraftValue(null, 's1', 'routing.recipient')).toBeUndefined();
    expect(readSessionDraftValue(null, 's1', 'routing.executionRunDelivery')).toBeUndefined();
    expect(readSessionDraftValue(null, 's1', 'structuredInput.mentions')).toBeUndefined();

  });

  it('keeps the composer text when direct takeover is cancelled from the send prompt', async () => {
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null, forceStop: false });
    writeSessionDraftValue(null, 's1', 'routing.recipient', { kind: 'execution_run', runId: 'run-1' });
    writeSessionDraftValue(null, 's1', 'routing.executionRunDelivery', 'interrupt');
    flushSessionDraftValues(null);
    const screen = await renderSessionView();

    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('draft stays here');
      agentInput.props.onStructuredInputMentionsChange?.([{
        kind: 'skill',
        tokenText: 'draft',
        start: 0,
        end: 5,
        name: 'draft',
      }]);
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('draft stays here');
    expect(readSessionDraftValue(null, 's1', 'routing.recipient')).toEqual({ kind: 'execution_run', runId: 'run-1' });
    expect(readSessionDraftValue(null, 's1', 'routing.executionRunDelivery')).toBe('interrupt');
    expect(readSessionDraftValue(null, 's1', 'structuredInput.mentions')).toEqual([{
      kind: 'skill',
      tokenText: 'draft',
      start: 0,
      end: 5,
      name: 'draft',
    }]);

  });

  it('does not restore old semantic choices over a newer draft after direct handoff failure', async () => {
    const oldRecipient = { kind: 'execution_run' as const, runId: 'run-old' };
    const newRecipient = { kind: 'execution_run' as const, runId: 'run-new' };
    const oldMention = {
      kind: 'skill' as const,
      tokenText: '$old',
      start: 8,
      end: 12,
      name: 'old',
    };
    const newMention = {
      kind: 'skill' as const,
      tokenText: '$new',
      start: 8,
      end: 12,
      name: 'new',
    };
    let rejectSubmit!: (error: Error) => void;

    clearSessionDraftValuesForSession(null, 's1', { reason: 'sessionDelete' });
    writeSessionDraftValue(null, 's1', 'routing.recipient', oldRecipient);
    writeSessionDraftValue(null, 's1', 'routing.executionRunDelivery', 'interrupt');
    writeSessionDraftValue(null, 's1', 'structuredInput.mentions', [oldMention]);
    flushSessionDraftValues(null);

    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
      return new Promise<void>((_resolve, reject) => {
        rejectSubmit = reject;
      });
    });
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    try {
      const screen = await renderSessionView();
      let agentInput = findAgentInput(screen);
      await act(async () => {
        agentInput.props.onChangeText('send to old target');
      });

      let sendPromise: Promise<void> | undefined;
      await act(async () => {
        sendPromise = agentInput.props.onSend();
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(readSessionDraftValue(null, 's1', 'routing.recipient')).toBeUndefined();
      expect(readSessionDraftValue(null, 's1', 'routing.executionRunDelivery')).toBeUndefined();
      expect(readSessionDraftValue(null, 's1', 'structuredInput.mentions')).toBeUndefined();

      writeSessionDraftValue(null, 's1', 'routing.recipient', newRecipient);
      writeSessionDraftValue(null, 's1', 'routing.executionRunDelivery', 'prompt');
      writeSessionDraftValue(null, 's1', 'structuredInput.mentions', [newMention]);

      await act(async () => {
        rejectSubmit(new Error('direct send rejected'));
        await sendPromise;
      });
      await settleExternalSessionView();

      agentInput = findAgentInput(screen);
      expect(agentInput.props.value).toBe('');
      expect(readSessionDraftValue(null, 's1', 'routing.recipient')).toEqual(newRecipient);
      expect(readSessionDraftValue(null, 's1', 'routing.executionRunDelivery')).toBe('prompt');
      expect(readSessionDraftValue(null, 's1', 'structuredInput.mentions')).toEqual([newMention]);
      expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'direct send rejected');
    } finally {
      clearSessionDraftValuesForSession(null, 's1', { reason: 'sessionDelete' });
      flushSessionDraftValues(null);
      resetSessionDraftValueCachesForTests();
    }
  });

  it('keeps the composer text while a direct takeover send prompt is still pending', async () => {
    showExternalSessionTakeoverDialogSpy.mockImplementationOnce(
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
    expect(agentInput.props.value).toBe('clear me immediately');
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

  });

  it('uses canonical public intent when persisting takeover from the send prompt', async () => {
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'persisted', forceStop: true });
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      activity: 'running',
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: true,
      trustedPid: 123,
    });
    (storageState.sessions.s1 as any).metadata.externalSessionV1 = {
      ...(storageState.sessions.s1 as any).metadata.externalSessionV1,
      linkedAtMs: 1_000,
      qualifiedIdentity: {
        v: 1,
        agent: { pluginId: 'happier.codex', localId: 'codex' },
        source: { kind: 'codexHome', contractVersion: 1 },
      },
    };
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('persist this');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    expect(machineExternalSessionTakeoverPersistSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      request: {
        v: 1,
        idempotencyKey: expect.any(String),
        sessionId: 's1',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          qualifiedIdentity: {
            v: 1,
            agent: { pluginId: 'happier.codex', localId: 'codex' },
            source: { kind: 'codexHome', contractVersion: 1 },
          },
          linkGeneration: '1000',
        },
        plan: 'takeover',
        targetStorageMode: 'persisted',
        targetRuntimeMode: 'terminal',
      },
    }, { serverId: 'server-canonical' });
    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      's1',
      'persist this',
      undefined,
      undefined,
      expectDirectSendProjectionOptions(),
    );

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
    expect(lastChatListProps?.externalControlFooter ?? null).toBeNull();
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
