import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  type SpawnAttemptCustodyTestResult = Readonly<{
    status: 'unresolved' | 'completed';
    userAttemptId: string;
    spawnNonce: string;
    targetFingerprint: string;
    createdSessionId?: string | null;
    firstTurnLocalId?: string;
    attachmentMessageLocalId?: string;
  }>;
  type SpawnNewSessionTestResult =
    | Readonly<{
        type: 'error';
        errorCode:
          | typeof SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE
          | typeof SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          | typeof SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED
          | typeof SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST;
        errorMessage: string;
        spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
      }>
    | Readonly<{
        type: 'success';
        sessionId?: string;
        spawnNonce?: string;
        sessionIdStatus?: 'available' | 'pending';
        spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
      }>;
  type ResolveSpawnSessionTestResult =
    | Readonly<{ status: 'success'; sessionId: string }>
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'not_found' }>
    | Readonly<{ status: 'unsupported' }>
    | Readonly<{ status: 'transport_error' }>;

  const machineSpawnNewSessionSpy = vi.fn(async (_options: unknown): Promise<SpawnNewSessionTestResult> => ({
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Daemon RPC is not available',
  }));
  const machineResolveSpawnSessionByNonceSpy = vi.fn(async (): Promise<ResolveSpawnSessionTestResult> => ({ status: 'not_found' }));
  const machineResolveSpawnSessionByNonceUntilSettledSpy = vi.fn(async (_params: unknown): Promise<ResolveSpawnSessionTestResult> => ({ status: 'not_found' }));
  const modalConfirmSpy = vi.fn(async () => false);
  const completeMachineSpawnAttemptCustodySpy = vi.fn(async () => true);
  const reconcileSpawnAttemptCustodyFromOperationSpy = vi.fn(async (params: {
    outcome: { kind: 'succeeded'; createdSessionId: string } | { kind: 'failed' | 'cancelled' };
  }) => params.outcome.kind === 'succeeded'
    ? {
        status: 'reconciled' as const,
        record: {
          v: 2 as const,
          scope: { serverId: 'server-a', accountId: 'account-a' },
          machineId: 'm1',
          targetFingerprint: 'target-1',
          userAttemptId: 'attempt-reentry',
          nonce: 'request-reentry',
          phase: 'post_spawn' as const,
          createdSessionId: params.outcome.createdSessionId,
          firstTurnLocalId: 'first-turn-reentry',
          attachmentMessageLocalId: 'attachments-reentry',
        },
      }
    : { status: 'removed' as const });
  const followUpSpawnedSessionWithServerScopeSpy = vi.fn(async (_params: unknown) => {});
  const captureSessionDraftCurrentnessSpy = vi.fn((params: Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    address: Readonly<{ kind: 'newSession'; draftId: string }>;
  }>) => ({
    address: params.address,
    mutationIds: { 'composer.text': 'mutation-before-launch' },
  }));
  const captureSessionDraftLaunchCurrentnessSpy = vi.fn((params: Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    address: Readonly<{ kind: 'newSession'; draftId: string }>;
    userAttemptId: string;
  }>) => ({
    address: params.address,
    mutationIds: { 'composer.text': 'mutation-before-launch' },
  }));
  const clearSessionDraftCurrentnessSpy = vi.fn(async () => true);
  const clearSessionDraftLaunchCurrentnessSpy = vi.fn(() => true);
  const markActionOperationSeenSpy = vi.fn(() => true);
  const storageState = {
    settings: {},
    machines: { m1: { id: 'm1' } },
    sessions: {} as Record<string, { id: string }>,
    updateSessionPermissionMode: vi.fn(),
    updateSessionModelMode: vi.fn(),
    updateSessionDraft: vi.fn(),
  };

  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
          if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
          if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
          if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
          return key;
        },
      }),
    storage: async () =>
      createStorageModuleStub({
        storage: {
          getState: () => storageState,
        },
      }),
  });
  vi.doMock('@/modal', () => ({ Modal: { alert: modalAlertSpy, confirm: modalConfirmSpy } }));
  vi.doMock('@/sync/sync', () => ({
    sync: {
      applySettings: vi.fn(),
      encryption: { encryptRaw: vi.fn(), encryptAutomationTemplateRaw: vi.fn() },
      decryptSecretValue: vi.fn(),
      refreshAutomations: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
      refreshMachines: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      ensureSessionVisibleForMessageRoute: vi.fn(async (sessionId: string) => {
        storageState.sessions[sessionId] = { id: sessionId };
      }),
      acquireUserRequestLease: () => () => {},
    },
  }));
  vi.doMock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
  }));
  vi.doMock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: vi.fn(),
    loadSettings: () => ({ settings: {}, version: null }),
    loadDeviceAnalyticsId: () => null,
    saveDeviceAnalyticsId: vi.fn(),
    saveSettings: vi.fn(),
    loadPendingSettings: () => ({}),
    savePendingSettings: vi.fn(),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    loadThemePreference: () => 'adaptive',
    loadPurchases: () => ({}),
    savePurchases: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadSessionReviewCommentsDrafts: () => ({}),
    saveSessionReviewCommentsDrafts: vi.fn(),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
    saveWorkspaceReviewCommentsDrafts: vi.fn(),
    loadSessionActionDrafts: () => ({}),
    saveSessionActionDrafts: vi.fn(),
    loadLocalPetSourcesBySourceKey: () => ({}),
    saveLocalPetSourcesBySourceKey: vi.fn(),
    loadNewSessionDraft: () => null,
    saveNewSessionDraft: vi.fn(),
    loadSessionPermissionModes: () => ({}),
    saveSessionPermissionModes: vi.fn(),
    loadSessionPermissionModeUpdatedAts: () => ({}),
    saveSessionPermissionModeUpdatedAts: vi.fn(),
    loadSessionLastViewed: () => ({}),
    saveSessionLastViewed: vi.fn(),
    loadSessionModelModes: () => ({}),
    saveSessionModelModes: vi.fn(),
    loadSessionModelModeUpdatedAts: () => ({}),
    saveSessionModelModeUpdatedAts: vi.fn(),
    loadSessionMaterializedMaxSeqById: () => ({}),
    saveSessionMaterializedMaxSeqById: vi.fn(),
    loadChangesCursor: () => null,
    saveChangesCursor: vi.fn(),
    loadLastChangesCursorByAccountId: () => ({}),
    saveLastChangesCursorByAccountId: vi.fn(),
    loadProfile: () => ({}),
    saveProfile: vi.fn(),
    clearPersistence: vi.fn(),
  }));
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => ({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    })),
    setActiveServer: vi.fn(),
  }));
  vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
      targetServerId: params.requestedServerId ?? params.allowedServerIds[0] ?? null,
      rejectedRequestedServerId: null,
    })),
  }));
  vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
    resolveLocalFeaturePolicyEnabled: vi.fn((featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[featureId] === true),
  }));
  vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => ({ token: 'next-token', secret: 'next-secret' })),
  }));
  vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
    readRecoverableFollowUpPayload: (error: unknown) => {
      if (!(error instanceof Error)) return null;
      const payload = (error as Error & { recoverableFollowUpPayload?: unknown }).recoverableFollowUpPayload;
      if (
        typeof payload === 'object'
        && payload !== null
        && 'draftText' in payload
        && typeof (payload as { draftText?: unknown }).draftText === 'string'
      ) {
        return payload;
      }
      return null;
    },
  }));
  vi.doMock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: vi.fn(() => null) }));
  vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    prefetchMachineCapabilities: vi.fn(async () => {}),
  }));
  vi.doMock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: vi.fn(() => 'temp-data-key'),
  }));
  vi.doMock('@/agents/catalog/catalog', async () => {
    const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
    return {
      ...actual,
      getAgentCore: vi.fn(() => ({ model: { supportsSelection: false } })),
      buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
      buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
      getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
      getNewSessionPreflightIssues: vi.fn(() => []),
      buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
    };
  });
  vi.doMock('@/agents/runtime/resumeCapabilities', () => ({ canAgentResume: vi.fn(() => false) }));
  vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({ formatResumeSupportDetailCode: vi.fn(() => '') }));
  vi.doMock('@/sync/ops', () => ({
    machineBash: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    machineSpawnNewSession: machineSpawnNewSessionSpy,
    machineResolveSpawnSessionByNonce: machineResolveSpawnSessionByNonceSpy,
    machineResolveSpawnSessionByNonceUntilSettled: machineResolveSpawnSessionByNonceUntilSettledSpy,
    completeMachineSpawnAttemptCustody: completeMachineSpawnAttemptCustodySpy,
    resetMachineSpawnAttemptCustody: vi.fn(async () => true),
  }));
  vi.doMock('@/sync/ops/machines', async () => {
    const actual = await vi.importActual<typeof import('@/sync/ops/machines')>('@/sync/ops/machines');
    return {
      ...actual,
      machineResolveSpawnSessionByNonce: machineResolveSpawnSessionByNonceSpy,
      machineResolveSpawnSessionByNonceUntilSettled: machineResolveSpawnSessionByNonceUntilSettledSpy,
    };
  });
  vi.doMock('@/sync/domains/session/spawn/spawnAttemptNonceStore', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/session/spawn/spawnAttemptNonceStore')>(
      '@/sync/domains/session/spawn/spawnAttemptNonceStore',
    );
    return {
      ...actual,
      reconcileSpawnAttemptCustodyFromOperation: reconcileSpawnAttemptCustodyFromOperationSpy,
    };
  });
  vi.doMock('@/sync/domains/actionOperations/actionOperationStore', () => ({
    actionOperationStore: {
      getState: () => ({ operationsById: new Map() }),
      markSeen: markActionOperationSeenSpy,
    },
  }));
  vi.doMock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    captureSessionDraftCurrentness: captureSessionDraftCurrentnessSpy,
    captureSessionDraftLaunchCurrentness: captureSessionDraftLaunchCurrentnessSpy,
    readSessionDraftLaunchCurrentness: vi.fn(() => null),
    clearSessionDraftCurrentness: clearSessionDraftCurrentnessSpy,
    clearSessionDraftLaunchCurrentness: clearSessionDraftLaunchCurrentnessSpy,
    getSessionDraftSnapshot: vi.fn(() => null),
  }));
  const { useCreateNewSession } = await import('./useCreateNewSession');
  return {
    useCreateNewSession,
    modalAlertSpy,
    modalConfirmSpy,
    completeMachineSpawnAttemptCustodySpy,
    reconcileSpawnAttemptCustodyFromOperationSpy,
    machineSpawnNewSessionSpy,
    machineResolveSpawnSessionByNonceSpy,
    machineResolveSpawnSessionByNonceUntilSettledSpy,
    storageState,
    followUpSpawnedSessionWithServerScopeSpy,
    captureSessionDraftCurrentnessSpy,
    captureSessionDraftLaunchCurrentnessSpy,
    clearSessionDraftCurrentnessSpy,
    clearSessionDraftLaunchCurrentnessSpy,
    markActionOperationSeenSpy,
  };
}

