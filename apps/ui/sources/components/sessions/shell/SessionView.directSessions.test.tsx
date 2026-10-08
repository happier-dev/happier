import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import 'fake-indexeddb/auto';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  buildSystemSessionMetadataV1,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderConnectionIdSchema,
  ProviderAccountUsageSnapshotV1Schema,
  SESSION_RUNNER_RUNTIME_METADATA_KEY,
  SessionCurrentProjectionRecordV1Schema,
  SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  SessionMetadataVersionConflictV1Schema,
  SessionMessageV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  SessionExecutionRunPendingEnqueueRequestV1Schema,
  SessionAgentTransitionRequestV1Schema,
  SessionContinuationInspectionBatchRequestV1Schema,
  tryWriteServerEnabledBitInPlace,
  StrictJsonValueSchema,
  type ProviderAccountUsageSnapshotV1,
  type SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import type { RestartStaleSessionRunnerResult } from '@/sync/ops/sessionRunnerRestart';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import type { sendVoiceSessionComposerText } from '@/voice/binding/sendVoiceSessionComposerText';
import type { Socket } from 'socket.io-client';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { SessionViewPresentation } from '@/components/sessions/shell/embedded/embeddedSessionPresentation';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { sessionRunnerRuntimeStatusRetention } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import {
  deleteSessionDraft,
  getSessionDraftSnapshot,
  resetSessionDraftRepositoryForTests,
  writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { SessionArmedAgentContinuation } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

// Responses are consumed only by the genuine Socket RPC boundary below;
// the Machine operations, schemas, routing, and Account admission stay real.
const machineDirectSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineDirectSessionTakeoverSpy = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true })));
const machineDirectSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true })));
let agentTransitionResult: 'accepted' | 'outcome_unknown' = 'accepted';
const syncSubmitMessageSpy = vi.hoisted(() => vi.fn(async (...args: unknown[]): Promise<unknown> => {
  const payload = args[0] as Readonly<{ localId: string }>;
  return { ok: true, id: 'direct-message-1', seq: 2, localId: payload.localId, didWrite: true };
}));
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
const sessionUsageLimitSwitchAccountNowSpy = vi.hoisted(() =>
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
const restartProviderBindingSessionRunnerSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<RestartStaleSessionRunnerResult>>(
    async (_request: unknown) => ({ ok: true, status: 'restarted', sessionId: 's1' }),
  ),
);
const restartConfigurationSessionRunnerSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<RestartStaleSessionRunnerResult>>(
    async (_request: unknown) => ({ ok: true, status: 'restarted', sessionId: 's1' }),
  ),
);
const getSessionRunnerRuntimeStatusSpy = vi.hoisted(() =>
  vi.fn<(_request: unknown) => Promise<unknown>>(async () => null),
);
const actionExecuteSpy = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, result: { ok: true } })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const voiceSurfacePropsSpy = vi.hoisted(() => vi.fn());
const sessionRpcWithPreferredSessionScopeSpy = vi.hoisted(() =>
  vi.fn<(..._args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => undefined),
);
const renderRealAgentInputPermissionSurfaceState = vi.hoisted(() => ({ current: false }));
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{
    action: 'direct' | 'persisted' | null;
    targetDirectory?: string;
  }>>(async () => ({ action: null })),
);
const sendVoiceSessionComposerTextSpy = vi.hoisted(() =>
  vi.fn<typeof sendVoiceSessionComposerText>(
    async (_params) => ({ ok: false as const, reason: 'not_voice_session' as const }),
  ),
);
const resolveVoiceSessionComposerRoutingSpy = vi.hoisted(() => vi.fn((_params: any): any => null));
const featureEnabledState = vi.hoisted(() => ({
  providers: false,
  voice: false,
  'files.reviewComments': false,
  'sessions.usageLimitRecovery': false,
  'connectedServices.quotas': false,
  'connectedServices.poolQuotaLimitSelection': false,
}));
const providerModelProjectionState = vi.hoisted(() => ({
  value: {
    data: null as any,
    error: null as any,
    loading: false,
    status: 'disabled' as 'disabled' | 'pending' | 'error' | 'success',
    refresh: vi.fn(async () => {}),
  },
  inputSpy: vi.fn(),
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
          agentId: 'codex',
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
  // Scenario inputs are applied through the canonical store before rendering.
  machines: {} as Record<string, any>,
  sessionListRowsByServerId: {} as Record<string, Record<string, any>>,
  ordinarySessionListMembershipByServerId: {} as Record<string, readonly string[]>,
  sessionPending: {} as Record<string, any>,
  sessionMessages: {} as Record<string, any>,
}));

vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
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
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
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
    return createExpoRouterMock().module;
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

// Composer admission and restoration now share the synchronized draft repository.
// Exercise that canonical owner instead of the shell testkit's lightweight draft stub.
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/agents/registry/registryUiBehavior');

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));


vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots', async () => {
  // The polling transport is the boundary; the normalized `profiles`
  // projection stays real because the shell reads its canonical keys.
  const { normalizeConnectedServiceQuotaProfileRefs } = await import(
    '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs'
  );
  return {
    useConnectedServiceQuotaSnapshots: (profiles: ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>) => {
      quotaSnapshotsState.requestedProfiles = profiles;
      return {
        profiles: normalizeConnectedServiceQuotaProfileRefs(profiles as any),
        snapshotsByKey: quotaSnapshotsState.current,
        loadingByKey: {},
      };
    },
  };
});

vi.mock('@/hooks/server/connectedServices/useProviderAccountUsageSnapshots', async () => {
  const { resolveProviderAccountUsageSnapshotState } = await import(
    '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors'
  );
  return {
    useProviderAccountUsageSnapshots: (recordIds: readonly string[]) => {
      providerAccountUsageSnapshotsState.requestedRecordIds = recordIds;
      return {
        snapshotsByRecordId: providerAccountUsageSnapshotsState.current,
        loadingByRecordId: {},
        stateByRecordId: Object.fromEntries(recordIds.map((recordId) => [
          recordId,
          resolveProviderAccountUsageSnapshotState({
            snapshot: providerAccountUsageSnapshotsState.current[recordId] ?? null,
            loading: false,
            hadError: false,
            nowMs: Date.now(),
          }),
        ])),
      };
    },
  };
});

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
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionReachableMachineTarget: () => ({ machineId: 'machine-1', basePath: '/tmp' }),
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
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
    resumeSession: resumeSessionSpy,
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
  };
});
vi.mock('@/sync/ops/sessionUsageLimitRecovery', () => ({
  sessionUsageLimitWaitResumeEnable: (sessionId: string, request?: unknown, opts?: unknown) =>
    sessionUsageLimitWaitResumeEnableSpy(sessionId, request, opts),
  sessionUsageLimitWaitResumeCancel: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitWaitResumeCancelSpy(sessionId, opts),
  sessionUsageLimitCheckNow: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitCheckNowSpy(sessionId, opts),
  sessionUsageLimitSwitchAccountNow: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitSwitchAccountNowSpy(sessionId, opts),
  sessionUsageLimitConsumeResetCredit: (sessionId: string, opts?: unknown) =>
    sessionUsageLimitConsumeResetCreditSpy(sessionId, opts),
}));
vi.mock('@/sync/ops/sessionRunnerRestart', () => ({
  getSessionRunnerRuntimeStatus: (request: unknown) => getSessionRunnerRuntimeStatusSpy(request),
  getSessionRunnerRuntimeStatusSnapshot: async (request: unknown) => {
    const result = await getSessionRunnerRuntimeStatusSpy(request);
    if (!result) return null;
    if (typeof result === 'object' && 'state' in result) {
      return {
        ...result,
        runnerProcessIdentity: 'runnerProcessIdentity' in result
          ? result.runnerProcessIdentity
          : null,
      };
    }
    return { state: result, runnerProcessIdentity: null };
  },
  restartSessionRunnerForProviderBindingChange: (request: unknown) =>
    restartProviderBindingSessionRunnerSpy(request),
  restartSessionRunnerForConfigurationChange: (request: unknown) =>
    restartConfigurationSessionRunnerSpy(request),
  restartSessionRunnerOnCurrentRuntime: (request: unknown) => restartStaleSessionRunnerSpy(request),
}));
vi.mock('@/sync/ops/connectedServiceQuotaRecoveryCredits', () => ({
  connectedServiceQuotaRecoveryCreditConsume: connectedServiceQuotaRecoveryCreditConsumeSpy,
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: actionExecuteSpy }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
  sessionRpcWithPreferredSessionScope: (...args: unknown[]) =>
    sessionRpcWithPreferredSessionScopeSpy(...args),
}));
vi.mock('@/components/sessions/agentInput', async () => {
  const { AgentInputPermissionRequests } = await import(
    '@/components/sessions/agentInput/components/AgentInputPermissionRequests'
  );
  return {
    AgentInput: (props: any) => React.createElement(
      'AgentInput',
      { testID: 'session-agent-input', ...props },
      // This suite keeps the large editor shell lightweight. The focused
      // post-End case still mounts the real composer permission owner and card.
      renderRealAgentInputPermissionSurfaceState.current
        ? React.createElement(AgentInputPermissionRequests, {
            sessionId: props.sessionId,
            permissionRequests: props.permissionRequests ?? [],
            approvalRequests: props.approvalRequests ?? [],
            permissionLocationsById: new Map(),
            approvalLocationsByArtifactId: new Map(),
            metadata: props.metadata ?? null,
            canApprovePermissions: props.canApprovePermissions,
            disabledReason: props.permissionDisabledReason,
            maxHeightPx: 320,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
          })
        : null,
    ),
  };
});
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
vi.mock('@/components/sessions/external/takeover/showExternalSessionTakeoverDialog', () => ({
  showExternalSessionTakeoverDialog: showDirectSessionTakeoverDialogSpy,
}));
vi.mock('@/voice/binding/sendVoiceSessionComposerText', () => ({
  sendVoiceSessionComposerText: (params: Parameters<typeof sendVoiceSessionComposerText>[0]) =>
    sendVoiceSessionComposerTextSpy(params),
}));
vi.mock('@/voice/binding/voiceSessionComposerRouting', () => ({
  resolveVoiceSessionComposerRouting: (params: any) => resolveVoiceSessionComposerRoutingSpy(params),
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
  useSessionSubagents: () => ({ subagents: [], participantTargets: participantTargetsState.current, sidechainIds: [] }),
}));
vi.mock('@/providers/hooks/useProviderModelProjection', () => ({
  useProviderModelProjection: (input: unknown) => {
    providerModelProjectionState.inputSpy(input);
    return providerModelProjectionState.value;
  },
}));
const homes = createHomeGovernanceHarness();
const externalRpcRequests: Array<Readonly<{ targetId: string; method: string; payload: unknown }>> = [];

function takeoverAdmissionResponse(input: unknown) {
  const { request } = ExternalSessionTakeoverStartInputV1Schema.parse(input);
  return ExternalSessionOperationActionResponseV1Schema.parse({
    ok: true,
    progress: {
      v: 1,
      operationId: 'takeover-operation-1',
      revision: 1,
      request: {
        plan: request.plan,
        targetStorageMode: request.targetStorageMode,
        targetDirectory: request.targetDirectory,
        targetRuntimeMode: request.targetRuntimeMode,
      },
      status: 'awaiting_user_resume',
      phase: 'validating',
      retryTargetPhase: 'validating',
      timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1[request.targetStorageMode === 'persisted'
        ? 'takeover_persisted' : 'takeover_external_linked'],
      updatedAtMs: 1,
      priorStableStorage: { state: 'machine_only' },
      currentStorageState: 'machine_only',
      checkpoint: {
        sourcePagesRead: 0,
        stagedItemCount: 0,
        importedItemCount: 0,
        requiredItemFailures: { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false },
      },
      fence: { kind: 'none' },
    },
  });
}
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary((socket: Socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // Fire-and-forget status demand is also an outbound network operation.
  vi.spyOn(socket, 'emit').mockImplementation(() => socket);
  // The outbound network acknowledgement is controlled here; Sync itself creates
  // the local Pending projection and publishes the composer's handoff.
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: unknown) => {
    if (event === 'message') return syncSubmitMessageSpy(payload);
    if (event === 'update-metadata') {
      const update = payload as { expectedVersion: number; metadata: string };
      return { result: 'success', version: update.expectedVersion + 1, metadata: update.metadata };
    }
    if (event === 'rpc-call') {
      const rpc = payload as Readonly<{ method: string; params: unknown }>;
      const separator = rpc.method.indexOf(':');
      const method = rpc.method.slice(separator + 1);
      externalRpcRequests.push({ targetId: rpc.method.slice(0, separator), method, payload: rpc.params });
      let result: unknown;
      if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET) {
        result = await machineDirectSessionStatusGetSpy(rpc.params);
      } else if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH) {
        result = { ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 30_000 };
      } else if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH) {
        result = { ok: true, detached: true };
      } else if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE) {
        result = { ok: true, items: [], hasMore: false, truncated: false };
      } else if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER) {
        const input = rpc.params as Readonly<{ v?: number; binding?: unknown }>;
        result = input.v === 1
          ? { v: 1, binding: input.binding, result: { outcome: 'already_current' } }
          : { ok: true, items: [], hasMore: false, truncated: false };
      } else if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START) {
        const { request } = ExternalSessionTakeoverStartInputV1Schema.parse(rpc.params);
        result = request.targetStorageMode === 'persisted'
          ? await machineDirectSessionTakeoverPersistSpy(rpc.params)
          : await machineDirectSessionTakeoverSpy(rpc.params);
      } else if (method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH) {
        const request = SessionContinuationInspectionBatchRequestV1Schema.parse(rpc.params);
        result = { v: 1, inspections: request.selections.map(() => ({
          type: 'available', protocolVersion: 1, sameSessionTransition: true,
        })) };
      } else if (method === RPC_METHODS.SESSION_AGENT_TRANSITION) {
        const request = SessionAgentTransitionRequestV1Schema.parse(rpc.params);
        result = { type: agentTransitionResult, localId: request.input.localId };
      } else {
        return { ok: false, error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' };
      }
      return { ok: true, result };
    }
    return { v: 1, ok: true, admittedSessionIds: [] };
  });
});
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
const { resolveWorkspaceTargetForSessionFromState } = await import('@/sync/domains/session/resolveWorkspaceTargetForSessionFromState');
const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SessionView } = await import('./SessionView');
const draftValues = await import('@/dev/testkit/sessionDraftRepositoryTestkit');

