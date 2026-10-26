import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { SessionArmedAgentContinuation } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  buildSystemSessionMetadataV1,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  SESSION_RUNNER_RUNTIME_STATE_FIELD_ID,
  SessionAgentTransitionRequestV1Schema,
  SessionContinuationInspectionBatchRequestV1Schema,
  type ActionOperationSnapshotV1,
  type ProviderAccountUsageSnapshotV1,
  type SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';
import type { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import type { RestartStaleSessionRunnerResult } from '@/sync/ops/sessionRunnerRestart';

import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createActionOperationFixture } from '@/dev/testkit/fixtures/actionOperationFixtures';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { listOpenApprovalArtifactsForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { sessionRunnerRuntimeStatusRetention } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const TEST_SERVER_ACCOUNT_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;
const TEST_SESSION_DRAFT_ADDRESS = { kind: 'session' as const, sessionId: 's1' };
let operationAccountScope: { serverId: string; accountId: string } = TEST_SERVER_ACCOUNT_SCOPE;

const machineDirectSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineDirectSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const actionOperationRpcSpy = vi.hoisted(() => vi.fn());
const usageLimitSessionRpcSpy = vi.hoisted(() => vi.fn());
let operationAccountId = '';
let operationTestIndex = 0;
const syncRefreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const syncRefreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const syncSubmitMessageSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const resumeSessionSpy = vi.hoisted(() => vi.fn(async (_options: unknown) => ({ type: 'success' as const, sessionId: 's1' })));
const sessionUsageLimitWaitResumeEnableSpy = vi.hoisted(() =>
  vi.fn<
    (
      _sessionId: string,
      _request?: unknown,
      _opts?: unknown,
    ) => Promise<{
      ok: true;
    } | {
      ok: false;
      error: string;
      errorCode?: string;
    }>
  >(async (_sessionId: string, _request?: unknown, _opts?: unknown) => ({ ok: true })),
);
const sessionUsageLimitWaitResumeCancelSpy = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _opts?: unknown) => ({ ok: true })),
);
const sessionUsageLimitCheckNowSpy = vi.hoisted(() =>
  vi.fn<typeof import('@/sync/ops/sessionUsageLimitRecovery').sessionUsageLimitCheckNow>(async () => ({ ok: true })),
);
const sessionUsageLimitSwitchAccountNowSpy = vi.hoisted(() =>
  vi.fn<typeof import('@/sync/ops/sessionUsageLimitRecovery').sessionUsageLimitSwitchAccountNow>(async () => ({ ok: true })),
);
const sessionUsageLimitConsumeResetCreditSpy = vi.hoisted(() =>
  vi.fn<
    (
      _sessionId: string,
      _opts?: unknown,
    ) => Promise<{
      ok: true;
      status?: 'ready' | 'waiting' | 'resumed' | 'exhausted' | 'inactive';
    } | {
      ok: false;
      error: string;
      errorCode?: string;
    }>
  >(async (_sessionId: string, _opts?: unknown) => ({ ok: true })),
);
const connectedServiceQuotaRecoveryCreditConsumeSpy = vi.hoisted(() =>
  vi.fn<
    (...args: Parameters<typeof connectedServiceQuotaRecoveryCreditConsume>) => ReturnType<typeof connectedServiceQuotaRecoveryCreditConsume>
  >(async () => ({ ok: false, errorCode: 'no_recovery_credit_available', error: 'no_recovery_credit_available' })),
);
const restartStaleSessionRunnerSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<RestartStaleSessionRunnerResult>>(
    async (_request: unknown) => ({ ok: true, status: 'restarted', sessionId: 's1' }),
  ),
);
const restartSessionRunnerForConfigurationSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<RestartStaleSessionRunnerResult>>(
    async (_request: unknown) => ({ ok: true, status: 'restarted', sessionId: 's1' }),
  ),
);
const getSessionRunnerRuntimeStatusSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<unknown>>(async () => null),
);
const setUsageLimitRecoverySettingsSpy = vi.hoisted(() => vi.fn());
const deleteSessionReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const clearSessionReviewCommentDraftsSpy = vi.hoisted(() => vi.fn());
const deleteWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const clearWorkspaceReviewCommentDraftsSpy = vi.hoisted(() => vi.fn());
const setWorkspaceReviewCommentDraftIncludedSpy = vi.hoisted(() => vi.fn());
const publishSessionAcpSessionModeOverrideToMetadataSpy = vi.hoisted(() => vi.fn(async () => {}));
const publishSessionAcpConfigOptionOverrideToMetadataSpy = vi.hoisted(() => vi.fn(async () => {}));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => false));
const routerPushSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const transcriptIdsState = vi.hoisted(() => ({ ids: ['m1'] as string[] }));
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const chatHeaderHarnessState = vi.hoisted(() => ({ renderRightElement: false }));
const voiceSurfacePropsSpy = vi.hoisted(() => vi.fn());
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const sendVoiceSessionComposerTextSpy = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => Promise<
      { ok: true }
      | { ok: false; reason: 'not_voice_session' | 'adapter_unavailable' | 'send_failed' | 'terminal_rejected'; message?: string }
    >
  >(async (_params: unknown) => ({ ok: false as const, reason: 'not_voice_session' as const })),
);
const resolveVoiceSessionComposerRoutingSpy = vi.hoisted(() => vi.fn((_params: any): any => null));
const featureEnabledState = vi.hoisted(() => ({
  voice: false,
  'files.reviewComments': false,
  'sessions.usageLimitRecovery': false,
  'connectedServices.quotas': false,
  'connectedServices.poolQuotaLimitSelection': false,
}));
const keyboardAvoidanceState = vi.hoisted(() => ({
  availablePanelHeight: undefined as number | undefined,
  keyboardHeight: 0,
}));
const settingsState = vi.hoisted(() => ({ current: {} as any }));
const settingByKeyState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const participantTargetsState = vi.hoisted(() => ({ current: [] as any[] }));
const reviewCommentDraftsState = vi.hoisted(() => ({ current: [] as any[] }));
const sessionMessagesState = vi.hoisted(() => ({ current: [] as any[] }));
const quotaSnapshotsState = vi.hoisted(() => ({
  current: {} as Record<string, any>,
  requestedProfiles: [] as ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>,
}));
const connectedServiceAuthGroupsState = vi.hoisted(() => ({
  groups: [] as any[],
  requestedServiceIds: [] as string[],
}));
const providerAccountUsageSnapshotsState = vi.hoisted(() => ({
  current: {} as Record<string, ProviderAccountUsageSnapshotV1 | null>,
  requestedRecordIds: [] as readonly string[],
}));
const storageState = vi.hoisted(() => ({
  sessions: {
    s1: {
      id: 's1',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'online',
      active: true,
      pendingVersion: 2,
      agentStateVersion: 1,
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
  artifacts: {} as Record<string, any>,
  profile: {
    connectedServicesV2: [],
  } as any,
  profileScope: null as { serverId: string; accountId: string } | null,
  settings: {} as Record<string, unknown>,
  sessionListViewDataByServerId: {} as Record<string, unknown>,
  sessionPending: {} as Record<string, any>,
  sessionMessages: {} as Record<string, any>,
  // The reactive store publishes immutable slices back into this legacy fixture;
  // render/update helpers publish fixture edits before exercising the real hooks.
  machines: {} as Record<string, any>,
  sessionListRenderables: {} as Record<string, any>,
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

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
    Heavy: 'heavy',
  },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
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
  featureEnabled: () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId as keyof typeof featureEnabledState] ?? false,
  }),
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
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
      translate: (key: string, params?: Record<string, unknown>) => {
        if (key === 'session.usageLimitRecovery.statusWaitingResetUntil') {
          const { time } = params as { time: string };
          return `${key}:${time}`;
        }
        return key;
      },
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args) => modalAlertSpy(...args));
    modalMock.spies.confirm.mockImplementation((...args) => modalConfirmSpy(...args));
    return modalMock.module;
  },
  storage: async (importOriginal) => {
    const { createStorageModuleMock, createReactiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');

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

    const store = createReactiveStorageStoreMock(storageState as any);
    // Legacy fixture handles must follow slices replaced by real store writers.
    store.subscribe((snapshot) => { Object.assign(storageState, snapshot); });
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        storage: store,
        getStorage: () => store,
        useSession: (sessionId: string) => (
          (storageState.sessions as Record<string, any>)[sessionId] ?? null
        ),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSessionMessages: () => ({ messages: sessionMessagesState.current, isLoaded: true }),
        useSessionTranscriptIds: () => ({ ids: transcriptIdsState.ids, isLoaded: true, hasRetainedContent: false }),
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
        useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useSessionReviewCommentsDrafts: () => reviewCommentDraftsState.current,
        useSessionUsage: () => null,
        useProfile: () => storageState.profile,
        useActiveServerAccountScope: () => operationAccountScope,
        useLocalSetting: readLocalSetting,
        useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [readLocalSetting(key), vi.fn<(value: LocalSettings[K]) => void>()],
        useSetting: readSetting,
        useSettingMutable: <K extends keyof Settings>(key: K) => [
          readSetting(key),
          key === 'usageLimitRecoverySettingsV1'
            ? setUsageLimitRecoverySettingsSpy
            : vi.fn<(value: Settings[K]) => void>(),
        ],
        useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {}, codexBackendMode: 'acp' }),
        useAutomations: () => [],
        useSessionAutomationsEnabledCount: () => 0,
        useArtifacts: () => Object.values(storageState.artifacts),
        useOpenApprovalArtifactsForSession: (sessionId: string) => listOpenApprovalArtifactsForSession(
          Object.values(storageState.artifacts),
          sessionId,
        ),
        useMachine: (machineId: string) => storageState.machines[machineId] ?? null,
      },
    });
  },
});

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

