import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type NewSessionHarnessStorageState = {
  settings: Record<string, unknown>;
  machines: Record<string, { id: string }>;
  sessions: Record<string, { id: string }>;
  upsertPendingMessage: ReturnType<typeof vi.fn>;
  markSessionOptimisticThinking: ReturnType<typeof vi.fn>;
  updateSessionPermissionMode: ReturnType<typeof vi.fn>;
  updateSessionModelMode: ReturnType<typeof vi.fn>;
  updateSessionDraft: ReturnType<typeof vi.fn>;
};

type SpawnNewSessionTestResult =
  | Readonly<{
      type: 'error';
      errorCode:
        | typeof SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE
        | typeof SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
        | typeof SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST;
      errorMessage: string;
      spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
    }>
  | Readonly<{
      type: 'success';
      sessionId: string;
      spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
    }>;

type SpawnAttemptCustodyTestResult = Readonly<{
  status: 'unresolved' | 'completed';
  userAttemptId: string;
  spawnNonce: string;
  targetFingerprint: string;
}>;

const activeHarnessStorageState: { current: NewSessionHarnessStorageState | null } = { current: null };

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const completeMachineSpawnAttemptCustodySpy = vi.fn(async () => true);
  const machineSpawnNewSessionSpy = vi.fn(async (_options: unknown): Promise<SpawnNewSessionTestResult> => ({
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Daemon RPC is not available',
  }));
  type ResolveSpawnSessionByNonceTestResult =
    | Readonly<{ status: 'success'; sessionId: string }>
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'not_found' }>
    | Readonly<{ status: 'unsupported' }>
    | Readonly<{ status: 'transport_error' }>;
  const machineResolveSpawnSessionByNonceSpy = vi.fn(async (_options: unknown): Promise<ResolveSpawnSessionByNonceTestResult> => ({
    status: 'not_found',
  }));
  const machineResolveSpawnSessionByNonceUntilSettledSpy = vi.fn(async (_options: unknown): Promise<ResolveSpawnSessionByNonceTestResult> => ({
    status: 'not_found',
  }));
  const storageState: NewSessionHarnessStorageState = {
    settings: {},
    machines: { m1: { id: 'm1' } },
    sessions: {} as Record<string, { id: string }>,
    upsertPendingMessage: vi.fn(),
    markSessionOptimisticThinking: vi.fn(),
    updateSessionPermissionMode: vi.fn(),
    updateSessionModelMode: vi.fn(),
    updateSessionDraft: vi.fn(),
  };
  activeHarnessStorageState.current = storageState;

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
          getState: () => activeHarnessStorageState.current ?? storageState,
        },
      }),
  });
  vi.doMock('@/modal', () => ({ Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) } }));
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
        const currentStorageState = activeHarnessStorageState.current ?? storageState;
        currentStorageState.sessions[sessionId] = { id: sessionId };
      }),
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
    followUpSpawnedSessionWithServerScope: vi.fn(async () => {}),
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
    completeMachineSpawnAttemptCustody: completeMachineSpawnAttemptCustodySpy,
    machineSpawnNewSession: machineSpawnNewSessionSpy,
    machineResolveSpawnSessionByNonce: machineResolveSpawnSessionByNonceSpy,
    machineResolveSpawnSessionByNonceUntilSettled: machineResolveSpawnSessionByNonceUntilSettledSpy,
  }));

  const { useCreateNewSession } = await import('./useCreateNewSession');
  return {
    useCreateNewSession,
    modalAlertSpy,
    completeMachineSpawnAttemptCustodySpy,
    machineSpawnNewSessionSpy,
    machineResolveSpawnSessionByNonceSpy,
    machineResolveSpawnSessionByNonceUntilSettledSpy,
    storageState,
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
    activeHarnessStorageState.current = null;
  });

  it('shows a daemon-unavailable alert with a Retry action', async () => {
    const { useCreateNewSession, modalAlertSpy } = await setupHarness();

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

  it('spawns first and enqueues the first turn with the launch attempt local id', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
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
        promptStore: createNewSessionPromptStore('Start here'),
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

    const spawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0];
    expect(spawnOptions).toEqual(expect.objectContaining({
      spawnNonce: expect.stringMatching(/^new-session-spawn-/),
    }));
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      initialMessageText: 'Start here',
      messageLocalId: expect.stringMatching(/^spawn-first-turn:new-session-spawn-/),
    }));
    const spawnNonce = (machineSpawnNewSessionSpy.mock.calls[0]?.[0] as any)?.spawnNonce;
    const firstTurnLocalId = (followUpSpy.mock.calls[0]?.[0] as any)?.messageLocalId;
    expect(spawnNonce).toBeTruthy();
    expect(firstTurnLocalId).toBeTruthy();

    await hook.unmount();
  });

  it('projects a Pending-owned first prompt before opening the created session route', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const callOrder: string[] = [];
    storageState.upsertPendingMessage = vi.fn(() => {
      callOrder.push('pending');
    });
    storageState.markSessionOptimisticThinking = vi.fn(() => {
      callOrder.push('thinking');
    });
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = {
      push: vi.fn(),
      replace: vi.fn(() => {
        callOrder.push('replace');
      }),
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
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
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: 'server-a',
        allowedTargetServerIds: ['server-a'],
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(storageState.markSessionOptimisticThinking).toHaveBeenCalledWith('session-created');
    expect(storageState.upsertPendingMessage).toHaveBeenCalledWith(
      'session-created',
      expect.objectContaining({
        localId: expect.stringMatching(/^spawn-first-turn:new-session-spawn-/),
        source: 'local_outbound',
        deliveryStatus: 'queued',
        text: 'Start here',
        displayText: 'Start here',
      }),
    );
    expect(callOrder.indexOf('thinking')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('pending')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('replace')).toBeGreaterThan(callOrder.indexOf('pending'));

    await hook.unmount();
  });

  it('publishes the first prompt as a launch attempt while spawn is unresolved', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const spawnDeferred = createDeferred<SpawnNewSessionTestResult>();
    machineSpawnNewSessionSpy.mockImplementationOnce(async () => spawnDeferred.promise);
    const onLaunchAttemptChange = vi.fn();

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
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: 'server-a',
        allowedTargetServerIds: ['server-a'],
        onLaunchAttemptChange,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ turns: 2 });
      });

      expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
      const publishedAttempts = onLaunchAttemptChange.mock.calls
        .map((call) => call[0])
        .filter(Boolean);
      expect(publishedAttempts[publishedAttempts.length - 1]).toEqual(expect.objectContaining({
        status: 'spawning',
        createdSessionId: null,
        prompt: expect.objectContaining({
          prompt: 'Start here',
          displayText: 'Start here',
        }),
      }));
      expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
    } finally {
      storageState.sessions['session-created'] = { id: 'session-created' };
      spawnDeferred.resolve({
        type: 'success',
        sessionId: 'session-created',
      });
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it('projects a built-in first turn into pending state before opening the created session route', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);
    followUpSpy.mockClear();
    const callOrder: string[] = [];
    storageState.sessions['session-created'] = { id: 'session-created' };
    storageState.upsertPendingMessage = vi.fn(() => {
      callOrder.push('pending');
    });
    storageState.markSessionOptimisticThinking = vi.fn(() => {
      callOrder.push('thinking');
    });
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = {
      push: vi.fn(),
      replace: vi.fn(() => {
        callOrder.push('replace');
      }),
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp/built-in-first-turn',
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
        promptStore: createNewSessionPromptStore('Built-in start here'),
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

    expect(machineSpawnNewSessionSpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(followUpSpy).toHaveBeenCalledTimes(1);
    const firstTurnLocalId = (followUpSpy.mock.calls[0]?.[0] as any)?.messageLocalId;
    expect(firstTurnLocalId).toMatch(/^spawn-first-turn:new-session-spawn-/);
    expect(storageState.markSessionOptimisticThinking).toHaveBeenCalledWith('session-created');
    expect(storageState.upsertPendingMessage).toHaveBeenCalledWith(
      'session-created',
      expect.objectContaining({
        localId: firstTurnLocalId,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        text: 'Built-in start here',
        displayText: 'Built-in start here',
      }),
    );
    expect(callOrder.indexOf('thinking')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('pending')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('replace')).toBeGreaterThan(callOrder.indexOf('pending'));

    await hook.unmount();
  });

  it('keeps the new-session surface active when the built-in first turn fails after spawn', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });
    followUpSpy.mockRejectedValueOnce(new Error('first turn failed'));

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
        promptStore: createNewSessionPromptStore('Start here'),
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

    expect(machineSpawnNewSessionSpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      initialMessageText: 'Start here',
      messageLocalId: expect.stringMatching(/^spawn-first-turn:new-session-spawn-/),
    }));
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'first turn failed');

    await hook.unmount();
  });

  it('does not duplicate shared spawn-timeout nonce recovery before offering Retry', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
    } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
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
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
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
        promptStore: createNewSessionPromptStore('Start here'),
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

    const spawnNonce = (machineSpawnNewSessionSpy.mock.calls[0]?.[0] as any)?.spawnNonce;
    expect(spawnNonce).toEqual(expect.stringMatching(/^new-session-spawn-/));
    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(machineResolveSpawnSessionByNonceSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(machineSpawnNewSessionSpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(followUpSpy).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'newSession.launchStillPendingTitle',
      expect.stringContaining('newSession.launchStillPendingBody'),
      expect.arrayContaining([expect.objectContaining({ text: 'common.retry' })]),
    );

    await hook.unmount();
  });

  it('keeps the built-in first turn when daemon initial-prompt custody is not confirmed', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      storageState,
    } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
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
        promptStore: createNewSessionPromptStore('Start here'),
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

    expect(machineSpawnNewSessionSpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      initialMessageText: 'Start here',
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('recovers a retryable timed-out spawn by nonce before sending another spawn request', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
      storageState,
    } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    storageState.sessions['session-after-retry'] = { id: 'session-after-retry' };
    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
        type: 'success',
        sessionId: 'session-after-retry',
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
    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
    };
    expect(firstSpawnOptions).not.toHaveProperty('initialPrompt');
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as Array<{ text?: string; onPress?: () => void }>)
      .find((button) => button?.text === 'common.retry');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runAllTimers: true });
    });

    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(machineResolveSpawnSessionByNonceSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    expect(machineSpawnNewSessionSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      spawnNonce: firstSpawnOptions.spawnNonce,
    }));
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-after-retry',
      initialMessageText: 'Retry same nonce',
      messageLocalId: `spawn-first-turn:${String(firstSpawnOptions.spawnNonce)}`,
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-after-retry?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('adopts the operation-owned nonce and user attempt id without a hook-level resolver', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
    } = await setupHarness();

    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
        spawnAttemptCustody: {
          status: 'unresolved',
          userAttemptId: 'attempt-a',
          spawnNonce: 'actual-nonce-a',
          targetFingerprint: 'target-a',
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        sessionId: 'session-from-operation-settlement',
        spawnAttemptCustody: {
          status: 'completed',
          userAttemptId: 'attempt-a',
          spawnNonce: 'actual-nonce-a',
          targetFingerprint: 'target-a',
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

    let durableUserAttemptId: string | null = null;
    const createHook = () =>
      useCreateNewSession({
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
        promptStore: createNewSessionPromptStore('Retry after route stall'),
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
        launchUserAttemptId: durableUserAttemptId,
        onLaunchUserAttemptIdChange: (next) => {
          durableUserAttemptId = next;
        },
      });

    const firstHook = await renderHook(createHook);
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await firstHook.unmount();

    const secondHook = await renderHook(createHook);
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await secondHook.unmount();

    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };

    expect(secondSpawnOptions.userAttemptId).toBe('attempt-a');
  });

  it('keeps the unresolved launch barrier after remounting with a changed prompt on the same launch scope', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
    } = await setupHarness();

    machineSpawnNewSessionSpy
      .mockResolvedValue({
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

    const createHook = (sessionPrompt: string) =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm-remount-prompt',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm-remount-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
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
        promptStore: createNewSessionPromptStore(sessionPrompt),
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

    const firstHook = await renderHook(() => createHook('First timed-out prompt'));
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await firstHook.unmount();

    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
    };

    const secondHook = await renderHook(() => createHook('Changed prompt after timeout'));
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });
    await secondHook.unmount();

    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as {
      spawnNonce?: string;
    };

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    expect(secondSpawnOptions.spawnNonce).not.toBe(firstSpawnOptions.spawnNonce);
  });

  it('rotates the action identity when the canonical launch intent changes on the same mounted screen', async () => {
    const {
      useCreateNewSession,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceSpy,
    } = await setupHarness();

    machineSpawnNewSessionSpy
      .mockResolvedValue({
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
      ({ launchIntentSignature }: { launchIntentSignature: string }) =>
        useCreateNewSession({
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

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };

    await hook.rerender({ launchIntentSignature: 'intent-b' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(machineResolveSpawnSessionByNonceSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    const secondSpawnOptions = machineSpawnNewSessionSpy.mock.calls[1]?.[0] as {
      spawnNonce?: string;
      userAttemptId?: string;
    };
    expect(secondSpawnOptions.userAttemptId).not.toBe(firstSpawnOptions.userAttemptId);
    expect(secondSpawnOptions.spawnNonce).not.toBe(firstSpawnOptions.spawnNonce);

    await hook.unmount();
  });

  it.each([
    ['not_found' as const],
    ['unsupported' as const],
    ['transport_error' as const],
  ])('does not respawn a daemon-initial prompt after ambiguous nonce recovery returns %s', async (resolveStatus) => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      machineSpawnNewSessionSpy,
      machineResolveSpawnSessionByNonceSpy,
      machineResolveSpawnSessionByNonceUntilSettledSpy,
    } = await setupHarness();
    const followUpModule = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
    const followUpSpy = vi.mocked(followUpModule.followUpSpawnedSessionWithServerScope);

    machineSpawnNewSessionSpy
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
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
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
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
    const firstSpawnOptions = machineSpawnNewSessionSpy.mock.calls[0]?.[0] as {
      spawnNonce?: string;
    };
    expect(firstSpawnOptions).not.toHaveProperty('initialPrompt');
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as Array<{ text?: string; onPress?: () => void }>)
      .find((button) => button?.text === 'common.retry');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runAllTimers: true });
    });

    expect(machineResolveSpawnSessionByNonceUntilSettledSpy).not.toHaveBeenCalled();
    expect(machineResolveSpawnSessionByNonceSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(2);
    expect(machineSpawnNewSessionSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      spawnNonce: firstSpawnOptions.spawnNonce,
    }));
    expect(followUpSpy).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('offers Retry for daemon-unavailable post-create follow-up failures without creating another session', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      effectiveSpawnServerId: 'server-a',
      launchAttempt: expect.objectContaining({
        attachmentMessageLocalId: expect.stringMatching(/^new-session-attachment-/),
      }),
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('drops duplicate create requests while a launch is already in flight', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValue({
      type: 'success',
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

    const hook = await renderHook(() =>
      useCreateNewSession({
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

    resolveAfterCreated();
    await firstCreate;
    await secondCreate;

    await hook.unmount();
  });

  it('does not navigate when launch scope changes before completion', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
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
      { initialProps: { targetServerId: 'server-a' as string | null } },
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

  it('keeps routing when macOS resolves a /tmp launch path to its /private/tmp canonical path', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
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
      ({ selectedPath }: { selectedPath: string }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: {
            id: 'm1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'devbox', platform: 'darwin', homeDir: '/Users/leeroy' },
          },
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
      { initialProps: { selectedPath: '/tmp/happier-ruqa-late-opencode-hqzCRl' } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ selectedPath: '/private/tmp/happier-ruqa-late-opencode-hqzCRl' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runAllTimers: true });

    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('keeps launch pending and routes when the created session hydrates after an initial route-readiness miss', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();
    const { sync } = await import('@/sync/sync');
    const ensureSessionVisibleForMessageRoute = vi.mocked(sync.ensureSessionVisibleForMessageRoute);

    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });
    let readinessChecks = 0;
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      readinessChecks += 1;
      if (readinessChecks < 2) {
        return { kind: 'retryable_failure', sessionId, cause: 'network' };
      }
      storageState.sessions[sessionId] = { id: sessionId };
      return { kind: 'available', sessionId };
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
    const setIsCreating = vi.fn();

    const hook = await renderHook(() =>
      useCreateNewSession({
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
        targetServerId: null,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await flushHookEffects({ runAllTimers: true });
    await createPromise;

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenCalledWith(true);
    expect(setIsCreating).not.toHaveBeenCalledWith(false);

    await hook.unmount();
  });

  it('treats profile-mode changes as launch scope changes', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
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

  it('retries post-create follow-up failures against the created session without respawning', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(new Error('Created session is not available locally yet'))
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

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ runAllTimers: true });
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as Array<{ text?: string; onPress?: () => void }>)
      .find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runAllTimers: true });
    });
    await createPromise;

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      launchAttempt: expect.objectContaining({
        createdSessionId: 'session-created',
      }),
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('shows the generic follow-up error when retry fails for a non-daemon reason', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy, storageState } = await setupHarness();

    storageState.sessions['session-created'] = { id: 'session-created' };
    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-created',
    });
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
      'common.error',
      'Attachment validation failed',
    ]);

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
});