describe('useCreateNewSession (daemon unavailable UX)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a daemon-unavailable alert with a Retry action', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      captureSessionDraftLaunchCurrentnessSpy,
      clearSessionDraftCurrentnessSpy,
      clearSessionDraftLaunchCurrentnessSpy,
    } = await setupHarness();

    const setIsCreating = vi.fn();
    const persistDraftForLaunch = vi.fn();
    const onLaunchUserAttemptIdChange = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
        draftScope: { serverId: 'server-a', accountId: 'account-a' },
        persistDraftForLaunch,
        onLaunchUserAttemptIdChange,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await createPromise;

    expect(modalAlertSpy).toHaveBeenCalled();
    const args = modalAlertSpy.mock.calls[0] ?? [];
    expect(args[0]).toBe('newSession.daemonRpcUnavailableTitle');
    expect(String(args[1] ?? '')).toContain('newSession.daemonRpcUnavailableBody');
    expect(String(args[1] ?? '')).toContain('status.lastSeen:time.minutesAgo:5');
    expect(Array.isArray(args[2])).toBe(true);
    const buttons = args[2] as any[];
    expect(buttons.some((b) => b?.text === 'common.retry' && typeof b?.onPress === 'function')).toBe(true);
    expect(persistDraftForLaunch).toHaveBeenCalledTimes(1);
    expect(captureSessionDraftLaunchCurrentnessSpy).toHaveBeenCalledWith({
      scope: { serverId: 'server-a', accountId: 'account-a' },
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      userAttemptId: expect.stringMatching(/^attempt-/),
    });
    expect(clearSessionDraftCurrentnessSpy).not.toHaveBeenCalled();
    expect(clearSessionDraftLaunchCurrentnessSpy).not.toHaveBeenCalled();
    expect(onLaunchUserAttemptIdChange).not.toHaveBeenCalledWith(null);
    await hook.unmount();
  });

  it('does not keep the single-flight guard latched after a local validation failure', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedMachineId }: { selectedMachineId: string | null }) =>
        useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId,
          selectedPath: '/tmp',
          selectedMachine: selectedMachineId
            ? { id: selectedMachineId, active: true, activeAt: Date.now(), metadata: { host: 'devbox' } }
            : null,
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: null,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedMachineId: null as string | null } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();

    await hook.rerender({ selectedMachineId: 'm1' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('uses the latest selectedPath immediately after a rerender (no stale ref window)', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy } = await setupHarness();

    let createPromise: Promise<void> | void | null = null;

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedPath, triggerCreate }: { selectedPath: string; triggerCreate: boolean }) => {
        const createHook = useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: null,
          allowedTargetServerIds: undefined,
        });

        // Simulate the user clicking "Start New Session" immediately after the path
        // rerender commits, before passive effects flush.
        React.useLayoutEffect(() => {
          if (!triggerCreate) return;
          createPromise = createHook.handleCreateSession();
        }, [triggerCreate, createHook.handleCreateSession]);

        return createHook;
      },
      { initialProps: { selectedPath: '', triggerCreate: false } },
    );

    await hook.rerender({ selectedPath: '/tmp', triggerCreate: true });

    if (!createPromise) throw new Error('expected createPromise to be assigned');
    await flushHookEffects({ runAllTimers: true });
    await createPromise;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const arg = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as any;
    expect(arg?.directory).toBe('/tmp');

    await hook.unmount();
  });

  it('uses the latest requested path getter even before the committed selectedPath rerenders', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy } = await setupHarness();

    const requestedPathRef = { current: '/home/happier/projects/subdir' };
    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/home/happier',
        getRequestedPath: () => requestedPathRef.current,
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await createPromise!;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const arg = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as any;
    expect(arg?.directory).toBe('/home/happier/projects/subdir');

    await hook.unmount();
  });

  it('does not retry after unmount when the alert Retry action is pressed', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();

    const buttons = (modalAlertSpy.mock.calls[0]?.[2] ?? []) as any[];
    const retry = buttons.find((b) => b?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await hook.unmount();

    await act(async () => {
      retry.onPress();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry in the hook before showing the daemon-unavailable alert', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy } = await setupHarness();

    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'Daemon RPC is not available',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });

  it('continues outer follow-up after direct spawn custody settles even when the launcher unmounts', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
      completeMachineSpawnAttemptCustodySpy,
      captureSessionDraftLaunchCurrentnessSpy,
      clearSessionDraftCurrentnessSpy,
      clearSessionDraftLaunchCurrentnessSpy,
    } = await setupHarness();
    let resolveSpawn!: (value: Readonly<{
      type: 'success';
      sessionId: string;
      spawnAttemptCustody: Readonly<{
        status: 'completed';
        userAttemptId: string;
        spawnNonce: string;
        targetFingerprint: string;
      }>;
    }>) => void;
    machineSpawnNewSessionSpy.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSpawn = resolve;
    }));
    storageState.sessions['session-created'] = { id: 'session-created' };
    completeMachineSpawnAttemptCustodySpy.mockResolvedValueOnce(false);
    const router = { push: vi.fn(), replace: vi.fn() };
    const afterCreated = vi.fn(async () => {});
    const persistDraftForLaunch = vi.fn();
    const onLaunchUserAttemptIdChange = vi.fn();
    const hook = await renderHook(() => useCreateNewSession({
      draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
      launchIntentSignature: 'direct-launch-intent',
      router,
      selectedMachineId: 'm1',
      selectedPath: '/tmp',
      selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox', homeDir: '/Users/alice' } },
      setIsCreating: vi.fn(),
      setIsResumeSupportChecking: vi.fn(),
      settings: { experiments: false } as unknown as Settings,
      useProfiles: false,
      selectedProfileId: null,
      profileMap: new Map(),
      recentMachinePaths: [],
      agentType: 'opencode' as any,
      permissionMode: 'default' as PermissionMode,
      modelMode: 'default' as ModelMode,
      promptStore: createNewSessionPromptStore('First turn'),
      resumeSessionId: '',
      agentNewSessionOptions: null,
      machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
      secrets: [],
      secretBindingsByProfileId: {},
      selectedSecretIdByProfileIdByEnvVarName: {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {},
      selectedMachineCapabilities: {},
      targetServerId: null,
      allowedTargetServerIds: undefined,
      draftScope: { serverId: 'server-a', accountId: 'account-a' },
      persistDraftForLaunch,
      onLaunchUserAttemptIdChange,
    }));

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
      await flushHookEffects({ cycles: 1, turns: 2 });
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      serverId: 'server-a',
      directory: '/tmp',
      spawnNonce: expect.stringMatching(/^spawn-/),
      userAttemptId: expect.stringMatching(/^attempt-/),
    }));
    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
    const spawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce: string;
      userAttemptId: string;
    };
    resolveSpawn({
      type: 'success',
      sessionId: 'session-created',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: spawnOptions.userAttemptId,
        spawnNonce: spawnOptions.spawnNonce,
        targetFingerprint: 'machine.spawn_new:{"machineId":"m1","serverId":"server-a","directory":"/tmp"}',
      },
    });
    await createPromise;

    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      initialMessageText: 'First turn',
      messageLocalId: expect.stringMatching(/^first-turn-/),
    }));
    expect(afterCreated).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      launchAttempt: expect.objectContaining({
        spawnTargetFingerprint: 'machine.spawn_new:{"machineId":"m1","serverId":"server-a","directory":"/tmp"}',
      }),
    }));
    expect(completeMachineSpawnAttemptCustodySpy).toHaveBeenCalledTimes(1);
    expect(persistDraftForLaunch).toHaveBeenCalledTimes(1);
    expect(captureSessionDraftLaunchCurrentnessSpy).toHaveBeenCalledWith({
      scope: { serverId: 'server-a', accountId: 'account-a' },
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      userAttemptId: spawnOptions.userAttemptId,
    });
    expect(clearSessionDraftLaunchCurrentnessSpy).toHaveBeenCalledWith({
      scope: { serverId: 'server-a', accountId: 'account-a' },
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      userAttemptId: spawnOptions.userAttemptId,
    });
    expect(clearSessionDraftCurrentnessSpy).toHaveBeenCalledWith({
      scope: { serverId: 'server-a', accountId: 'account-a' },
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      currentness: expect.objectContaining({
        mutationIds: { 'composer.text': 'mutation-before-launch' },
      }),
    });
    expect(onLaunchUserAttemptIdChange).toHaveBeenLastCalledWith(null);
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created?serverId=server-a',
      expect.anything(),
    );
  });

  it('consumes the operation settlement and actual custody identity without a hook-level resolver', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created-from-nonce'] = { id: 'session-created-from-nonce' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created-from-nonce',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'persisted-attempt-a',
        spawnNonce: 'actual-operation-nonce',
        targetFingerprint: 'new-session.launch:scope-a',
      },
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('First turn'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
        launchUserAttemptId: 'persisted-attempt-a',
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const spawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };
    expect(spawnOptions.spawnNonce).toEqual(expect.stringMatching(/^spawn-/));
    expect(spawnOptions.userAttemptId).toBe('persisted-attempt-a');
    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created-from-nonce',
      initialMessageText: 'First turn',
    }));
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created-from-nonce?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('fails closed when a stale response belongs to a different user attempt', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      modalAlertSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();
    storageState.sessions['session-from-attempt-a'] = { id: 'session-from-attempt-a' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
        type: 'success',
        sessionId: 'session-from-attempt-a',
        spawnAttemptCustody: {
          status: 'completed',
          userAttemptId: 'attempt-a',
          spawnNonce: 'nonce-a',
          targetFingerprint: 'new-session.launch:scope-a',
        },
      });
    const router = { push: vi.fn(), replace: vi.fn() };
    const disableDraftPersistence = vi.fn();
    const onLaunchUserAttemptIdChange = vi.fn();
    const hook = await renderHook(() => useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
      router,
      selectedMachineId: 'm1',
      selectedPath: '/tmp',
      selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
      setIsCreating: vi.fn(),
      setIsResumeSupportChecking: vi.fn(),
      settings: { experiments: false } as unknown as Settings,
      useProfiles: false,
      selectedProfileId: null,
      profileMap: new Map(),
      recentMachinePaths: [],
      agentType: 'opencode' as any,
      permissionMode: 'default' as PermissionMode,
      modelMode: 'default' as ModelMode,
      promptStore: createNewSessionPromptStore('new intent B'),
      resumeSessionId: '',
      agentNewSessionOptions: null,
      machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
      secrets: [],
      secretBindingsByProfileId: {},
      selectedSecretIdByProfileIdByEnvVarName: {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {},
      selectedMachineCapabilities: {},
      targetServerId: null,
      allowedTargetServerIds: undefined,
      disableDraftPersistence,
      launchUserAttemptId: 'attempt-b',
      onLaunchUserAttemptIdChange,
    }));

    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(followUpSpawnedSessionWithServerScopeSpy).not.toHaveBeenCalled();
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(onLaunchUserAttemptIdChange).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'newSession.failedToStart',
    );
    await hook.unmount();
  });

  it('rotates the action identity when the canonical launch intent changes on the same mounted screen', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceSpy,
    } = await setupHarness();
    machineSpawnNewSessionSpy.mockResolvedValue({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session startup timed out',
    });
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const hook = await renderHook(
      ({ launchIntentSignature }: { launchIntentSignature: string }) => useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm-mounted-prompt',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm-mounted-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Unchanged prompt'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
        launchUserAttemptId: 'persisted-attempt-a',
        launchIntentSignature,
      }),
      { initialProps: { launchIntentSignature: 'intent-a' } },
    );

    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ runAllTimers: true });
    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };

    await hook.rerender({ launchIntentSignature: 'intent-b' });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ runAllTimers: true });

    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };
    expect(machineResolveSpawnSessionByNonceSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    expect(secondSpawnOptions.userAttemptId).not.toBe(firstSpawnOptions.userAttemptId);
    expect(secondSpawnOptions.spawnNonce).not.toBe(firstSpawnOptions.spawnNonce);
    await hook.unmount();
  });

  it('uses the operation-settled pending ACK before sending the first turn', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created-after-ack'] = { id: 'session-created-after-ack' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created-after-ack',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('First turn after ack'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const spawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as { spawnNonce?: string };
    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created-after-ack',
      initialMessageText: 'First turn after ack',
    }));
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created-after-ack?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('uses the operation-settled ambiguous spawn before sending the first turn', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created-after-pending'] = { id: 'session-created-after-pending' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created-after-pending',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('First turn after pending'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const spawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as { spawnNonce?: string };
    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created-after-pending',
      initialMessageText: 'First turn after pending',
    }));
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created-after-pending?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('keeps an ambiguous timed-out spawn retryable with the same nonce when nonce resolution is still pending', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-after-retry'] = { id: 'session-after-retry' };
    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
        type: 'success' as const,
        sessionId: 'session-after-retry',
      });
    machineResolveSpawnSessionByNonceUntilSettledSpy.mockResolvedValueOnce({
      status: 'pending' as const,
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry same nonce'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(router.replace).not.toHaveBeenCalled();
    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as { spawnNonce?: string };
    expect(firstSpawnOptions.spawnNonce).toEqual(expect.stringMatching(/^spawn-/));
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    expect(retryAlertCall?.[0]).toBe('newSession.launchStillPendingTitle');
    expect(retryAlertCall?.[1]).toContain('newSession.launchStillPendingBody');
    const retry = ((retryAlertCall?.[2] ?? []) as any[]).find((button) => button?.text === 'common.retry');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runAllTimers: true });
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as { spawnNonce?: string };
    expect(secondSpawnOptions.spawnNonce).toBe(firstSpawnOptions.spawnNonce);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-after-retry',
      initialMessageText: 'Retry same nonce',
    }));
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-after-retry?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it.each([
    ['not_found' as const],
    ['unsupported' as const],
    ['transport_error' as const],
  ])('keeps an ambiguous timed-out spawn retryable when nonce resolution returns %s', async (resolveStatus) => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions[`session-after-${resolveStatus}-retry`] = { id: `session-after-${resolveStatus}-retry` };
    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
        type: 'success' as const,
        sessionId: `session-after-${resolveStatus}-retry`,
      });
    machineResolveSpawnSessionByNonceUntilSettledSpy.mockResolvedValueOnce({
      status: resolveStatus,
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(`Retry after ${resolveStatus}`),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(router.replace).not.toHaveBeenCalled();
    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as { spawnNonce?: string };
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as any[]).find((button) => button?.text === 'common.retry');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runAllTimers: true });
    });

    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as { spawnNonce?: string };
    expect(secondSpawnOptions.spawnNonce).toBe(firstSpawnOptions.spawnNonce);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `session-after-${resolveStatus}-retry`,
      initialMessageText: `Retry after ${resolveStatus}`,
    }));
    expect(router.replace).toHaveBeenCalledWith(
      `/session/session-after-${resolveStatus}-retry?serverId=server-a`,
      expect.anything(),
    );

    await hook.unmount();
  });

  it('offers Retry for daemon-unavailable post-create follow-up failures without creating another session', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockImplementationOnce(async (options: any) => ({
        type: 'success' as const,
        sessionId: 'session-created',
        spawnAttemptCustody: {
          status: 'completed',
          userAttemptId: options.userAttemptId,
          spawnNonce: options.spawnNonce,
          targetFingerprint: 'new-session.launch:first-turn-retry',
          createdSessionId: 'session-created',
          firstTurnLocalId: options.firstTurnLocalId,
          attachmentMessageLocalId: options.attachmentMessageLocalId,
        },
      }));
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('First turn'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    let retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    for (let attempts = 0; attempts < 5 && !retryAlertCall; attempts += 1) {
      await flushHookEffects({ runAllTimers: true });
      retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
        const buttons = call[2];
        return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
      });
    }
    expect(retryAlertCall).toBeTruthy();
    expect(modalAlertSpy.mock.calls.some((call) => call[0] === 'common.error')).toBe(false);
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      effectiveSpawnServerId: 'server-a',
      launchAttempt: expect.objectContaining({
        attachmentMessageLocalId: expect.stringMatching(/^attachment-message-/),
      }),
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('drops duplicate create requests while a launch is already in flight', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValue({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    let firstCreate: Promise<void> | void | null = null;
    let secondCreate: Promise<void> | void | null = null;
    await act(async () => {
      firstCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
      secondCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    resolveAfterCreated();
    await firstCreate;
    await secondCreate;
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('does not navigate or clear drafts when launch scope changes before completion', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();

    const hook = await renderHook(
      ({ targetServerId }: { targetServerId: string | null }) =>
        useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId,
          allowedTargetServerIds: ['server-a', 'server-b'],
        }),
      { initialProps: { targetServerId: 'server-a' } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ targetServerId: 'server-b' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runAllTimers: true });

    expect(router.replace).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenLastCalledWith(false);

    await hook.unmount();
  });

  it('does not retry a post-create follow-up after the launch scope changes', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ targetServerId }: { targetServerId: string | null }) =>
        useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId,
          allowedTargetServerIds: ['server-a', 'server-b'],
        }),
      { initialProps: { targetServerId: 'server-a' as string | null } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    const retry = ((retryAlertCall?.[2] ?? []) as any[]).find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await hook.rerender({ targetServerId: 'server-b' });

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('treats profile-mode changes as launch scope changes', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ useProfiles }: { useProfiles: boolean }) =>
        useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: null,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { useProfiles: false } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ useProfiles: true });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runAllTimers: true });

    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('shows the generic follow-up error when retry fails for a non-daemon reason', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockRejectedValueOnce(new Error('Attachment validation failed'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(modalAlertSpy.mock.calls).toContainEqual([
      'newSession.createdWithSetupIssueTitle',
      expect.stringContaining('Attachment validation failed'),
    ]);

    await hook.unmount();
  });

  it('opens the created session instead of respawning after a real first-turn ack timeout', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(createSocketIoAckTimeoutError());

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'claude' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('first turn'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      initialMessageText: 'first turn',
      messageLocalId: expect.stringMatching(/^first-turn-/),
    }));
    expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'operation has timed out');
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created?serverId=server-a',
      expect.anything(),
    );

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('does not reuse a created session after an unrelated bare timeout failure', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(new Error('timeout'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'claude' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('first turn'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'newSession.createdWithSetupIssueTitle',
      expect.stringContaining('timeout'),
    );
    expect(router.replace).not.toHaveBeenCalledWith(
      '/session/session-created?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('reuses the created session when retrying after a real first-turn ack timeout', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      storageState,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    followUpSpawnedSessionWithServerScopeSpy
      .mockRejectedValueOnce(createSocketIoAckTimeoutError())
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'claude' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('first turn'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledTimes(2);
    const firstFollowUpParams = followUpSpawnedSessionWithServerScopeSpy.mock.calls[0]?.[0] as { messageLocalId?: string } | undefined;
    const secondFollowUpParams = followUpSpawnedSessionWithServerScopeSpy.mock.calls[1]?.[0] as { messageLocalId?: string } | undefined;
    expect(secondFollowUpParams?.messageLocalId).toBe(firstFollowUpParams?.messageLocalId);
    expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'operation has timed out');
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('does not reuse a created session after a fatal post-create follow-up failure', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created-1'] = { id: 'session-created-1' };
    storageState.sessions['session-created-2'] = { id: 'session-created-2' };
    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'success' as const,
        sessionId: 'session-created-1',
      })
      .mockResolvedValueOnce({
        type: 'success' as const,
        sessionId: 'session-created-2',
      });
    const fatalFollowUpError = Object.assign(new Error('invalid_parameters'), {
      errorCode: 'invalid_parameters',
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(fatalFollowUpError)
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy.mock.calls).toContainEqual([
      'newSession.createdWithSetupIssueTitle',
      expect.stringContaining('invalid_parameters'),
    ]);

    await act(async () => {
      await hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created-2',
      effectiveSpawnServerId: 'server-a',
    }));
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-created-2?serverId=server-a',
      expect.anything(),
    );

    await hook.unmount();
  });

  it('does not offer post-create retry for fatal method-unavailable follow-up failures', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success' as const,
      sessionId: 'session-created',
    });
    const fatalTransferError = Object.assign(new Error('Machine transfer is disabled on the selected server'), {
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
    });
    const afterCreated = vi.fn().mockRejectedValueOnce(fatalTransferError);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
    });
    await flushHookEffects({ runAllTimers: true });

    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy.mock.calls).toContainEqual([
      'newSession.createdWithSetupIssueTitle',
      expect.stringContaining('Machine transfer is disabled on the selected server'),
    ]);
    const retryAlerts = modalAlertSpy.mock.calls.filter((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlerts).toHaveLength(0);

    await hook.unmount();
  });

  it('falls back to selectedPath when checkout materialization returns an empty sessionPath', async () => {
    vi.doMock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
      materializeNewSessionCheckout: vi.fn(async () => ({
        success: true,
        path: '/tmp',
        sessionPath: '   ',
        repositoryRootPath: '/tmp',
      })),
    }));

    const { useCreateNewSession, machineSpawnNewSessionSpy } = await setupHarness();

    let createPromise: Promise<void> | void | null = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ triggerCreate }: { triggerCreate: boolean }) => {
        const createHook = useCreateNewSession({
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'opencode' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: null,
          allowedTargetServerIds: undefined,
        });

        React.useLayoutEffect(() => {
          if (!triggerCreate) return;
          createPromise = createHook.handleCreateSession();
        }, [triggerCreate, createHook.handleCreateSession]);

        return createHook;
      },
      { initialProps: { triggerCreate: true } },
    );

    if (!createPromise) throw new Error('expected createPromise to be assigned');
    await flushHookEffects({ runAllTimers: true });
    await createPromise;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    const arg = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as any;
    expect(arg?.directory).toBe('/tmp');

    await hook.unmount();
  });

  it('reattaches a succeeded tracked spawn and runs the incumbent completion path without spawning again', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      reconcileSpawnAttemptCustodyFromOperationSpy,
      followUpSpawnedSessionWithServerScopeSpy,
      markActionOperationSeenSpy,
      captureSessionDraftLaunchCurrentnessSpy,
      clearSessionDraftCurrentnessSpy,
      clearSessionDraftLaunchCurrentnessSpy,
    } = await setupHarness();
    const router = { push: vi.fn(), replace: vi.fn() };
    const custody = {
      v: 2 as const,
      scope: { serverId: 'server-a', accountId: 'account-a' },
      machineId: 'm1',
      targetFingerprint: 'target-1',
      userAttemptId: 'attempt-reentry',
      nonce: 'request-reentry',
      phase: 'spawning' as const,
      createdSessionId: null,
      firstTurnLocalId: 'first-turn-reentry',
      attachmentMessageLocalId: 'attachments-reentry',
    };
    const hook = await renderHook(() => useCreateNewSession({
      draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
      launchIntentSignature: 'reentry-intent',
      launchUserAttemptId: custody.userAttemptId,
      persistedOperationReentry: {
        custody,
        launchCurrentness: {
          address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
          mutationIds: { 'composer.text': 'captured-before-reload' },
        },
        operation: {
          version: 1,
          operationId: 'operation-reentry',
          requestId: custody.nonce,
          revision: 3,
          actionId: 'session.spawn_new',
          state: 'succeeded',
          scope: { accountId: custody.scope.accountId, machineId: custody.machineId },
          title: 'Create session',
          createdAt: 1,
          startedAt: 2,
          settledAt: 3,
          result: { type: 'success', sessionId: 'session-reentry' },
          cancellation: 'unsupported',
        },
      },
      router,
      selectedMachineId: 'm1',
      selectedPath: '/tmp',
      selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
      setIsCreating: vi.fn(),
      setIsResumeSupportChecking: vi.fn(),
      settings: { experiments: false } as unknown as Settings,
      useProfiles: false,
      selectedProfileId: null,
      profileMap: new Map(),
      recentMachinePaths: [],
      agentType: 'opencode' as any,
      permissionMode: 'default' as PermissionMode,
      modelMode: 'default' as ModelMode,
      promptStore: createNewSessionPromptStore(''),
      resumeSessionId: '',
      agentNewSessionOptions: null,
      machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
      secrets: [],
      secretBindingsByProfileId: {},
      selectedSecretIdByProfileIdByEnvVarName: {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {},
      selectedMachineCapabilities: {},
      targetServerId: 'server-a',
      draftScope: custody.scope,
    }));

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(reconcileSpawnAttemptCustodyFromOperationSpy).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-reentry',
      outcome: { kind: 'succeeded', createdSessionId: 'session-reentry' },
    }));
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledOnce();
    expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-reentry',
      targetServerId: 'server-a',
    }));
    expect(captureSessionDraftLaunchCurrentnessSpy).not.toHaveBeenCalled();
    expect(clearSessionDraftCurrentnessSpy).toHaveBeenCalledWith({
      scope: custody.scope,
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      currentness: {
        address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
        mutationIds: { 'composer.text': 'captured-before-reload' },
      },
    });
    expect(clearSessionDraftLaunchCurrentnessSpy).toHaveBeenCalledWith({
      scope: custody.scope,
      address: { kind: 'newSession', draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
      userAttemptId: custody.userAttemptId,
    });
    expect(router.replace).toHaveBeenCalledWith(
      '/session/session-reentry?serverId=server-a',
      expect.anything(),
    );
    expect(markActionOperationSeenSpy).toHaveBeenCalledWith('operation-reentry');
    await hook.unmount();
  });

  it('does not surface a socket-disconnected error after the exact tracked spawn is running', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, modalAlertSpy } = await setupHarness();
    machineSpawnNewSessionSpy.mockRejectedValueOnce(new Error('Socket not connected'));
    const custody = {
      v: 2 as const,
      scope: { serverId: 'server-a', accountId: 'account-a' },
      machineId: 'm1', targetFingerprint: 'target-1', userAttemptId: 'attempt-reentry',
      nonce: 'request-reentry', phase: 'spawning' as const, createdSessionId: null,
      firstTurnLocalId: 'first-turn-reentry', attachmentMessageLocalId: 'attachments-reentry',
    };
    const hook = await renderHook(() => useCreateNewSession({
      draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
      launchIntentSignature: 'reentry-intent', launchUserAttemptId: custody.userAttemptId,
      persistedOperationReentry: {
        custody,
        launchCurrentness: null,
        operation: {
          version: 1, operationId: 'operation-reentry', requestId: custody.nonce, revision: 2,
          actionId: 'session.spawn_new', state: 'running',
          scope: { accountId: custody.scope.accountId, machineId: custody.machineId },
          title: 'Create session', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
        },
      },
      router: { push: vi.fn(), replace: vi.fn() }, selectedMachineId: 'm1', selectedPath: '/tmp',
      selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
      setIsCreating: vi.fn(), setIsResumeSupportChecking: vi.fn(),
      settings: { experiments: false } as unknown as Settings, useProfiles: false,
      selectedProfileId: null, profileMap: new Map(), recentMachinePaths: [], agentType: 'opencode' as any,
      permissionMode: 'default' as PermissionMode, modelMode: 'default' as ModelMode,
      promptStore: createNewSessionPromptStore(''), resumeSessionId: '', agentNewSessionOptions: null,
      machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
      secrets: [], secretBindingsByProfileId: {}, selectedSecretIdByProfileIdByEnvVarName: {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {}, selectedMachineCapabilities: {}, targetServerId: 'server-a',
      draftScope: custody.scope,
    }));

    await act(async () => { await hook.getCurrent().handleCreateSession(); });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
