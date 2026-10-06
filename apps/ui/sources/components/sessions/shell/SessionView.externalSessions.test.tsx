import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  ApprovalRequestV1Schema,
  buildApprovalRequestArtifactHeaderV1,
  buildProviderAccountUsageRecordId,
  buildSystemSessionMetadataV1,
  ExternalSessionOperationSharedPresentationV1Schema,
  StrictJsonValueSchema,
  PluginProjectionV2Schema,
  SessionCurrentProjectionRecordV1Schema,
  SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  SessionRuntimeIssueV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
  ExternalSessionStatusGetRequestSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionAttachRequestSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionDetachResponseSchema,
  ExternalSessionTranscriptPageRequestSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
  ExternalSessionTranscriptReadAfterRequestSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
  WorkspaceAnchorsResolveRequestV1Schema,
  WorkspaceAnchorsResolveResponseV1Schema,
} from '@happier-dev/protocol';
import { ExternalSessionTakeoverStartInputV1Schema, ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationProgressV1Schema, EXTERNAL_SESSION_OPERATION_TIMELINES_V1 } from '@happier-dev/protocol/sessions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';

import {
  computeExistingSessionComposerInputMaxHeight,
  computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  deleteSessionDraft,
  getSessionDraftSnapshot,
  resetSessionDraftRepositoryForTests,
  writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  getResolvedBackendCatalogEntries: () => [],
}));
const daemonMergedProjectionState = vi.hoisted(() => ({
  current: { phase: 'idle', inputs: null as any },
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => daemonMergedProjectionState.current,
}));

const machineExternalSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineExternalSessionAttachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 })));
const machineExternalSessionDetachSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, detached: true })));
const machineExternalSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineExternalSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
const outboundMessageAckSpy = vi.hoisted(() => vi.fn<(event: string, payload: unknown) => Promise<unknown>>());
const pendingHttpSpy = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<Response>>());
const transcriptPageReply = vi.hoisted(() => vi.fn());
const transcriptReadAfterReply = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const voiceSurfacePropsSpy = vi.hoisted(() => vi.fn());
const warningActionBannerPropsSpy = vi.hoisted(() => vi.fn());
const showExternalSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{
    action: 'direct' | 'persisted' | 'recheck' | null;
    targetDirectory?: string;
  }>>(async () => ({ action: null })),
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
const activeServerAccountScopeState = vi.hoisted(() => ({
  current: null as { serverId: string; accountId: string } | null,
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
const featureEnabledState = vi.hoisted(() => ({
  voice: false,
  'execution.runs': false,
  'files.reviewComments': false,
}));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ current: false }));
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
const sessionTranscriptRenderState = vi.hoisted(() => ({
  current: { ids: ['m1'] as string[], isLoaded: true },
}));
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
  machines: {} as Record<string, Partial<ReturnType<typeof createMachineFixture>>>,
  sessions: {
    s1: {
      id: 's1',
      serverId: 'server-canonical',
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
  sessionListRowsByServerId: {} as Record<string, Record<string, unknown>>,
  ordinarySessionListMembershipByServerId: {} as Record<string, readonly string[]>,
  sessionTailContiguousBoundary: {} as Record<string, unknown>,
  sessionTranscriptLoadIssues: {} as StorageState['sessionTranscriptLoadIssues'],
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
    executionRunRequestedAction: { v: 1, kind: 'steer_if_active' },
    setExecutionRunRequestedAction: vi.fn(),
  },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  Octicons: 'Octicons',
}));
vi.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 0, height: 0 },
      insets,
    },
    SafeAreaInsetsContext: React.createContext(null),
    SafeAreaProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => insets,
  };
});

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
      translate: (key: string) => key === 'agentInput.agent.codex' ? 'Codex' : key,
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args) => modalAlertSpy(...args));
    return modalMock.module;
  },
});

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
  useIsFocused: () => focusState.current,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  // Test boundary: the real view is a keyboard/scroll scaffold. It renders three
  // slots, and `placeholder` is the one the transcript recovery states live in, so
  // dropping it here would make every placeholder assertion unfalsifiable.
  AgentContentView: (props: any) =>
    React.createElement(
      'AgentContentView',
      props,
      React.createElement(
        React.Fragment,
        null,
        props.content ?? null,
        props.placeholder ?? null,
        props.input ?? null,
      ),
    ),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'session:s1',
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
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
  useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedState.current,
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots', async () => {
  // The polling transport is the boundary; the normalized `profiles`
  // projection stays real because the shell reads its canonical keys.
  const { normalizeConnectedServiceQuotaProfileRefs } = await import(
    '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs'
  );
  return {
    useConnectedServiceQuotaSnapshots: (profiles: unknown) => {
      useConnectedServiceQuotaSnapshotsSpy(profiles);
      return {
        profiles: normalizeConnectedServiceQuotaProfileRefs((profiles ?? []) as any),
        snapshotsByKey: connectedServiceQuotaSnapshotsState.current,
        loadingByKey: {},
      };
    },
  };
});
vi.mock('@/hooks/server/connectedServices/useProviderAccountUsageSnapshots', async () => {
  const { resolveProviderAccountUsageSnapshotState } = await import('@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors');
  return {
  useProviderAccountUsageSnapshots: (recordIds: unknown) => {
    useProviderAccountUsageSnapshotsSpy(recordIds);
    return {
      snapshotsByRecordId: providerAccountUsageSnapshotsState.current,
      loadingByRecordId: {},
      stateByRecordId: Object.fromEntries(Object.entries(providerAccountUsageSnapshotsState.current).map(([id, value]) => [
        id, resolveProviderAccountUsageSnapshotState({ snapshot: ProviderAccountUsageSnapshotV1Schema.parse(value), loading: false, hadError: false, nowMs: Date.now() }),
      ])),
    };
  },
  };
});
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
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/sync/ops', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sessionAbort: vi.fn(),
    resumeSession: vi.fn(),
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
  };
});
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

installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'emit').mockReturnValue(socket);
  vi.spyOn(socket, 'disconnect').mockImplementation(() => {
    socket.connected = false;
    for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
    return socket;
  });
  // Layout-0 metadata writes use the published Socket.IO acknowledgement seam.
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event === 'rpc-call') {
      // Socket.IO's generic wire payload is narrowed by each published request codec.
      const request = payload as SocketRpcRequestPayload;
      const carrier = socket as unknown as { io: { uri: string }; auth: { token?: string } };
      expect(new URL(carrier.io.uri).origin).toBe('https://server-canonical');
      expect(carrier.auth.token).toBe(shellCredentials?.token);
      let result: unknown;
      switch (request.method) {
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET}`:
          result = ExternalSessionStatusGetResponseSchema.parse(await machineExternalSessionStatusGetSpy(ExternalSessionStatusGetRequestSchema.parse(request.params)));
          break;
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`:
          result = ExternalSessionAttachResponseSchema.parse(await machineExternalSessionAttachSpy(ExternalSessionAttachRequestSchema.parse(request.params)));
          break;
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH}`:
          result = ExternalSessionDetachResponseSchema.parse(await machineExternalSessionDetachSpy(ExternalSessionDetachRequestSchema.parse(request.params)));
          break;
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START}`: {
          const input = ExternalSessionTakeoverStartInputV1Schema.parse(request.params);
          const remote = input.request.targetStorageMode === 'persisted' ? machineExternalSessionTakeoverPersistSpy : machineExternalSessionTakeoverSpy;
          result = ExternalSessionOperationActionResponseV1Schema.parse(await remote(input));
          break;
        }
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE}`:
          result = ExternalSessionTranscriptPageResponseSchema.parse(await transcriptPageReply(ExternalSessionTranscriptPageRequestSchema.parse(request.params)));
          break;
        case `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`: {
          // The initial window and secure refresh owners share the RPC id, not a payload schema.
          const refresh = ExternalSessionTranscriptRefreshReadAfterRequestV1Schema.safeParse(request.params);
          result = refresh.success
            ? ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse(await transcriptReadAfterReply(refresh.data))
            : ExternalSessionTranscriptReadAfterResponseSchema.parse(await transcriptReadAfterReply(ExternalSessionTranscriptReadAfterRequestSchema.parse(request.params)));
          break;
        }
        case `machine-1:${RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE}`: {
          const input = WorkspaceAnchorsResolveRequestV1Schema.parse(request.params);
          result = WorkspaceAnchorsResolveResponseV1Schema.parse({ success: true,
            resolutions: input.comments.map((comment) => ({
              id: comment.id, filePath: comment.filePath, originalAnchor: comment.anchor,
              resolvedAnchor: comment.anchor, status: 'exact', confidence: 1, preview: comment.snapshot,
            })),
          });
          break;
        }
        default: throw new Error(`Unexpected external Session RPC: ${request.method}`);
      }
      return { ok: true, result };
    }
    if (event !== 'update-metadata' || !wireSession) throw new Error(`Unexpected shell socket event: ${event}`);
    const request = payload as { sid: string; expectedVersion: number; metadata: string };
    expect(request.sid).toBe('s1');
    expect(request.expectedVersion).toBe(wireSession.metadataVersion);
    wireSession = SessionCurrentProjectionRecordV1Schema.parse({
      ...wireSession, metadata: request.metadata, metadataVersion: request.expectedVersion + 1,
    });
    return { result: 'success', version: wireSession.metadataVersion, metadata: wireSession.metadata };
  });
});
// The shared shell helper predates the canonical draft and registry owners.
// Keep its platform boundaries, but do not replace those deterministic owners.
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
vi.doUnmock('@/sync/domains/state/storage');
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
  (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const { storage: canonicalStorage } = await import('@/sync/domains/state/storage');
shellStorageStoreState.current = canonicalStorage;
const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { SessionView } = await import('./SessionView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let shellCredentials: import('@/auth/storage/tokenStorage').AuthCredentials | null = null;
let wireSession: ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse> | null = null;
let wireMachine: FetchedMachineRow | null = null;
const { composerStructuredMentionsFromReferences, placePositionlessComposerReferences } = await import('@/components/sessions/composer/composerScopeAdapters');

function syncShellStorageStore() {
  const shellStorageStore = shellStorageStoreState.current;
  if (!shellStorageStore) return;
  storageState.sessions.s1 = createSessionFixture(storageState.sessions.s1);
  const machine = createMachineFixture({ id: 'machine-1', storageMode: 'plain', active: true, activeAt: Date.now(),
    ...storageState.machines['machine-1'] });
  const row = { ...machine, metadata: encodePlainMachineStoredContent(machine.metadata),
    daemonState: machine.daemonState === null ? null : encodePlainMachineStoredContent(machine.daemonState),
    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } satisfies FetchedMachineRow;
  wireMachine = row;
  shellStorageStore.setState({
    sessions: storageState.sessions,
    isDataReady: storageState.isDataReady,
    artifacts: storageState.artifacts,
    profile: { ...shellStorageStore.getState().profile, ...storageState.profile },
    sessionTranscriptLoadIssues: storageState.sessionTranscriptLoadIssues,
    sessionListRowsByServerId: {},
    ordinarySessionListMembershipByServerId: {},
    reviewCommentsDraftsByWorkspaceCacheKey: {
      [buildWorkspaceCacheKey({ serverId: 'server-canonical', machineId: 'machine-1', rootPath: '/tmp' })]: reviewCommentDraftsState.current,
    },
    machines: { 'machine-1': machine },
    sessionMessages: {
      s1: createSessionMessagesFixture({
        messageIdsOldestFirst: sessionMessagesState.current.length
          ? sessionMessagesState.current.map((message) => message.id)
          : sessionTranscriptRenderState.current.ids,
        messagesById: Object.fromEntries(sessionMessagesState.current.map((message) => [message.id, message])),
        isLoaded: sessionTranscriptRenderState.current.isLoaded,
      }),
    },
    settings: { ...settingsDefaults, experiments: true, codexBackendMode: 'acp', ...settingsState.current, ...settingByKeyState.current },
    localSettings: { ...localSettingsDefaults, uiMultiPanePanelsEnabled: true },
  });
}

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

describe('SessionView (direct sessions)', () => {
  const canonicalDraftScope: ServerAccountScope = {
    serverId: 'server-canonical',
    accountId: 'account-canonical',
  };

  function useCanonicalDraftScope() {
    activeServerAccountScopeState.current = canonicalDraftScope;
  }

  function writeCanonicalSessionDraft(input: Readonly<{
    text?: string;
    recipient?: unknown;
    executionRunRequestedAction?: unknown;
    mentions?: readonly unknown[];
  }>) {
    writeExistingSessionDraft({
      scope: canonicalDraftScope,
      sessionId: 's1',
      patch: {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.mentions === undefined
          ? {}
          : { mentions: input.mentions.map((mention) => StrictJsonValueSchema.parse(mention)) }),
        routing: {
          ...(input.recipient === undefined
            ? {}
            : { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: input.recipient }) }),
          ...(input.executionRunRequestedAction === undefined
            ? {}
            : { executionRunRequestedAction: StrictJsonValueSchema.parse(input.executionRunRequestedAction) }),
        },
      },
    });
  }

  function readCanonicalSessionDraft() {
    const document = getSessionDraftSnapshot(canonicalDraftScope, { kind: 'session', sessionId: 's1' })?.document;
    return document?.target.kind === 'session' ? document : null;
  }

  function readCanonicalDraftRecipient(): unknown {
    const document = readCanonicalSessionDraft();
    if (!document || document.target.kind !== 'session') return undefined;
    const value = document.target.routing.recipient.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.mode === 'manual' ? candidate.recipient : undefined;
  }

  function readCanonicalDraftRequestedAction(): unknown {
    const document = readCanonicalSessionDraft();
    return document?.target.kind === 'session'
      ? document.target.routing.executionRunDelivery.value
      : undefined;
  }

  function readCanonicalDraftMentions(): unknown {
    return readCanonicalSessionDraft()?.composer.mentions.value;
  }

  function clearCanonicalSessionDraft() {
    deleteSessionDraft({
      scope: canonicalDraftScope,
      address: { kind: 'session', sessionId: 's1' },
    });
  }

  async function renderSessionView() {
    if (recipientStateState.current.recipient) {
      writeCanonicalSessionDraft({ recipient: recipientStateState.current.recipient,
        executionRunRequestedAction: recipientStateState.current.executionRunRequestedAction });
    }
    syncShellStorageStore();
    const session = storageState.sessions.s1;
    wireSession = SessionCurrentProjectionRecordV1Schema.parse({
      ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
      ...(session.lastRuntimeIssue ? { lastRuntimeIssue: SessionRuntimeIssueV1Schema.parse(session.lastRuntimeIssue) } : {}),
      effectiveAccess: { v: 1, level: session.access.level, sources: [{ kind: 'owner' }], capabilities: session.access.capabilities },
      responsibleAccountId: null, responsibleAccount: null, share: null,
      archivedAt: null, agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: session.pendingVersion ?? 0,
    });
    return renderScreen(
      <InjectedAuthProvider credentials={shellCredentials}>
        <AppPaneProvider>
          <SessionView id="s1" routeServerId="server-canonical" surfaceFocusedOverride={focusState.current} />
        </AppPaneProvider>
      </InjectedAuthProvider>,
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

  function findWarningActionBannerProps(testID: string) {
    return warningActionBannerPropsSpy.mock.calls
      .map(([props]) => props)
      .find((props) => props?.testID === testID);
  }

  beforeEach(async () => {
    wireSession = null;
    wireMachine = null;
    await loadSyncSingletonForTests();
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: 3 };
    pendingHttpSpy.mockReset();
    pendingHttpSpy.mockResolvedValue(Response.json({ error: 'Session input refused', code: 'session_input_target_unavailable' }, { status: 409 }));
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://server-canonical', accountId: 'account-canonical',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
        if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-canonical', ...storageState.profile });
        if (path === '/v1/machines') return Response.json(wireMachine ? [wireMachine] : []);
        if (path === '/v1/machines/machine-1' && wireMachine) return Response.json({ machine: wireMachine });
        if (path.endsWith('/pending') && init?.method === 'POST') return pendingHttpSpy(path, JSON.parse(String(init.body)));
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/sessions/s1' && wireSession) {
          if (init?.method === 'PATCH') {
            const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
            if (patch.mode === 'shared_editor') throw new Error('This Account fixture owns the Session metadata');
            const target = patch.mode === 'owner_migration' ? patch.target : patch;
            wireSession = SessionCurrentProjectionRecordV1Schema.parse({
              ...wireSession, metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
              ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
              metadataVersion: wireSession.metadataVersion + 1, agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1,
            });
            return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({
              success: true, metadataLayoutVersion: 1, sharedMetadata: { version: wireSession.metadataVersion },
              agentState: { version: wireSession.agentStateVersion },
            }));
          }
          return Response.json({ session: wireSession });
        }
        if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
        return Response.json({ error: 'not_found' }, { status: 404 });
      },
    });
    shellCredentials = connection.credentials;
    onTestFinished(() => connection.dispose());
    expect(connection.home.id).toBe('server-canonical');
    await waitForHomeGovernance(() => expect(canonicalStorage.getState().endpointStatus).toBe('online'));
    const { sync } = await import('@/sync/sync');
    outboundMessageAckSpy.mockReset();
    outboundMessageAckSpy.mockResolvedValue({ ok: true, id: 'committed-user-message', seq: 2, localId: null, didWrite: true });
    sync.setMessageTransport({
      // A remote transport reply is generic until Sync validates the owning response schema.
      emitWithAck: async <T,>(event: string, payload: unknown) => await outboundMessageAckSpy(event, payload) as T,
      send: vi.fn(),
    });
    onTestFinished(() => sync.resetMessageTransport());
    activeServerAccountScopeState.current = canonicalDraftScope;
    createDefaultActionExecutorMock.mockReset();
    chatListPropsSpy.mockReset();
    chatHeaderPropsSpy.mockReset();
    voiceSurfacePropsSpy.mockReset();
    warningActionBannerPropsSpy.mockClear();
    featureEnabledState.voice = false;
    featureEnabledState['execution.runs'] = false;
    featureEnabledState['files.reviewComments'] = false;
    delete (featureEnabledState as Record<string, boolean>)['sessions.usageLimitRecovery'];
    sessionExecutionRunsSupportedState.current = false;
    daemonMergedProjectionState.current = { phase: 'idle', inputs: null };
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
    machineExternalSessionTakeoverSpy.mockReset();
    machineExternalSessionTakeoverPersistSpy.mockReset();
    const acceptedTakeover = (input: ReturnType<typeof ExternalSessionTakeoverStartInputV1Schema.parse>) => {
      const request = input.request;
      return {
      ok: true,
      progress: ExternalSessionOperationProgressV1Schema.parse({
        v: 1, operationId: 'operation-1', revision: 1,
        request: { plan: request.plan, targetStorageMode: request.targetStorageMode,
          targetRuntimeMode: request.targetRuntimeMode, targetDirectory: request.targetDirectory },
        status: 'running', phase: 'validating', timeline: request.targetStorageMode === 'persisted'
          ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked, updatedAtMs: Date.now(),
        priorStableStorage: { state: 'machine_only' }, currentStorageState: 'machine_only',
        checkpoint: { sourcePagesRead: 0, stagedItemCount: 0, importedItemCount: 0,
          requiredItemFailures: { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false } },
        fence: { kind: 'none' },
      }),
      };
    };
    machineExternalSessionTakeoverSpy.mockImplementation(acceptedTakeover);
    machineExternalSessionTakeoverPersistSpy.mockImplementation(acceptedTakeover);
    transcriptPageReply.mockReset();
    transcriptPageReply.mockResolvedValue({ ok: true, items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false });
    transcriptReadAfterReply.mockReset();
    transcriptReadAfterReply.mockImplementation(async (request:
      ReturnType<typeof ExternalSessionTranscriptRefreshReadAfterRequestV1Schema.parse>
      | ReturnType<typeof ExternalSessionTranscriptReadAfterRequestSchema.parse>) => (
      'v' in request
        ? { v: 1, binding: request.binding, result: { outcome: 'already_current' } }
        : { ok: true, items: [], nextCursor: null, truncated: false, hasMore: false }
    ));
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
    sessionTranscriptRenderState.current = { ids: ['m1'], isLoaded: true };
    storageState.sessionTranscriptLoadIssues = {};
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
      serverId: 'server-canonical',
      seq: 1,
      encryptionMode: 'plain',
      presence: 'offline',
      active: true,
      currentStorageState: 'machine_only',
      accessLevel: 'edit',
      canApprovePermissions: false,
      access: createSessionAccessFixture('edit', { approveRuntimePermissions: false }),
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
    storageState.sessionListRowsByServerId = {};
    storageState.ordinarySessionListMembershipByServerId = {};
    storageState.machines = {};
    syncShellStorageStore();
    recipientStateState.current = {
      recipient: null,
      setManualRecipient: vi.fn(),
      clearPersistedManualRecipient: vi.fn(),
      executionRunRequestedAction: { v: 1, kind: 'steer_if_active' },
      setExecutionRunRequestedAction: vi.fn(),
    };
    resetSessionDraftRepositoryForTests();
    showExternalSessionTakeoverDialogSpy.mockResolvedValue({ action: null });
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

    expect(chatListPropsSpy).toHaveBeenCalled();
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
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith(expect.objectContaining({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      target: expect.objectContaining({
        machineId: 'machine-1',
        machineHomeDir: '/tmp',
        initialDirectory: '/tmp',
      }),
    }));
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
  });

  it('keeps the external control footer reference stable across unrelated shell renders', async () => {
    let forceShellRender: (() => void) | null = null;
    function ShellRenderHarness() {
      const [renderSequence, setRenderSequence] = React.useState(0);
      forceShellRender = () => setRenderSequence((current) => current + 1);
      return (
        <InjectedAuthProvider credentials={shellCredentials}><AppPaneProvider>
          {React.createElement('View', { testID: 'shell-render-marker', accessibilityLabel: String(renderSequence) })}
          <SessionView
            id="s1"
            routeServerId="server-canonical"
            paneUrlState={renderSequence === 0
              ? null
              : { key: `unrelated-shell-render-${renderSequence}` } as any}
          />
        </AppPaneProvider></InjectedAuthProvider>
      );
    }
    const screen = await renderScreen(<ShellRenderHarness />);
    await settleExternalSessionView();
    const initialFooter = chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter;
    expect(initialFooter).toBeTruthy();
    expect(screen.findByTestId('shell-render-marker')?.props.accessibilityLabel).toBe('0');

    await act(async () => {
      forceShellRender?.();
    });
    await settleExternalSessionView();

    expect(screen.findByTestId('shell-render-marker')?.props.accessibilityLabel).toBe('1');
    expect(chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter).toBe(initialFooter);
    await act(async () => { await initialFooter.onRequestTakeoverPreflight(); });
    await settleExternalSessionView();
    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(chatListPropsSpy.mock.calls.at(-1)?.[0]?.externalControlFooter).toMatchObject({
      statusKnown: true, canTakeOverDirect: true, canTakeOverPersist: true,
    });
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

  it('gives a recoverable external operation exclusive composer admission', async () => {
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

    const screen = await renderSessionViewAndSettle();
    const agentInput = findAgentInput(screen);
    expect(agentInput.props.isSendDisabled).toBe(true);
    expect(agentInput.props.disabled).toBe(true);
    expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 's1' })?.state)
      .toMatchObject({ editable: false, submittable: false });

    machineExternalSessionStatusGetSpy.mockClear();
    machineExternalSessionTakeoverSpy.mockClear();
    showExternalSessionTakeoverDialogSpy.mockResolvedValue({ action: 'direct' });
    await act(async () => {
      agentInput.props.onSend({ inputTextOverride: 'do not start another operation' });
      await Promise.resolve();
    });
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();

    const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    const previousDraft = findAgentInput(screen).props.value;
    await act(async () => {
      chatListProps?.onEditPendingMessage?.({
        id: 'pending-1',
        text: 'queued text',
        displayText: 'queued text',
        message: { id: 'pending-1', localId: 'pending-1' },
      });
    });
    expect(findAgentInput(screen).props.value).toBe(previousDraft);
  });

  it('places pending-message references into the editable composer document', async () => {
    expect(composerStructuredMentionsFromReferences({
      existing: [],
      references: placePositionlessComposerReferences({
        text: 'inspect @src/a.ts',
        references: [{ kind: 'file', ref: 'src/a.ts', token: '@src/a.ts' }],
      }),
    })).toEqual([{
      kind: 'file',
      ref: 'src/a.ts',
      tokenText: '@src/a.ts',
      start: 8,
      end: 17,
    }]);
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

    const screen = await renderSessionViewAndSettle();

    const banner = findWarningActionBannerProps('session.externalTranscript.snapshot');
    expect(banner).toBeDefined();
    expect(banner).toMatchObject({ tone: 'neutral' });
    expect(banner).not.toHaveProperty('body');
    expect(banner).not.toHaveProperty('actionLabel');
    expect(banner).not.toHaveProperty('actionTestID');
    expect(banner).not.toHaveProperty('onActionPress');
  });

  it('says the visible transcript is the last known one when a refresh fails over retained rows', async () => {
    await renderSessionViewAndSettle();

    const shellStorageStore = shellStorageStoreState.current;
    if (!shellStorageStore) throw new Error('Expected SessionView test storage to be mounted');
    await act(async () => {
      shellStorageStore.setState((state) => ({
        ...state,
        sessionTranscriptLoadIssues: {
          ...state.sessionTranscriptLoadIssues,
          s1: { kind: 'source_discontinuity' },
        },
      }));
    });
    await settleExternalSessionView();

    const banners = warningActionBannerPropsSpy.mock.calls
      .map(([props]) => props)
      .filter((props) => props?.testID === 'session.externalTranscript.loadIssue');
    expect(banners.length).toBeGreaterThan(0);
    expect(banners.at(-1)).toMatchObject({
      title: 'externalSessions.transcriptRetainedRefreshFailedTitle',
      body: 'externalSessions.transcriptLoadFailed',
      actionLabel: 'common.retry',
    });
  });

  it('renders a retryable typed transcript-load issue instead of an authoritative empty state', async () => {
    const session = storageState.sessions.s1 as any;
    session.seq = 0;
    // A refresh needs a generation-qualified live source; a legacy viewer lease is not read authority.
    session.metadata.externalSessionV1.linkedAtMs = 1;
    sessionTranscriptRenderState.current = { ids: [], isLoaded: false };

    const screen = await renderSessionViewAndSettle();

    const shellStorageStore = shellStorageStoreState.current;
    if (!shellStorageStore) throw new Error('Expected SessionView test storage to be mounted');
    await act(async () => {
      shellStorageStore.setState((state) => ({
        ...state,
        sessionTranscriptLoadIssues: {
          ...state.sessionTranscriptLoadIssues,
          s1: { kind: 'read_failed', errorCode: 'agent_unavailable' },
        },
      }));
    });
    await settleExternalSessionView();

    const banners = screen.findAllByType('WarningActionBanner').filter((node) => node.props.testID === 'session.externalTranscript.loadIssue');
    expect(banners).toHaveLength(1);
    const banner = banners[0].props;
    expect(banner).toMatchObject({
      title: 'externalSessions.sharingTranscriptUnavailableTitle',
      body: 'externalSessions.browseAgentUnavailable',
      actionLabel: 'common.retry',
      actionTestID: 'session.externalTranscript.loadIssue.retry',
    });

    const refresh = createDeferred<ReturnType<typeof ExternalSessionTranscriptPageResponseSchema.parse>>();
    onTestFinished(() => refresh.resolve(ExternalSessionTranscriptPageResponseSchema.parse({
      ok: false, errorCode: 'agent_unavailable', error: 'Agent unavailable',
    })));
    transcriptPageReply.mockClear();
    transcriptPageReply.mockReturnValueOnce(refresh.promise);
    await act(async () => {
      void banner.onActionPress();
      void banner.onActionPress();
      await Promise.resolve();
    });
    await waitForHomeGovernance(() => expect(transcriptPageReply).toHaveBeenCalledTimes(1));
    expect(transcriptPageReply).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1', remoteSessionId: 'vendor-session-1', direction: 'older',
    }));
    refresh.resolve(ExternalSessionTranscriptPageResponseSchema.parse({ ok: false, errorCode: 'agent_unavailable', error: 'Agent unavailable' }));
    await act(async () => {
      await refresh.promise;
    });
    await waitForHomeGovernance(() => expect(shellStorageStore.getState().sessionTranscriptLoadIssues.s1)
      .toMatchObject({ kind: 'read_failed', errorCode: 'agent_unavailable' }));
  });

  it('tells a transcript read that timed out apart from an unavailable Agent', async () => {
    const session = storageState.sessions.s1 as any;
    session.seq = 0;
    sessionTranscriptRenderState.current = { ids: [], isLoaded: false };

    await renderSessionViewAndSettle();

    const shellStorageStore = shellStorageStoreState.current;
    if (!shellStorageStore) throw new Error('Expected SessionView test storage to be mounted');
    await act(async () => {
      shellStorageStore.setState((state) => ({
        ...state,
        sessionTranscriptLoadIssues: {
          ...state.sessionTranscriptLoadIssues,
          s1: { kind: 'read_failed', errorCode: 'agent_timeout' },
        },
      }));
    });
    await settleExternalSessionView();

    const banners = warningActionBannerPropsSpy.mock.calls
      .map(([props]) => props)
      .filter((props) => props?.testID === 'session.externalTranscript.loadIssue');
    expect(banners.at(-1)).toMatchObject({
      body: 'externalSessions.browseAgentTimedOut',
      actionLabel: 'common.retry',
    });
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

    const banner = findWarningActionBannerProps('session.externalTranscript.snapshot');
    expect(banner).toBeDefined();
    expect(banner).toMatchObject({ tone: 'neutral' });
    expect(banner).not.toHaveProperty('body');
    expect(banner).not.toHaveProperty('actionLabel');
    expect(banner).not.toHaveProperty('actionTestID');
    expect(banner).not.toHaveProperty('onActionPress');
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
    const screen = await renderSessionView();
    await settleExternalSessionView();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
    machineExternalSessionDetachSpy.mockClear();

    focusState.current = false;
    act(() => {
      screen.tree.update(
        <InjectedAuthProvider credentials={shellCredentials}><AppPaneProvider>
          <SessionView id="s1" routeServerId="server-canonical" surfaceFocusedOverride={false} />
        </AppPaneProvider></InjectedAuthProvider>,
      );
    });
    await settleExternalSessionView();

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 's1',
      leaseId: 'lease-1',
    });
  });

  it('builds the default action executor from the local session target helper', async () => {
    await renderSessionView();

    expect(createDefaultActionExecutorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveServerIdForSessionId: expect.any(Function),
      }),
    );
    const resolveServerIdForSessionId = createDefaultActionExecutorMock.mock.calls[0]?.[0]?.resolveServerIdForSessionId;
    expect(resolveServerIdForSessionId?.('s1')).toBe('server-canonical');
    expect(resolveServerIdForSessionId?.('unknown-session')).toBeNull();
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

    for (const artifact of Object.values(storageState.artifacts)) {
      const request = ApprovalRequestV1Schema.parse({
        v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: artifact.header.sessionId },
        requestedSurface: 'agent', actionId: artifact.header.actionId,
        actionArgs: {}, summary: artifact.header.approvalSummary,
      });
      artifact.header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'server-canonical' });
      artifact.body = JSON.stringify(request);
      artifact.bodyVersion = 1;
    }

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
    session.access = createSessionAccessFixture('owner');
    session.accessLevel = 'owner';
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
    expect(agentInput.props.agentPickerSelectedOptionId).toBeNull();
    expect(agentInput.props.agentPickerApplyLabel).toBeUndefined();
    expect(agentInput.props.metadata).toEqual(session.metadata);
    expect(typeof agentInput.props.onModelModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpSessionModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpConfigOptionChange).toBe('function');

    await act(async () => {
      agentInput.props.onAcpSessionModeChange('plan');
    });
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)?.sessionModeOverrideV1)
      .toMatchObject({ modeId: 'plan' }));
    await act(async () => { findAgentInput(screen).props.onAcpConfigOptionChange('thinking', 'high'); });
    await waitForHomeGovernance(() => expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)?.acpConfigOptionOverridesV1)
      .toMatchObject({ overrides: { thinking: { value: 'high' } } }));
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
    expect(agentInput.props.agentType).toBe('customAcp');
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
      serverId: 'server-canonical',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1,
    });
  });

  it('applies connected-service reset credits from the usage-limit recovery banner', async () => {
    daemonMergedProjectionState.current = { phase: 'ready', inputs: {
      pluginProjectionById: {},
      pluginProjectionV2: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
        codex: { id: 'codex', identity: { pluginId: 'happier.codex', localId: 'codex' }, capabilities: {
          sessions: { open: ['resume'], delivery: ['newTurn'], cancel: true, usageLimitRecovery: { active: ['checkNow'] } },
        } },
      } }),
    } };
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
      serverId: 'server-canonical',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1000,
    });
    expect(sessionUsageLimitConsumeResetCreditSpy).not.toHaveBeenCalled();
  });

  it('uses the current external Agent usage-recovery declaration for check-now', async () => {
    (featureEnabledState as Record<string, boolean>)['sessions.usageLimitRecovery'] = true;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      metadata: {
        machineId: 'machine-1',
        host: 'happy-host',
        path: '/tmp',
        homeDir: '/tmp',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acme-lifecycle',
          agent: { providerSessionId: 'acme-session-1' },
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        agentId: 'acme-lifecycle',
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    };
    daemonMergedProjectionState.current = {
      phase: 'ready',
      inputs: {
        pluginProjectionById: {},
        pluginProjectionV2: PluginProjectionV2Schema.parse({
          v: 2,
          generation: 42,
          agentsById: {
            'acme-lifecycle': {
              id: 'acme-lifecycle',
              identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
              capabilities: {
                sessions: {
                  open: ['resume'],
                  delivery: ['newTurn'],
                  cancel: true,
                  usageLimitRecovery: { active: ['checkNow'] },
                },
              },
            },
          },
        }),
      },
    } as any;

    await renderSessionViewAndSettle();

    expect(findWarningActionBannerProps('session-usageLimit-recovery')?.secondaryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'check_now',
        testID: 'session-usageLimit-recovery-checkNow',
      }),
    ]));
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
      serverId: 'server-canonical',
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
          status: 'ok',
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
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      setExecutionRunRequestedAction: vi.fn(),
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
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).toContain('execution-run-requested-action');
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
    settingByKeyState.current.sessionMessageSendMode = 'agent_queue';
    (storageState.sessions.s1 as any).pendingVersion = 2;
    storageState.sessions.s1.metadata.version = MINIMUM_CLI_PENDING_QUEUE_V2_VERSION;
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
    storageState.sessionListRowsByServerId = {
      'server-canonical': {
        s1: {
          id: 's1',
          metadata: {
            machineId: 'machine-1',
            path: '/tmp',
          },
        },
      },
    };
    storageState.ordinarySessionListMembershipByServerId = {
      'server-canonical': ['s1'],
    };
    (storageState as any).machines = {
      'machine-1': {
        id: 'machine-1',
        active: true,
        metadata: { host: 'happy-host' },
      },
    };
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });
    pendingHttpSpy.mockImplementationOnce(async (_path, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected Pending enqueue body');
      const body = input as Readonly<Record<string, unknown>>;
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });

    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    await waitForHomeGovernance(() => expect(pendingHttpSpy).toHaveBeenCalled());
    expect(pendingHttpSpy).toHaveBeenCalledWith('/v2/sessions/s1/pending', expect.objectContaining({
      content: { t: 'plain', v: expect.objectContaining({
        content: expect.objectContaining({ text: expect.stringContaining('Send this comment.') }),
        meta: expect.objectContaining({ happier: expect.objectContaining({
          kind: 'review_comments.v1', payload: expect.objectContaining({ comments: [expect.objectContaining({ id: 'included-draft' })] }),
        }) }),
      }) },
    }));
    expect(JSON.stringify(pendingHttpSpy.mock.calls)).not.toContain('Keep this comment for later.');
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey({
      serverId: 'server-canonical', machineId: 'machine-1', rootPath: '/tmp',
    })]?.map((draft) => draft.id)).toEqual(['detached-draft']));
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
      recipient: null,
      setManualRecipient: vi.fn(),
      clearPersistedManualRecipient: vi.fn(),
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      setExecutionRunRequestedAction: vi.fn(),
    };

    const screen = await renderSessionViewAndSettle();

    const agentInput = findAgentInput(screen);
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).not.toContain('participants-recipient');
    expect((agentInput.props.extraActionChips ?? []).map((chip: { key: string }) => chip.key)).not.toContain('execution-run-requested-action');
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
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      setExecutionRunRequestedAction: vi.fn(),
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
    }) => chip.key === 'execution-run-requested-action');

    expect(deliveryChip).toEqual(expect.objectContaining({
      key: 'execution-run-requested-action',
      controlId: 'delivery',
    }));
    expect(deliveryChip?.collapsedOptionsPopover?.label).toBe('runs.delivery.cardDelivery');
    expect(deliveryChip?.collapsedOptionsPopover?.presentation).toBe('list');
    const deliveryFirstSection = deliveryChip?.collapsedOptionsPopover?.rootStep?.sections?.[0];
    const deliveryOptions = deliveryFirstSection?.kind === 'static'
      ? deliveryFirstSection.options ?? []
      : [];
    expect(deliveryOptions.map((option: { id: string }) => option.id)).toEqual([
      'enqueue',
      'steer_if_active',
      'send_now',
    ]);
    expect(deliveryChip?.collapsedOptionsPopover?.selectedOptionId).toBe('send_now');
    expect(typeof deliveryChip?.collapsedOptionsPopover?.onSelect).toBe('function');
  });

  it('passes storage and provider badges to the session header for direct sessions', async () => {
    await renderSessionViewAndSettle();

    expect(chatHeaderPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      badges: ['sessionsList.storageExternalFilter', 'Codex'],
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
    expect(transcriptPageReply).not.toHaveBeenCalled();

    await act(async () => {
      await sleep(75);
    });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(transcriptPageReply).not.toHaveBeenCalled();
  });

  it('locally expires pushed external-Agent footer status without a status RPC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
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
      observedAtMs: 1_000,
      expiresAtMs: 1_500,
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

    await flushHookEffects({ advanceTimersMs: 500, cycles: 1, turns: 2 });

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

  it('starts takeover on the selected fixed-machine path, never the remote source path', async () => {
    const remoteProviderDirectory = '/remote/provider/workspace';
    const localMachineHomeDirectory = '/local/linked-machine-home';
    const selectedLocalDirectory = '/local/selected/workspace';
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({
      action: 'direct',
      targetDirectory: selectedLocalDirectory,
    });
    (storageState.sessions.s1 as any).metadata.path = remoteProviderDirectory;
    (storageState.sessions.s1 as any).metadata.homeDir = localMachineHomeDirectory;
    storageState.machines['machine-1'] = createMachineFixture({
      metadata: { ...createMachineFixture().metadata!, homeDir: localMachineHomeDirectory },
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
    useCanonicalDraftScope();
    writeCanonicalSessionDraft({
      recipient: { kind: 'execution_run', runId: 'run-1' },
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
    });
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
      target: {
        machineId: 'machine-1',
        machineHomeDir: localMachineHomeDirectory,
        initialDirectory: localMachineHomeDirectory,
        serverId: 'server-canonical',
      },
    });
    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith({
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
        targetStorageMode: 'external-linked',
        targetDirectory: selectedLocalDirectory,
        targetRuntimeMode: 'terminal',
      },
    });
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('continue this session');
    expect(readCanonicalDraftRecipient()).toEqual({ kind: 'execution_run', runId: 'run-1' });
    expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'send_now' });
    expect(readCanonicalDraftMentions()).toEqual([{
      kind: 'skill',
      tokenText: 'continue',
      start: 0,
      end: 8,
      name: 'continue',
    }]);

  });

  it('keeps the composer draft and emits no input when fresh external status is unavailable', async () => {
    machineExternalSessionStatusGetSpy.mockRejectedValueOnce(new Error('Failed to fetch'));
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('draft survives unavailable status');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('draft survives unavailable status');
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionStatusUnavailable',
    );
  });

  it('does not submit a late send after SessionView unmounts during external-status admission', async () => {
    const statusRead = createDeferred<unknown>();
    machineExternalSessionStatusGetSpy.mockReturnValueOnce(statusRead.promise);
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('do not send after unmount');
      agentInput.props.onSend();
      await Promise.resolve();
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await screen.unmount();
    });

    await act(async () => {
      statusRead.resolve({
        ok: true,
        machineOnline: true,
        runnerActive: true,
        activity: 'running',
        canTakeOverDirect: false,
        canTakeOverPersist: false,
        canForceStop: false,
      });
      await Promise.resolve();
    });
    await settleExternalSessionView();

    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(sendVoiceSessionComposerTextSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });

  it('admits one pending execution action at a time and releases admission for retry', async () => {
    featureEnabledState['execution.runs'] = true;
    sessionExecutionRunsSupportedState.current = true;
    const actionExecution = createDeferred<{ ok: true; result: { runId: string } }>();
    const executeAction = vi.fn(() => actionExecution.promise);
    createDefaultActionExecutorMock.mockReturnValue({ execute: executeAction });
    const screen = await renderSessionView();
    const agentInput = findAgentInput(screen);
    const sendOptions = { inputTextOverride: '/review review this external session' };

    await act(async () => {
      agentInput.props.onSend(sendOptions);
      agentInput.props.onSend(sendOptions);
      await Promise.resolve();
    });

    try {
      expect(executeAction).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        actionExecution.resolve({ ok: true, result: { runId: 'run-1' } });
        await actionExecution.promise;
      });
    }
    await settleExternalSessionView();

    await act(async () => {
      agentInput.props.onSend(sendOptions);
      await Promise.resolve();
    });

    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it('keeps execution-run dispatch behind external takeover admission', async () => {
    recipientStateState.current = {
      recipient: { kind: 'execution_run', runId: 'run-1' },
      setManualRecipient: vi.fn(),
      clearPersistedManualRecipient: vi.fn(),
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      setExecutionRunRequestedAction: vi.fn(),
    };
    const screen = await renderSessionView();

    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('keep this execution draft');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith(expect.objectContaining({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      target: expect.objectContaining({
        machineId: 'machine-1',
        machineHomeDir: '/tmp',
        initialDirectory: '/tmp',
      }),
    }));
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('keep this execution draft');
  });

  it('keeps the composer text when direct takeover is cancelled from the send prompt', async () => {
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null });
    useCanonicalDraftScope();
    writeCanonicalSessionDraft({
      recipient: { kind: 'execution_run', runId: 'run-1' },
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
    });
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
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('draft stays here');
    expect(readCanonicalDraftRecipient()).toEqual({ kind: 'execution_run', runId: 'run-1' });
    expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'send_now' });
    expect(readCanonicalDraftMentions()).toEqual([{
      kind: 'skill',
      tokenText: 'draft',
      start: 0,
      end: 5,
      name: 'draft',
    }]);

  });

  it('retains an unchanged composer snapshot when the Run pending admission is rejected', async () => {
    settingByKeyState.current.sessionMessageSendMode = 'agent_queue';
    (storageState.sessions.s1 as any).pendingVersion = 2;
    const recipient = { kind: 'execution_run' as const, runId: 'run-restored' };
    const mention = {
      kind: 'skill' as const,
      tokenText: '$restored',
      start: 20,
      end: 29,
      name: 'restored',
    };
    const pendingReply = createDeferred<Response>();

    useCanonicalDraftScope();
    clearCanonicalSessionDraft();
    writeCanonicalSessionDraft({
      recipient,
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      mentions: [mention],
    });

    pendingHttpSpy.mockReturnValueOnce(pendingReply.promise);
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });

    try {
      const screen = await renderSessionView();
      let agentInput = findAgentInput(screen);
      await act(async () => {
        agentInput.props.onChangeText('restore this prompt $restored');
      });

      await act(async () => {
        agentInput.props.onSend();
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      await waitForHomeGovernance(() => expect(pendingHttpSpy).toHaveBeenCalledWith(
        '/v2/sessions/s1/execution-runs/run-restored/pending', expect.objectContaining({
          v: 1, targetMachineId: 'machine-1', requestedAction: { v: 1, kind: 'send_now' },
          content: { t: 'plain', v: expect.objectContaining({
            meta: expect.objectContaining({ happier: { kind: 'participant_message.v1', payload: { recipient } } }),
          }) },
        })));
      expect(readCanonicalDraftRecipient()).toEqual(recipient);
      expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'send_now' });
      expect(readCanonicalDraftMentions()).toEqual([mention]);

      await act(async () => {
        pendingReply.resolve(Response.json({ code: 'session_input_target_unavailable' }, { status: 409 }));
      });
      await settleExternalSessionView();
      await waitForHomeGovernance(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session_input_target_unavailable'));

      agentInput = findAgentInput(screen);
      expect(agentInput.props.value).toBe('restore this prompt $restored');
      expect(readCanonicalDraftRecipient()).toEqual(recipient);
      expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'send_now' });
      expect(readCanonicalDraftMentions()).toEqual([mention]);
    } finally {
      pendingReply.resolve(Response.json({ code: 'session_input_target_unavailable' }, { status: 409 }));
      clearCanonicalSessionDraft();
      resetSessionDraftRepositoryForTests();
    }
  });

  it('does not overwrite a newer authored draft after Run pending admission is rejected', async () => {
    settingByKeyState.current.sessionMessageSendMode = 'agent_queue';
    (storageState.sessions.s1 as any).pendingVersion = 2;
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
    const pendingReply = createDeferred<Response>();

    useCanonicalDraftScope();
    clearCanonicalSessionDraft();
    writeCanonicalSessionDraft({
      recipient: oldRecipient,
      executionRunRequestedAction: { v: 1, kind: 'send_now' },
      mentions: [oldMention],
    });

    pendingHttpSpy.mockReturnValueOnce(pendingReply.promise);
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });

    try {
      const screen = await renderSessionView();
      let agentInput = findAgentInput(screen);
      await act(async () => {
        agentInput.props.onChangeText('send to $old target');
      });

      await act(async () => {
        agentInput.props.onSend();
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      await waitForHomeGovernance(() => expect(pendingHttpSpy).toHaveBeenCalledWith(
        '/v2/sessions/s1/execution-runs/run-old/pending', expect.objectContaining({
          v: 1, targetMachineId: 'machine-1', requestedAction: { v: 1, kind: 'send_now' },
          content: { t: 'plain', v: expect.objectContaining({
            meta: expect.objectContaining({ happier: { kind: 'participant_message.v1', payload: { recipient: oldRecipient } } }),
          }) },
        })));
      expect(readCanonicalDraftRecipient()).toEqual(oldRecipient);
      expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'send_now' });
      expect(readCanonicalDraftMentions()).toEqual([oldMention]);

      agentInput = findAgentInput(screen);
      const onStructuredInputMentionsChange = agentInput.props.onStructuredInputMentionsChange;
      if (typeof onStructuredInputMentionsChange !== 'function') {
        throw new Error('Expected SessionView to expose the structured-mention owner');
      }
      await act(async () => {
        agentInput.props.onChangeText('send to $new target');
        writeCanonicalSessionDraft({
          recipient: newRecipient,
          executionRunRequestedAction: { v: 1, kind: 'enqueue' },
        });
        onStructuredInputMentionsChange([newMention]);
      });

      await act(async () => {
        pendingReply.resolve(Response.json({ code: 'session_input_target_unavailable' }, { status: 409 }));
      });
      await settleExternalSessionView();
      await waitForHomeGovernance(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session_input_target_unavailable'));

      agentInput = findAgentInput(screen);
      expect(agentInput.props.value).toBe('send to $new target');
      expect(readCanonicalDraftRecipient()).toEqual(newRecipient);
      expect(readCanonicalDraftRequestedAction()).toEqual({ v: 1, kind: 'enqueue' });
      expect(readCanonicalDraftMentions()).toEqual([newMention]);
    } finally {
      pendingReply.resolve(Response.json({ code: 'session_input_target_unavailable' }, { status: 409 }));
      clearCanonicalSessionDraft();
      resetSessionDraftRepositoryForTests();
    }
  });

  it('keeps the composer text while a direct takeover send prompt is still pending', async () => {
    showExternalSessionTakeoverDialogSpy.mockImplementationOnce(
      () => new Promise<{
        action: 'direct' | 'persisted' | 'recheck' | null;
        targetDirectory?: string;
      }>(() => {}),
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
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();

  });

  it('uses canonical public intent without emitting input when persisting takeover from the send prompt', async () => {
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({
      action: 'persisted',
      targetDirectory: '/tmp',
    });
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
        targetDirectory: '/tmp',
        targetRuntimeMode: 'terminal',
      },
    });
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('persist this');

  });

  it('keeps an external-linked Voice composer draft while takeover admission is declined', async () => {
    sendVoiceSessionComposerTextSpy.mockResolvedValueOnce({ ok: true });
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue({
      kind: 'adapter_text',
      binding: {
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        controlSessionId: 'voice-global',
        conversationSessionId: 's1',
        transcriptMode: 'synthetic',
        targetSessionId: null,
        updatedAt: 1,
      },
    });
    const screen = await renderSessionView();

    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('keep this Voice draft');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });
    await settleExternalSessionView();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith(expect.objectContaining({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      target: expect.objectContaining({
        machineId: 'machine-1',
        machineHomeDir: '/tmp',
        initialDirectory: '/tmp',
      }),
    }));
    expect(sendVoiceSessionComposerTextSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('keep this Voice draft');
  });

  it('routes hidden Voice conversation sends after external runner admission is verified', async () => {
    machineExternalSessionStatusGetSpy.mockResolvedValueOnce({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });
    sendVoiceSessionComposerTextSpy.mockImplementationOnce(() => new Promise(() => {}) as any);
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue({
      kind: 'adapter_text',
      binding: {
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
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
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();

  });

  it('routes hidden Voice conversation sends without external admission', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    const metadata = { ...session.metadata };
    delete metadata.externalSessionV1;
    session.metadata = metadata;
    sendVoiceSessionComposerTextSpy.mockImplementationOnce(() => new Promise(() => {}) as any);
    resolveVoiceSessionComposerRoutingSpy.mockReturnValue({
      kind: 'adapter_text',
      binding: {
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
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
      agentInput.props.onChangeText('ordinary voice conversation');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(sendVoiceSessionComposerTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationSessionId: 's1',
        text: 'ordinary voice conversation',
      }),
    );
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();
  });

  it('shows the adapter send error when a hidden voice conversation send fails', async () => {
    machineExternalSessionStatusGetSpy.mockResolvedValueOnce({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });
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
    expect(outboundMessageAckSpy).not.toHaveBeenCalled();

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