describe('SessionView (direct sessions)', () => {
  const canonicalDraftScope: ServerAccountScope = {
    serverId: 'server-route-1',
    accountId: 'account-route-1',
  };

  function useCanonicalDraftScope() {
    expect(storage.getState().settingsScope).toEqual(canonicalDraftScope);
  }

  describe('persisted Agent continuation custody', () => {
    const currentAgentRow: AgentInputChipPickerOption = {
      id: 'engine:current', label: 'Current Agent', renderDetailContent: () => null,
    };

    function targetKey(agentId: string): string {
      const entry = getResolvedBackendCatalogEntries({
        enabledAgentIds: ['claude', 'codex', 'gemini'],
        acpCatalogSettingsV1: { v: 2, backends: [] },
      }).find((candidate) => candidate.agentId === agentId);
      if (!entry) throw new Error(`Agent catalog entry ${agentId} is unavailable`);
      return entry.backendTargetKey;
    }

    function readArm(): SessionArmedAgentContinuation | null | undefined {
      return draftValues.readSessionDraftValue(canonicalDraftScope, 's1', 'routing.agentContinuation');
    }

    function readOptions(screen: Awaited<ReturnType<typeof renderSessionView>>): AgentInputChipPickerOption[] {
      return findAgentInput(screen).props.composeAgentPickerOptions([currentAgentRow]);
    }

    async function openPicker(screen: Awaited<ReturnType<typeof renderSessionView>>) {
      await act(async () => { findAgentInput(screen).props.onAgentPickerVisibilityChange(true); });
      await settleDirectSessionView();
    }

    async function selectAgent(screen: Awaited<ReturnType<typeof renderSessionView>>, agentId: string) {
      await openPicker(screen);
      const option = readOptions(screen).find((row) => row.id === targetKey(agentId));
      if (!option?.onSelectImmediate) throw new Error(`Agent option ${agentId} is unavailable`);
      const select = option.onSelectImmediate;
      await act(async () => { select(); });
      expect(readArm()?.backendTargetKey).toBe(targetKey(agentId));
    }

    async function submitSwitch(screen: Awaited<ReturnType<typeof renderSessionView>>) {
      await selectAgent(screen, 'claude');
      await act(async () => { findAgentInput(screen).props.onChangeText('switch and send this'); });
      await act(async () => { await findAgentInput(screen).props.onSend(); });
      await settleDirectSessionView();
      const dispatch = externalRpcRequests.find((request) => request.method === RPC_METHODS.SESSION_AGENT_TRANSITION);
      if (!dispatch) throw new Error('Agent transition did not reach the Socket boundary');
      return SessionAgentTransitionRequestV1Schema.parse(dispatch.payload).input.localId;
    }

    async function publishCustody(localId: string) {
      homes.answer(canonicalDraftScope.serverId, '/v2/sessions/s1/pending?includeDiscarded=1', { body: {
        pending: [{
          localId, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'switch and send this' } } },
          messageRole: 'user', position: 0, createdAt: 1, updatedAt: 2,
          status: 'delivering', deliveryStatus: { status: 'delivering' },
        }],
      } });
      await act(async () => { await sync.fetchPendingMessages('s1'); });
      expect(storage.getState().sessionPending.s1.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ localId, source: 'server_pending' }),
      ]));
      await settleDirectSessionView();
    }

    beforeEach(async () => {
      useCanonicalDraftScope();
      settingsState.current = {
        backendEnabledByTargetKey: Object.fromEntries(['claude', 'codex', 'gemini'].map((id) => [targetKey(id), true])),
        featureToggles: { sessions: true, 'sessions.agentSwitching': true },
      };
      const features = createRootLayoutFeaturesResponse();
      for (const id of ['sessions', 'sessions.agentSwitching'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Feature fixture ${id} is unavailable`);
      }
      homes.answer(canonicalDraftScope.serverId, '/v1/features', { body: features });
      homes.answer(canonicalDraftScope.serverId, '/v1/features/authenticated', { body: features });
      const { directSessionV1: _direct, ...metadata } = storageState.sessions.s1.metadata;
      storageState.sessions.s1 = {
        ...storageState.sessions.s1, metadata,
        accessLevel: 'owner',
        access: createSessionAccessFixture('owner', { approveRuntimePermissions: false }),
      };
      storageState.machines['machine-1'] = createMachineFixture({ activeAt: Date.now() });
      applyDirectSessionFixtures();
      const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      const snapshot = await getServerFeaturesSnapshot({ serverId: canonicalDraftScope.serverId, force: true });
      const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('@/sync/domains/features/featureDecisionRuntime');
      expect(resolveRuntimeFeatureDecisionFromSnapshot({
        featureId: 'sessions.agentSwitching', settings: storage.getState().settings, snapshot,
        scope: { scopeKind: 'spawn', serverId: canonicalDraftScope.serverId },
      })).toMatchObject({ state: 'enabled' });
    });

    it('consumes the accepted submission and offers selectable Agents after remount', async () => {
      const first = await renderSessionViewAndSettle();
      await submitSwitch(first);
      expect(readArm()).toBeNull();
      expect(findAgentInput(first).props.value).toBe('');
      expect(getSessionDraftSnapshot(canonicalDraftScope, { kind: 'session', sessionId: 's1' })?.document.composer.text.value ?? '').toBe('');
      storageState.sessions.s1.metadata = { ...storageState.sessions.s1.metadata, flavor: 'claude' };
      await first.unmount();

      const second = await renderSessionViewAndSettle();
      await openPicker(second);
      expect(readArm()).toBeNull();
      expect(readOptions(second).map((row) => row.id)).toContain(targetKey('codex'));
      await selectAgent(second, 'codex');
    });

    it('retains unknown submission identity through remount and consumes delayed custody while preserving newer text', async () => {
      agentTransitionResult = 'outcome_unknown';
      const first = await renderSessionViewAndSettle();
      const localId = await submitSwitch(first);
      expect(readArm()?.submission).toMatchObject({
        localId, currentness: { text: 'switch and send this', mentions: [], composerAttachments: [], attachmentDraftIds: [] },
      });
      storageState.sessions.s1.metadata = { ...storageState.sessions.s1.metadata, flavor: 'claude' };
      await first.unmount();

      const second = await renderSessionViewAndSettle();
      expect(readArm()?.submission?.localId).toBe(localId);
      expect(findAgentInput(second).props.value).toBe('switch and send this');
      expect(readOptions(second).map((row) => row.id)).not.toContain(targetKey('codex'));
      await act(async () => { findAgentInput(second).props.onChangeText('a newer draft'); });
      await publishCustody(localId);

      expect(readArm()).toBeNull();
      expect(findAgentInput(second).props.value).toBe('a newer draft');
      await openPicker(second);
      expect(readOptions(second).map((row) => row.id)).toContain(targetKey('codex'));
      await selectAgent(second, 'codex');
    });

    it('preserves a newer armed Agent and composer when an older submission reaches custody', async () => {
      agentTransitionResult = 'outcome_unknown';
      const screen = await renderSessionViewAndSettle();
      const previousLocalId = await submitSwitch(screen);
      await selectAgent(screen, 'gemini');
      await act(async () => { findAgentInput(screen).props.onChangeText('send this to Gemini'); });
      const newerArm = readArm();
      expect(newerArm?.submission).toBeUndefined();

      await publishCustody(previousLocalId);

      expect(readArm()).toEqual(newerArm);
      expect(findAgentInput(screen).props.agentPickerSelectedOptionId).toBe(targetKey('gemini'));
      expect(findAgentInput(screen).props.value).toBe('send this to Gemini');
    });
  });

  function writeCanonicalSessionDraft(input: Readonly<{
    recipient?: unknown;
    executionRunDelivery?: unknown;
  }>) {
    writeExistingSessionDraft({
      scope: canonicalDraftScope,
      sessionId: 's1',
      patch: {
        routing: {
          ...(input.recipient === undefined
            ? {}
            : { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: input.recipient }) }),
          ...(input.executionRunDelivery === undefined
            ? {}
            : { executionRunDelivery: StrictJsonValueSchema.parse(input.executionRunDelivery) }),
        },
      },
    });
  }

  function readCanonicalDraftRecipient(): unknown {
    const document = getSessionDraftSnapshot(canonicalDraftScope, { kind: 'session', sessionId: 's1' })?.document;
    if (!document || document.target.kind !== 'session') return undefined;
    const value = document.target.routing.recipient.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.mode === 'manual' ? candidate.recipient : undefined;
  }

  function readCanonicalDraftDelivery(): unknown {
    const document = getSessionDraftSnapshot(canonicalDraftScope, { kind: 'session', sessionId: 's1' })?.document;
    return document?.target.kind === 'session'
      ? document.target.routing.executionRunDelivery.value
      : undefined;
  }

  function clearCanonicalSessionDraft() {
    return deleteSessionDraft({
      scope: canonicalDraftScope,
      address: { kind: 'session', sessionId: 's1' },
    });
  }

  function applyDirectSessionFixtures() {
    const state = storage.getState();
    state.applySettingsLocal({
      ...settingsDefaults,
      experiments: true,
      featureToggles: {},
      codexBackendMode: 'acp',
      sessionMessageSendMode: 'agent_queue',
      ...settingsState.current,
      ...settingByKeyState.current,
    });
    state.applyLocalSettings({
      ...localSettingsDefaults,
      acknowledgedCliVersions: {},
      uiMultiPanePanelsEnabled: true,
      detailsPaneTabsBehavior: 'preview',
      rightPaneWidthPx: 360,
      rightPaneWidthBasisPx: 1200,
      detailsPaneWidthPx: 520,
      detailsPaneWidthBasisPx: 1200,
    }, { persist: false });
    const sessions = Object.fromEntries(Object.entries(storageState.sessions).map(([id, session]) => [
      id,
      createSessionFixture(session),
    ]));
    for (const session of Object.values(sessions)) {
      const serverId = session.serverId ?? canonicalDraftScope.serverId;
      const machineId = session.metadata?.machineId ?? 'machine-1';
      homes.answer(serverId, `/v1/machines/${machineId}`, {
        body: { machine: { id: machineId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } },
      });
      const {
        ownerMetadataView: _ownerMetadataView,
        composerOptionsInput: _composerOptionsInput,
        ...sessionWireInput
      } = session;
      let wireSession = SessionCurrentProjectionRecordV1Schema.parse({
        ...sessionWireInput,
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(session.metadata),
        agentState: session.agentState == null ? null : JSON.stringify(session.agentState),
        effectiveAccess: {
          v: 1,
          level: session.access!.level,
          sources: [session.access!.role === 'owner'
            ? { kind: 'owner' }
            : { kind: 'direct', shareId: `share-${session.id}` }],
          capabilities: session.access!.capabilities,
        },
        responsibleAccountId: null,
        responsibleAccount: null,
        share: null,
        archivedAt: null,
        dataEncryptionKey: null,
        pendingCount: session.pendingCount ?? 0,
        pendingVersion: session.pendingVersion ?? 2,
      });
      for (const path of [`/v2/sessions/${session.id}`, `/v2/sessions/${session.id}?accessProjectionVersion=1`]) {
        homes.answer(serverId, path, { select: () => ({ body: { session: wireSession } }) });
        homes.answer(serverId, `PATCH ${path}`, { select: (input) => {
          const patch = SessionMetadataTuplePatchV1Schema.parse(input);
          const expectedTupleMatches = patch.mode === 'owner_migration'
            ? wireSession.metadataLayoutVersion === 0
              && patch.source.metadata.version === wireSession.metadataVersion
              && patch.source.metadata.ciphertext === wireSession.metadata
              && patch.source.agentState.version === wireSession.agentStateVersion
              && patch.source.agentState.ciphertext === wireSession.agentState
            : wireSession.metadataLayoutVersion === 1
              && patch.sharedMetadata.expectedVersion === wireSession.metadataVersion
              && (patch.mode === 'shared_editor'
                || (patch.agentState.expectedVersion === wireSession.agentStateVersion
                  && JSON.stringify(patch.expectedOwnerMetadata) === JSON.stringify(wireSession.ownerMetadata)));
          if (!expectedTupleMatches) {
            return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({
              code: 'session_metadata_version_conflict',
              metadataLayoutVersion: 1,
              sharedMetadata: { version: wireSession.metadataVersion },
              agentState: { version: wireSession.agentStateVersion },
            }) };
          }
          if (patch.mode === 'shared_editor') {
            wireSession = SessionCurrentProjectionRecordV1Schema.parse({
              ...wireSession,
              metadata: patch.sharedMetadata.ciphertext,
              metadataVersion: wireSession.metadataVersion + 1,
            });
          } else {
            const target = patch.mode === 'owner_migration' ? patch.target : patch;
            wireSession = SessionCurrentProjectionRecordV1Schema.parse({
              ...wireSession,
              metadataLayoutVersion: 1,
              metadata: target.sharedMetadata.ciphertext,
              ownerMetadata: target.ownerMetadata,
              agentState: target.agentState.ciphertext,
              metadataVersion: wireSession.metadataVersion + 1,
              agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1,
            });
          }
          return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({
            success: true,
            metadataLayoutVersion: 1,
            sharedMetadata: { version: wireSession.metadataVersion },
            agentState: { version: wireSession.agentStateVersion },
          }) };
        } });
      }
      for (const path of [`/v2/sessions/${session.id}/pending`, `/v2/sessions/${session.id}/pending?includeDiscarded=1`]) {
        homes.answer(serverId, path, { body: { pending: [] } });
      }
      for (const path of [`/v1/sessions/${session.id}/messages`, `/v1/sessions/${session.id}/messages?scope=main`]) {
        homes.answer(serverId, path, { body: { messages: [], hasMore: false, nextBeforeSeq: null } });
      }
    }
    storage.setState({
      isDataReady: true,
      profile: { ...state.profile, ...storageState.profile },
      artifacts: storageState.artifacts,
      sessionPending: storageState.sessionPending,
      sessionMessages: Object.fromEntries(Object.keys(sessions).map((id) => [id,
        createSessionMessagesFixture({
          isLoaded: true,
          ...(id === 's1' ? {
            messagesById: Object.fromEntries(sessionMessagesState.current.map((message) => [message.id, message])),
            messageIdsOldestFirst: sessionMessagesState.current.map((message) => message.id),
          } : {}),
          ...storageState.sessionMessages[id],
        }),
      ])),
      sessionListRowsByServerId: storageState.sessionListRowsByServerId,
      ordinarySessionListMembershipByServerId: storageState.ordinarySessionListMembershipByServerId,
      reviewCommentsDraftsBySessionId: {},
    });
    storage.setState({ sessions: {} });
    storage.getState().applySessions(Object.values(sessions));
    const machines = Object.fromEntries(Object.values(sessions).map((session) => {
      const id = session.metadata?.machineId ?? 'machine-1';
      return [id, createMachineFixture({
        id,
        storageMode: 'plain',
        metadata: {
          ...createMachineFixture().metadata!,
          host: session.metadata?.host ?? 'happy-host',
          homeDir: session.metadata?.homeDir ?? '/tmp',
        },
        ...storageState.machines[id],
      })];
    }));
    for (const machine of Object.values(storageState.machines)) {
      machines[machine.id] = createMachineFixture({ storageMode: 'plain', ...machine });
    }
    storage.setState({ machines: {}, machineListByServerId: {} });
    state.applyMachines(Object.values(machines), true, { sourceServerId: canonicalDraftScope.serverId });
    for (const serverId of new Set(Object.values(sessions).map((session) => session.serverId ?? canonicalDraftScope.serverId))) {
      if (serverId === canonicalDraftScope.serverId) continue;
      const ids = new Set(Object.values(sessions)
        .filter((session) => session.serverId === serverId)
        .map((session) => session.metadata?.machineId ?? 'machine-1'));
      state.applyMachines(Object.values(machines).filter((machine) => ids.has(machine.id)), true, { sourceServerId: serverId });
    }
    const reviewScope = resolveWorkspaceTargetForSessionFromState(storage.getState(), {
      serverId: sessions.s1?.serverId ?? canonicalDraftScope.serverId,
      sessionId: 's1',
    });
    storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: reviewScope
      ? { [reviewScope.workspaceCacheKey]: reviewCommentDraftsState.current }
      : {},
    });
    // Fixture mutations and public store reads address the same Session records.
    Object.assign(storageState.sessions, storage.getState().sessions);
  }

  async function renderSessionView(props: {
    sessionId?: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    presentation?: SessionViewPresentation;
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
    applyDirectSessionFixtures();
    return renderScreen(
      <InjectedAuthProvider credentials={accountConnection!.credentials}>
      <AppPaneProvider>
        <SessionView
          id={sessionId}
          routeServerId={props.routeServerId ?? (sessions[sessionId]?.serverId as string | undefined)}
          jumpToSeq={props.jumpToSeq}
          presentation={props.presentation}
        />
      </AppPaneProvider>
      </InjectedAuthProvider>,
    );
  }

  async function renderSessionViewAndSettle(props: {
    sessionId?: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    presentation?: SessionViewPresentation;
  } = {}) {
    // Match the app bootstrap's persisted-draft preparation before mounting the real composer.
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const screen = await renderSessionView(props);
    await settleDirectSessionView();
    return screen;
  }

  async function updateSessionView(
    screen: Awaited<ReturnType<typeof renderSessionView>>,
    props: {
      sessionId?: string;
      routeServerId?: string;
      jumpToSeq?: number | null;
    } = {},
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
      applyDirectSessionFixtures();
      screen.tree.update(
        <InjectedAuthProvider credentials={accountConnection!.credentials}>
        <AppPaneProvider>
          <SessionView
            id={sessionId}
            routeServerId={props.routeServerId ?? (sessions[sessionId]?.serverId as string | undefined)}
            jumpToSeq={props.jumpToSeq}
          />
        </AppPaneProvider>
        </InjectedAuthProvider>,
      );
    });
  }

  async function updateSessionViewAndSettle(
    screen: Awaited<ReturnType<typeof renderSessionView>>,
    props: {
      sessionId?: string;
      routeServerId?: string;
      jumpToSeq?: number | null;
    } = {},
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
      badge.key === 'usage-limit-recovery');
  }

  function findStaleRunnerStatusBadge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'stale-session-runner');
  }

  function findMcpSelectionRestartStatusBadge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.statusBadges.find((badge: { key?: string }) =>
      badge.key === 'session-mcp-selection-restart-required');
  }

  function findProviderUsageGauge(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.instrumentQuota?.viewModel;
  }

  function findProviderUsageRecoveryAction(screen: Awaited<ReturnType<typeof renderSessionView>>) {
    return findAgentInput(screen).props.instrumentQuota?.onRecoveryCreditPress;
  }

  function buildSessionRunnerRuntimeStatus(input: Readonly<{
    sessionId: string;
    machineId: string;
    versionState: 'current' | 'stale';
    pid?: number;
    runtimeId?: string;
  }>): SessionRunnerRuntimeStateV1 {
    const current = input.versionState === 'current';
    return {
      v: 1,
      sessionId: input.sessionId,
      machineId: input.machineId,
      observedAtMs: current ? 2 : 1,
      runner: {
        pid: input.pid ?? 123,
        runtimeId: input.runtimeId ?? (current ? 'version:cli-new' : 'version:cli-old'),
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
        [SESSION_RUNNER_RUNTIME_METADATA_KEY]: buildSessionRunnerRuntimeStatus({
          sessionId: 's1',
          machineId: 'machine-1',
          versionState: 'stale',
        }),
      },
    };
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
        [SESSION_RUNNER_RUNTIME_METADATA_KEY]: buildSessionRunnerRuntimeStatus({
          sessionId: 's1',
          machineId: 'machine-1',
          versionState: 'current',
        }),
      },
    };
  }

  function installUnknownIdentityStaleSessionRunnerStatus() {
    installStaleSessionRunnerStatus();
    const metadata = storageState.sessions.s1.metadata as Record<string, any>;
    metadata[SESSION_RUNNER_RUNTIME_METADATA_KEY] = {
      ...metadata[SESSION_RUNNER_RUNTIME_METADATA_KEY],
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
      ...(typeof params.recoveryCredits !== 'undefined'
        ? { recoveryCredits: normalizeRecoveryCreditsFixture(params.recoveryCredits) }
        : {}),
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
      ...(typeof params.recoveryCredits !== 'undefined'
        ? { recoveryCredits: normalizeRecoveryCreditsFixture(params.recoveryCredits) }
        : {}),
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

  function normalizeRecoveryCreditsFixture(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { kind: _legacyKind, credits, ...rest } = value as Record<string, unknown>;
    if (!Array.isArray(credits)) return rest;
    return {
      ...rest,
      credits: credits.map((credit, index) => {
        if (!credit || typeof credit !== 'object' || Array.isArray(credit)) return credit;
        const record = credit as Record<string, unknown>;
        return {
          id: typeof record.id === 'string' && record.id.trim().length > 0
            ? record.id
            : `reset-credit-${index + 1}`,
          ...record,
        };
      }),
    };
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
          recoveryCredits: normalizeRecoveryCreditsFixture({
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [{ kind: 'usage_limit_reset', status: 'available' }],
          }),
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        agentId: 'codex',
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

  function installRunnerActiveDirectSubmitStatus() {
    machineDirectSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
    });
  }

  beforeEach(async () => {
    externalRpcRequests.length = 0;
    agentTransitionResult = 'accepted';
    await homes.reset();
    await homes.addHome({ name: 'Active Home', serverUrl: 'https://server-1', accountId: 'account-route-1', active: false });
    for (const serverId of ['server-a', 'server-b', 'server-route-2', 'server-route-1-cleared', 'server-runtime-refresh', 'server-route-polled']) {
      await homes.addHome({ name: serverId, serverUrl: `https://${serverId}`, accountId: 'account-route-1', active: false });
    }
    await homes.addHome({ name: 'Session Home', serverUrl: 'https://server-route-1', accountId: 'account-route-1' });
    homes.answer('server-route-1', '/v1/account/encryption/currentness', {
      body: createPlainAccountEncryptionCurrentnessFixture(),
    });
    accountConnection = await restoreServerAccountForTest({
      serverUrl: 'https://server-route-1',
      accountId: 'account-route-1',
      request: async (url, init) => {
        const address = new URL(String(url));
        const { serverFetch } = await import('@/sync/http/client');
        return serverFetch(`${address.pathname}${address.search}`, init);
      },
    });
    chatListPropsSpy.mockReset();
    chatHeaderPropsSpy.mockReset();
    voiceSurfacePropsSpy.mockReset();
    sessionRpcWithPreferredSessionScopeSpy.mockReset();
    sessionRpcWithPreferredSessionScopeSpy.mockResolvedValue(undefined);
    renderRealAgentInputPermissionSurfaceState.current = false;
    featureEnabledState.providers = false;
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
    actionExecuteSpy.mockReset();
    actionExecuteSpy.mockResolvedValue({ ok: true, result: { ok: true } });
    syncSubmitMessageSpy.mockReset();
    syncSubmitMessageSpy.mockImplementation(async (...args: unknown[]) => {
      const payload = args[0] as Readonly<{ localId: string }>;
      return { ok: true, id: 'direct-message-1', seq: 2, localId: payload.localId, didWrite: true };
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
    restartProviderBindingSessionRunnerSpy.mockReset();
    restartProviderBindingSessionRunnerSpy.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 's1' });
    restartConfigurationSessionRunnerSpy.mockReset();
    restartConfigurationSessionRunnerSpy.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 's1' });
    getSessionRunnerRuntimeStatusSpy.mockReset();
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue(null);
    sessionRunnerRuntimeStatusRetention.clearForTests();
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockReset();
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({ ok: false, errorCode: 'no_recovery_credit_available', error: 'no_recovery_credit_available' });
    machineDirectSessionTakeoverSpy.mockReset();
    machineDirectSessionTakeoverSpy.mockImplementation(async (input: unknown) => takeoverAdmissionResponse(input));
    machineDirectSessionTakeoverPersistSpy.mockReset();
    machineDirectSessionTakeoverPersistSpy.mockImplementation(async (input: unknown) => takeoverAdmissionResponse(input));
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
    providerAccountUsageSnapshotsState.current = {};
    providerAccountUsageSnapshotsState.requestedRecordIds = [];
    providerModelProjectionState.value = {
      data: null,
      error: null,
      loading: false,
      status: 'disabled',
      refresh: vi.fn(async () => {}),
    };
    providerModelProjectionState.inputSpy.mockReset();
    for (const sessionId of Object.keys(storageState.sessions)) {
      delete (storageState.sessions as Record<string, unknown>)[sessionId];
    }
    storageState.sessions.s1 = {
      id: 's1',
      seq: 1,
      // A Session row names the Home it belongs to, and the surface is always
      // mounted from that Home's route.
      serverId: 'server-route-1',
      encryptionMode: 'plain',
      presence: 'online',
      active: true,
      pendingVersion: 2,
      agentStateVersion: 1,
      accessLevel: 'edit',
      canApprovePermissions: false,
      // `SessionView` reads write capability from `access.capabilities`, not
      // from the legacy `accessLevel` field, so the row has to carry the same
      // projection the canonical fixture owner derives.
      access: createSessionAccessFixture('edit', { approveRuntimePermissions: false }),
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
    for (const key of Object.keys(storageState.sessionPending)) {
      delete storageState.sessionPending[key];
    }
    for (const key of Object.keys(storageState.sessionMessages)) {
      delete storageState.sessionMessages[key];
    }
    // Clear the stable container references in place (see hoisted storageState
    // notes) so per-test mutations remain visible through the storage snapshot.
    for (const key of Object.keys(storageState.sessionListRowsByServerId)) {
      delete storageState.sessionListRowsByServerId[key];
    }
    for (const key of Object.keys(storageState.ordinarySessionListMembershipByServerId)) {
      delete storageState.ordinarySessionListMembershipByServerId[key];
    }
    for (const key of Object.keys(storageState.machines)) {
      delete storageState.machines[key];
    }
    showDirectSessionTakeoverDialogSpy.mockResolvedValue({ action: null });
    machineDirectSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      activity: 'running',
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    applyDirectSessionFixtures();
  });

  afterEach(async () => {
    standardCleanup();
    await clearCanonicalSessionDraft();
    resetSessionDraftRepositoryForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    await accountConnection?.dispose();
    accountConnection = null;
    await homes.reset();
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
        agentId: 'opencode',
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
      badge.key === 'usage-limit-recovery');

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
        issueFingerprint: 'usage-limit:opencode:1',
        remember: true,
        resumePromptMode: 'off',
      },
      expect.objectContaining({ serverId: 'server-route-1' }),
    );
    expect(sessionUsageLimitCheckNowSpy).not.toHaveBeenCalled();
    expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual(expect.objectContaining({
      v: 1,
      mode: 'auto_wait',
      resumePromptMode: 'off',
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

  it('renders and applies the active-session MCP restart notice through the current runner owner', async () => {
    installMcpSelectionRestartRequired();

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(screen.findByTestId('session.mcpSelectionRestartRequired.banner')).toBeTruthy();
    expect(findMcpSelectionRestartStatusBadge(screen)).toEqual(expect.objectContaining({
      testID: 'session.mcpSelectionRestartRequired.badge',
      tone: 'warning',
    }));

    await pressTestInstanceAsync(screen.findByTestId('session.mcpSelectionRestartRequired.restart'));
    await settleDirectSessionView();
    expect(restartConfigurationSessionRunnerSpy).toHaveBeenCalledWith({
      runtimeState: expect.objectContaining({ sessionId: 's1', machineId: 'machine-1' }),
      serverId: 'server-route-1',
    });
    expect(screen.findByTestId('session.mcpSelectionRestartRequired.banner')).toBeNull();
  });

  it('keeps the stale-runner notice visible while restart is blocked by runtime activity', async () => {
    installStaleSessionRunnerStatus();
    const metadata = storageState.sessions.s1.metadata as Record<string, any>;
    metadata[SESSION_RUNNER_RUNTIME_METADATA_KEY] = {
      ...metadata[SESSION_RUNNER_RUNTIME_METADATA_KEY],
      plannedRestart: {
        supported: true,
        eligible: false,
        disabledReason: 'turn_in_progress',
      },
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const restartAction = screen.findByTestId('session-staleRunner-restart');

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    expect(restartAction).toBeTruthy();
    expect(restartAction?.props.disabled).toBe(true);
    expect(restartAction?.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(restartAction?.props.onPress).toBeUndefined();
    expect(findStaleRunnerStatusBadge(screen)).toEqual(expect.objectContaining({
      testID: 'session-staleRunner-status-badge',
      tone: 'warning',
    }));
    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
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
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-restart'));
    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledWith({
      serverId: 'server-route-1',
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'machine-1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'version:cli-old',
        }),
      }),
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
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-restart'));
    await settleDirectSessionView();

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledWith({
      serverId: 'server-route-1',
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'machine-1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'version:cli-old',
        }),
      }),
    });
    expect(getSessionRunnerRuntimeStatusSpy).toHaveBeenCalledTimes(2);
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
  });

  it('keeps stale-runner restart disabled for view-only shared sessions', async () => {
    installStaleSessionRunnerStatus();
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      accessLevel: 'view',
      access: createSessionAccessFixture('view'),
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    // A disabled banner action carries no press handler at all, so a view-only participant has no
    // reachable path to the restart operation.
    const restartAction = screen.findByTestId('session-staleRunner-restart');
    expect(restartAction?.props.disabled).toBe(true);
    expect(restartAction?.props.onPress).toBeUndefined();

    expect(restartStaleSessionRunnerSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
  });

  it('dismisses the stale-runner notice when restart reports already current', async () => {
    installStaleSessionRunnerStatus();
    restartStaleSessionRunnerSpy.mockResolvedValueOnce({ ok: true, status: 'already_current', sessionId: 's1' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-restart'));

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
  });

  it('keeps the stale-runner notice visible with inline daemon restart failure state', async () => {
    installStaleSessionRunnerStatus();
    restartStaleSessionRunnerSpy.mockResolvedValueOnce({ ok: false, status: 'spawn_failed', sessionId: 's1' });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await pressTestInstanceAsync(screen.findByTestId('session-staleRunner-restart'));

    expect(restartStaleSessionRunnerSpy).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    expect(findStaleRunnerStatusBadge(screen)).toEqual(expect.objectContaining({
      label: 'session.staleRunner.status.failed',
    }));
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
        agentId: 'opencode',
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
      key: 'usage-limit-recovery',
      testID: 'session-usageLimit-status-badge',
    }));
    expect(findStaleRunnerStatusBadge(screen)).toEqual(expect.objectContaining({
      key: 'stale-session-runner',
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
        agentId: 'opencode',
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
        agentId: 'opencode',
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
        agentId: 'opencode',
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
        agentId: 'opencode',
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

    expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual({
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
        agentId: 'opencode',
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

    expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual({
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
        agentId: 'opencode',
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
    expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual(settingByKeyState.current.usageLimitRecoverySettingsV1);
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
        agentId: 'codex',
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

  it('clears the stale usage-limit warning when an active check-now resumes the provider runtime', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    sessionUsageLimitCheckNowSpy.mockResolvedValueOnce({ ok: true, status: 'resumed' });
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
        agentId: 'codex',
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
    expect(resumeSessionSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
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
        agentId: 'codex',
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

  it('clears a switchable group usage-limit warning when fallback switching resumes the provider runtime', async () => {
    featureEnabledState['sessions.usageLimitRecovery'] = true;
    settingByKeyState.current.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
    sessionUsageLimitSwitchAccountNowSpy.mockResolvedValueOnce({ ok: true, status: 'resumed' });
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
        agentId: 'codex',
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
    expect(screen.findByTestId('session-usageLimit-recovery-checkNow')).toBeNull();
    await pressTestInstanceAsync(screen.findByTestId('session-usageLimit-recovery-switchFallbackNow'));
    await settleDirectSessionView();

    expect(sessionUsageLimitSwitchAccountNowSpy).toHaveBeenCalledWith('s1', expect.objectContaining({
      provider: 'codex',
      serverId: 'server-route-1',
    }));
    expect(sessionUsageLimitCheckNowSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
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
        agentId: 'codex',
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
      label: 'session.usageLimitRecovery.status.checking',
    }));

    await act(async () => {
      resolveSwitchAccountNow?.({ ok: true, status: 'waiting' });
      await Promise.resolve();
    });
    await settleDirectSessionView();
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
        agentId: 'codex',
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
      latestTurnStatus: null,
      latestTurnStatusObservedAt: null,
      presence: 'online',
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('online');
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

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('working');
    expect(findAgentInput(screen).props.showAbortButton).toBe(true);
  });

  it('shows background Activity in AgentInput status without exposing foreground Stop', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityRevision: 1,
    };

    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.connectionStatus?.text).toBe('working in background');
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
        agentId: 'codex',
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

  it('does not surface runtime quota evidence for a connected binding without a source-backed quota view', async () => {
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
        agentId: 'codex',
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
          effectiveMeterId: 'weekly',
          effectiveRemainingPct: 42,
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(quotaSnapshotsState.requestedProfiles).toEqual([
      { serviceId: 'openai-codex', profileId: 'launch-profile' },
    ]);
    expect(findProviderUsageGauge(screen)).toBeUndefined();
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
        agentId: 'claude',
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

    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      serviceId: 'claude-subscription',
      remainingPct: 52,
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      serviceId: 'codex',
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
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
      connectedAccountGroupsV4: [{
        v: 1,
        ref: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          groupId: 'happier',
        },
        incarnation: 'happier:1',
        displayName: 'Happier pool',
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          quotaLimitSelection: { mode: 'all' },
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: false,
            refreshFailure: true,
          },
        },
        activeConnectedAccountId: 'active-profile',
        generation: 7,
        runtimeStateRevision: 1,
        state: { status: 'ready' },
        createdAt: 0,
        updatedAt: 0,
        members: [{
          v: 1,
          connectedAccountId: 'active-profile',
          priority: 100,
          enabled: true,
          state: {},
          createdAt: 0,
          updatedAt: 0,
        }],
      }],
    };
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      activeAccountDisplayLabel: 'Active Codex account',
      ringValueLabel: '65',
    }));
  });

  it('uses only the pool-selected allowance families in the session usage badge', async () => {
    featureEnabledState['connectedServices.quotas'] = true;
    featureEnabledState['connectedServices.poolQuotaLimitSelection'] = true;
    storageState.profile = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'active-profile', status: 'connected', kind: 'oauth' }],
        groups: [{
          groupId: 'happier',
          activeProfileId: 'active-profile',
          memberProfileIds: ['active-profile'],
        }],
      }],
      connectedAccountGroupsV4: [{
        v: 1,
        ref: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          groupId: 'happier',
        },
        incarnation: 'happier:1',
        displayName: 'Happier pool',
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] },
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: false,
            refreshFailure: true,
          },
        },
        activeConnectedAccountId: 'active-profile',
        generation: 7,
        runtimeStateRevision: 1,
        state: { status: 'ready' },
        createdAt: 0,
        updatedAt: 0,
        members: [{
          v: 1,
          connectedAccountId: 'active-profile',
          priority: 100,
          enabled: true,
          state: {},
          createdAt: 0,
          updatedAt: 0,
        }],
      }],
    };
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
        meters: [
          { meterId: 'standard:primary', providerLimitId: 'standard', label: 'Session', used: 20, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
          { meterId: 'spark:primary', providerLimitId: 'spark', label: 'Spark', used: 95, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
        ],
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
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
    connectedServiceQuotaRecoveryCreditConsumeSpy.mockResolvedValue({
      ok: true,
      receipt: {
        idempotencyKey: 'reset-credit-1',
        status: 'consumed',
      },
      snapshot: consumedSnapshot,
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    expect(findProviderUsageRecoveryAction(screen)).toEqual(expect.any(Function));
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeTruthy();

    await act(async () => {
      await findProviderUsageRecoveryAction(screen)();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1,
    });
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      ringValueLabel: '55',
      recoveryCreditSummary: null,
    }));
    expect(findProviderUsageRecoveryAction(screen)).toBeUndefined();
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
    expect(findProviderUsageGauge(screen)?.usageRings
      .map((ring: { meterId: string; ringValueLabel: string }) => [ring.meterId, ring.ringValueLabel]))
      .toEqual([['weekly', '18'], ['five_hour', '70'], ['daily', '5']]);
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      lastRuntimeIssue: {
        v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit',
        source: 'usage_limit', occurredAt: 10_000, provider: 'codex',
        usageLimit: {
          v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'switch_account',
          quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'backup-profile', fetchedAtMs: 10_000 },
          allWindows: [
            { meterId: 'weekly', scope: 'Weekly', remainingPct: 42 },
            { meterId: 'five_hour', scope: '5-hour', remainingPct: 70 },
            { meterId: 'backup_daily', scope: 'Daily', remainingPct: 55 },
          ],
        },
      },
    };
    settingByKeyState.current.connectedServicesQuotaPinnedMeterIdsByKey = {
      'openai-codex/work': ['daily'], 'openai-codex/backup-profile': ['backup_daily'],
    };
    await updateSessionViewAndSettle(screen, { routeServerId: 'server-route-refreshed' });
    expect(findProviderUsageGauge(screen)?.usageRings.map((ring: { meterId: string }) => ring.meterId))
      .toEqual(['weekly', 'five_hour', 'backup_daily']);

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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      activeAccountDisplayLabel: 'Connected Codex account',
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));

    await act(async () => {
      await findProviderUsageRecoveryAction(screen)();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 2_000,
    });
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

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 2_000,
    });
    expect(sessionUsageLimitConsumeResetCreditSpy).not.toHaveBeenCalled();
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      ringValueLabel: '18',
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    expect(screen.findByTestId('session-usageLimit-recovery-consumeResetCredit')).toBeTruthy();

    await act(async () => {
      await findProviderUsageRecoveryAction(screen)();
    });
    await settleDirectSessionView();

    expect(connectedServiceQuotaRecoveryCreditConsumeSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-route-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      sourceSnapshotFetchedAtMs: 1,
    });

    quotaSnapshotsState.current = {
      'openai-codex/work': polledSnapshot,
    };
    await updateSessionViewAndSettle(screen, { routeServerId: 'server-route-polled' });

    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      ringValueLabel: '55',
      recoveryCreditSummary: null,
    }));
    expect(findProviderUsageRecoveryAction(screen)).toBeUndefined();
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));
    await act(async () => {
      await findProviderUsageRecoveryAction(screen)();
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
          recoveryCredits: normalizeRecoveryCreditsFixture({
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [{ kind: 'usage_limit_reset', status: 'available' }],
          }),
        },
      },
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        agentId: 'codex',
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
    expect(findProviderUsageGauge(screen)).toEqual(expect.objectContaining({
      recoveryCreditSummary: expect.objectContaining({ availableCount: 1 }),
    }));

    await act(async () => {
      await findProviderUsageRecoveryAction(screen)();
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

  it('keeps direct takeover footer status conservative and exposes one explicit takeover preflight', async () => {
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
      materialize: null,
    });
    expect(machineDirectSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(machineDirectSessionTakeoverSpy).not.toHaveBeenCalled();
  });

  it('projects Import into Happier as the primary normal control for a machine-only linked session', async () => {
    const current = storageState.sessions.s1;
    const {
      directSessionV1: _releasedLink,
      ...metadata
    } = current.metadata;
    storageState.sessions.s1 = {
      ...current,
      currentStorageState: 'machine_only',
      metadata: {
        ...metadata,
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
          linkedAtMs: 42,
        },
      },
    };

    await renderSessionView();

    const latestChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestChatListProps?.externalControlFooter?.materialize).toEqual({
      requestEnabled: true,
      inFlight: false,
      onRequest: expect.any(Function),
    });
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

  it.each([
    {
      decision: 'approve',
      actionTestId: 'permission-footer.allow',
      approved: true,
      providerDecision: 'approved',
    },
    {
      decision: 'deny',
      actionTestId: 'permission-footer.deny',
      approved: false,
      providerDecision: 'denied',
    },
  ] as const)(
    'keeps a hidden post-End Voice permission actionable through the ordinary session composer for $decision',
    async ({ actionTestId, approved, providerDecision }) => {
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
        toolViewDetailLevelDefault: 'title',
      };
      renderRealAgentInputPermissionSurfaceState.current = true;

      const session = storageState.sessions.s1 as any;
      session.canApprovePermissions = true;
      session.access = createSessionAccessFixture('edit', { approveRuntimePermissions: true });
      session.metadata = {
        ...session.metadata,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
      };
      session.agentState = null;
      sessionMessagesState.current = [
        {
          kind: 'tool-call',
          id: 'm-hidden-voice-permission',
          localId: null,
          createdAt: 2,
          children: [],
          tool: {
            id: 'hidden-voice-permission',
            name: 'Bash',
            state: 'running',
            input: { command: 'git status' },
            createdAt: 2,
            startedAt: 2,
            completedAt: null,
            description: 'Inspect repository status',
            permission: {
              id: 'hidden-voice-permission',
              status: 'pending',
              kind: 'permission',
            },
          },
        },
      ];

      const screen = await renderSessionViewAndSettle({ routeServerId: 'server-a' });

      expect(voiceSurfacePropsSpy).not.toHaveBeenCalled();
      expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();
      expect(screen.findByTestId('permission-prompt-card')).toBeTruthy();
      expect(findAgentInput(screen).props.permissionRequests).toEqual([
        expect.objectContaining({
          id: 'hidden-voice-permission',
          tool: 'Bash',
          kind: 'permission',
          arguments: { command: 'git status' },
        }),
      ]);

      await screen.pressByTestIdAsync(actionTestId);

      expect(screen.findByTestId('permission-footer.action-error')).toBeNull();
      expect(sessionRpcWithPreferredSessionScopeSpy).toHaveBeenCalledTimes(1);
      expect(sessionRpcWithPreferredSessionScopeSpy).toHaveBeenCalledWith({
        sessionId: 's1',
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: expect.objectContaining({
          id: 'hidden-voice-permission',
          approved,
          decision: providerDecision,
        }),
      });
      expect(voiceSurfacePropsSpy).not.toHaveBeenCalled();
      expect(sendVoiceSessionComposerTextSpy).not.toHaveBeenCalled();
    },
  );

  it('mounts the Voice surface even when the configured next-start provider is Off', async () => {
    /*
     * Presentation is the Voice surface's own decision (`resolveVoicePresentedProviderId`):
     * a running attempt keeps its surface after the user selects Off, because hiding it
     * would leave an open microphone with no control to stop it. The session host is not a
     * second decision-maker — gating the mount on the *configured* next-start provider
     * unmounted the surface out from under a live attempt.
     */
    featureEnabledState.voice = true;
    settingsState.current = { voice: { providerId: 'off' } };
    settingByKeyState.current = {
      voice: { providerId: 'off' },
      toolViewDetailLevelDefault: 'title',
    };

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-b' });

    expect(voiceSurfacePropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'session',
        sessionAddress: { serverId: 'server-b', sessionId: 's1' },
      }),
    );
    expect(screen.findByTestId('session-agent-input')?.props.sessionAddress).toEqual({
        serverId: 'server-b',
        sessionId: 's1',
    });
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
          createdBy: { surface: 'agent', sessionId: 's1' },
          requestedSurface: 'agent',
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
          v: 1,
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
          createdBy: expect.objectContaining({ surface: 'agent', sessionId: 's1' }),
        }),
      }),
    ]);
  });

  it('passes live engine control props directly to AgentInput instead of custom agent picker options', async () => {
    // ACP intent is owner-private metadata, so this positive publishing case
    // supplies the owner's current access projection rather than an editor row.
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      access: createSessionAccessFixture('owner'),
      accessLevel: 'owner',
      canApprovePermissions: true,
    };
    const session = storageState.sessions.s1;
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
    expect(agentInput.props.agentPickerApplyLabel).toBeUndefined();
    // The in-session Agent catalog extends the composer's own row rather than replacing
    // the projection, and selects nothing of its own until a continuation is armed.
    expect(typeof agentInput.props.composeAgentPickerOptions).toBe('function');
    expect(agentInput.props.agentPickerSelectedOptionId).toBeNull();
    expect(agentInput.props.metadata).toEqual(session.metadata);
    expect(typeof agentInput.props.onModelModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpSessionModeChange).toBe('function');
    expect(typeof agentInput.props.onAcpConfigOptionChange).toBe('function');

    await act(async () => {
      agentInput.props.onAcpSessionModeChange('plan');
      agentInput.props.onAcpConfigOptionChange('thinking', 'high');
    });

    await waitForHomeGovernance(() => {
      const metadata = readSessionOwnerMetadataView(storage.getState().sessions.s1);
      expect(metadata?.acpSessionModeOverrideV1).toEqual(expect.objectContaining({ modeId: 'plan' }));
      expect(metadata?.acpConfigOptionOverridesV1).toEqual(expect.objectContaining({
        overrides: { thinking: expect.objectContaining({ value: 'high' }) },
      }));
    });
  });

  it('supplies the canonical native-only SessionModelPicker when Providers are feature-disabled', async () => {
    const screen = await renderSessionViewAndSettle();

    expect(providerModelProjectionState.inputSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    expect(modelContentOverride).toBeTruthy();
    expect(modelContentOverride.props.agentTargetKey).toBe('agent:happier.agent.codex/codex');
    expect(modelContentOverride.props.providerGroups).toEqual([]);
    expect(modelContentOverride.props.hiddenNativeModelKeys).toEqual(new Set());
  });

  it('projects a uniquely resolved unqualified native selection onto its advertised existing-session row', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-luna',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'openai-codex/gpt-5.6-luna',
          availableModels: [{
            id: 'openai-codex/gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            modelOptions: [{
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
              ],
            }],
          }],
        },
      },
    };

    const screen = await renderSessionViewAndSettle();
    const picker = findAgentInput(screen).props.modelContentOverride;

    expect(picker.props.selected).toEqual({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'openai-codex/gpt-5.6-luna',
    });
    expect(picker.props.effectiveLabel).toBe('GPT-5.6 Luna');
    expect(picker.props.selectedOptionControls).toEqual([
      expect.objectContaining({ option: expect.objectContaining({ id: 'reasoning_effort' }) }),
    ]);
  });

  it.each([
    {
      label: 'Provider model',
      selection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
      expectedInput: {
        sessionId: 's1',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    },
    {
      label: 'native default',
      selection: null,
      expectedInput: {
        sessionId: 's1',
        providerConnectionId: null,
        modelId: 'default',
      },
    },
  ])('routes an existing-session $label selection through session.model.set', async ({
    selection,
    expectedInput,
  }) => {
    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;

    await act(async () => {
      modelContentOverride.props.onSelect(selection);
      await Promise.resolve();
    });

    expect(actionExecuteSpy).toHaveBeenCalledWith(
      'session.model.set',
      expectedInput,
      {
        surface: 'ui',
        defaultSessionId: 's1',
        serverId: 'server-route-1',
      },
    );
    expect(homes.requests.filter(({ input }) => SessionMetadataTuplePatchV1Schema.safeParse(input).success)).toEqual([]);
  });

  it('admits an embed\'s granted model change without Send in a controls-only composer', async () => {
    // Send off, Change model on: the credential grants `session.model.set` on its own, so the
    // model control is reachable and its mutation is admitted without text submission.
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      accessLevel: 'view',
      access: createSessionAccessFixture('view'),
    };
    const screen = await renderSessionViewAndSettle({
      routeServerId: 'server-route-1',
      presentation: { kind: 'embedded', composer: 'auto', modelPicker: true, modelSelectionGranted: true },
    });
    const agentInput = findAgentInput(screen);
    expect(agentInput.props.inputPresentation).toBe('controlsOnly');

    await act(async () => {
      agentInput.props.modelContentOverride.props.onSelect(null);
      await Promise.resolve();
    });

    expect(actionExecuteSpy).toHaveBeenCalledWith(
      'session.model.set',
      { sessionId: 's1', providerConnectionId: null, modelId: 'default' },
      { surface: 'ui', defaultSessionId: 's1', serverId: 'server-route-1' },
    );
  });

  it('keeps an embed without Send or a model grant composer-free', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      accessLevel: 'view',
      access: createSessionAccessFixture('view'),
    };
    const screen = await renderSessionViewAndSettle({
      routeServerId: 'server-route-1',
      // The picker alone (a host choice) is not authority to change the model.
      presentation: { kind: 'embedded', composer: 'auto', modelPicker: true },
    });

    expect(findAgentInput(screen)).toBeNull();
  });

  it('routes an exact existing-session Team resource selection through session.model.set', async () => {
    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: 'team-model',
    };

    await act(async () => {
      modelContentOverride.props.onSelectTeamCredentialModel(teamCredentialModel);
      await Promise.resolve();
    });

    expect(actionExecuteSpy).toHaveBeenCalledWith(
      'session.model.set',
      { sessionId: 's1', teamCredentialModel },
      { surface: 'ui', defaultSessionId: 's1', serverId: 'server-route-1' },
    );
    expect(homes.requests.filter(({ input }) => SessionMetadataTuplePatchV1Schema.safeParse(input).success)).toEqual([]);
  });

  it('offers the explicit restart for a Team resource selection the Home committed', async () => {
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: 'team-model',
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        reason: 'team_resource_binding_changed',
        requestedTeamSelection: teamCredentialModel,
      },
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    await act(async () => {
      modelContentOverride.props.onSelectTeamCredentialModel(teamCredentialModel);
      await Promise.resolve();
    });
    await settleDirectSessionView();

    // The Home accepted this selection; only the process already running has
    // not adopted it. Restarting stays the person's explicit choice, and the
    // committed selection is never reported as an unavailable connection.
    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
    expect(restartConfigurationSessionRunnerSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });

  it('reports a Team resource selection the Home never committed as its own refusal', async () => {
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: 'team-model',
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'team_resource_active_transition_unsupported',
      error: 'team_resource_active_transition_unsupported',
      details: {
        status: 'team_resource_active_transition_unsupported',
        reason: 'session_activated_before_team_resource_commit',
      },
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    await act(async () => {
      modelContentOverride.props.onSelectTeamCredentialModel(teamCredentialModel);
      await Promise.resolve();
    });
    await settleDirectSessionView();

    // Nothing was saved, so there is nothing to restart into.
    expect(screen.findByTestId('session.providerBinding.banner')).toBeNull();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'teams.credentials.selection.activeTransitionUnsupported',
    );
  });

  it.each(['brokered', 'direct'] as const)(
    'preserves the exact %s route when restoring an existing-session Team model proposal',
    async (deliveryMode) => {
      const state = (await import('@/sync/domains/state/storage')).storage.getState();
      const session = state.sessions.s1 as any;
      storageState.sessions.s1 = {
        ...session,
        metadata: {
          ...session.metadata,
          modelSelectionIntentV2: {
            v: 2,
            updatedAt: 11,
            ref: {
              source: 'team_resource',
              teamId: 'team-1',
              resourceId: 'resource-1',
              expectedResourceRevision: 7,
              deliveryMode,
              agentTargetKey: 'agent:happier.agent.codex/codex',
              modelId: 'team-model',
            },
          },
        },
      };

      const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });

      expect(findAgentInput(screen).props.modelContentOverride.props.selectedTeamCredentialModel).toEqual({
        kind: 'team_credential_provider_model',
        teamId: 'team-1',
        resourceId: 'resource-1',
        expectedResourceRevision: 7,
        deliveryMode,
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: 'team-model',
      });
    },
  );

  it('restores restart-to-apply UX after remount from the durable V2 Team model intent', async () => {
    const state = (await import('@/sync/domains/state/storage')).storage.getState();
    const session = state.sessions.s1;
    if (!session) throw new Error('expected session fixture');
    storageState.sessions.s1 = {
      ...session,
      active: true,
      metadata: {
        ...session.metadata,
        modelSelectionIntentV2: {
          v: 2,
          updatedAt: 11,
          ref: {
            source: 'team_resource',
            teamId: 'team-1',
            resourceId: 'resource-1',
            expectedResourceRevision: 7,
            deliveryMode: 'brokered',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'team-model',
          },
        },
      },
    };

    const firstScreen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(firstScreen.findByTestId('session.providerBinding.banner')).toBeTruthy();
    await firstScreen.unmount();

    const remountedScreen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    expect(remountedScreen.findByTestId('session.providerBinding.banner')).toBeTruthy();
    expect(
      findAgentInput(remountedScreen).props.modelContentOverride.props.selectedTeamCredentialModel,
    ).toEqual({
      kind: 'team_credential_provider_model',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: 'team-model',
    });
  });

  it('leaves active and proposed model facts unchanged when the transition owner is unavailable', async () => {
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'session_model_transition_owner_unavailable',
      error: 'session_model_transition_owner_unavailable',
    });
    const screen = await renderSessionViewAndSettle();
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    const modelModeBeforeSelection = storage.getState().sessions.s1.modelMode;

    await act(async () => {
      modelContentOverride.props.onSelect({
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      });
      await Promise.resolve();
    });

    expect(actionExecuteSpy).toHaveBeenCalledOnce();
    expect(storage.getState().sessions.s1.modelMode).toBe(modelModeBeforeSelection);
    expect(storageState.sessions.s1.metadata).not.toHaveProperty('modelSelectionIntentV1');
    expect(homes.requests.filter(({ input }) => SessionMetadataTuplePatchV1Schema.safeParse(input).success)).toEqual([]);
  });

  it.each([
    'restart_required',
    'reconciliation_required',
  ] as const)('surfaces %s and restarts through the existing Provider runner recovery', async (status) => {
    featureEnabledState.providers = true;
    const requestedSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
      modelId: 'provider-model',
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: status,
      error: status,
      details: {
        status,
        activeSelection: status === 'reconciliation_required'
          ? null
          : {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null,
              modelId: 'default',
            },
        requestedSelection,
      },
    });
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue({
      state: {
        v: 1,
        sessionId: 's1',
        machineId: 'machine-1',
        observedAtMs: 1,
        runner: {
          pid: 123,
          runtimeId: 'version:cli-current',
          processCommandHash: 'hash-current',
          entrypointVersion: 'cli-current',
          entrypointSource: 'process_command',
          startedBy: 'daemon',
          startingMode: 'remote',
        },
        daemon: {
          currentEntrypointVersion: 'version:cli-current',
          currentEntrypointSource: 'launch_spec',
        },
        versionState: 'current',
        statusSource: 'daemon_tracking',
        plannedRestart: {
          supported: true,
          eligible: true,
        },
      },
      runnerProcessIdentity: { pid: 123, processStartTimeMs: 1_000 },
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    await act(async () => {
      modelContentOverride.props.onSelect(requestedSelection);
      await Promise.resolve();
    });
    await settleDirectSessionView();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
    await pressTestInstanceAsync(screen.findByTestId('session.providerBinding.action'));
    expect(restartProviderBindingSessionRunnerSpy).toHaveBeenCalledWith({
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'machine-1',
      }),
      runnerProcessIdentity: { pid: 123, processStartTimeMs: 1_000 },
      serverId: 'server-route-1',
    });
  });

  it('never reuses a cached Provider restart target after the control machine changes', async () => {
    const requestedSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'native-next',
    } as const;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: requestedSelection,
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-old',
          availableModels: [
            { id: 'native-old', name: 'Native old' },
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'native-old',
        },
        requestedSelection,
      },
    });
    const runtimeState = (machineId: string) => ({
      v: 1 as const,
      sessionId: 's1',
      machineId,
      observedAtMs: 1,
      runner: {
        pid: machineId === 'machine-1' ? 123 : 456,
        runtimeId: `version:${machineId}`,
        processCommandHash: `hash:${machineId}`,
        entrypointVersion: 'cli-current',
        entrypointSource: 'process_command' as const,
        startedBy: 'daemon' as const,
        startingMode: 'remote' as const,
      },
      daemon: {
        currentEntrypointVersion: 'version:cli-current',
        currentEntrypointSource: 'launch_spec' as const,
      },
      versionState: 'current' as const,
      statusSource: 'daemon_tracking' as const,
      plannedRestart: {
        supported: true,
        eligible: true,
      },
    });
    let resolveMachineTwo!: (value: ReturnType<typeof runtimeState>) => void;
    const machineTwoStatus = new Promise<ReturnType<typeof runtimeState>>((resolve) => {
      resolveMachineTwo = resolve;
    });
    getSessionRunnerRuntimeStatusSpy.mockImplementation(async (request: any) => {
      const state = request.machineId === 'machine-1'
        ? runtimeState('machine-1')
        : await machineTwoStatus;
      return {
        state,
        runnerProcessIdentity: {
          pid: state.runner.pid,
          processStartTimeMs: state.runner.pid === 123 ? 1_000 : 2_000,
        },
      };
    });

    const screen = await renderSessionViewAndSettle({ routeServerId: 'server-route-1' });
    await act(async () => {
      findAgentInput(screen).props.modelContentOverride.props.onSelect(requestedSelection);
      await Promise.resolve();
    });
    await settleDirectSessionView();
    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        machineId: 'machine-2',
      },
    };
    await updateSessionViewAndSettle(screen, {
      routeServerId: 'server-route-1',
      jumpToSeq: 1,
    });
    expect(getSessionRunnerRuntimeStatusSpy).toHaveBeenLastCalledWith({
      sessionId: 's1',
      machineId: 'machine-2',
      serverId: 'server-route-1',
    });

    const restartAction = screen.findByTestId('session.providerBinding.action');
    if (!restartAction) throw new Error('expected provider binding restart action');
    const restartPromise = restartAction.props.onPress() as Promise<void>;
    await Promise.resolve();
    expect(restartProviderBindingSessionRunnerSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveMachineTwo(runtimeState('machine-2'));
      await restartPromise;
    });
    expect(restartProviderBindingSessionRunnerSpy).toHaveBeenCalledWith({
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'machine-2',
      }),
      runnerProcessIdentity: { pid: 456, processStartTimeMs: 2_000 },
      serverId: 'server-route-1',
    });
  });

  it('does not clear local restart UX from another Agent model snapshot', async () => {
    const requestedSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'default',
    } as const;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        sessionModelsV1: {
          v: 1,
          agentId: 'stale-agent',
          updatedAt: 10,
          currentModelId: 'default',
          availableModels: [
            { id: 'default', name: 'Stale Agent default' },
          ],
        },
      },
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'native-old',
        },
        requestedSelection,
      },
    });
    const screen = await renderSessionViewAndSettle();
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;

    await act(async () => {
      modelContentOverride.props.onSelect(requestedSelection);
      await Promise.resolve();
    });
    await settleDirectSessionView();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('restores restart-to-apply UX after remount from durable native intent versus active runtime facts', async () => {
    const runtimeState = buildSessionRunnerRuntimeStatus({
      sessionId: 's1',
      machineId: 'machine-1',
      versionState: 'current',
    });
    const runnerProcessIdentity = {
      pid: runtimeState.runner.pid!,
      processStartTimeMs: 2_000,
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      activeAt: 1_000_000,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'native-next',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-old',
          activeSelectionV1: {
            v: 1,
            selection: {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null,
              modelId: 'native-old',
            },
            source: 'runtime_readback',
            runner: runnerProcessIdentity,
          },
          availableModels: [
            { id: 'native-old', name: 'Native old' },
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue({
      state: runtimeState,
    });

    const screen = await renderSessionViewAndSettle();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('projects a matching exact runner witness as running active model truth after remount', async () => {
    const runtimeState = buildSessionRunnerRuntimeStatus({
      sessionId: 's1',
      machineId: 'machine-1',
      versionState: 'current',
      pid: 123,
    });
    const runnerProcessIdentity = {
      pid: 123,
      processStartTimeMs: 2_000,
    };
    const activeSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'native-next',
    } as const;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      activeAt: 1_000_000,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: activeSelection,
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-next',
          activeSelectionV1: {
            v: 1,
            selection: activeSelection,
            source: 'runtime_readback',
            runner: runnerProcessIdentity,
          },
          availableModels: [
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue({
      state: runtimeState,
      runnerProcessIdentity,
    });

    const screen = await renderSessionViewAndSettle();
    const agentInput = findAgentInput(screen);

    expect(agentInput.props.currentRunnerProcessIdentity).toEqual(runnerProcessIdentity);
    expect(agentInput.props.modelContentOverride.props.reportedModel).toEqual({
      ref: activeSelection,
      status: 'running',
    });
    expect(screen.findByTestId('session.providerBinding.banner')).toBeNull();
  });

  it('keeps V1 presentation but retracts a stale V2 runner witness when a remount refresh is unavailable', async () => {
    const runtimeState = buildSessionRunnerRuntimeStatus({
      sessionId: 's1',
      machineId: 'machine-1',
      versionState: 'current',
      pid: 123,
    });
    const runnerProcessIdentity = {
      pid: 123,
      processStartTimeMs: 2_000,
    };
    const activeSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'native-next',
    } as const;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      activeAt: 1_000_000,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: activeSelection,
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-next',
          activeSelectionV1: {
            v: 1,
            selection: activeSelection,
            source: 'runtime_readback',
            runner: runnerProcessIdentity,
          },
          availableModels: [
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };
    getSessionRunnerRuntimeStatusSpy
      .mockResolvedValueOnce({
        state: runtimeState,
        runnerProcessIdentity,
      })
      .mockResolvedValueOnce(null);

    const firstScreen = await renderSessionViewAndSettle();
    expect(findAgentInput(firstScreen).props.currentRunnerProcessIdentity).toEqual(runnerProcessIdentity);
    await firstScreen.unmount();

    const secondScreen = await renderSessionViewAndSettle();

    expect(findAgentInput(secondScreen).props.currentRunnerProcessIdentity).toBeNull();
    expect(findAgentInput(secondScreen).props.modelContentOverride.props.reportedModel).toEqual({
      ref: activeSelection,
      status: 'last_reported',
    });
    expect(secondScreen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('keeps restart-to-apply visible after same-version PID reuse invalidates active proof', async () => {
    const replacementRuntimeState = buildSessionRunnerRuntimeStatus({
      sessionId: 's1',
      machineId: 'machine-1',
      versionState: 'current',
      pid: 123,
      runtimeId: 'version:cli-current',
    });
    const activeSelectionRunnerProcessIdentity = {
      pid: 123,
      processStartTimeMs: 1_000,
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      activeAt: 1_000_000,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'native-next',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-next',
          activeSelectionV1: {
            v: 1,
            selection: {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null,
              modelId: 'native-next',
            },
            source: 'runtime_apply',
            runner: activeSelectionRunnerProcessIdentity,
          },
          availableModels: [
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };
    getSessionRunnerRuntimeStatusSpy.mockResolvedValue({
      state: replacementRuntimeState,
      runnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 2_000,
      },
    });

    const screen = await renderSessionViewAndSettle();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
    expect(findAgentInput(screen).props.modelContentOverride.props.reportedModel).toEqual({
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'native-next',
      },
      status: 'last_reported',
    });
  });

  it('keeps restart-to-apply visible when only fallback current-model metadata matches the proposal', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'native-next',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-next',
          availableModels: [
            { id: 'native-next', name: 'Native next' },
          ],
        },
        sessionAppliedModelV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 9,
          modelId: 'native-next',
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'native-next',
          },
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('does not label a fallback current-model projection as running without exact active proof', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'native-next',
          availableModels: [
            { id: 'native-next', name: 'Native next' },
          ],
        },
      },
    };

    const screen = await renderSessionViewAndSettle();
    const picker = findAgentInput(screen).props.modelContentOverride;

    expect(picker.props.reportedModel).toEqual({
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'native-next',
      },
      status: 'last_reported',
    });
  });

  it('does not treat another Agent model snapshot as exact active truth or a confirmed transition after remount', async () => {
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'native-next',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'stale-agent',
          updatedAt: 10,
          currentModelId: 'native-next',
          availableModels: [
            { id: 'native-next', name: 'Stale Agent model' },
          ],
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('keeps restart-to-apply UX for supported older Provider bindings without an embedded model', async () => {
    featureEnabledState.providers = true;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        providerBindingV1: {
          v: 1,
          connectionId: 'pc_work',
          contributionKey: null,
          connectionRevision: 1,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          compatibilityFingerprint: 'compatibility:v1:a',
          bindingSecurityFingerprint: 'binding-security:v1:a',
          displaySnapshot: {
            providerName: 'Gateway',
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 11,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-next',
          },
        },
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 10,
          currentModelId: 'provider-next',
          availableModels: [
            { id: 'provider-next', name: 'Provider next' },
          ],
        },
      },
    };

    const screen = await renderSessionViewAndSettle();

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('does not clear local restart presentation from fallback current-model metadata', async () => {
    featureEnabledState.providers = true;
    const requestedSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_b'),
      modelId: 'model-b',
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'default',
        },
        requestedSelection,
      },
    });
    const screen = await renderSessionViewAndSettle();
    await act(async () => {
      findAgentInput(screen).props.modelContentOverride.props.onSelect(requestedSelection);
      await Promise.resolve();
    });
    await settleDirectSessionView();
    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();

    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 20,
          currentModelId: 'default',
          availableModels: [
            { id: 'default', name: 'Default' },
          ],
        },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 20,
          selection: requestedSelection,
        },
      },
    };
    await updateSessionViewAndSettle(screen, { jumpToSeq: 1 });

    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();
  });

  it('suppresses local Provider restart presentation when the Providers feature turns off', async () => {
    featureEnabledState.providers = true;
    const requestedSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_b'),
      modelId: 'model-b',
    };
    actionExecuteSpy.mockResolvedValue({
      ok: false,
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'default',
        },
        requestedSelection,
      },
    });
    const screen = await renderSessionViewAndSettle();
    await act(async () => {
      findAgentInput(screen).props.modelContentOverride.props.onSelect(requestedSelection);
      await Promise.resolve();
    });
    await settleDirectSessionView();
    expect(screen.findByTestId('session.providerBinding.banner')).toBeTruthy();

    featureEnabledState.providers = false;
    await updateSessionViewAndSettle(screen, { jumpToSeq: 1 });

    expect(screen.findByTestId('session.providerBinding.banner')).toBeNull();
  });

  it('does not derive Provider switch presentation from retained projection data after Providers are disabled', async () => {
    const providerConnectionId = ProviderConnectionIdSchema.parse('pc_stale');
    const exactSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId,
      modelId: 'provider-only-model',
    };
    const retainedGroup = {
      connectionId: providerConnectionId,
      providerName: 'Retained Gateway',
      connectionName: 'Retained connection',
      connectionRole: 'named' as const,
      connectionDisplayNameMode: 'custom' as const,
      connectionRevision: 1,
      authorization: { authorized: true as const },
      manualModelPolicy: 'allowed' as const,
      supportsFreeformModelIds: true,
      suppressedConnectedServiceIds: [],
      modelLoadAction: 'descriptor_absent' as const,
      rows: [{
        ref: exactSelection,
        descriptor: { id: exactSelection.modelId, name: 'Retained model' },
        sources: { manual: false, static: true, probe: false },
        confidence: 'verified_static' as const,
        compatibility: {
          result: {
            status: 'verified' as const,
            selectedProtocol: 'openai-responses' as const,
            evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-13' },
          },
          compatibilityFingerprint: 'compatibility:v1:retained',
          confirmed: true,
        },
        endpointHealth: 'available' as const,
        catalog: { stale: false },
        loadState: 'unknown' as const,
        visibility: 'visible' as const,
      }],
    } satisfies SessionModelProjectionGroup;
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: exactSelection,
        },
      },
    };
    providerModelProjectionState.value = {
      data: {
        status: 'success',
        agentTargetKey: exactSelection.agentTargetKey,
        groups: [retainedGroup],
      },
      error: null,
      loading: false,
      status: 'success',
      refresh: vi.fn(async () => {}),
    };

    const screen = await renderSessionViewAndSettle();

    expect(providerModelProjectionState.inputSpy).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      currentSelection: exactSelection,
    }));
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    expect(modelContentOverride.props.providerGroups).toEqual([]);
    expect(modelContentOverride.props.selected).toEqual(exactSelection);
    expect(screen.findByTestId('session.providerBinding.banner')).toBeNull();
  });

  it('preserves the persisted launch binding label when Providers are feature-disabled', async () => {
    const providerConnectionId = ProviderConnectionIdSchema.parse('pc_launch');
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        providerBindingV1: {
          v: 1,
          connectionId: providerConnectionId,
          contributionKey: null,
          connectionRevision: 1,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          compatibilityFingerprint: 'compatibility:v1:launch',
          bindingSecurityFingerprint: 'binding-security:v1:launch',
          displaySnapshot: {
            providerName: 'Launch Gateway',
            connectionName: 'Launch connection',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
      },
    };
    const screen = await renderSessionViewAndSettle();

    expect(findAgentInput(screen).props.statusBadges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'provider-binding',
        label: 'session.providerBinding.launchNamedLabel',
      }),
    ]));
    expect(screen.findByTestId('session.providerBinding.banner')).toBeNull();
  });

  it('keeps an exact Provider selection in the canonical picker when enabled projection fails before data', async () => {
    featureEnabledState.providers = true;
    const providerConnectionId = (await import('@happier-dev/protocol')).ProviderConnectionIdSchema.parse('pc_stale');
    const exactSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId,
      modelId: 'provider-only-model',
    };
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      metadata: {
        ...storageState.sessions.s1.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: exactSelection,
        },
      },
    };
    providerModelProjectionState.value = {
      data: null,
      error: {
        v: 1,
        code: 'provider_endpoint_unreachable',
        retryable: true,
        action: 'retry',
        connectionId: providerConnectionId,
      },
      loading: false,
      status: 'error',
      refresh: vi.fn(async () => {}),
    };
    const screen = await renderSessionViewAndSettle();

    expect(providerModelProjectionState.inputSpy).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      currentSelection: exactSelection,
    }));
    const modelContentOverride = findAgentInput(screen).props.modelContentOverride;
    expect(modelContentOverride).toBeTruthy();
    expect(modelContentOverride.props.agentTargetKey).toBe('agent:happier.agent.codex/codex');
    expect(modelContentOverride.props.providerGroups).toEqual([]);
    expect(modelContentOverride.props.selected).toEqual(exactSelection);
    expect(modelContentOverride.props.effectiveLabel).toBe('provider-only-model');
  });

  it('publishes ACP config-option overrides without creating a parallel local override owner', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
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
    expect(agentInput.props.acpConfigOptionOverridesOverride).toBeUndefined();

    await act(async () => {
      agentInput.props.onAcpConfigOptionChange('thinking', 'high');
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.acpConfigOptionOverridesOverride).toBeUndefined();
    await waitForHomeGovernance(() => {
      expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)?.acpConfigOptionOverridesV1).toEqual(expect.objectContaining({
        overrides: { thinking: expect.objectContaining({ value: 'high' }) },
      }));
    });
  });

  it('projects the reported runtime model separately from the selected model and its controls', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      flavor: 'grok',
      directSessionV1: {
        ...session.metadata.directSessionV1,
        providerId: 'grok',
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'grok',
        updatedAt: 1,
        currentModelId: 'grok-4.5',
        availableModels: [{
          id: 'grok-4.5',
          name: 'Grok 4.5',
          modelOptions: [{
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'high', name: 'High' },
              { value: 'medium', name: 'Medium' },
              { value: 'low', name: 'Low' },
            ],
          }],
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const picker = findAgentInput(screen).props.modelContentOverride;
    expect(picker.props.selected).toBeNull();
    expect(picker.props.reportedModel).toEqual({
      ref: {
        agentTargetKey: 'agent:happier.agent.grok/grok',
        providerConnectionId: null,
        modelId: 'grok-4.5',
      },
      status: 'last_reported',
    });
    expect(picker.props.selectedOptionControls).toBeUndefined();
  });

  it('derives model-specific controls from the selected model instead of the reported runtime model', async () => {
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 2,
        selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5.6-sol',
        },
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 1,
        currentModelId: 'gpt-5.6-terra',
        availableModels: [
          {
            id: 'gpt-5.6-terra',
            name: '5.6 Terra',
            modelOptions: [{
              id: 'runtime_control',
              name: 'Runtime control',
              type: 'select',
              currentValue: 'runtime',
              options: [{ value: 'runtime', name: 'Runtime' }],
            }],
          },
          {
            id: 'gpt-5.6-sol',
            name: '5.6 Sol',
            modelOptions: [{
              id: 'selected_control',
              name: 'Selected control',
              type: 'select',
              currentValue: 'selected',
              options: [{ value: 'selected', name: 'Selected' }],
            }],
          },
        ],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const picker = findAgentInput(screen).props.modelContentOverride;

    expect(picker.props.selected).toEqual({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null,
      modelId: 'gpt-5.6-sol',
    });
    expect(picker.props.reportedModel).toEqual({
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'gpt-5.6-terra',
      },
      status: 'last_reported',
    });
    expect(picker.props.selectedOptionControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({ id: 'selected_control' }),
        effectiveValue: 'selected',
      }),
    ]);
  });

  it('resolves the published config-option override into the selected model controls', async () => {
    // A live session's Ultracode switch reads its state from these controls. When the memo
    // ignored the session's published overrides, the switch rendered the catalog default
    // (off) forever and every toggle snapped back on the next metadata tick.
    const session = (await import('@/sync/domains/state/storage')).storage.getState().sessions.s1 as any;
    session.metadata = {
      ...session.metadata,
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 7,
        overrides: { ultracode: { updatedAt: 7, value: 'true' } },
      },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 2,
        selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5.6-sol',
        },
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 1,
        currentModelId: 'gpt-5.6-sol',
        availableModels: [{
          id: 'gpt-5.6-sol',
          name: '5.6 Sol',
          modelOptions: [{
            id: 'ultracode',
            name: 'Ultracode',
            type: 'boolean',
            currentValue: 'false',
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'On' },
            ],
          }],
        }],
      },
    };

    const screen = await renderSessionViewAndSettle();
    const picker = findAgentInput(screen).props.modelContentOverride;

    expect(picker.props.selectedOptionControls).toEqual([
      expect.objectContaining({
        option: expect.objectContaining({ id: 'ultracode' }),
        requestedValue: 'true',
        effectiveValue: 'true',
        isPending: true,
      }),
    ]);
  });

  it('does not inject an unpublished Claude config override into the next submitted message', async () => {
    machineDirectSessionStatusGetSpy.mockResolvedValueOnce({
      ok: true,
      machineOnline: true,
      runnerActive: true,
      activity: 'running',
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
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
        agentId: 'claude',
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
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onAcpConfigOptionChange('reasoning_effort', 'low');
    });
    await settleDirectSessionView();

    await act(async () => {
      agentInput.props.onChangeText('use the lower effort');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sid: 's1',
        message: {
          t: 'plain',
          v: expect.objectContaining({
            content: { type: 'text', text: 'use the lower effort' },
            meta: expect.objectContaining({
              __happierComposerSourceRefV1: { kind: 'session', sessionId: 's1' },
            }),
          }),
        },
      }),
    );
    const payload = syncSubmitMessageSpy.mock.calls[0]?.[0] as { message: { v: { meta: Record<string, unknown> } } };
    expect(payload.message.v.meta).not.toHaveProperty('acpConfigOptionOverridesV1');
  });

  it('keeps composer text until direct-session acceptance, then clears it', async () => {
    installRunnerActiveDirectSubmitStatus();
    useCanonicalDraftScope();
    let resolveSubmit!: () => void;
    syncSubmitMessageSpy.mockImplementationOnce(
      async (...args: unknown[]) => {
        const payload = args[0] as { localId: string };
        return new Promise<unknown>((resolve) => {
          resolveSubmit = () => resolve({ ok: true, id: 'direct-message-1', seq: 2, localId: payload.localId });
        });
      },
    );
    const screen = await renderSessionView();
    let agentInput = findAgentInput(screen);
    await act(async () => {
      agentInput.props.onChangeText('continue this session');
    });

    agentInput.props.onSend();
    await vi.waitFor(() => expect(syncSubmitMessageSpy).toHaveBeenCalledTimes(1));

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('continue this session');

    await act(async () => {
      resolveSubmit();
    });
    await settleDirectSessionView();

    agentInput = findAgentInput(screen);
    expect(agentInput.props.value).toBe('');
  });

  it('restores composer text when direct-session outbound handoff fails before acceptance', async () => {
    installRunnerActiveDirectSubmitStatus();
    useCanonicalDraftScope();
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      throw new Error('direct send rejected');
    });
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
    installRunnerActiveDirectSubmitStatus();
    useCanonicalDraftScope();
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const payload = args[0] as { localId: string; message: unknown };
      homes.answer('server-route-1', '/v2/sessions/s1/pending?includeDiscarded=1', { body: {
        pending: [{
          localId: payload.localId,
          content: payload.message,
          messageRole: 'user',
          position: 0,
          createdAt: 1,
          updatedAt: 2,
          status: 'delivering',
          deliveryStatus: { status: 'delivering' },
        }],
      } });
      await sync.fetchPendingMessages('s1');
      expect(storage.getState().sessionPending.s1.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ localId: payload.localId, source: 'server_pending' }),
      ]));
      throw new Error('direct send response lost');
    });
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
    installRunnerActiveDirectSubmitStatus();
    useCanonicalDraftScope();
    syncSubmitMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const payload = args[0] as { localId: string };
      homes.answer(canonicalDraftScope.serverId, '/v1/sessions/s1/messages?scope=main', {
        body: { messages: [SessionMessageV1Schema.parse({
          id: 'history',
          seq: 1,
          localId: payload.localId,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'older recovered prompt' } } },
          createdAt: 1,
          transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        })], hasMore: false },
      });
      const authority = await captureServerRequestAuthorityForServerAccountScope({
        scope: canonicalDraftScope,
        activeRequest: async (path, init) => {
          const { serverFetch } = await import('@/sync/http/client');
          return serverFetch(path, init);
        },
      });
      try {
        await sync.refreshSessionMessages('s1', { authority });
      } finally {
        await authority.release();
      }
      expect(storage.getState().sessionMessages.s1.messagesById.history).toMatchObject({
        localId: payload.localId,
        transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
      });
      throw new Error('direct send rejected before server custody');
    });

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

  it('restores submitted text without overwriting newer semantic choices after direct-session handoff failure', async () => {
    installRunnerActiveDirectSubmitStatus();
    useCanonicalDraftScope();
    const oldRecipient = { kind: 'execution_run' as const, runId: 'run-old' };
    const newRecipient = { kind: 'execution_run' as const, runId: 'run-new' };
    const releaseSubmit = createDeferred<void>();
    const pendingPath = '/v2/sessions/s1/execution-runs/run-old/pending';

    draftValues.resetSessionDraftValueCachesForTests();
    draftValues.clearSessionDraftValuesForSession(canonicalDraftScope, 's1', { reason: 'sessionDelete' });
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient', oldRecipient);
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'send_now' });

    try {
      homes.answer(canonicalDraftScope.serverId, `POST ${pendingPath}`, {
        respondAfter: releaseSubmit.promise,
        status: 400,
        body: { error: 'direct send rejected' },
      });
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
      await waitForHomeGovernance(() => expect(homes.requestsFor(pendingPath)).toHaveLength(1));
      const outbound = SessionExecutionRunPendingEnqueueRequestV1Schema.parse(homes.requestsFor(pendingPath)[0].input);
      expect(outbound).toMatchObject({
        v: 1,
        targetMachineId: 'machine-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send to old target' } } },
        requestedAction: { v: 1, kind: 'send_now' },
      });

      expect(draftValues.readSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient')).toEqual(oldRecipient);
      expect(draftValues.readSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction')).toEqual({ v: 1, kind: 'send_now' });
      expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

      draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient', newRecipient);
      draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'enqueue' });

      await act(async () => {
        releaseSubmit.resolve();
        await sendPromise;
      });
      await settleDirectSessionView();

      agentInput = findAgentInput(screen);
      expect(agentInput.props.value).toBe('send to old target');
      expect(draftValues.readSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient')).toEqual(newRecipient);
      expect(draftValues.readSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction')).toEqual({ v: 1, kind: 'enqueue' });
      expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Failed to enqueue pending message (400)');
      expect(homes.requestsFor(pendingPath)).toHaveLength(1);
      expect(SessionExecutionRunPendingEnqueueRequestV1Schema.parse(homes.requestsFor(pendingPath)[0].input).localId).toBe(outbound.localId);
      expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    } finally {
      releaseSubmit.resolve();
      await clearCanonicalSessionDraft();
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
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient', { kind: 'execution_run', runId: 'run-1' });
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'send_now' });

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
    installRunnerActiveDirectSubmitStatus();
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
    storageState.sessionListRowsByServerId['server-1'] = {
      s1: {
        id: 's1',
        metadata: {
          machineId: 'machine-1',
          path: '/tmp',
        },
      },
    };
    storageState.ordinarySessionListMembershipByServerId['server-1'] = ['s1'];
    storageState.machines['machine-1'] = {
      id: 'machine-1',
      active: true,
      metadata: { host: 'happy-host' },
    };
    const screen = await renderSessionView();

    const agentInput = findAgentInput(screen);
    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sid: 's1',
        message: { t: 'plain', v: expect.objectContaining({
          content: { type: 'text', text: expect.stringContaining('Send this comment.') },
          meta: expect.objectContaining({
            happier: expect.objectContaining({
              kind: 'review_comments.v1',
              payload: expect.objectContaining({ comments: [expect.objectContaining({ id: 'included-draft' })] }),
            }),
          }),
        }) },
      }),
    );
    const payload = syncSubmitMessageSpy.mock.calls[0]?.[0] as { message: { v: { content: { text: string } } } };
    expect(payload.message.v.content.text).not.toContain('Keep this comment for later.');
    const remaining = Object.values(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey).flat();
    expect(remaining.map((draft) => draft.id)).toEqual(['detached-draft']);
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
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient', { kind: 'execution_run', runId: 'run-1' });
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'send_now' });

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
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.recipient', { kind: 'execution_run', runId: 'run-1' });
    draftValues.writeSessionDraftValue(canonicalDraftScope, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'send_now' });

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
    }) => chip.key === 'execution-run-requested-action');

    expect(deliveryChip).toEqual(expect.objectContaining({
      key: 'execution-run-requested-action',
      controlId: 'delivery',
    }));
    expect(deliveryChip?.collapsedOptionsPopover?.label).toBe('runs.delivery.cardDelivery');
    expect(deliveryChip?.collapsedOptionsPopover?.presentation).toBe('list');
    const deliveryFirstSection = deliveryChip?.collapsedOptionsPopover?.rootStep?.sections?.[0];
    const deliveryOptions = (deliveryFirstSection && deliveryFirstSection.kind === 'static'
      ? deliveryFirstSection.options ?? []
      : []);
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
    storageState.sessions.s1 = {
      ...storageState.sessions.s1,
      presence: 'offline',
      metadata: {
        ...storageState.sessions.s1.metadata,
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
    };
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
    expect(machineDirectSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(homes.requests.filter(({ path }) => path.startsWith('/v1/sessions/s1/messages'))).toEqual([]);
    expect(externalRpcRequests.filter(({ method }) => method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER)).toEqual([]);

    await act(async () => {
      await sleep(75);
    });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(machineDirectSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(homes.requests.filter(({ path }) => path.startsWith('/v1/sessions/s1/messages'))).toEqual([]);
    expect(externalRpcRequests.filter(({ method }) => method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER)).toEqual([]);
  });

  it('starts takeover on send without emitting input before explicit operation Resume', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', targetDirectory: '/tmp' });
    (storageState.sessions.s1 as any).metadata.directSessionV1 = {
      ...(storageState.sessions.s1 as any).metadata.directSessionV1,
      linkedAtMs: 1_000,
    };
    (storageState.sessions.s1 as any).metadata.externalSessionV1 = {
      v: 1,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'vendor-session-1',
      source: { kind: 'codexHome', home: 'user' },
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
      agentInput.props.onChangeText('continue this session');
    });

    await act(async () => {
      await agentInput.props.onSend();
    });

    expect(showDirectSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      target: {
        machineId: 'machine-1',
        machineHomeDir: '/tmp',
        initialDirectory: '/tmp',
        serverId: 'server-route-1',
      },
    });
    expect(externalRpcRequests).toContainEqual(expect.objectContaining({
      targetId: 'machine-1', method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START,
    }));
    expect(machineDirectSessionTakeoverSpy).toHaveBeenCalledWith({
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
        targetDirectory: '/tmp',
        targetRuntimeMode: 'terminal',
      },
    });
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('continue this session');

  });

  it('keeps the composer text when direct takeover is cancelled from the send prompt', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null });
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

  it('keeps the composer text visible while a direct takeover send prompt is still pending', async () => {
    showDirectSessionTakeoverDialogSpy.mockImplementationOnce(
      () => new Promise<{
        action: 'direct' | 'persisted' | null;
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
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();

  });

  it('uses canonical public intent without emitting input when persisting takeover from the send prompt', async () => {
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'persisted', targetDirectory: '/tmp' });
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
    (storageState.sessions.s1 as any).metadata.directSessionV1 = {
      ...(storageState.sessions.s1 as any).metadata.directSessionV1,
      linkedAtMs: 1_000,
    };
    (storageState.sessions.s1 as any).metadata.externalSessionV1 = {
      v: 1,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'vendor-session-1',
      source: { kind: 'codexHome', home: 'user' },
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

    expect(externalRpcRequests).toContainEqual(expect.objectContaining({
      targetId: 'machine-1', method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START,
    }));
    expect(machineDirectSessionTakeoverPersistSpy).toHaveBeenCalledWith({
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
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('persist this');

  });

  it('routes hidden voice conversation sends through the voice session binding helper and retains pending text', async () => {
    installRunnerActiveDirectSubmitStatus();
    sendVoiceSessionComposerTextSpy.mockResolvedValueOnce({
      ok: true,
      localId: 'voice-local-1',
      disposition: 'pending',
    });
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
    expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    expect(findAgentInput(screen).props.value).toBe('continue the voice conversation');

  });

  it('shows a typed definite-rejection error and preserves the hidden voice composer draft', async () => {
    installRunnerActiveDirectSubmitStatus();
    sendVoiceSessionComposerTextSpy.mockResolvedValueOnce({
      ok: false,
      reason: 'terminal_rejected',
      localId: 'voice-local-2',
      message: 'RPC method not available',
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
    expect(lastChatListProps?.externalControlFooter ?? null).toBeNull();
    expect(lastChatListProps?.onRequestSwitchToRemote).toBeUndefined();
    expect(voiceSurfacePropsSpy).not.toHaveBeenCalled();

    await act(async () => {
      await screen.unmount();
    });
  });

  it('renders exact-session Codex Voice without requiring its global account binding', async () => {
    featureEnabledState.voice = true;
    settingByKeyState.current = {
      voice: {
        providerId: 'happier.agent.codex/realtime-codex',
        providers: {
          'happier.agent.codex/realtime-codex': {
            schemaVersion: 2,
            config: { globalConnectedServices: null },
          },
        },
      },
    };

    const screen = await renderSessionView();

    expect(voiceSurfacePropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'session',
        sessionAddress: { serverId: 'server-route-1', sessionId: 's1' },
      }),
    );

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
