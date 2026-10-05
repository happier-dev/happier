import 'fake-indexeddb/auto';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, MACHINE_PLAIN_DATA_KEY_MARKER, RPC_ERROR_CODES, SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';
import type { HandleCreateSessionOptions } from './useCreateNewSession';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn());
const scopedSocketEmitWithAckSpy = vi.hoisted(() => vi.fn());
const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: vi.fn(async () => ({
    timeout: () => ({ emitWithAck: scopedSocketEmitWithAckSpy }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
  BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
}));

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

});

type HarnessOptions = Readonly<{
  storageState?: Record<string, unknown>;
}>;
let currentHarnessOptions: HarnessOptions | undefined;
async function createHarness() {
  const options = currentHarnessOptions;
  const fixedServerNowMs = Date.parse('2026-02-05T00:00:00.000Z');
  const sessionSpawnNewRpcSpy = vi.fn(async (input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'success',
    disposition: 'created',
    sessionId: 'sess_new',
    executionTarget: input.executionTarget,
    organizationPlacement: input.organizationPlacement ?? { folderId: null, tagIds: [] },
    initialInput: input.initialInput
      ? { status: 'accepted', localId: 'pending-1' }
      : { status: 'notRequested' },
  }));
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  const persistence = await import('@/sync/domains/state/persistence');
  const clearNewSessionDraftSpy = vi.spyOn(persistence, 'clearNewSessionDraft');
  await selectNewSessionTestHome();
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().applySettings({
    ...storage.getState().settings,
    ...options?.storageState?.settings as Partial<Settings>,
  }, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
  for (const sessionId of Object.keys(options?.storageState?.sessions ?? {})) {
    storage.getState().applySessions([createSessionFixture({ id: sessionId })]);
  }
  if (options?.storageState?.artifacts) {
    storage.setState({ artifacts: options.storageState.artifacts as ReturnType<typeof storage.getState>['artifacts'] });
  }

  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  const publishModeSpy = vi.spyOn(sync, 'publishSessionAcpSessionModeOverrideToMetadata');
  const sendMessageSpy = vi.spyOn(sync, 'sendMessage');

  vi.doMock('@/sync/runtime/time', () => ({
    nowServerMs: vi.fn(() => fixedServerNowMs),
  }));

  // Exercise the real Action executor and custody owner through the daemon transport boundary.
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, _method, input) =>
    await sessionSpawnNewRpcSpy(SessionSpawnNewInputV2Schema.parse(input)));
  await import('@/sync/ops/actions/defaultActionExecutor');
  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  const defaultSpawn = sessionSpawnNewRpcSpy.getMockImplementation()!;
  return {
    async reset(options?: HarnessOptions) {
      currentHarnessOptions = options;
      sessionSpawnNewRpcSpy.mockReset().mockImplementation(defaultSpawn);
      publishModeSpy.mockClear();
      sendMessageSpy.mockClear();
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {}, artifacts: {} });
      storage.getState().applySettings(
        { ...initialStore.settings, ...options?.storageState?.settings as Partial<Settings> },
        (storage.getState().settingsVersion ?? 0) + 1,
      );
      for (const sessionId of Object.keys(options?.storageState?.sessions ?? {})) {
        storage.getState().applySessions([createSessionFixture({ id: sessionId })]);
      }
      if (options?.storageState?.artifacts) {
        storage.setState({ artifacts: options.storageState.artifacts as ReturnType<typeof storage.getState>['artifacts'] });
      }
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      await selectNewSessionTestHome();
    },
    useCreateNewSession,
    publishModeSpy,
    sendMessageSpy,
    sessionSpawnNewRpcSpy,
    clearNewSessionDraftSpy,
  };
}

let harness: Awaited<ReturnType<typeof createHarness>>;
async function setupHarness(options?: HarnessOptions) {
  await harness.reset(options);
  return harness;
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
    selectedMachine: createMachineFixture({ id: 'm1' }),
    setIsCreating: vi.fn(),
    setIsResumeSupportChecking: vi.fn(),
    settings: { experiments: false } as unknown as Settings,
    useProfiles: false,
    selectedProfileId: null,
    profileMap: new Map(),
    recentMachinePaths: [],
    agentType: 'codex' as any,
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
    targetServerId: undefined,
    allowedTargetServerIds: ['server-a'],
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await createHarness();
  const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
  await prepareSessionDraftPersistenceStorage();
});
afterAll(() => {
  syncSingletonBridge.current = null;
  vi.restoreAllMocks();
});