const authContextState = vi.hoisted(() => ({
  value: { credentials: { token: 't', secret: 's' } },
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => authContextState.value,
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots', () => ({
  useConnectedServiceQuotaSnapshots: (profiles: ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>) => {
    quotaSnapshotsState.requestedProfiles = profiles;
    return {
      snapshotsByKey: quotaSnapshotsState.current,
      loadingByKey: {},
    };
  },
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => ({
  listConnectedServiceAuthGroupsV3: async (_credentials: unknown, params: { serviceId: string }) => {
    connectedServiceAuthGroupsState.requestedServiceIds.push(params.serviceId);
    return connectedServiceAuthGroupsState.groups;
  },
}));

vi.mock('@/hooks/server/connectedServices/useProviderAccountUsageSnapshots', () => ({
  useProviderAccountUsageSnapshots: (recordIds: readonly string[]) => {
    providerAccountUsageSnapshotsState.requestedRecordIds = recordIds;
    return providerAccountUsageSnapshotsState.current;
  },
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
    return chatHeaderHarnessState.renderRightElement ? props.rightElement ?? null : null;
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
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://server.example', generation: 1 }),
  subscribeActiveServer: (listener: (active: any) => void) => {
    listener({ serverId: 'server-1' });
    return () => {};
  },
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/sync/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/sync')>();
  return {
    sync: {
      markSessionViewed: async () => {},
      fetchPendingMessages: async () => {},
      publishSessionPermissionModeToMetadata: async () => {},
      publishNextPromptPermissionModeAfterAdmission: actual.sync.publishNextPromptPermissionModeAfterAdmission.bind(actual.sync),
      publishSessionAcpSessionModeOverrideToMetadata: publishSessionAcpSessionModeOverrideToMetadataSpy,
      publishSessionAcpConfigOptionOverrideToMetadata: publishSessionAcpConfigOptionOverrideToMetadataSpy,
      publishSessionModelOverrideToMetadata: async () => {},
      materializeExistingSessionDraft: async () => {},
      ensureSessionVisibleForMessageRoute: async () => ({ kind: 'available' }),
      refreshSessions: syncRefreshSessionsSpy,
      refreshSessionMessages: syncRefreshSessionMessagesSpy,
      refreshSessionForSubmit: async (sessionId: string) =>
        storageState.sessions[sessionId as keyof typeof storageState.sessions] ?? null,
      onSessionVisible: () => {},
      markSessionLiveTailIntent: () => {},
      sendMessage: syncSubmitMessageSpy,
      enqueuePendingMessage: async () => {},
      submitMessage: syncSubmitMessageSpy,
      encryption: { getMachineEncryption: () => null },
      onSessionViewportChange: () => {},
    },
  };
});
vi.mock('@/sync/ops', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sessionAbort: vi.fn(),
    resumeSession: resumeSessionSpy,
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
  };
});
vi.mock('@/sync/ops/machineDirectSessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/ops/machineDirectSessions')>(),
  machineDirectSessionStatusGet: machineDirectSessionStatusGetSpy,
  machineDirectSessionTakeover: machineDirectSessionTakeoverSpy,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: actionOperationRpcSpy,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: usageLimitSessionRpcSpy,
}));
vi.mock('@/sync/ops/sessionUsageLimitRecovery', () => ({
  sessionUsageLimitWaitResumeEnable: (sessionId: string, request?: unknown, opts?: unknown) =>
    sessionUsageLimitWaitResumeEnableSpy(sessionId, request, opts),
  sessionUsageLimitWaitResumeCancel: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitWaitResumeCancelSpy(sessionId, opts),
  sessionUsageLimitCheckNow: (sessionId: string, opts?: Parameters<typeof import('@/sync/ops/sessionUsageLimitRecovery').sessionUsageLimitCheckNow>[1]) =>
    sessionUsageLimitCheckNowSpy(sessionId, opts),
  sessionUsageLimitSwitchAccountNow: (sessionId: string, opts?: Parameters<typeof import('@/sync/ops/sessionUsageLimitRecovery').sessionUsageLimitSwitchAccountNow>[1]) =>
    sessionUsageLimitSwitchAccountNowSpy(sessionId, opts),
  sessionUsageLimitConsumeResetCredit: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitConsumeResetCreditSpy(sessionId, opts),
}));
vi.mock('@/sync/ops/sessionRunnerRestart', () => ({
  getSessionRunnerRuntimeStatus: (request: unknown) => getSessionRunnerRuntimeStatusSpy(request),
  restartSessionRunnerForConfigurationWithObserve: (request: unknown) => restartSessionRunnerForConfigurationSpy(request),
  restartStaleSessionRunnerWithObserve: (request: unknown) => restartStaleSessionRunnerSpy(request),
}));
vi.mock('@/sync/ops/connectedServiceQuotaRecoveryCredits', () => ({
  connectedServiceQuotaRecoveryCreditConsume: connectedServiceQuotaRecoveryCreditConsumeSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', { testID: 'session-agent-input', ...props }),
}));
vi.mock('@/components/sessions/keyboardAvoidance', () => ({
  useComposerAvailablePanelHeight: () => keyboardAvoidanceState.availablePanelHeight,
  useComposerKeyboardLayoutContext: () => ({
    getKeyboardHeight: () => keyboardAvoidanceState.keyboardHeight,
    subscribeKeyboardHeight: (listener: (height: number) => void) => {
      listener(keyboardAvoidanceState.keyboardHeight);
      return () => {};
    },
  }),
}));
vi.mock('@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog', () => ({
  showDirectSessionTakeoverDialog: showDirectSessionTakeoverDialogSpy,
}));
vi.mock('@/voice/sessionBinding/sendVoiceSessionComposerText', () => ({
  sendVoiceSessionComposerText: (params: any) => sendVoiceSessionComposerTextSpy(params),
}));
vi.mock('@/voice/sessionBinding/voiceSessionComposerRouting', () => ({
  resolveVoiceSessionComposerRouting: (params: any) => resolveVoiceSessionComposerRoutingSpy(params),
}));
vi.mock('@/components/sessions/agentInput/routing/useSessionRecipientState', () => ({
  useSessionRecipientState: () => recipientStateState.current,
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
  useSessionSubagents: () => ({
    // SessionView now consumes the canonical subagent roster and derives recipient targets itself.
    // Keep this fixture at that owner boundary instead of injecting the removed derived output.
    subagents: participantTargetsState.current.map((target) => ({
      id: target.key,
      kind: target.recipient.kind === 'agent_team_member' ? 'agent_team_member' : 'execution_run',
      status: 'running',
      recipient: target.recipient,
      transcript: {},
      capabilities: {
        canOpen: false,
        canSend: true,
        canStop: false,
        canLaunchChild: false,
        canDelete: false,
        canOpenAdvancedRun: false,
      },
      timestamps: {},
      display: {
        title: target.displayLabel,
        ...(target.accentName ? { accentName: target.accentName } : {}),
      },
    })),
    participantTargets: [],
    sidechainIds: [],
  }),
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
  };
});

