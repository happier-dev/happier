import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_ERROR_CODES } from '@happier-dev/protocol';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import type { HandleCreateSessionOptions } from './useCreateNewSession';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type StorageState = {
  settings: Record<string, unknown>;
  machines: Record<string, { id: string }>;
  updateSessionPermissionMode: ReturnType<typeof vi.fn>;
  updateSessionModelMode: ReturnType<typeof vi.fn>;
} & Record<string, unknown>;

let storageState: StorageState = {
  settings: {},
  machines: { m1: { id: 'm1' } },
  updateSessionPermissionMode: vi.fn(),
  updateSessionModelMode: vi.fn(),
};

const modalAlertSpy = vi.hoisted(() => vi.fn());

installNewSessionScreenModelCommonModuleMocks({
  modal: async () => ({
    Modal: {
      alert: modalAlertSpy,
      alertAsync: vi.fn(async () => {}),
      confirm: vi.fn(async () => false),
      hide: vi.fn(),
      hideAll: vi.fn(),
      prompt: vi.fn(async () => null),
      show: vi.fn(),
      update: vi.fn(),
    },
  }),
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => storageState,
      },
    });
  },
});

async function setupHarness(options?: Readonly<{
  storageState?: Record<string, unknown>;
  fetchArtifactWithBodyResult?: Record<string, unknown> | null;
}>) {
  const fixedServerNowMs = Date.parse('2026-02-05T00:00:00.000Z');
  const actionOperationPresentationRegisterSpy = vi.fn();
  const publishModeSpy = vi.fn(async (_params: any) => {});
  const clearNewSessionDraftSpy = vi.fn();
  const sendMessageSpy = vi.fn(async (
    _sessionId: string,
    _text: string,
    _displayText?: string,
    _metaOverrides?: Record<string, unknown>,
    _options?: Readonly<{ profileId?: string | null }>,
  ) => {});
  const machineSpawnNewSessionSpy = vi.fn(async (..._args: any[]) => ({ type: 'success', sessionId: 'sess_new' }));
  const executeSessionSpawnNewActionSpy = vi.fn<(input: unknown, context: unknown) => Promise<unknown>>(async (_input, _context) => ({
    ok: true as const,
    result: {
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'sess_new',
      executionTarget: { serverId: 'server-a', machineId: 'm1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'pending-1' },
    },
  }));
  const followUpSpawnedSessionWithServerScopeSpy = vi.fn(async (params: {
    sessionId: string;
    initialMessageText?: string | null;
  }) => {
    if (typeof params.initialMessageText !== 'string' || params.initialMessageText.trim().length === 0) {
      return;
    }

    await sendMessageSpy(params.sessionId, params.initialMessageText);
  });
  storageState = {
    settings: {},
    machines: { m1: { id: 'm1' } },
    updateSessionPermissionMode: vi.fn(),
    updateSessionModelMode: vi.fn(),
    ...(options?.storageState ?? {}),
  };
  vi.doMock('@/sync/sync', () => ({
    sync: {
      applySettings: vi.fn(),
      encryption: { encryptRaw: vi.fn(), encryptAutomationTemplateRaw: vi.fn() },
      decryptSecretValue: vi.fn(),
      refreshAutomations: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
      refreshMachines: vi.fn(async () => {}),
      sendMessage: sendMessageSpy,
      acquireUserRequestLease: vi.fn(() => vi.fn()),
      fetchArtifactWithBody: vi.fn(async () => options?.fetchArtifactWithBodyResult ?? null),
      publishSessionAcpSessionModeOverrideToMetadata: publishModeSpy,
    },
  }));
  vi.doMock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
  }));
  vi.doMock('@/components/inbox/actionOperations/actionOperationPresentationRuntime', () => ({
    actionOperationPresentationCoordinator: {
      register: actionOperationPresentationRegisterSpy,
      acknowledgeRequestPresented: vi.fn(),
    },
  }));
  vi.doMock('@/sync/domains/state/storage', () => ({
    storage: {
      getState: () => storageState,
    },
  }));
  vi.doMock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: clearNewSessionDraftSpy,
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
  vi.doMock('@/sync/runtime/time', () => ({
    nowServerMs: vi.fn(() => fixedServerNowMs),
  }));
  vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => ({ token: 'next-token', secret: 'next-secret' })),
  }));
  vi.doMock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: vi.fn(() => null) }));
  vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    prefetchMachineCapabilities: vi.fn(async () => {}),
  }));
  vi.doMock('@/agents/catalog/catalog', async () => {
    const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
    return {
      ...actual,
      getAgentCore: vi.fn((agentId: string) => ({
        sessionModes: { kind: agentId === 'codex' ? 'acpPolicyPresets' : 'acpAgentModes' },
        model: { supportsSelection: false },
      })),
      buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
      buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
      getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
      getNewSessionPreflightIssues: vi.fn(() => []),
      buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
    };
  });
  vi.doMock('@/agents/runtime/resumeCapabilities', () => ({ canAgentResume: vi.fn(() => false) }));
  vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({ formatResumeSupportDetailCode: vi.fn(() => '') }));
  vi.doMock('@/sync/ops', () => ({ machineSpawnNewSession: machineSpawnNewSessionSpy }));
  vi.doMock('@/sync/ops/actions/sessionSpawnNewAction', () => ({
    executeSessionSpawnNewAction: (input: unknown, context: unknown) =>
      executeSessionSpawnNewActionSpy(input, context),
    resolveSessionSpawnNewActionFailureMessageKey: () => 'newSession.actionMethodUnavailable',
    resolveSessionSpawnNewResultFailureMessageKey: () => 'newSession.failedToStart',
  }));
  vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
  }));
  vi.doMock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: vi.fn(() => 'temp-data-key'),
  }));

  const { useCreateNewSession } = await import('./useCreateNewSession');
  return {
    useCreateNewSession,
    publishModeSpy,
    sendMessageSpy,
    machineSpawnNewSessionSpy,
    executeSessionSpawnNewActionSpy,
    followUpSpawnedSessionWithServerScopeSpy,
    clearNewSessionDraftSpy,
    actionOperationPresentationRegisterSpy,
  };
}

function buildCreateSessionHookParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const machineEnvPresence: UseMachineEnvPresenceResult = {
    isPreviewEnvSupported: false,
    isLoading: false,
    meta: {},
    refreshedAt: null,
    refresh: () => {},
  };

  return {
    launchIntentSignature: 'test-launch-intent',
    router: { push: vi.fn(), replace: vi.fn() },
    selectedMachineId: 'm1',
    selectedPath: '/tmp',
    selectedMachine: { metadata: {} },
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
    machineEnvPresence,
    secrets: [],
    secretBindingsByProfileId: {},
    selectedSecretIdByProfileIdByEnvVarName: {},
    sessionOnlySecretValueByProfileIdByEnvVarName: {},
    selectedMachineCapabilities: null,
    targetServerId: null,
    allowedTargetServerIds: ['server-a'],
    ...overrides,
  };
}

describe('useCreateNewSession (ACP mode seeding)', () => {
  beforeEach(() => {
    vi.resetModules();
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates through the strict V2 Action with its existing attempt identity and initial input', async () => {
    const {
      useCreateNewSession,
      executeSessionSpawnNewActionSpy,
      machineSpawnNewSessionSpy,
      publishModeSpy,
      sendMessageSpy,
      followUpSpawnedSessionWithServerScopeSpy,
    } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: 'plan',
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: expect.any(String),
      executionTarget: { serverId: 'server-a', machineId: 'm1' },
      directory: '/tmp',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
      },
      agentModeId: 'plan',
      initialMessage: 'hello',
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(executeSessionSpawnNewActionSpy.mock.calls[0]?.[1]).toEqual({
      surface: 'ui',
      actionRequestId: (executeSessionSpawnNewActionSpy.mock.calls[0]?.[0] as { creationKey: string }).creationKey,
    });
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScopeSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('projects accepted post-create follow-up settlement once without changing the create return contract', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy } = await setupHarness();
    const afterCreated = vi.fn(async () => {});
    const onAfterCreatedSettled = vi.fn();
    let handleCreateSession: null | ((options?: Record<string, unknown>) => Promise<void>) = null;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as (options?: Record<string, unknown>) => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));
    await act(async () => {
      await handleCreateSession?.({
        initialMessage: 'skip',
        afterCreated,
        onAfterCreatedSettled,
      });
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_new' }));
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({
      status: 'accepted',
      sessionId: 'sess_new',
    });
  });

  it('leaves accepted draft clearing to the semantic document coordinator when requested', async () => {
    const {
      useCreateNewSession,
      clearNewSessionDraftSpy,
      executeSessionSpawnNewActionSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_new: { id: 'sess_new' } } },
    });
    executeSessionSpawnNewActionSpy.mockResolvedValue({
      ok: true as const,
      result: {
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId: 'sess_new',
        executionTarget: { serverId: 'server-a', machineId: 'm1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
      },
    });
    const disableDraftPersistence = vi.fn();
    const afterCreated = vi.fn(async () => {});
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      disableDraftPersistence,
    }) as any));
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;

    await act(async () => {
      await handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
        deferAcceptedDraftClearToDocument: true,
      });
    });

    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('projects one rejected settlement when its post-create follow-up fails terminally', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy } = await setupHarness();
    const afterCreated = vi.fn(async () => {
      throw new Error('attachment upload was rejected');
    });
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams() as any));
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;

    await act(async () => {
      await handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
        onAfterCreatedSettled,
      });
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
    await hook.unmount();
  });

  it('settles accepted only after a retryable post-create follow-up retry succeeds', async () => {
    const {
      useCreateNewSession,
      executeSessionSpawnNewActionSpy,
      clearNewSessionDraftSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_new: { id: 'sess_new' } } },
    });
    executeSessionSpawnNewActionSpy.mockResolvedValue({
      ok: true as const,
      result: {
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId: 'sess_new',
        executionTarget: { serverId: 'server-a', machineId: 'm1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
      },
    });
    const disableDraftPersistence = vi.fn();
    const afterCreated = vi.fn()
      .mockRejectedValueOnce({ code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE })
      .mockResolvedValueOnce(undefined);
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      disableDraftPersistence,
    }) as any));
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;
    let createPromise: Promise<void> | null = null;

    await act(async () => {
      createPromise = handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
        onAfterCreatedSettled,
        deferAcceptedDraftClearToDocument: true,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });

    const buttons = modalAlertSpy.mock.calls[0]?.[2] as Array<Readonly<{
      text?: string;
      onPress?: () => void;
    }>>;
    const retry = buttons.find((button) => button.text === 'common.retry');
    expect(retry?.onPress).toBeTypeOf('function');

    await act(async () => {
      retry?.onPress?.();
      await createPromise;
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    const firstAfterCreatedContext = afterCreated.mock.calls[0]?.[0] as
      | Readonly<{ launchAttempt?: Readonly<{ firstTurnLocalId?: string }> }>
      | undefined;
    const retryAfterCreatedContext = afterCreated.mock.calls[1]?.[0] as
      | Readonly<{ launchAttempt?: Readonly<{ firstTurnLocalId?: string }> }>
      | undefined;
    expect(retryAfterCreatedContext?.launchAttempt?.firstTurnLocalId)
      .toBe(firstAfterCreatedContext?.launchAttempt?.firstTurnLocalId);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({
      status: 'accepted',
      sessionId: 'sess_new',
    });
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('projects rejected when its New Session scope retires during the post-create follow-up', async () => {
    const {
      useCreateNewSession,
      executeSessionSpawnNewActionSpy,
      clearNewSessionDraftSpy,
    } = await setupHarness();
    const disableDraftPersistence = vi.fn();
    let resolveAfterCreated: (() => void) | null = null;
    const afterCreated = vi.fn(() => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(
      ({ selectedPath }: Readonly<{ selectedPath: string }>) => useCreateNewSession(buildCreateSessionHookParams({
        selectedPath,
        disableDraftPersistence,
      }) as any),
      { initialProps: { selectedPath: '/tmp' } },
    );
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;
    let createPromise: Promise<void> | null = null;

    await act(async () => {
      createPromise = handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
        onAfterCreatedSettled,
        deferAcceptedDraftClearToDocument: true,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(afterCreated).toHaveBeenCalledTimes(1);
    });

    await hook.rerender({ selectedPath: '/other' });
    await act(async () => {
      resolveAfterCreated?.();
      await createPromise;
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('projects rejected when unmounted during the post-create follow-up', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy } = await setupHarness();
    let resolveAfterCreated: (() => void) | null = null;
    const afterCreated = vi.fn(() => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams() as any));
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;
    let createPromise: Promise<void> | null = null;

    await act(async () => {
      createPromise = handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
        onAfterCreatedSettled,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(afterCreated).toHaveBeenCalledTimes(1);
    });

    await hook.unmount();
    await act(async () => {
      resolveAfterCreated?.();
      await createPromise;
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
  });

  it('finishes post-create follow-up and clears the persisted draft without navigating when unmounted before tracked spawn settles', async () => {
    const mountedRef = { current: true };
    vi.doMock('@/hooks/ui/useMountedRef', () => ({
      useMountedRef: () => mountedRef,
    }));
    const {
      useCreateNewSession,
      executeSessionSpawnNewActionSpy,
      clearNewSessionDraftSpy,
      actionOperationPresentationRegisterSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_detached: { id: 'sess_detached' } } },
    });
    const spawn = createDeferred<Readonly<{
      ok: true;
      result: Readonly<{
        type: 'success';
        disposition: 'created';
        sessionId: string;
        executionTarget: Readonly<{ serverId: string; machineId: string }>;
        organizationPlacement: Readonly<{ folderId: null; tagIds: readonly string[] }>;
        initialInput: Readonly<{ status: 'notRequested' }>;
      }>;
    }>>();
    executeSessionSpawnNewActionSpy.mockReturnValueOnce(spawn.promise);
    const routerReplace = vi.fn();
    const afterCreated = vi.fn(async () => {});
    const draftScope = { serverId: 'server-a', accountId: 'account-a' };
    const disableDraftPersistence = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      router: { push: vi.fn(), replace: routerReplace },
      draftScope,
      disableDraftPersistence,
    }) as any));
    const createPromise = hook.getCurrent().handleCreateSession({
      initialMessage: 'skip',
      afterCreated,
    }) as unknown as Promise<void>;

    await vi.waitFor(() => {
      expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    });
    mountedRef.current = false;
    await act(async () => {
      spawn.resolve({
        ok: true,
        result: {
          type: 'success',
          disposition: 'created',
          sessionId: 'sess_detached',
          executionTarget: { serverId: 'server-a', machineId: 'm1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(actionOperationPresentationRegisterSpy).toHaveBeenCalledWith({
      requestId: expect.any(String),
      onStart: 'current',
      origin: expect.objectContaining({ resolve: expect.any(Function) }),
    });
    expect(clearNewSessionDraftSpy).toHaveBeenCalledWith(draftScope);
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    await createPromise;
    await hook.unmount();
  });

  it('does not turn observer socket loss into terminal failure after the canonical store has daemon custody', async () => {
    const mountedRef = { current: true };
    vi.doMock('@/hooks/ui/useMountedRef', () => ({
      useMountedRef: () => mountedRef,
    }));
    const {
      useCreateNewSession,
      executeSessionSpawnNewActionSpy,
    } = await setupHarness();
    const observer = createDeferred<never>();
    executeSessionSpawnNewActionSpy.mockReturnValueOnce(observer.promise);
    const setIsCreating = vi.fn();
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      setIsCreating,
      draftScope: { serverId: 'server-a', accountId: 'account-a' },
      launchUserAttemptId: 'request-owned-by-daemon',
    }) as any));

    const createPromise = hook.getCurrent().handleCreateSession({
      initialMessage: 'skip',
      onAfterCreatedSettled,
    }) as unknown as Promise<void>;
    await vi.waitFor(() => expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1));

    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    act(() => actionOperationStore.mergeSnapshots([{
      version: 1,
      operationId: 'operation-owned-by-daemon',
      revision: 1,
      actionId: 'session.spawn_new',
      state: 'accepted',
      scope: { accountId: 'account-a', machineId: 'm1' },
      title: 'Create session',
      requestId: 'request-owned-by-daemon',
      createdAt: 1,
      cancellation: 'supported',
    }]));
    mountedRef.current = false;
    observer.reject(new Error('Socket not connected'));
    await createPromise;

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(onAfterCreatedSettled).not.toHaveBeenCalledWith({ status: 'rejected' });
    actionOperationStore.reset();
    await hook.unmount();
  });

  it('shows typed update guidance when an older CLI does not implement session.spawn_new', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, machineSpawnNewSessionSpy } = await setupHarness();
    executeSessionSpawnNewActionSpy.mockResolvedValue({
      ok: false,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      error: 'RPC method not available',
    });

    let handleCreateSession: null | (() => Promise<void>) = null;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: null,
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'newSession.actionMethodUnavailable',
    );
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
  });

  it('carries agent mode through the strict V2 Action for staticAgentModes (Claude)', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, machineSpawnNewSessionSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

    const { getAgentCore } = await import('@/agents/catalog/catalog');
    (getAgentCore as any).mockReturnValue({ sessionModes: { kind: 'staticAgentModes' }, model: { supportsSelection: false } });

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: 'plan',
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries agent mode through the strict V2 Action for Codex', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, machineSpawnNewSessionSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: 'plan',
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries transient ACP config option overrides through the strict V2 Action', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, machineSpawnNewSessionSpy, sendMessageSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: null,
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 123,
          overrides: {
            speed: { updatedAt: 123, value: 'fast' },
          },
        },
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: {
          speed: { updatedAtMs: 123, value: 'fast' },
        },
      }),
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries the descriptor-owned Codex backend mode through strict V2 configuration', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, machineSpawnNewSessionSpy } = await setupHarness();

    const { buildSpawnSessionExtrasFromUiState } = await import('@/agents/catalog/catalog');
    (buildSpawnSessionExtrasFromUiState as any).mockImplementation(({ settings, updatedAt }: {
      settings: { codexBackendMode?: string };
      updatedAt?: number;
    }) => ({
      codexBackendMode: settings.codexBackendMode,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: updatedAt ?? 0,
        overrides: {
          codexBackendMode: {
            value: settings.codexBackendMode,
            updatedAt: updatedAt ?? 0,
          },
        },
      },
    }));

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'acp' } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: null,
        promptStore: createNewSessionPromptStore('hello'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: expect.objectContaining({
          codexBackendMode: expect.objectContaining({
            value: 'acp',
            updatedAtMs: expect.any(Number),
          }),
        }),
      }),
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
  });

  it('expands prompt templates before admitting the initial input in the strict V2 Action', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, sendMessageSpy } = await setupHarness({
      storageState: {
        settings: {
          promptInvocationsV1: {
            v: 1,
            entries: [
              {
                id: 'tmpl_1',
                token: '/qa-check',
                title: 'QA Template',
                target: { kind: 'doc', artifactId: 'artifact_prompt_1' },
                behavior: 'insert_and_send',
                allowArgs: true,
                availableIn: 'global',
              },
            ],
          },
        },
        artifacts: {
          artifact_prompt_1: {
            id: 'artifact_prompt_1',
            body: JSON.stringify({
              v: 1,
              markdown: 'Expanded QA Template',
              createdAtMs: 1,
              updatedAtMs: 1,
            }),
          },
        },
      },
    });

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: null,
        promptStore: createNewSessionPromptStore('/qa-check this is a UI QA check'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: 'Expanded QA Template\n\nthis is a UI QA check',
    }), expect.objectContaining({ surface: 'ui', actionRequestId: expect.any(String) }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('inserts prompt templates without creating a new session when behavior is insert', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy, sendMessageSpy, machineSpawnNewSessionSpy } = await setupHarness({
      storageState: {
        settings: {
          promptInvocationsV1: {
            v: 1,
            entries: [
              {
                id: 'tmpl_1',
                token: '/qa-check',
                title: 'QA Template',
                target: { kind: 'doc', artifactId: 'artifact_prompt_1' },
                behavior: 'insert',
                allowArgs: true,
                availableIn: 'global',
              },
            ],
          },
        },
        artifacts: {
          artifact_prompt_1: {
            id: 'artifact_prompt_1',
            body: JSON.stringify({
              v: 1,
              markdown: 'Expanded QA Template',
              createdAtMs: 1,
              updatedAtMs: 1,
            }),
          },
        },
      },
    });

    let handleCreateSession: null | (() => Promise<void>) = null;
    const setSessionPrompt = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: null,
        promptStore: createNewSessionPromptStore('/qa-check this is a UI QA check'),
        setSessionPrompt,
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(setSessionPrompt).toHaveBeenCalledWith('Expanded QA Template\n\nthis is a UI QA check');
    expect(executeSessionSpawnNewActionSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

/**
 * Render-to-spawn parity for an INSTALLED (non-bundled) Agent.
 *
 * The composer renders an installed Agent's declared new-session options from
 * the descriptor its machine projected (proved descriptor-side in
 * `registryUiBehavior.externalAgentParity.test.ts`). This is the other half:
 * the spawn envelope has to be built for that same Agent, on that same machine.
 * An Agent whose options are rendered and then dropped before
 * `session.spawn_new` is assembled silently launches with a configuration the
 * user did not choose.
 */
describe('useCreateNewSession (installed Agent render-to-spawn parity)', () => {
  const EXTERNAL_AGENT_ID = 'acme.review.agent';

  beforeEach(() => {
    vi.resetModules();
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spawns an installed Agent with the options it declared, resolved on the selected machine', async () => {
    const { useCreateNewSession, executeSessionSpawnNewActionSpy } = await setupHarness();

    const { buildSpawnSessionExtrasFromUiState } = await import('@/agents/catalog/catalog');
    // Stands in for the installed Agent's projected descriptor: it answers only
    // for that Agent's own identity, only on the machine the session will run
    // on, and only from the option values the composer collected.
    (buildSpawnSessionExtrasFromUiState as any).mockImplementation(({ agentId, machineId, newSessionOptions, updatedAt }: {
      agentId: string;
      machineId?: string | null;
      newSessionOptions?: Record<string, unknown> | null;
      updatedAt?: number;
    }) => {
      if (agentId !== EXTERNAL_AGENT_ID || machineId !== 'm1') return {};
      if (newSessionOptions?.allowIndexing !== true) return {};
      return {
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: updatedAt ?? 0,
          overrides: { allowIndexing: { value: 'true', updatedAt: updatedAt ?? 0 } },
        },
      };
    });

    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      agentType: EXTERNAL_AGENT_ID,
      runtimeCarrierAgentId: EXTERNAL_AGENT_ID,
      agentNewSessionOptions: { allowIndexing: true },
      promptStore: createNewSessionPromptStore('hello'),
      // The daemon projection is what makes an installed Agent addressable at
      // the strict Action boundary; without it there is no Agent to spawn.
      daemonMergedProjectionInputs: {
        mergedBackendProjectionById: {},
        mergedProviderProjectionById: {
          [EXTERNAL_AGENT_ID]: {
            agentId: EXTERNAL_AGENT_ID,
            identity: { pluginId: 'acme.tools', localId: 'review-agent' },
          },
        },
      },
    }) as any));
    const handleCreateSession = hook.getCurrent().handleCreateSession as unknown as (
      options?: HandleCreateSessionOptions,
    ) => Promise<void>;

    await act(async () => {
      await handleCreateSession({ initialMessage: 'skip' });
    });

    expect(executeSessionSpawnNewActionSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: expect.objectContaining({
          allowIndexing: expect.objectContaining({ value: 'true' }),
        }),
      }),
    }), expect.objectContaining({ surface: 'ui' }));
    await hook.unmount();
  }, 300_000);
});