describe('useCreateNewSession (ACP mode seeding)', () => {
  beforeEach(() => {
    modalAlertSpy.mockReset();
    scopedSocketEmitWithAckSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps a Temporary computer Composer submission pending until its real first input is admitted', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness({
      storageState: { sessions: { 'runner-session-1': { id: 'runner-session-1' } } },
    });
    const creatorSettlements: Array<Readonly<{
      attachmentMessageLocalId: string;
      firstTurnLocalId: string;
      present(sessionId: string): Promise<void>;
      complete(sessionId: string, uploaded: readonly []): Promise<void>;
      reject(): void;
    }>> = [];
    const temporaryComputerLaunch = vi.fn(async (_submission, settlement) => {
      creatorSettlements.push(settlement);
    });
    const onAfterCreatedSettled = vi.fn();
    const afterCreated = vi.fn(async () => undefined);
    const router = { push: vi.fn(), replace: vi.fn() };
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    // The active authoring Account and temporary destination are deliberately
    // different Homes and Accounts.
    const targetScope = { serverId: 'server-b', accountId: 'account-b' } as const;
    const prepareTemporaryComputerLaunchDraft = vi.fn(async () => undefined);
    const draftId = 'temporary-computer-completion-draft';
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { sync } = await import('@/sync/syncEngine');
    const ensureSessionVisibleForMessageRouteSpy = vi
      .spyOn(sync, 'ensureSessionVisibleForMessageRoute')
      .mockResolvedValue({ kind: 'available', sessionId: 'runner-session-1' });
    writeNewSessionDraft({
      scope: draftScope,
      draftId,
      patch: { text: 'reviewed prompt' },
      materializationIntent: 'userEdit',
    });
    const submission = {
      composer: { text: 'reviewed prompt' },
      attachmentDrafts: [],
      attachmentDestination: {
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      },
      maxFileBytes: 1024,
    } as never;
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      authoringDraft: {
        executionTarget: { kind: 'temporary_computer', artifactTarget: 'linux-x64' },
        automation: null,
      },
      temporaryComputerLaunch,
      router,
      draftScope,
      temporaryComputerTargetScope: targetScope,
      prepareTemporaryComputerLaunchDraft,
      targetServerId: targetScope.serverId,
      allowedTargetServerIds: [targetScope.serverId],
      draftId,
    }) as never));

    await act(async () => {
      await hook.getCurrent().handleCreateSession({
        initialMessage: 'skip',
        temporaryComputerSubmission: submission,
        afterCreated,
        onAfterCreatedSettled,
        deferAcceptedDraftClearToDocument: true,
      });
    });

    expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
    expect(prepareTemporaryComputerLaunchDraft).toHaveBeenCalledWith({
      sourceScope: draftScope,
      targetScope,
      draftId,
    });
    expect(prepareTemporaryComputerLaunchDraft.mock.invocationCallOrder[0])
      .toBeLessThan(temporaryComputerLaunch.mock.invocationCallOrder[0]);
    expect(temporaryComputerLaunch).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).not.toHaveBeenCalled();

    const creatorSettlement = creatorSettlements[0];
    if (!creatorSettlement) throw new Error('Expected Temporary computer creator settlement');

    await act(async () => {
      await creatorSettlement.present('runner-session-1');
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith('runner-session-1', {
      forceRefresh: true,
      serverId: targetScope.serverId,
    });
    expect(afterCreated).not.toHaveBeenCalled();
    expect(onAfterCreatedSettled).not.toHaveBeenCalled();
    expect(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.document.composer.text.value)
      .toBe('reviewed prompt');

    await expect(creatorSettlement.complete('runner-session-2', []))
      .rejects.toThrow('runner_creator_materialized_session_changed');
    expect(afterCreated).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);

    await act(async () => {
      await creatorSettlement.complete('runner-session-1', []);
    });
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({
      status: 'accepted',
      sessionId: 'runner-session-1',
    });
    expect(afterCreated).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'runner-session-1',
      effectiveSpawnServerId: targetScope.serverId,
      preuploadedAttachments: [],
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.document.composer.text.value)
      .toBe('reviewed prompt');
    ensureSessionVisibleForMessageRouteSpy.mockRestore();
    await hook.unmount();
  });

  it('creates through the strict V2 Action with its existing attempt identity and initial input', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewRpcSpy,
      publishModeSpy,
      sendMessageSpy,
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        targetServerId: undefined,
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
    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: expect.any(String),
      executionTarget: { serverId: 'server-a', machineId: 'm1' },
      directory: '/tmp',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      agentModeId: 'plan',
      initialInput: { text: 'hello' },
    }));
    expect(sessionSpawnNewRpcSpy.mock.calls[0]?.[0].creationKey).toMatch(/^manual:.+/);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('preserves the authored Team context and access in the final spawn payload', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
    const access = {
      grants: [{ subject: { kind: 'team' as const, teamId: 'team-acme' }, accessLevel: 'view' as const, canApprovePermissions: false }],
    };
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      authoringDraft: { access, primaryTeamId: 'team-acme' },
    }) as never));

    await act(async () => { await hook.getCurrent().handleCreateSession(); });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      primaryTeamId: 'team-acme',
      initialAccess: access,
    }));
  });

  it('projects accepted post-create follow-up settlement once without changing the create return contract', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings: { experiments: false } as unknown as Settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
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
        targetServerId: undefined,
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
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
      sessionSpawnNewRpcSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_new: { id: 'sess_new' } } },
    });
    sessionSpawnNewRpcSpy.mockResolvedValue({
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId: 'sess_new',
        executionTarget: { serverId: 'server-a', machineId: 'm1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
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
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
    await hook.unmount();
  });

  it('settles accepted only after a retryable post-create follow-up retry succeeds', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewRpcSpy,
      clearNewSessionDraftSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_new: { id: 'sess_new' } } },
    });
    sessionSpawnNewRpcSpy.mockResolvedValue({
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId: 'sess_new',
        executionTarget: { serverId: 'server-a', machineId: 'm1' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
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
      sessionSpawnNewRpcSpy,
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('projects rejected when unmounted during the post-create follow-up', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
    expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
  });

  it('finishes post-create follow-up and clears the persisted draft without navigating when unmounted before tracked spawn settles', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewRpcSpy,
    } = await setupHarness({
      storageState: { sessions: { sess_detached: { id: 'sess_detached' } } },
    });
    const spawn = createDeferred<SessionSpawnNewResultV1>();
    sessionSpawnNewRpcSpy.mockReturnValueOnce(spawn.promise);
    const routerReplace = vi.fn();
    const afterCreated = vi.fn(async () => {});
    const draftScope = { serverId: 'server-a', accountId: 'account-a' };
    const draftId = 'detached-post-create-draft';
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    writeNewSessionDraft({
      scope: draftScope,
      draftId,
      patch: { text: 'skip' },
      materializationIntent: 'userEdit',
    });
    const disableDraftPersistence = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      router: { push: vi.fn(), replace: routerReplace },
      draftScope,
      draftId,
      disableDraftPersistence,
    }) as any));
    let createPromise: Promise<void> | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({
        initialMessage: 'skip',
        afterCreated,
      }) as unknown as Promise<void>;
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    });
    await hook.unmount();
    await act(async () => {
      spawn.resolve({
          type: 'success',
          disposition: 'created',
          sessionId: 'sess_detached',
          executionTarget: { serverId: 'server-a', machineId: 'm1' },
          organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(afterCreated).toHaveBeenCalledTimes(1);
    await createPromise;
    expect(getSessionDraftSnapshot(
      draftScope,
      { kind: 'newSession', draftId },
    )?.document.composer.text?.value ?? '').toBe('');
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    await hook.unmount();
  });


  it('does not turn observer socket loss into terminal failure after the canonical store has daemon custody', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewRpcSpy,
    } = await setupHarness();
    const observer = createDeferred<never>();
    sessionSpawnNewRpcSpy.mockReturnValueOnce(observer.promise);
    const setIsCreating = vi.fn();
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      setIsCreating,
      draftScope: { serverId: 'server-a', accountId: 'account-a' },
      launchUserAttemptId: 'request-owned-by-daemon',
    }) as any));

    let createPromise: Promise<void> | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({
        initialMessage: 'skip',
        onAfterCreatedSettled,
      }) as unknown as Promise<void>;
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1));

    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    act(() => actionOperationStore.mergeSnapshots({ serverId: 'server-a', snapshots: [{
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
    }] }));
    await hook.unmount();
    await act(async () => {
      observer.reject(new Error('Socket not connected'));
      await createPromise;
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(onAfterCreatedSettled).not.toHaveBeenCalledWith({ status: 'rejected' });
    actionOperationStore.reset();
    await hook.unmount();
  });

  it('shows typed update guidance when an older CLI does not implement session.spawn_new', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const activeServer = getActiveServerSnapshot();
    const accountToken = `header.${btoa(JSON.stringify({ sub: 'account-a' }))}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    expect(await TokenStorage.setCredentialsForServerUrl(
      activeServer.serverUrl,
      { serverId: activeServer.serverId },
      { token: accountToken },
    )).toBe(true);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/v1/machines/m1')) {
        return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
      }
      if (url.includes('/v1/auth/ping')) {
        return Response.json({ ok: true });
      }
      return Response.json({
        features: {},
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    sessionSpawnNewRpcSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    }));
    scopedSocketEmitWithAckSpy.mockResolvedValue({
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings: { experiments: false } as unknown as Settings,
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
        targetServerId: undefined,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(2);
    expect(scopedSocketEmitWithAckSpy).toHaveBeenCalledTimes(2);
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'newSession.actionMethodUnavailable',
    );
    expect(await TokenStorage.removeCredentialsForServerUrl(
      activeServer.serverUrl,
      { serverId: activeServer.serverId },
    )).toBe(true);
  });

  it('carries agent mode through the strict V2 Action for staticAgentModes (Claude)', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        targetServerId: undefined,
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
    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries agent mode through the strict V2 Action for Codex', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        targetServerId: undefined,
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
    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries transient ACP config option overrides through the strict V2 Action', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, sendMessageSpy } = await setupHarness();

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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        targetServerId: undefined,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: expect.objectContaining({
          speed: { updatedAtMs: 123, value: 'fast' },
        }),
      }),
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries the descriptor-owned Codex backend mode through strict V2 configuration', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = {} as Settings;
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        pluginSettings: { account: { codexBackendMode: 'acp' } },
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
        targetServerId: undefined,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: expect.objectContaining({
          codexBackendMode: expect.objectContaining({
            value: 'acp',
            updatedAtMs: expect.any(Number),
          }),
        }),
      }),
    }));
  });

  it('expands prompt templates before admitting the initial input in the strict V2 Action', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, sendMessageSpy } = await setupHarness({
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
    const { storage } = await import('@/sync/domains/state/storageStore');
    const settings = storage.getState().settings;
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        promptStore: createNewSessionPromptStore('/qa-check this is a UI QA check'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: undefined,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      initialInput: expect.objectContaining({
        text: 'Expanded QA Template\n\nthis is a UI QA check',
      }),
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('inserts prompt templates without creating a new session when behavior is insert', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, sendMessageSpy } = await setupHarness({
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
    const { storage } = await import('@/sync/domains/state/storageStore');
    const settings = storage.getState().settings;
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
        selectedMachine: createMachineFixture({ id: 'm1' }),
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
        targetServerId: undefined,
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
    expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
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
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('spawns an installed Agent with the options it declared, resolved on the selected machine', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();

    const {
      clearProjectedAgentUiBehaviorDescriptors,
      publishProjectedAgentUiBehaviorDescriptors,
    } = await import('@/agents/registry/agentUiBehaviorProjection');
    publishProjectedAgentUiBehaviorDescriptors({
      machineId: 'm1',
      descriptorsByAgentId: {
        [EXTERNAL_AGENT_ID]: {
          kind: 'plugin.ui.v1',
          pluginId: 'acme.tools',
          agentId: EXTERNAL_AGENT_ID,
          version: 1,
          behavior: {
            newSession: {
              agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
            },
          },
        },
      },
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

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        options: expect.objectContaining({
          allowIndexing: expect.objectContaining({ value: true }),
        }),
      }),
    }));
    clearProjectedAgentUiBehaviorDescriptors();
    await hook.unmount();
  }, 300_000);
});