// Configure native/transport fixtures before importing modules that read storage.
const { createDeferred, createPendingMessageFixture, pressTestInstanceAsync, renderScreen, resetBrowserSessionDraftPersistenceForTest, standardCleanup } = await import('@/dev/testkit');
const { existingSessionDraftSemanticValues } = await import('@/sync/domains/input/drafts/existingSessionDraftSemanticValues');
const { deleteSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { __resetConnectedServiceQuotaSnapshotStore } = await import('@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore');
const { SessionView } = await import('./SessionView');

describe('SessionView (direct sessions)', () => {
  describe('persisted Agent continuation custody', () => {
    let transitionResult: 'accepted' | 'outcome_unknown';
    const currentAgentRow: AgentInputChipPickerOption = {
      id: 'engine:current', label: 'Current Agent', renderDetailContent: () => null,
    };

    function readArm(): SessionArmedAgentContinuation | undefined {
      return existingSessionDraftSemanticValues.read(
        { ...TEST_SERVER_ACCOUNT_SCOPE, accountId: operationAccountId }, 's1', 'routing.agentContinuation',
      );
    }

    function readOptions(screen: Awaited<ReturnType<typeof renderSessionView>>): AgentInputChipPickerOption[] {
      return findAgentInput(screen).props.composeAgentPickerOptions([currentAgentRow]);
    }

    async function selectAgent(screen: Awaited<ReturnType<typeof renderSessionView>>, agentId: string) {
      await act(async () => { findAgentInput(screen).props.onAgentPickerIntent(); });
      await settleDirectSessionView();
      const option = readOptions(screen).find((row) => row.id === `agent:${agentId}`);
      if (!option?.onSelectImmediate) throw new Error(`Agent option ${agentId} is unavailable`);
      const select = option.onSelectImmediate;
      await act(async () => { select(); });
      expect(readArm()?.intent.selection.agentId).toBe(agentId);
    }

    async function submitSwitch(screen: Awaited<ReturnType<typeof renderSessionView>>) {
      await selectAgent(screen, 'claude');
      await act(async () => { findAgentInput(screen).props.onChangeText('switch and send this'); });
      const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
      expect(getActiveServerAccountScope()).toEqual(operationAccountScope);
      expect(findAgentInput(screen).props.value).toBe('switch and send this');
      await act(async () => { await findAgentInput(screen).props.onSend(); });
      await settleDirectSessionView();
      const dispatch = actionOperationRpcSpy.mock.calls.find(([params]) => (
        params.method === RPC_METHODS.SESSION_AGENT_TRANSITION
      ));
      expect(dispatch).toBeDefined();
      return SessionAgentTransitionRequestV1Schema.parse(dispatch?.[0].payload).input.localId;
    }

    async function publishCustody(localId: string) {
      const { storage } = await import('@/sync/domains/state/storage');
      await act(async () => {
        storageState.sessionPending.s1 = {
          messages: [createPendingMessageFixture({
            localId, text: 'switch and send this', source: 'server_pending',
            messageRole: 'user', pendingDeliveryStatus: 'server_queued',
            requestedAction: { v: 1, kind: 'enqueue' },
          })],
          discarded: [], isLoaded: true,
        };
        storage.setState({ sessionPending: { ...storageState.sessionPending } });
      });
      await settleDirectSessionView();
    }

    beforeEach(async () => {
      transitionResult = 'accepted';
      const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
      resetServerFeaturesClientForTests();
      const features = buildServerFeaturesResponse();
      features.features.sessions.enabled = true;
      features.features.sessions.agentSwitching.enabled = true;
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({ settings: {
        ...settingsDefaults, experiments: true,
        featureToggles: { sessions: true, 'sessions.agentSwitching': true },
      } });
      const { directSessionV1: _direct, ...metadata } = storageState.sessions.s1.metadata;
      storageState.sessions.s1 = { ...storageState.sessions.s1, metadata };
      storageState.machines['machine-1'] = {
        id: 'machine-1', active: true, activeAt: Date.now(), daemonStateVersion: 1,
        metadata: { host: 'happy-host', homeDir: '/tmp', platform: 'darwin' },
      };
      actionOperationRpcSpy.mockImplementation(async (params: { method: string; payload: unknown }) => {
        if (params.method === RPC_METHODS.CAPABILITIES_DETECT) {
          return { protocolVersion: 1, results: {
            'tool.sessionAgentTransition': { ok: true, checkedAt: 1,
              data: { supportsInputPermissionIntent: true } },
          } };
        }
        if (params.method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH) {
          const request = SessionContinuationInspectionBatchRequestV1Schema.parse(params.payload);
          return { v: 1, inspections: request.selections.map(() => ({
            type: 'available', protocolVersion: 1, sameSessionTransition: true,
          })) };
        }
        if (params.method === RPC_METHODS.SESSION_AGENT_TRANSITION) {
          const request = SessionAgentTransitionRequestV1Schema.parse(params.payload);
          return { type: transitionResult, localId: request.input.localId };
        }
        return { items: [], nextCursor: null };
      });
      await getServerFeaturesSnapshot({ serverId: 'server-1', force: true });
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
      resetServerFeaturesClientForTests();
    });

    it('removes the accepted submission from the draft and offers Agents again after remount', async () => {
      const first = await renderSessionViewAndSettle();
      await submitSwitch(first);
      expect(readArm()).toBeUndefined();
      expect(findAgentInput(first).props.value).toBe('');
      expect(getSessionDraftSnapshot(operationAccountScope, TEST_SESSION_DRAFT_ADDRESS)?.document.composer.text.value ?? '').toBe('');
      storageState.sessions.s1.metadata = { ...storageState.sessions.s1.metadata, flavor: 'claude' };
      await act(async () => { first.tree.unmount(); });

      const second = await renderSessionViewAndSettle();
      await act(async () => { findAgentInput(second).props.onAgentPickerIntent(); });
      await settleDirectSessionView();
      expect(readArm()).toBeUndefined();
      expect(readOptions(second).map((row) => row.id)).toContain('agent:codex');
      await selectAgent(second, 'codex');
    });

    it('retains unknown submission identity across remount, then spends delayed custody without clearing newer text', async () => {
      transitionResult = 'outcome_unknown';
      const first = await renderSessionViewAndSettle();
      const localId = await submitSwitch(first);
      expect(readArm()?.submission?.localId).toBe(localId);
      storageState.sessions.s1.metadata = { ...storageState.sessions.s1.metadata, flavor: 'claude' };
      await act(async () => { first.tree.unmount(); });

      const second = await renderSessionViewAndSettle();
      expect(readArm()?.submission?.localId).toBe(localId);
      expect(findAgentInput(second).props.value).toBe('switch and send this');
      expect(readOptions(second).map((row) => row.id)).not.toContain('agent:codex');
      await act(async () => { findAgentInput(second).props.onChangeText('a newer draft'); });
      await publishCustody(localId);

      expect(readArm()).toBeUndefined();
      expect(findAgentInput(second).props.value).toBe('a newer draft');
      await act(async () => { findAgentInput(second).props.onAgentPickerIntent(); });
      await settleDirectSessionView();
      expect(readOptions(second).map((row) => row.id)).toContain('agent:codex');
      await selectAgent(second, 'codex');
    });

    it('preserves a newer armed Agent and composer when the previous submission reaches custody', async () => {
      transitionResult = 'outcome_unknown';
      const screen = await renderSessionViewAndSettle();
      const previousLocalId = await submitSwitch(screen);
      await selectAgent(screen, 'gemini');
      await act(async () => { findAgentInput(screen).props.onChangeText('send this to Gemini'); });
      const newerArm = readArm();
      expect(newerArm?.submission).toBeUndefined();

      await publishCustody(previousLocalId);

      expect(readArm()).toEqual(newerArm);
      expect(findAgentInput(screen).props.agentPickerSelectedOptionId).toBe('agent:gemini');
      expect(findAgentInput(screen).props.value).toBe('send this to Gemini');
    });
  });

  async function publishStorageFixture() {
    const { storage } = await import('@/sync/domains/state/storage');
    // Bind after module setup: imperative scope guards and hooks share this store.
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(storage.getState);
    storage.setState({
      ...storageState,
      profileScope: operationAccountScope,
      settings: storage.getState().settings,
      sessionListViewDataByServerId: storage.getState().sessionListViewDataByServerId,
      sessions: { ...storageState.sessions },
      machines: { ...storageState.machines },
    });
  }

  async function renderSessionView(props: {
    sessionId?: string;
    routeServerId?: string;
    contentOverride?: React.ReactNode;
  } = {}) {
    const sessionId = props.sessionId ?? 's1';
    const routeServerId = props.routeServerId?.trim();
    const sessions = storageState.sessions as Record<string, any>;
    if (routeServerId && sessions[sessionId]) {
      sessions[sessionId] = {
        ...sessions[sessionId],
        serverId: routeServerId,
      };
    }
    await publishStorageFixture();
    return renderScreen(
      <AppPaneProvider>
        <SessionView
          id={sessionId}
          routeServerId={props.routeServerId}
          contentOverride={props.contentOverride}
        />
      </AppPaneProvider>,
    );
  }

  async function renderSessionViewAndSettle(props: {
    sessionId?: string;
    routeServerId?: string;
    contentOverride?: React.ReactNode;
  } = {}) {
    const screen = await renderSessionView(props);
    await settleDirectSessionView();
    return screen;
  }

  async function updateSessionView(
    screen: Awaited<ReturnType<typeof renderSessionView>>,
    props: { sessionId?: string; routeServerId?: string } = {},
  ) {
    const sessionId = props.sessionId ?? 's1';
    const routeServerId = props.routeServerId?.trim();
    const sessions = storageState.sessions as Record<string, any>;
    if (routeServerId && sessions[sessionId]) {
      sessions[sessionId] = {
        ...sessions[sessionId],
        serverId: routeServerId,
      };
    }
    await act(async () => {
      await publishStorageFixture();
      screen.tree.update(
        <AppPaneProvider>
          <SessionView id={sessionId} routeServerId={props.routeServerId} />
        </AppPaneProvider>,
      );
    });
  }

  async function updateSessionViewAndSettle(
    screen: Awaited<ReturnType<typeof renderSessionView>>,
    props: { sessionId?: string; routeServerId?: string } = {},
  ) {
    await updateSessionView(screen, props);
    await settleDirectSessionView();
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

  function findUsageLimitStatusBadge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'session-usage-limit-recovery');
  }

  function findStaleRunnerStatusBadge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'session-stale-runner');
  }

  function findMcpSelectionRestartStatusBadge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'session-mcp-selection-restart-required');
  }

  function installMcpSelectionRestartRequired() {
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host', homeDir: '/tmp' },
    } as any;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      metadata: {
        ...storageState.sessions.s1.metadata,
        hostPid: 123,
        mcpSelectionV1: {
          v: 1,
          managedServersEnabled: true,
          forceIncludeServerIds: ['server-new'],
          forceExcludeServerIds: [],
        },
        mcpSelectionRestartRequiredV1: {
          v: 1,
          appliedSelection: {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
          },
        },
      },
    };
  }

  function buildSessionRunnerRuntimeStatus(input: Readonly<{
    sessionId: string;
    machineId: string;
    versionState: 'current' | 'stale';
  }>): SessionRunnerRuntimeStateV1 {
    const current = input.versionState === 'current';
    return {
      v: 1,
      sessionId: input.sessionId,
      machineId: input.machineId,
      observedAtMs: current ? 2 : 1,
      runner: {
        pid: 123,
        runtimeId: current ? 'version:cli-new' : 'version:cli-old',
        processCommandHash: current ? 'hash-new' : 'hash-old',
        entrypointVersion: current ? 'cli-new' : 'cli-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        currentEntrypointVersion: 'version:cli-new',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: input.versionState,
      statusSource: 'daemon_tracking',
      plannedRestart: {
        supported: true,
        eligible: !current,
      },
    };
  }

  function installStaleSessionRunnerStatus() {
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host', homeDir: '/tmp' },
    } as any;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      metadata: {
        ...storageState.sessions.s1.metadata,
        [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: buildSessionRunnerRuntimeStatus({
          sessionId: 's1',
          machineId: 'machine-1',
          versionState: 'stale',
        }),
      },
    };
  }

  function installUnknownIdentityStaleSessionRunnerStatus() {
    installStaleSessionRunnerStatus();
    const metadata = storageState.sessions.s1.metadata as Record<string, any>;
    metadata[SESSION_RUNNER_RUNTIME_STATE_FIELD_ID] = {
      ...metadata[SESSION_RUNNER_RUNTIME_STATE_FIELD_ID],
      daemon: {
        currentEntrypointVersion: null,
        currentEntrypointSource: 'unknown',
      },
    };
  }

  function buildOpenAiCodexWorkQuotaSnapshot(params: Readonly<{
    fetchedAt: number;
    used: number;
    profileId?: string;
    accountLabel?: string;
    recoveryCredits?: unknown;
  }>) {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: params.profileId ?? 'work',
      fetchedAt: params.fetchedAt,
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: params.accountLabel ?? null,
      ...(typeof params.recoveryCredits !== 'undefined' ? { recoveryCredits: params.recoveryCredits } : {}),
      meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: params.used,
        limit: 100,
        unit: 'count',
        utilizationPct: null,
        remainingPct: null,
        resetsAt: null,
        status: 'ok',
        details: {},
      }],
    });
  }

  function buildProviderAccountUsageSnapshot(params: Readonly<{
    accountSubjectId?: string;
    accountLabel?: string;
    used: number;
    recoveryCredits?: unknown;
  }>): ProviderAccountUsageSnapshotV1 {
    const accountSubjectId = params.accountSubjectId ?? 'provider-account-1';
    const recordKey = {
      providerId: 'codex',
      accountSubjectId,
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    return ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: accountSubjectId },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      staleAfterMs: 60_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'Pro',
      accountLabel: params.accountLabel ?? 'Provider account',
      ...(typeof params.recoveryCredits !== 'undefined' ? { recoveryCredits: params.recoveryCredits } : {}),
      meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: params.used,
        limit: 100,
        unit: 'count',
        utilizationPct: null,
        remainingPct: null,
        resetsAt: null,
        status: 'ok',
        details: { limitCategory: 'usage_limit' },
      }],
    });
  }

  function installConnectedServiceWorkProfileRecoveryCreditSession() {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        connectedServices: {
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'exhausted',
          issueFingerprint: 'usage-limit:codex:unknown-turn:1:unknown-reset',
          armedAtMs: 1,
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 1,
          maxAttempts: 1,
          lastProbeError: null,
          selectedAuth: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
          },
          recoveryCredits: {
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [{ kind: 'usage_limit_reset', status: 'available' }],
          },
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'manual',
          quotaSnapshotRef: {
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAtMs: 1,
          },
        },
      },
    };
  }

  function expectDirectSendProjectionOptions() {
    return expect.objectContaining({
      localId: undefined,
      onLocalPendingProjectionCreated: expect.any(Function),
      profileId: undefined,
    });
  }

  beforeEach(async () => {
    await resetBrowserSessionDraftPersistenceForTest();
    __resetConnectedServiceQuotaSnapshotStore();
    sessionRunnerRuntimeStatusRetention.clear();
    chatListPropsSpy.mockReset();
    transcriptIdsState.ids = ['m1'];
    chatHeaderPropsSpy.mockReset();
    chatHeaderHarnessState.renderRightElement = false;
    voiceSurfacePropsSpy.mockReset();
    featureEnabledState.voice = false;
    featureEnabledState['files.reviewComments'] = false;
    featureEnabledState['sessions.usageLimitRecovery'] = false;
    featureEnabledState['connectedServices.quotas'] = false;
    featureEnabledState['connectedServices.poolQuotaLimitSelection'] = false;
    keyboardAvoidanceState.availablePanelHeight = undefined;
    keyboardAvoidanceState.keyboardHeight = 0;
    settingsState.current = {};
    settingByKeyState.current = {};
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    modalConfirmSpy.mockResolvedValue(false);
    routerPushSpy.mockReset();
    syncRefreshSessionMessagesSpy.mockReset();
    syncSubmitMessageSpy.mockReset();
    syncSubmitMessageSpy.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
    });
    resumeSessionSpy.mockReset();
    resumeSessionSpy.mockResolvedValue({ type: 'success', sessionId: 's1' });
    sessionUsageLimitWaitResumeEnableSpy.mockClear();
    sessionUsageLimitWaitResumeCancelSpy.mockClear();
    sessionUsageLimitCheckNowSpy.mockClear();
    sessionUsageLimitSwitchAccountNowSpy.mockClear();
    sessionUsageLimitConsumeResetCreditSpy.mockReset();
    sessionUsageLimitConsumeResetCreditSpy.mockResolvedValue({ ok: true });
    restartStaleSessionRunnerSpy.mockReset();
    restartStaleSessionRunnerSpy.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 's1' });
    restartSessionRunnerForConfigurationSpy.mockReset();
    restartSessionRunnerForConfigurationSpy.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 's1' });
    getSessionRunnerRuntimeStatusSpy.mockReset();
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue(null);
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockReset();
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({ ok: false, errorCode: 'no_recovery_credit_available', error: 'no_recovery_credit_available' });
    setUsageLimitRecoverySettingsSpy.mockClear();
    deleteSessionReviewCommentDraftSpy.mockReset();
    clearSessionReviewCommentDraftsSpy.mockReset();
    deleteWorkspaceReviewCommentDraftSpy.mockReset();
    clearWorkspaceReviewCommentDraftsSpy.mockReset();
    setWorkspaceReviewCommentDraftIncludedSpy.mockReset();
    machineDirectSessionTakeoverSpy.mockReset();
    operationAccountId = `shell-import-${++operationTestIndex}`;
    operationAccountScope = { ...TEST_SERVER_ACCOUNT_SCOPE, accountId: operationAccountId };
    actionOperationRpcSpy.mockReset();
    actionOperationRpcSpy.mockResolvedValue({ items: [], nextCursor: null });
    usageLimitSessionRpcSpy.mockReset();
    syncRefreshSessionsSpy.mockReset();
    machineDirectSessionStatusGetSpy.mockReset();
    showDirectSessionTakeoverDialogSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockReset();
    sendVoiceSessionComposerTextSpy.mockResolvedValue({ ok: false, reason: 'not_voice_session' });
    resolveVoiceSessionComposerRoutingSpy.mockReset();
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue(null);
    participantTargetsState.current = [];
    reviewCommentDraftsState.current = [];
    sessionMessagesState.current = [];
    quotaSnapshotsState.current = {};
    quotaSnapshotsState.requestedProfiles = [];
    connectedServiceAuthGroupsState.groups = [];
    connectedServiceAuthGroupsState.requestedServiceIds = [];
    providerAccountUsageSnapshotsState.current = {};
    providerAccountUsageSnapshotsState.requestedRecordIds = [];
    storageState.sessions.s1 = {
      id: 's1',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'online',
      active: true,
      pendingVersion: 2,
      agentStateVersion: 1,
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
      lastRuntimeIssue: null,
    };
    delete (storageState.sessions as Record<string, any>).s2;
    storageState.artifacts = {};
    storageState.profile = {
      connectedServicesV2: [],
    };
    storageState.settings = settingsState.current;
    storageState.sessionListViewDataByServerId = {};
    for (const key of Object.keys(storageState.sessionPending)) {
      delete storageState.sessionPending[key];
    }
    for (const key of Object.keys(storageState.sessionMessages)) {
      delete storageState.sessionMessages[key];
    }
    // Clear the stable container references in place (see hoisted storageState
    // notes) so per-test mutations remain visible through the storage snapshot.
    for (const key of Object.keys(storageState.sessionListRenderables)) {
      delete storageState.sessionListRenderables[key];
    }
    for (const key of Object.keys(storageState.machines)) {
      delete storageState.machines[key];
    }
    (storageState as any).deleteSessionReviewCommentDraft = deleteSessionReviewCommentDraftSpy;
    (storageState as any).clearSessionReviewCommentDrafts = clearSessionReviewCommentDraftsSpy;
    (storageState as any).deleteWorkspaceReviewCommentDraft = deleteWorkspaceReviewCommentDraftSpy;
    (storageState as any).clearWorkspaceReviewCommentDrafts = clearWorkspaceReviewCommentDraftsSpy;
    (storageState as any).setWorkspaceReviewCommentDraftIncluded = setWorkspaceReviewCommentDraftIncludedSpy;
    recipientStateState.current = {
	      recipient: null,
	      setManualRecipient: vi.fn(),
	      clearPersistedManualRecipient: vi.fn(),
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
    const { storage } = await import('@/sync/domains/state/storage');
    // These legacy send cases exercise immediate agent delivery, not the pending queue.
    storage.setState({ settings: { ...settingsDefaults, sessionMessageSendMode: 'agent_queue' }, sessionPending: storageState.sessionPending });
  });

  afterEach(() => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('surfaces generic usage-limit recovery actions and status for provider runtime issues', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const agentInput = findAgentInput(screen);
    const usageStatusBadge = agentInput.props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'session-usage-limit-recovery');

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(usageStatusBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      tone: 'warning',
    }));

    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-remember'));

    expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledTimes(1);
    // The session UI has no per-operation resume-prompt control, so the account
    // setting must NOT be sent as the explicit per-operation value: stored
    // intent and group policy would otherwise never win the precedence.
    expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledWith(
      's1',
      {
        issueFingerprint: 'usage-limit:opencode:unknown-turn:1:1779039000000',
        rememberPreference: true,
      },
      expect.objectContaining({ serverId: 'server-route-1' }),
    );
    expect(sessionUsageLimitCheckNowSpy).not.toHaveBeenCalled();
    expect(setUsageLimitRecoverySettingsSpy).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      mode: 'auto_wait',
      resumePromptMode: 'off',
    }));
  });

  it('reopens a session while usage-limit recovery is waiting for a known reset time', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'auto_wait', resumePromptMode: 'off' };
    const resetAtMs = Date.UTC(2026, 4, 17, 17, 30, 0);
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'waiting',
          issueFingerprint: `usage-limit:claude:unknown-turn:1:${resetAtMs}`,
          armedAtMs: 1,
          resetAtMs,
          nextCheckAtMs: resetAtMs,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          resumePromptMode: 'off',
          selectedAuth: { kind: 'native' },
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'claude',
        usageLimit: {
          v: 1,
          resetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({
      label: expect.stringContaining('session.usageLimitRecovery.statusWaitingResetUntil:'),
      testID: 'session-usageLimit-status-badge',
    }));
  });

  it('renders stale-runner composer notice and badge from canonical daemon status', async () => {
    installStaleSessionRunnerStatus();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const staleRunnerBadge = findStaleRunnerStatusBadge(screen);

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    expect(staleRunnerBadge).toEqual(expect.objectContaining({
      testID: 'session-staleRunner-status-badge',
      tone: 'warning',
    }));
  });

  it('renders the MCP restart notice and badge for an active-session selection change', async () => {
    installMcpSelectionRestartRequired();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(screen.findByTestId('session.mcpSelectionRestartRequired.banner')).toBeTruthy();
    expect(findMcpSelectionRestartStatusBadge(screen)).toEqual(expect.objectContaining({
      testID: 'session.mcpSelectionRestartRequired.badge',
      tone: 'warning',
    }));

  });

  it('restarts the active runner from the MCP selection banner', async () => {
    installMcpSelectionRestartRequired();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session.mcpSelectionRestartRequired.restart'));
    await settleDirectSessionView();

    expect(restartSessionRunnerForConfigurationSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'machine-1',
      serverId: 'server-route-1',
      expectedRunnerPid: 123,
    });
    expect(screen.findByTestId('session.mcpSelectionRestartRequired.banner')).toBeNull();
  });

  it('renders stale-runner composer notice from daemon status RPC for an inactive session when metadata is not seeded', async () => {
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host', homeDir: '/tmp' },
    } as any;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: false,
      metadata: {
        ...storageState.sessions.s1.metadata,
        machineId: 'machine-1',
      },
    };
    getSessionRunnerRuntimeStatusSpy.mockResolvedValueOnce({
      v: 1,
      sessionId: 's1',
      machineId: 'machine-1',
      observedAtMs: 1,
      runner: {
        pid: 123,
        runtimeId: 'version:cli-old',
        processCommandHash: 'hash-old',
        entrypointVersion: 'cli-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        currentEntrypointVersion: 'version:cli-new',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'stale',
      statusSource: 'daemon_tracking',
      plannedRestart: {
        supported: true,
        eligible: true,
      },
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await settleDirectSessionView();

    expect(getSessionRunnerRuntimeStatusSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'machine-1',
      serverId: 'server-route-1',
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'machine-1',
      serverId: 'server-route-1',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-old',
      expectedRunnerEntrypointIdentity: 'version:cli-old',
    });
  });

  it('retains validated stale-runner status across a full remount when refresh is unavailable without leaking identities', async () => {
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host-a', homeDir: '/tmp/a' },
    } as any;
    storageState.machines['machine-2'] = {
      id: 'machine-2',
      active: true,
      metadata: { host: 'happy-host-b', homeDir: '/tmp/b' },
    } as any;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: false,
      serverId: 'server-a',
      metadata: {
        ...storageState.sessions.s1.metadata,
        machineId: 'machine-1',
        host: 'happy-host-a',
        homeDir: '/tmp/a',
        path: '/tmp/a/project',
      },
    };
    (storageState.sessions as Record<string, any>).s2 = {
      ...storageState.sessions.s1,
      id: 's2',
      serverId: 'server-b',
      metadata: {
        ...storageState.sessions.s1.metadata,
        machineId: 'machine-2',
        host: 'happy-host-b',
        homeDir: '/tmp/b',
        path: '/tmp/b/project',
        directSessionV1: {
          ...storageState.sessions.s1.metadata.directSessionV1,
          machineId: 'machine-2',
          remoteSessionId: 'vendor-session-2',
        },
      },
    };

    const sessionBRefresh = createDeferred<unknown>();
    const returnedSessionARefresh = createDeferred<unknown>();
    let sessionARefreshCount = 0;
    getSessionRunnerRuntimeStatusSpy.mockImplementation(async (request: any) => {
      if (request.sessionId === 's2') {
        return sessionBRefresh.promise;
      }
      sessionARefreshCount += 1;
      if (sessionARefreshCount === 1) {
        return buildSessionRunnerRuntimeStatus({
          sessionId: 's1',
          machineId: 'machine-1',
          versionState: 'stale',
        });
      }
      return returnedSessionARefresh.promise;
    });

    const firstSessionAScreen = await renderSessionViewAndSettle({
      sessionId: 's1',
      routeServerId: 'server-a',
    });
    expect(firstSessionAScreen.findByTestId('session-staleRunner-version')).toBeTruthy();
    await firstSessionAScreen.unmount();

    const sessionBScreen = await renderSessionView({
      sessionId: 's2',
      routeServerId: 'server-b',
    });
    expect(sessionBScreen.findByTestId('session-staleRunner-version')).toBeNull();

    sessionBRefresh.resolve(null);
    await settleDirectSessionView();
    expect(sessionBScreen.findByTestId('session-staleRunner-version')).toBeNull();
    await sessionBScreen.unmount();

    const returnedSessionAScreen = await renderSessionView({
      sessionId: 's1',
      routeServerId: 'server-a',
    });
    expect(returnedSessionAScreen.findByTestId('session-staleRunner-version')).toBeTruthy();

    returnedSessionARefresh.resolve(null);
    await settleDirectSessionView();
    expect(returnedSessionAScreen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('does not render stale-runner composer notice when canonical identity is unknown', async () => {
    installUnknownIdentityStaleSessionRunnerStatus();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
    expect(findStaleRunnerStatusBadge(screen)).toBeUndefined();
  });

  it('lets the stale-runner status badge hide and show the composer notice', async () => {
    installStaleSessionRunnerStatus();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const staleRunnerBadge = findStaleRunnerStatusBadge(screen);

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();

    await act(async () => {
      staleRunnerBadge.onPress();
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();

    await act(async () => {
      staleRunnerBadge.onPress();
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('invokes the daemon-owned stale-runner restart operation with expected runner identity', async () => {
    installStaleSessionRunnerStatus();
    restartStaleSessionRunnerSpy.mockResolvedValueOnce({ ok: true, status: 'restarted', sessionId: 's1' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(getSessionRunnerRuntimeStatusSpy).toHaveBeenCalledTimes(1);
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    await settleDirectSessionView();

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'machine-1',
      serverId: 'server-route-1',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-old',
      expectedRunnerEntrypointIdentity: 'version:cli-old',
    });
    expect(getSessionRunnerRuntimeStatusSpy).toHaveBeenCalledTimes(2);
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
  });

  function installBackgroundActivity(count: number) {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
      activeAt: Date.now(),
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: count,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityRevision: 1,
    };
  }

  it('asks before a stale-runner restart stops background agents and sends nothing on cancel', async () => {
    installStaleSessionRunnerStatus();
    installBackgroundActivity(2);
    modalConfirmSpy.mockResolvedValueOnce(false);

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    await settleDirectSessionView();

    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
    expect(modalConfirmSpy.mock.calls[0]?.[1]).toBe('session.runnerRestartBackgroundWork.body');
    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('sends the stale-runner restart only after the background-agent stop is confirmed', async () => {
    installStaleSessionRunnerStatus();
    installBackgroundActivity(1);
    let confirmStop: (value: boolean) => void = () => {};
    modalConfirmSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirmStop = resolve; }));

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();

    await act(async () => {
      confirmStop(true);
    });
    await settleDirectSessionView();

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'machine-1',
      serverId: 'server-route-1',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-old',
      expectedRunnerEntrypointIdentity: 'version:cli-old',
    });
  });

  it.each([
    ['stale-runner', 'foreground and background work coexist'],
    ['MCP configuration', 'foreground and background work coexist'],
    ['stale-runner', 'the activity observation is stale'],
    ['MCP configuration', 'the activity observation is stale'],
  ])('still asks before a %s restart when %s', async (entryPoint, activityCase) => {
    if (entryPoint === 'stale-runner') installStaleSessionRunnerStatus();
    else installMcpSelectionRestartRequired();
    installBackgroundActivity(2);
    storageState.sessions.s1 = activityCase === 'the activity observation is stale'
      ? {
        ...storageState.sessions.s1,
        activeAt: 1,
        runtimeActivityObservedAt: 1,
      }
      : {
        ...storageState.sessions.s1,
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: Date.now(),
      };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId(entryPoint === 'stale-runner'
      ? 'session-staleRunner-version-restart'
      : 'session.mcpSelectionRestartRequired.restart'));
    await settleDirectSessionView();

    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
    expect(restartSessionRunnerForConfigurationSpy).not.toHaveBeenCalled();
  });

  it('opens one background-agent confirmation for repeated restart presses', async () => {
    installStaleSessionRunnerStatus();
    installBackgroundActivity(1);
    let confirmStop: (value: boolean) => void = () => {};
    modalConfirmSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirmStop = resolve; }));

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    await act(async () => {
      confirmStop(true);
    });
    await settleDirectSessionView();

    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
  });

  it('restarts the stale runner without asking when no background agents run', async () => {
    installStaleSessionRunnerStatus();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));
    await settleDirectSessionView();

    expect(modalConfirmSpy).not.toHaveBeenCalled();
    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
  });

  it('asks before the MCP configuration restart stops background agents', async () => {
    installMcpSelectionRestartRequired();
    installBackgroundActivity(1);
    modalConfirmSpy.mockResolvedValueOnce(false);

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session.mcpSelectionRestartRequired.restart'));
    await settleDirectSessionView();

    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
    expect(restartSessionRunnerForConfigurationSpy).not.toHaveBeenCalled();

    modalConfirmSpy.mockResolvedValueOnce(true);
    await pressTestInstanceAsync(screen.findByTestId('session.mcpSelectionRestartRequired.restart'));
    await settleDirectSessionView();

    expect(restartSessionRunnerForConfigurationSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps stale-runner restart disabled for view-only shared sessions', async () => {
    installStaleSessionRunnerStatus();
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      accessLevel: 'view',
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    // A disabled banner action carries no press handler at all, so a view-only participant has no
    // reachable path to the restart operation.
    const restartAction = screen.findByTestId('session-staleRunner-version-restart');
    expect(restartAction?.props.disabled).toBe(true);
    expect(restartAction?.props.onPress).toBeUndefined();

    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('dismisses the stale-runner notice when restart reports already current', async () => {
    installStaleSessionRunnerStatus();
    restartStaleSessionRunnerSpy.mockResolvedValueOnce({ ok: true, status: 'already_current', sessionId: 's1' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
  });

  it('keeps the stale-runner notice visible and reports daemon restart failures', async () => {
    installStaleSessionRunnerStatus();
    restartStaleSessionRunnerSpy.mockResolvedValueOnce({ ok: false, status: 'failure', sessionId: 's1' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-version-restart'));

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'session.staleRunner.errorTitle',
      'session.staleRunner.errorBody',
    );
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('keeps usage-limit status badge behavior when stale-runner status is also visible', async () => {
    installStaleSessionRunnerStatus();
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({
      key: 'session-usage-limit-recovery',
      testID: 'session-usageLimit-status-badge',
    }));
    expect(findStaleRunnerStatusBadge(screen)).toEqual(expect.objectContaining({
      key: 'session-stale-runner',
      testID: 'session-staleRunner-status-badge',
    }));

    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-remember'));

    expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledTimes(1);
    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
  });

  it('lets the usage-limit status badge collapse and reopen the recovery banner', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    const expandedBadge = findUsageLimitStatusBadge(screen);
    expect(expandedBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      onPress: expect.any(Function),
    }));
    expect(expandedBadge.renderPopover).toBeUndefined();

    await act(async () => {
      expandedBadge.onPress();
    });
    await settleDirectSessionView();

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
    const collapsedBadge = findUsageLimitStatusBadge(screen);
    expect(collapsedBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      onPress: expect.any(Function),
    }));

    await act(async () => {
      collapsedBadge.onPress();
    });
    await settleDirectSessionView();

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
  });

  it('keeps the usage-limit recovery banner collapsed when a different issue replaces the collapsed one', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const badge = findUsageLimitStatusBadge(screen);
    await act(async () => {
      badge.onPress();
    });
    await settleDirectSessionView();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 2,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 18, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };
    await updateSessionViewAndSettle(screen, { routeServerId: 'server-route-2' });

    // Collapse is remembered per banner kind, not per issue: a replacement issue stays collapsed
    // and keeps its signal on the status badge until the user reopens it.
    const badgeForReplacementIssue = findUsageLimitStatusBadge(screen);
    expect(badgeForReplacementIssue).toBeTruthy();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();

    await act(async () => {
      badgeForReplacementIssue.onPress();
    });
    await settleDirectSessionView();

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
  });

  it('preserves the stored custom resume prompt when remembering usage-limit recovery', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = {
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Resume from the last checklist item.',
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-remember'));

    expect(setUsageLimitRecoverySettingsSpy).toHaveBeenCalledWith({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Resume from the last checklist item.',
    });
  });

  it('preserves the stored custom resume prompt when forgetting usage-limit recovery', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = {
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Resume from the last checklist item.',
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-forget'));

    expect(setUsageLimitRecoverySettingsSpy).toHaveBeenCalledWith({
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Resume from the last checklist item.',
    });
  });

  it('does not persist auto-wait preference when arming usage-limit wait resume fails', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    sessionUsageLimitWaitResumeEnableSpy.mockResolvedValueOnce({
      ok: false,
      error: 'usage_limit_issue_unavailable',
      errorCode: 'usage_limit_issue_unavailable',
    });
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'opencode',
        usageLimit: {
          v: 1,
          resetAtMs: Date.UTC(2026, 4, 17, 17, 30, 0),
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-remember'));

    expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    expect(setUsageLimitRecoverySettingsSpy).not.toHaveBeenCalled();
  });

  it('clears inactive ready usage-limit recovery without surfacing a resume failure', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    sessionUsageLimitCheckNowSpy.mockResolvedValueOnce({ ok: true, status: 'ready' });
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: false,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: 1,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-resumeNow'));
    await settleDirectSessionView();

    expect(sessionUsageLimitCheckNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(modalAlertSpy).not.toHaveBeenCalled();

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: null,
      serverId: 'server-route-1-cleared',
    };
    await screen.update(
      <AppPaneProvider>
        <SessionView id="s1" routeServerId="server-route-1-cleared" />
      </AppPaneProvider>,
    );

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
  });

  it.each([
    ['ready', 'session.usageLimitRecovery.statusReady'],
    ['resumed', 'session.usageLimitRecovery.statusWaiting'],
    ['cancelled', 'session.usageLimitRecovery.statusLimitReached'],
    ['not_found', 'session.usageLimitRecovery.statusLimitReached'],
  ])('keeps the usage-limit warning actionable after an active check-now returns %s', async (status, statusLabel) => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    const operations = await vi.importActual<typeof import('@/sync/ops/sessionUsageLimitRecovery')>('@/sync/ops/sessionUsageLimitRecovery');
    sessionUsageLimitCheckNowSpy.mockImplementationOnce(operations.sessionUsageLimitCheckNow);
    usageLimitSessionRpcSpy.mockImplementation(async ({ method }: { method: string }) => (
      method === SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW
        ? status === 'cancelled' || status === 'not_found'
          ? { ok: false, status, errorCode: status === 'cancelled' ? 'session_rpc_cancelled' : 'usage_limit_issue_unavailable', sessionId: 's1' }
          : { ok: true, status, sessionId: 's1' }
        : undefined
    ));
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-checkNow'));
    await settleDirectSessionView();

    expect(sessionUsageLimitCheckNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(resumeSessionSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({ label: statusLabel }));
    if (status === 'ready') expect(screen.findByTestId('session-usageLimit-recovery-resumeNow')).toBeTruthy();
    if (status === 'cancelled' || status === 'not_found') expect(modalAlertSpy).toHaveBeenCalled();
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
  });

  it('does not offer a resume-now action for an active reset-elapsed issue when no interrupted work remains', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'auto_wait', resumePromptMode: 'standard' };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      metadata: {
        ...storageState.sessions.s1.metadata,
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: 1,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(screen.findByTestId('session-usageLimit-recovery-resumeNow')).toBeNull();
  });

  it('keeps a switchable group usage-limit warning until the provider confirms recovery', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    const operations = await vi.importActual<typeof import('@/sync/ops/sessionUsageLimitRecovery')>('@/sync/ops/sessionUsageLimitRecovery');
    sessionUsageLimitSwitchAccountNowSpy.mockImplementationOnce(operations.sessionUsageLimitSwitchAccountNow);
    usageLimitSessionRpcSpy.mockImplementation(async ({ method }: { method: string }) => (
      method === SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW
        ? { ok: true, status: 'resumed', sessionId: 's1' }
        : undefined
    ));
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'switch_account',
          connectedService: {
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'codex-main',
            groupExhausted: true,
          },
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(screen.findByTestId('session-usageLimit-recovery-checkNow')).toBeTruthy();
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-switchFallbackNow'));
    await settleDirectSessionView();

    expect(sessionUsageLimitSwitchAccountNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(sessionUsageLimitCheckNowSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({
      label: 'session.usageLimitRecovery.statusWaiting',
    }));
  });

  it('surfaces switch-account recovery progress while the control request is in flight', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    let resolveSwitchAccountNow: ((value: { ok: true; status: 'waiting' }) => void) | null = null;
    sessionUsageLimitSwitchAccountNowSpy.mockImplementationOnce(async () => (
      await new Promise<{ ok: true; status: 'waiting' }>((resolve) => {
        resolveSwitchAccountNow = resolve;
      })
    ));
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'switch_account',
          connectedService: {
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'codex-main',
            groupExhausted: false,
          },
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await act(async () => {
      void screen.findByTestId('session-usageLimit-recovery-switchAccountNow')?.props.onPress?.();
      await Promise.resolve();
    });
    await settleDirectSessionView();

    expect(sessionUsageLimitSwitchAccountNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(sessionUsageLimitCheckNowSpy).not.toHaveBeenCalled();
    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({
      label: 'session.usageLimitRecovery.statusChecking',
    }));

    await act(async () => {
      resolveSwitchAccountNow?.({ ok: true, status: 'waiting' });
      await Promise.resolve();
    });

    expect(findUsageLimitStatusBadge(screen)).toEqual(expect.objectContaining({
      label: 'session.usageLimitRecovery.statusWaiting',
    }));
  });

  it('shows a user-facing check-now error instead of raw recovery-control codes', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    sessionUsageLimitCheckNowSpy.mockResolvedValueOnce({
      ok: false,
      error: 'session_usage_limit_recovery_control_remote_unavailable',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-checkNow'));

    expect(sessionUsageLimitCheckNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    const [, message] = modalAlertSpy.mock.calls[0] ?? [];
    expect(String(message ?? '')).not.toContain('session_usage_limit_recovery_control_remote_unavailable');
    expect(String(message ?? '')).not.toContain('_');
  });

  it('starts fresh from a usage-limit recovery failure with a fresh explicit draft identity', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    sessionUsageLimitCheckNowSpy.mockResolvedValueOnce({
      ok: false,
      error: 'switch failed',
      uxDiagnostic: {
        code: 'post_switch_verification_failed',
        failurePhase: 'post_switch_verification',
        source: 'usage_limit_recovery',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account'],
      },
    });
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-checkNow'));

    const buttons = modalAlertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void }> | undefined;
    const startFresh = buttons?.find((button) =>
      button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction');
    expect(startFresh).toBeTruthy();
    startFresh?.onPress?.();

    expect(routerPushSpy).toHaveBeenCalledWith({
      pathname: '/new',
      params: {
        draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      },
    });
  });

  it('updates AgentInput runtime status from fresh heartbeat fields without replacing the shell session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    settingByKeyState.current.sessionListWorkingStatusAnimatedTextEnabled = false;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      activeAt: 1,
      thinking: true,
      thinkingAt: 1,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
      presence: 'online',
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('status.online');
    expect(findAgentInput(screen).props.showAbortButton).toBe(false);

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      serverId: 'server-runtime-refresh',
      activeAt: 1_000_000,
      thinkingAt: 1_000_000,
      latestTurnStatusObservedAt: 1_000_000,
    };
    await screen.update(
      <AppPaneProvider>
        <SessionView id="s1" routeServerId="server-runtime-refresh" />
      </AppPaneProvider>,
    );

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('status.working');
    expect(findAgentInput(screen).props.showAbortButton).toBe(true);
  });

  it('shows background Activity in AgentInput status without exposing foreground Stop', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
    };

    const screen = await renderSessionViewAndSettle();
    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('status.online');

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      serverId: 'server-runtime-activity-refresh',
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityRevision: 1,
    };
    await screen.update(
      <AppPaneProvider>
        <SessionView id="s1" routeServerId="server-runtime-activity-refresh" />
      </AppPaneProvider>,
    );

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('status.backgroundActive');
    expect(findAgentInput(screen).props.showAbortButton).toBe(false);
  });

  it('shows the main status as restarting while quota recovery is switching accounts', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: false,
      presence: 'offline',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: Date.now(),
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'switch_account',
          recoveryDecision: 'switching',
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('connectedServices.authSwitch.status.restarting');
    expect(findAgentInput(screen).props.connectionStatus?.isPulsing).toBe(true);
  });

  it('uses runtime quota evidence for the provider usage account label when it overrides launch-time profile quota', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        connectedServices: {
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'launch-profile',
            },
          },
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 10_000,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'switch_account',
          quotaSnapshotRef: {
            serviceId: 'openai-codex',
            profileId: 'backup-profile',
            groupId: 'backup-account',
            fetchedAtMs: 10_000,
          },
          allWindows: [
            { meterId: 'weekly', scope: 'Weekly', remainingPct: 42 },
            { meterId: 'daily', scope: 'Daily', remainingPct: 55 },
            { meterId: 'five_hour', scope: '5-hour', remainingPct: 70 },
          ],
          effectiveMeterId: 'weekly',
          effectiveRemainingPct: 42,
        },
      },
    };

    settingByKeyState.current.sessionProviderUsageGaugeWindowModes = ['weekly'];
    settingByKeyState.current.connectedServicesQuotaPinnedMeterIdsByKey = {
      'openai-codex/launch-profile': ['daily'],
      'openai-codex/backup-profile': ['five_hour'],
    };
    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      providerDisplayName: 'connectedServices.serviceNames.openaiCodex',
      activeAccountDisplayLabel: 'backup-account',
    }));
    expect(findAgentInput(screen).props.providerUsageGauge.usageRings.map((ring: { meterId: string }) => ring.meterId))
      .toEqual(['weekly', 'five_hour']);
  });

  it('uses runtime quota evidence for provider usage title when no launch-time profile binding exists', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 10_000,
        provider: 'claude',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
          quotaSnapshotRef: {
            serviceId: 'claude-subscription',
            profileId: 'claude-backup',
            groupId: 'claude-backup',
            fetchedAtMs: 10_000,
          },
          effectiveMeterId: 'weekly',
          effectiveRemainingPct: 52,
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      serviceId: 'claude-subscription',
      providerDisplayName: 'connectedServices.serviceNames.claudeSubscription',
      activeAccountDisplayLabel: 'claude-backup',
    }));
  });

  it('falls back to native provider account usage metadata for the provider usage badge without a connected binding', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    const snapshot = buildProviderAccountUsageSnapshot({
      used: 62,
      accountLabel: 'Native Codex account',
    });
    providerAccountUsageSnapshotsState.current = {
      [snapshot.recordId]: snapshot,
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        providerAccountUsageRefsV1: {
          v: 1,
          recordIds: [snapshot.recordId],
          updatedAtMs: 1_000,
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(providerAccountUsageSnapshotsState.requestedRecordIds).toEqual([snapshot.recordId]);
    expect(quotaSnapshotsState.requestedProfiles).toEqual([]);
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      providerDisplayName: 'connectedServices.serviceNames.openaiCodex',
      activeAccountDisplayLabel: 'Native Codex account',
      ringValueLabel: '38',
    }));
  });

  it('prefers the connected-service quota view ahead of connected account-usage metadata for connected bindings', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    const snapshot = buildProviderAccountUsageSnapshot({
      used: 64,
      accountLabel: 'Connected Codex account',
    });
    providerAccountUsageSnapshotsState.current = {
      [snapshot.recordId]: snapshot,
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        connectedServices: {
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
        providerAccountUsageRefsV1: {
          v: 1,
          recordIds: [snapshot.recordId],
          updatedAtMs: 1_000,
        },
      },
    };
    quotaSnapshotsState.current = {
      'openai-codex/work': buildOpenAiCodexWorkQuotaSnapshot({
        fetchedAt: 2_000,
        used: 82,
        accountLabel: 'View-backed Codex account',
      }),
    };

    const screen = await renderSessionViewAndSettle();

    expect(providerAccountUsageSnapshotsState.requestedRecordIds).toEqual([snapshot.recordId]);
    expect(quotaSnapshotsState.requestedProfiles).toEqual([
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    ]);
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      activeAccountDisplayLabel: 'View-backed Codex account',
      ringValueLabel: '18',
    }));
  });

  it('uses the active group profile for provider usage when the binding stores only a group id', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    storageState.profile = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'active-profile',
          status: 'connected',
          kind: 'oauth',
        }],
        groups: [{
          groupId: 'happier',
          activeProfileId: 'active-profile',
          memberProfileIds: ['active-profile'],
        }],
      }],
    };
    connectedServiceAuthGroupsState.groups = [{
      groupId: 'happier',
      activeProfileId: 'active-profile',
      members: [],
      policy: { quotaLimitSelection: { mode: 'all' } },
    }];
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        connectedServices: {
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
            },
          },
        },
      },
    };
    quotaSnapshotsState.current = {
      'openai-codex/active-profile': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active-profile',
        fetchedAt: Date.now(),
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: 'Active Codex account',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 35,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          remainingPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(quotaSnapshotsState.requestedProfiles).toEqual([
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'active-profile',
      }),
    ]);
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      activeAccountDisplayLabel: 'Active Codex account',
      ringValueLabel: '65',
    }));
  });

  it('uses only the group-selected allowance in the session usage badge', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['connectedServices.poolQuotaLimitSelection'] = true;
    storageState.profile = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'active-profile', status: 'connected', kind: 'oauth' }],
        groups: [{
          groupId: 'happier',
          activeProfileId: 'active-profile',
          generation: 7,
          memberProfileIds: ['active-profile'],
        }],
      }],
    };
    connectedServiceAuthGroupsState.groups = [{
      groupId: 'happier',
      activeProfileId: 'active-profile',
      generation: 7,
      members: [],
      policy: { quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] } },
    }];
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        connectedServices: {
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
          },
        },
      },
    };
    quotaSnapshotsState.current = {
      'openai-codex/active-profile': {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active-profile',
        fetchedAt: Date.now(),
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: 'Active Codex account',
        meters: [
          { meterId: 'standard:primary', providerLimitId: 'standard', label: 'Session', used: 20, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
          { meterId: 'spark:primary', providerLimitId: 'spark', label: 'Spark', used: 95, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
        ],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(connectedServiceAuthGroupsState.requestedServiceIds).toContain('openai-codex');
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      ringValueLabel: '80',
    }));
  });

  it('removes stale session-metadata recovery credits when consume returns a fresh connected-service snapshot', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    installConnectedServiceWorkProfileRecoveryCreditSession();
    const beforeSnapshot = buildOpenAiCodexWorkQuotaSnapshot({
      fetchedAt: 1,
      used: 82,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        credits: [{ kind: 'usage_limit_reset', status: 'available' }],
      },
    });
    const consumedSnapshot = buildOpenAiCodexWorkQuotaSnapshot({
      fetchedAt: 2,
      used: 45,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 0,
        credits: [],
      },
    });
    quotaSnapshotsState.current = {
      'openai-codex/work': beforeSnapshot,
    };
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockImplementation(async () => {
      // This file replaces the shared quota hook with an in-memory view. Mirror the
      // canonical store's successful-consume publication so the SessionView assertion
      // still observes the fresh snapshot instead of retaining the mocked stale view.
      quotaSnapshotsState.current = {
        'openai-codex/work': consumedSnapshot,
      };
      return {
        ok: true,
        receipt: {
          idempotencyKey: 'reset-credit-1',
          status: 'consumed',
        },
        snapshot: consumedSnapshot,
      };
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    expect(findAgentInput(screen).props.onProviderUsageRecoveryCreditPress).toEqual(expect.any(Function));
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeTruthy();

    await act(async () => {
      await findAgentInput(screen).props.onProviderUsageRecoveryCreditPress();
    });
    await settleDirectSessionView();
    // The in-memory hook replacement has no store subscription; force its next
    // render to read the fresh snapshot mirrored by the consume response above.
    await updateSessionViewAndSettle(screen, { routeServerId: 'server-route-refreshed' });

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
    }));
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      ringValueLabel: '55',
      recoveryCreditSummary: null,
    }));
    expect(findAgentInput(screen).props.onProviderUsageRecoveryCreditPress).toBeUndefined();
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeNull();
  });

  it('combines global windows with the active connected account favorites', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    installConnectedServiceWorkProfileRecoveryCreditSession();
    const snapshot = buildOpenAiCodexWorkQuotaSnapshot({ fetchedAt: 2_000, used: 82 });
    quotaSnapshotsState.current = {
      'openai-codex/work': { ...snapshot, meters: [
        ...snapshot.meters,
        { ...snapshot.meters[0]!, meterId: 'five_hour', label: '5-hour', windowDurationMs: 18_000_000, used: 30 },
        { ...snapshot.meters[0]!, meterId: 'daily', label: 'Daily', windowDurationMs: 86_400_000, used: 95 },
      ] },
    };

    settingByKeyState.current.connectedServicesQuotaPinnedMeterIdsByKey = { 'openai-codex/work': ['daily'] };
    settingByKeyState.current.sessionProviderUsageGaugeWindowModes = ['weekly', 'session'];

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findAgentInput(screen).props.providerUsageGauge.usageRings
      .map((ring: { meterId: string; ringValueLabel: string }) => [ring.meterId, ring.ringValueLabel]))
      .toEqual([['weekly', '18'], ['five_hour', '70'], ['daily', '5']]);
  });

  it('uses connected-service reset-credit consumption from the connected-service quota view for connected-service-bound account usage', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    installConnectedServiceWorkProfileRecoveryCreditSession();
    quotaSnapshotsState.current = {
      'openai-codex/work': buildOpenAiCodexWorkQuotaSnapshot({
        fetchedAt: 2_000,
        used: 82,
        accountLabel: 'Connected Codex account',
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 1,
          credits: [{ kind: 'usage_limit_reset', status: 'available' }],
        },
      }),
    };
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({
      ok: true,
      receipt: {
        idempotencyKey: 'reset-credit-1',
        status: 'consumed',
      },
      snapshot: null,
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      activeAccountDisplayLabel: 'Connected Codex account',
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));

    await act(async () => {
      await findAgentInput(screen).props.onProviderUsageRecoveryCreditPress();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
    }));
    expect(sessionUsageLimitConsumeResetCreditSpy).not.toHaveBeenCalled();
  });

  it('uses connected-service reset-credit consumption from the recovery banner for connected-service-bound account usage', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    installConnectedServiceWorkProfileRecoveryCreditSession();
    quotaSnapshotsState.current = {
      'openai-codex/work': buildOpenAiCodexWorkQuotaSnapshot({
        fetchedAt: 2_000,
        used: 82,
        accountLabel: 'Connected Codex account',
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 1,
          credits: [{ kind: 'usage_limit_reset', status: 'available' }],
        },
      }),
    };
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({
      ok: true,
      receipt: {
        idempotencyKey: 'reset-credit-1',
        status: 'consumed',
      },
      snapshot: null,
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit'));
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
    }));
    expect(sessionUsageLimitConsumeResetCreditSpy).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'transport_error'])('settles checking and preserves retry after Apply reset %s', async (failure) => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    installConnectedServiceWorkProfileRecoveryCreditSession();
    quotaSnapshotsState.current = {
      'openai-codex/work': buildOpenAiCodexWorkQuotaSnapshot({
        fetchedAt: 2_000,
        used: 82,
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 1,
          credits: [{ kind: 'usage_limit_reset', status: 'available' }],
        },
      }),
    };
    const operations = await vi.importActual<typeof import('@/sync/ops/connectedServiceQuotaRecoveryCredits')>('@/sync/ops/connectedServiceQuotaRecoveryCredits');
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockImplementationOnce(operations.connectedServiceQuotaRecoveryCreditConsume);
    // Exercise the real redemption/cache/presentation path beneath the machine transport.
    actionOperationRpcSpy.mockImplementation(async (request: { method: string }) => {
      if (request.method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME) {
        return { items: [], nextCursor: null };
      }
      if (failure === 'transport_error') throw new Error('connection_lost');
      return { ok: false, errorCode: 'no_recovery_credit_available', error: 'no_recovery_credit_available' };
    });
    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit'));
    await settleDirectSessionView();

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')?.props.disabled).not.toBe(true);
    expect(findUsageLimitStatusBadge(screen)?.label).not.toBe('session.usageLimitRecovery.statusChecking');
  });

  it('uses later polled quota after connected-service reset-credit consume returns no snapshot', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask', resumePromptMode: 'off' };
    installConnectedServiceWorkProfileRecoveryCreditSession();
    const beforeSnapshot = buildOpenAiCodexWorkQuotaSnapshot({
      fetchedAt: 1,
      used: 82,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        credits: [{ kind: 'usage_limit_reset', status: 'available' }],
      },
    });
    const polledSnapshot = buildOpenAiCodexWorkQuotaSnapshot({
      fetchedAt: 2,
      used: 45,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 0,
        credits: [],
      },
    });
    quotaSnapshotsState.current = {
      'openai-codex/work': beforeSnapshot,
    };
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({
      ok: true,
      receipt: {
        idempotencyKey: 'reset-credit-1',
        status: 'consumed',
      },
      snapshot: null,
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      ringValueLabel: '18',
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeTruthy();

    await act(async () => {
      await findAgentInput(screen).props.onProviderUsageRecoveryCreditPress();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
    }));

    quotaSnapshotsState.current = {
      'openai-codex/work': polledSnapshot,
    };
    await updateSessionViewAndSettle(screen, { routeServerId: 'server-route-polled' });

    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      ringValueLabel: '55',
      recoveryCreditSummary: null,
    }));
    expect(findAgentInput(screen).props.onProviderUsageRecoveryCreditPress).toBeUndefined();
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeNull();
  });

  it('does not expose connected-service reset-credit consumption for native provider account usage refs', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    const snapshot = buildProviderAccountUsageSnapshot({
      used: 82,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        credits: [{ kind: 'usage_limit_reset', status: 'available' }],
      },
    });
    providerAccountUsageSnapshotsState.current = {
      [snapshot.recordId]: snapshot,
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        providerAccountUsageRefsV1: {
          v: 1,
          recordIds: [snapshot.recordId],
          updatedAtMs: 1_000,
        },
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(providerAccountUsageSnapshotsState.requestedRecordIds).toEqual([snapshot.recordId]);
    expect(quotaSnapshotsState.requestedProfiles).toEqual([]);
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    await act(async () => {
      await findAgentInput(screen).props.onProviderUsageRecoveryCreditPress();
    });
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeNull();
    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).not.toHaveBeenCalled();
    expect(sessionUsageLimitConsumeResetCreditSpy).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        serverId: 'server-route-1',
        refreshMachineTargets: expect.any(Function),
      }),
    );
  });

  it('falls back to session consume-reset-credit when provider usage has no connected-service profile ref', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'exhausted',
          issueFingerprint: 'usage-limit:codex:unknown-turn:1:unknown-reset',
          armedAtMs: 1,
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 1,
          maxAttempts: 1,
          lastProbeError: null,
          selectedAuth: {
            kind: 'native',
            serviceId: 'openai-codex',
          },
          recoveryCredits: {
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [{ kind: 'usage_limit_reset', status: 'available' }],
          },
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider: 'codex',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'manual',
          quotaSnapshotRef: {
            serviceId: 'openai-codex',
            profileId: 'native',
            fetchedAtMs: 1,
          },
          effectiveMeterId: 'weekly',
          effectiveRemainingPct: 4,
        },
      },
    };
    sessionUsageLimitConsumeResetCreditSpy.mockResolvedValue({ ok: true, status: 'ready' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findAgentInput(screen).props.providerUsageGauge).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));

    await act(async () => {
      await findAgentInput(screen).props.onProviderUsageRecoveryCreditPress();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).not.toHaveBeenCalled();
    expect(sessionUsageLimitConsumeResetCreditSpy).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        serverId: 'server-route-1',
        provider: 'codex',
        refreshMachineTargets: expect.any(Function),
      }),
    );
  });

  it('passes direct takeover footer actions when an uncontrolled linked direct session has an empty transcript', async () => {
    storageState.sessions.s1.seq = 0;
    transcriptIdsState.ids = [];
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
    }, { serverId: 'server-1' });
    expect(modalAlertSpy).not.toHaveBeenCalled();

  });

  it.each([
    { terminal: 'failed' as const, refreshFails: false },
    { terminal: 'succeeded' as const, refreshFails: true },
    { terminal: 'succeeded' as const, refreshFails: false },
  ])('keeps the same footer through empty conversion to $terminal (refresh fails: $refreshFails)', async ({ terminal, refreshFails }) => {
    storageState.sessions.s1.seq = 0;
    transcriptIdsState.ids = [];
    const running = createActionOperationFixture({ operationId: `import-${operationAccountId}`,
      scope: { accountId: operationAccountId, machineId: 'machine-1', sessionId: 's1' },
      cancellation: 'unsupported', progress: { kind: 'phase', phase: 'converting', label: 'Converting' } });
    const screen = await renderSessionViewAndSettle();
    actionOperationRpcSpy.mockResolvedValue({ ok: true, operation: running });
    await act(async () => { chatListPropsSpy.mock.calls.at(-1)?.[0]?.directControlFooter.onRequestTakeOverPersist(); });
    await flushHookEffects();
    const { storage } = await import('@/sync/domains/state/storage');
    const { directSessionV1: _removed, ...metadata } = storageState.sessions.s1.metadata;
    storageState.sessions.s1 = { ...storageState.sessions.s1, metadata };
    chatListPropsSpy.mockClear();
    await act(async () => { storage.setState({ sessions: { ...storageState.sessions } }); });
    await updateSessionViewAndSettle(screen);
    const converting = chatListPropsSpy.mock.calls.at(-1)?.[0]?.directControlFooter;
    expect(converting?.importOperation?.state).toBe('running');
    expect(converting?.onRequestTakeOverDirect).toBeUndefined();
    expect(converting?.onRequestTakeOverPersist).toBeUndefined();
    const settled = { ...running, revision: 2, state: terminal, settledAt: 110,
      ...(terminal === 'failed' ? { error: { errorCode: 'failed', error: 'conversion failed' } } : {}) } satisfies ActionOperationSnapshotV1;
    if (refreshFails) syncRefreshSessionsSpy.mockRejectedValueOnce(new Error('refresh disconnected'));
    await act(async () => { actionOperationStore.merge(settled); });
    actionOperationRpcSpy.mockResolvedValue({ kind: 'found', operation: settled });
    if (terminal === 'failed' || refreshFails) {
      const recovered = chatListPropsSpy.mock.calls.at(-1)?.[0]?.directControlFooter;
      expect(recovered?.importOperation?.state).toBe(terminal);
      if (refreshFails) {
        expect(recovered.importStatusError).not.toBeNull();
        await act(async () => { await recovered.onRefreshImport(); });
        expect(screen.findAll((node) => String(node.type) === 'ChatList')).toHaveLength(0);
      }
    } else {
      expect(screen.findAll((node) => String(node.type) === 'ChatList')).toHaveLength(0);
    }
    await screen.unmount();
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

  it('passes scaffold available panel height to AgentInput when already below the session composer cap', async () => {
    keyboardAvoidanceState.availablePanelHeight = 300;

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.maxPanelHeight).toBe(300);
  });

  it('caps the existing-session text input viewport while preserving the scaffold panel height', async () => {
    keyboardAvoidanceState.availablePanelHeight = 900;

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.maxPanelHeight).toBe(900);
    expect(agentInput.props.inputMaxHeight).toBe(200);
  });

  it('tightens the collapsed existing-session text input cap while the keyboard is open', async () => {
    keyboardAvoidanceState.availablePanelHeight = 900;
    keyboardAvoidanceState.keyboardHeight = 320;

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.maxPanelHeight).toBe(900);
    expect(agentInput.props.inputMaxHeight).toBe(120);
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
      approval_1: {
        id: 'approval_1',
        header: {
          kind: 'approval_request.v1',
          title: 'Approve session list',
          approvalStatus: 'open',
          sessionId: 's1',
        },
        title: 'Approve session list',
        body: JSON.stringify({
          v: 1,
          status: 'open',
          createdAtMs: 1,
          updatedAtMs: 1,
          createdBy: { surface: 'session_agent', sessionId: 's1' },
          requestedSurface: 'session_agent',
          actionId: 'session.list',
          actionArgs: {},
          summary: 'List sessions',
        }),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.approvalRequests).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ id: 'approval_1' }),
        approval: expect.objectContaining({
          actionId: 'session.list',
          summary: 'List sessions',
        }),
      }),
    ]);
  });

  it('passes bodyless session-scoped open approval artifact headers to AgentInput', async () => {
    storageState.artifacts = {
      approval_1: {
        id: 'approval_1',
        header: {
          kind: 'approval_request.v1',
          title: 'Approve session list',
          approvalStatus: 'open',
          actionId: 'session.list',
          sessionId: 's1',
        },
        title: 'Approve session list',
        body: undefined,
        headerVersion: 1,
        bodyVersion: undefined,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
      },
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect(agentInput.props.approvalRequests).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ id: 'approval_1' }),
        approval: expect.objectContaining({
          status: 'open',
          actionId: 'session.list',
          summary: 'Approve session list',
          createdBy: expect.objectContaining({ surface: 'session_agent', sessionId: 's1' }),
        }),
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
    // The composer still builds its own current-Agent rows: SessionView never hands it a
    // wholesale replacement projection. The in-session picker only *extends* that list and
    // reports which row is armed — null here, because no continuation has been selected.
    expect(agentInput.props.agentPickerOptions).toBeUndefined();
    expect(agentInput.props.composeAgentPickerOptions).toBeTypeOf('function');
    expect(agentInput.props.agentPickerSelectedOptionId).toBeNull();
    expect(agentInput.props.agentPickerApplyLabel).toBeUndefined();
    expect(agentInput.props.metadata).toEqual(session.metadata);
    expect(typeof agentInput.props.onModelModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpSessionModeChange).toBe('function');
    expect(typeof agentInput.props.onSessionConfigOptionChange).toBe('function');

    await act(async () => {
      agentInput.props.onAcpSessionModeChange('plan');
      agentInput.props.onSessionConfigOptionChange('thinking', 'high');
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

  it('applies ACP config-option overrides optimistically to existing-session AgentInput props', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      sessionModelsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModelId: 'default',
        availableModels: [
          {
            id: 'default',
            name: 'Use CLI settings',
            modelOptions: [
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
        ],
      },
    };

    const screen = await renderSessionViewAndSettle();

    let agentInput = findAgentInput(screen);
    expect(agentInput.props.acpConfigOptionOverridesOverride).toBeNull();

    await act(async () => {
      agentInput.props.onSessionConfigOptionChange('thinking', 'high');
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.acpConfigOptionOverridesOverride).toEqual({
      v: 1,
      updatedAt: expect.any(Number),
      overrides: {
        thinking: {
          updatedAt: expect.any(Number),
          value: 'high',
        },
      },
    });
    expect(publishSessionAcpConfigOptionOverrideToMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      configId: 'thinking',
      value: 'high',
    }));
  });

  it('includes the optimistic Claude reasoning effort override in the next submitted message', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      flavor: 'claude',
      directSessionV1: {
        ...session.metadata.directSessionV1,
        providerId: 'claude',
      },
      sessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-sonnet-4-6',
        availableModels: [
          {
            id: 'claude-sonnet-4-6',
            name: 'Sonnet 4.6',
            modelOptions: [
              {
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        ],
      },
    };
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onSessionConfigOptionChange('reasoning_effort', 'low');
    });
    await settleDirectSessionView();

    await act(async () => {
      agentInput.props.onChangeText('use the lower effort');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      's1',
      'use the lower effort',
      undefined,
      expect.objectContaining({
        reasoningEffort: 'low',
      }),
      expectDirectSendProjectionOptions(),
    );
  });

  it('clears composer text at direct-session outbound handoff and leaves it clear after acceptance', async () => {
    let resolveSubmit!: () => void;
    syncSubmitMessageSpy.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[4] as
          | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
          | undefined;
        options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
        return new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        });
      },
    );
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();
    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue this session');
    });

    await act(async () => {
      agentInput.props.onSend();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('');

    await act(async () => {
      resolveSubmit();
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('');
  });

  it('restores composer text when direct-session outbound handoff fails before acceptance', async () => {
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
      throw new Error('direct send rejected');
    });
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();
    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('retry this direct send');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('retry this direct send');
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'direct send rejected');
  });

  it('keeps composer custody clear when canonical Pending commits before an ambiguous direct-send error', async () => {
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
      storageState.sessionPending.s1 = {
        messages: [{
          id: 'pending-1',
          localId: 'direct-local-id',
          createdAt: 1,
          updatedAt: 2,
          source: 'server_pending',
          deliveryStatus: 'accepted',
          pendingDeliveryStatus: 'server_delivering',
          text: 'ambiguous but committed',
          rawRecord: {},
        }],
        discarded: [],
        isLoaded: true,
      };
      throw new Error('direct send response lost');
    });
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();
    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('ambiguous but committed');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('');
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'direct send response lost');
  });

  it('restores composer custody when only recovered history shares the outbound local id', async () => {
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as
        | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
        | undefined;
      options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
      storageState.sessionMessages.s1 = {
        messagesById: {
          history: {
            id: 'history',
            kind: 'user-text',
            localId: 'direct-local-id',
            text: 'older recovered prompt',
            createdAt: 1,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
          },
        },
      };
      throw new Error('direct send rejected before server custody');
    });
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

    const screen = await renderSessionView();
    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('new prompt with reused local id');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('new prompt with reused local id');
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'direct send rejected before server custody');
  });

  it('does not restore an old semantic snapshot over newer semantic choices after direct-session handoff failure', async () => {
    const scope = { ...TEST_SERVER_ACCOUNT_SCOPE, accountId: operationAccountId };
    const oldRecipient = { kind: 'execution_run' as const, runId: 'run-old' };
    const newRecipient = { kind: 'execution_run' as const, runId: 'run-new' };
    const oldMention = {
      kind: 'skill' as const,
      tokenText: '$old',
      name: 'old',
    };
    const newMention = {
      kind: 'skill' as const,
      tokenText: '$new',
      name: 'new',
    };
    let rejectSubmit!: (error: Error) => void;

    await deleteSessionDraft({ scope, address: TEST_SESSION_DRAFT_ADDRESS });
    existingSessionDraftSemanticValues.write(scope, 's1', 'routing.recipient', oldRecipient);
    existingSessionDraftSemanticValues.write(scope, 's1', 'routing.executionRunDelivery', 'interrupt');
    existingSessionDraftSemanticValues.write(scope, 's1', 'structuredInput.mentions', [oldMention]);

    try {
      syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
        const options = args[4] as
          | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
          | undefined;
        options?.onLocalPendingProjectionCreated?.({ localId: 'direct-local-id' });
        return new Promise<void>((_resolve, reject) => {
          rejectSubmit = reject;
        });
      });
      showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });

      const screen = await renderSessionView();
      let agentInput = findAgentInput(screen);
      await act(async () => {
        agentInput.props.onChangeText('send $old to old target');
      });

      let sendPromise: Promise<void> | undefined;
      await act(async () => {
        sendPromise = agentInput.props.onSend();
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'routing.recipient')).toBeUndefined();
      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'routing.executionRunDelivery')).toBeUndefined();
      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'structuredInput.mentions') ?? []).toEqual([]);

      await act(async () => {
        findAgentInput(screen).props.onChangeText('send $new to newer target');
        existingSessionDraftSemanticValues.write(scope, 's1', 'routing.recipient', newRecipient);
        existingSessionDraftSemanticValues.write(scope, 's1', 'routing.executionRunDelivery', 'prompt');
        existingSessionDraftSemanticValues.write(scope, 's1', 'structuredInput.mentions', [newMention]);
      });

      await act(async () => {
        rejectSubmit(new Error('direct send rejected'));
        await sendPromise;
      });
      await settleDirectSessionView();

      agentInput = findAgentInput(screen);
      expect(agentInput.props.value).toBe('send $new to newer target');
      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'routing.recipient')).toEqual(newRecipient);
      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'routing.executionRunDelivery')).toBe('prompt');
      expect(existingSessionDraftSemanticValues.read(scope, 's1', 'structuredInput.mentions')).toEqual([newMention]);
      expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'direct send rejected');
    } finally {
      await deleteSessionDraft({ scope, address: TEST_SESSION_DRAFT_ADDRESS });
    }
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
    // R5/Lane F-redo migrated the recipient chip from flat `options` to
    // `presentation: 'list' + rootStep` with sections — walk the rootStep here.
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
    const recipientOptions = (recipientFirstSection && recipientFirstSection.kind === 'static'
      ? recipientFirstSection.options ?? []
      : []);
    expect(recipientOptions.map((option: { id: string }) => option.id)).toEqual([
      'lead',
      'agent_team_broadcast:team-1',
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
    storageState.sessionListRenderables.s1 = {
      id: 's1',
      metadata: {
        machineId: 'machine-1',
        path: '/tmp',
      },
    };
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host' },
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
    // R5/Lane F-redo migrated the delivery chip from flat `options` to
    // `presentation: 'list' + rootStep` with sections — walk the rootStep here.
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
    const deliveryOptions = (deliveryFirstSection && deliveryFirstSection.kind === 'static'
      ? deliveryFirstSection.options ?? []
      : []);
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
      badges: ['sessionsList.storageDirectTab', 'agentInput.agent.codex · happy-host'],
    }));
  });

  it('owns one direct-session status and transcript poller for the mounted session surface', async () => {
    chatHeaderHarnessState.renderRightElement = true;
    await renderSessionViewAndSettle();

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(syncRefreshSessionMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('shares the session surface direct runtime with nested details consumers', async () => {
    const { useSessionDirectSessionRuntime } = await import('../model/useSessionDirectSessionRuntime');
    let nestedRuntimeStatus: ReturnType<typeof useSessionDirectSessionRuntime>['status'] = null;
    const NestedDetailsConsumer = () => {
      nestedRuntimeStatus = useSessionDirectSessionRuntime({
        sessionId: 's1',
        metadata: storageState.sessions.s1.metadata,
      }).status;
      return null;
    };

    await renderSessionViewAndSettle({ contentOverride: <NestedDetailsConsumer /> });

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(syncRefreshSessionMessagesSpy).toHaveBeenCalledTimes(1);
    expect(nestedRuntimeStatus).toMatchObject({ machineOnline: true, activity: 'running' });
  });

  it('shares the session surface direct runtime with nested execution and subagent projections', async () => {
    const { useSessionExecutionRunLaunchability } = await import('@/hooks/session/useSessionExecutionRunLaunchability');
    const { useSessionSubagents } = await import('@/hooks/session/useSessionSubagents');
    const NestedSessionProjections = () => {
      useSessionExecutionRunLaunchability('s1', storageState.sessions.s1);
      useSessionSubagents({
        sessionId: 's1',
        session: storageState.sessions.s1,
        messages: [],
      });
      return null;
    };

    await renderSessionViewAndSettle({ contentOverride: <NestedSessionProjections /> });

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(syncRefreshSessionMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('polls direct session status and transcript refreshes using the active cadence while the session view is open', async () => {
    const previousActivePollMs = process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE;
    process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE = '50';

    try {
      await renderSessionView();

      const initialStatusCallCount = machineDirectSessionStatusGetSpy.mock.calls.length;
      expect(initialStatusCallCount).toBeGreaterThanOrEqual(1);
      expect(syncRefreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
      const initialRefreshCallCount = syncRefreshSessionMessagesSpy.mock.calls.length;

      await act(async () => {
        await sleep(75);
      });
      await flushHookEffects({ cycles: 1, turns: 2 });
      expect(machineDirectSessionStatusGetSpy.mock.calls.length).toBeGreaterThanOrEqual(initialStatusCallCount + 1);
      expect(syncRefreshSessionMessagesSpy.mock.calls.length).toBeGreaterThanOrEqual(initialRefreshCallCount + 1);
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
    }, { serverId: 'server-1' });
    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      's1',
      'continue this session',
      undefined,
      undefined,
      expectDirectSendProjectionOptions(),
    );

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
    expect(actionOperationRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toBe(false);
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('draft stays here');

  });

  it('keeps the composer text visible while a direct takeover send prompt is still pending', async () => {
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
    expect(agentInput.props.value).toBe('clear me immediately');
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

    actionOperationRpcSpy.mockResolvedValue({ ok: true, operation: createActionOperationFixture({
      operationId: `send-import-${operationAccountId}`,
      scope: { accountId: operationAccountId, machineId: 'machine-1', sessionId: 's1' },
      state: 'succeeded', settledAt: 110, cancellation: 'unsupported', result: { ok: true, converted: true },
    }) });
    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('persist this');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(actionOperationRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.directSessions.takeoverPersist.start', serverId: 'server-1',
      payload: expect.objectContaining({ machineId: 'machine-1', sessionId: 's1', forceStop: true, requestId: expect.any(String) }),
    }));
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

  it('keeps the composer text when durable voice dispatch is definitively rejected', async () => {
    sendVoiceSessionComposerTextSpy.mockResolvedValueOnce({
      ok: false,
      reason: 'send_failed',
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

    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.voiceServiceUnavailable');
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('continue the voice conversation');

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
