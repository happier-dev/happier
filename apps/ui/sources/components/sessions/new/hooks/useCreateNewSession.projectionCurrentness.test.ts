import 'fake-indexeddb/auto';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { AIBackendProfile } from '@/sync/domains/profiles/aiBackendProfileSchema';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));

/**
 * New Session create admission vs machine-projection currentness.
 *
 * The create owner's `daemonMergedProjectionInputs` parameter is
 * authoritative-only by contract: the New Session screen model passes null
 * unless the selected machine's projection is `ready`. These tests pin the
 * admission contract on both directions — a qualified Agent identity is
 * emitted verbatim only from a current projection, and a non-bundled target
 * fails closed (never reaching the daemon spawn Action) when the current
 * projection cannot qualify it. The screen-model gate that feeds this
 * parameter is proven by `useNewSessionScreenModel.projectionCurrentness.test.tsx`.
 */

type NewSessionHarnessStorageState = ReturnType<(typeof import('@/sync/domains/state/storageStore'))['storage']['getState']>;

const ACME_AGENT_ID = 'acme.review.provider';
const ACME_IDENTITY = { pluginId: 'acme.review', localId: 'provider' } as const;
const ACME_AGENT_TARGET = { kind: 'agent' as const, identity: ACME_IDENTITY };
const ACME_SPAWN_BACKEND_TARGET = { kind: 'backend' as const, backendId: 'acme.review.backend' };

function buildAcmeProjectionInputs(): Record<string, unknown> {
  return {
    mergedProviderProjectionById: {
      [ACME_AGENT_ID]: {
        agentId: ACME_AGENT_ID,
        identity: ACME_IDENTITY,
        projectionGeneration: 7,
        title: 'Acme Review Provider',
        isBuiltIn: false,
      },
    },
    mergedBackendProjectionById: {
      'acme.review.backend': {
        backendId: 'acme.review.backend',
        agentId: ACME_AGENT_ID,
      },
    },
  };
}

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const defaultSpawnResult = async (_input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'error', code: 'machine_offline', retryable: true,
  } as const);
  const sessionSpawnNewActionBoundarySpy = vi.fn(defaultSpawnResult);
  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string) => key,
      }),
  });
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  vi.doMock('@/modal', () => ({ Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) } }));
  vi.doMock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
  }));
  await selectNewSessionTestHome();
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
  const initialStore = storage.getState();
  let storageState: NewSessionHarnessStorageState = storage.getState();
  vi.spyOn(storageState, 'upsertPendingMessage');
  vi.spyOn(storageState, 'markSessionOptimisticThinking');
  vi.spyOn(storageState, 'updateSessionPermissionMode');
  vi.spyOn(storageState, 'updateSessionModelMode');
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
  vi.doMock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
  }));
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
  vi.doMock('@/sync/ops', () => ({}));
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  // Keep Action policy and custody real; only daemon network I/O is substituted.
  vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, input) => {
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return {
        protocolVersion: 1,
        projection: {
          v: 2,
          generation: 7,
          agentsById: {
            [ACME_AGENT_ID]: {
              id: ACME_AGENT_ID,
              identity: ACME_IDENTITY,
              title: 'Acme Review Provider',
            },
          },
          installedPackagesById: {},
          actionsById: {},
          toolsById: {},
          commandsById: {},
          resourcesById: {},
          settingsById: {},
          familiesById: {},
          diagnostics: [],
        },
      } as never;
    }
    return sessionSpawnNewActionBoundarySpy(SessionSpawnNewInputV2Schema.parse(input));
  });
  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  await import('@/sync/ops/actions/defaultActionExecutor');

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  type UseCreateNewSessionTestParams = Omit<Parameters<typeof useCreateNewSessionOwner>[0], 'resolveSavedSecretReference'> & Readonly<{
    resolveSavedSecretReference?: Parameters<typeof useCreateNewSessionOwner>[0]['resolveSavedSecretReference'];
  }>;
  const useCreateNewSession = (params: UseCreateNewSessionTestParams) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
    resolveSavedSecretReference: params.resolveSavedSecretReference ?? ((ref) => ({
      ref,
      kind: 'personal',
      status: 'temporarily_unavailable',
      entry: null,
      secret: null,
      revision: null,
      fingerprint: null,
    })),
  });
  return {
    async reset() {
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
      storageState = storage.getState();
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      await selectNewSessionTestHome();
      modalAlertSpy.mockClear();
      vi.mocked(storageState.upsertPendingMessage).mockClear();
      vi.mocked(storageState.markSessionOptimisticThinking).mockClear();
      vi.mocked(storageState.updateSessionPermissionMode).mockClear();
      vi.mocked(storageState.updateSessionModelMode).mockClear();
      sessionSpawnNewActionBoundarySpy.mockReset().mockImplementation(defaultSpawnResult);
    },
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    storageState,
  };
}

async function renderCreateHook(
  useCreateNewSession: Awaited<ReturnType<typeof setupHarness>>['useCreateNewSession'],
  params: Readonly<{
    daemonMergedProjectionInputs: Record<string, unknown> | null;
    authoringCommitPending?: boolean;
    profile?: AIBackendProfile;
    selectedSecretId?: string;
  }>,
) {
  const setIsCreating = vi.fn();
  const settings = { experiments: false } as unknown as Settings;
  const machineEnvPresence: UseMachineEnvPresenceResult = {
    isPreviewEnvSupported: false,
    isLoading: false,
    meta: {},
    refreshedAt: null,
    refresh: () => {},
  };

  return await renderHook(() =>
    useCreateNewSession({
      launchIntentSignature: 'projection-currentness-launch-intent',
      authoringCommitPending: params.authoringCommitPending,
      router: { push: vi.fn(), replace: vi.fn() },
      selectedMachineId: 'm1',
      selectedPath: '/tmp',
      selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
      setIsCreating,
      setIsResumeSupportChecking: vi.fn(),
      settings,
      useProfiles: params.profile !== undefined,
      selectedProfileId: params.profile?.id ?? null,
      profileMap: new Map(params.profile ? [[params.profile.id, params.profile]] : []),
      recentMachinePaths: [],
      // An installed (non-bundled) Agent selected through the projected catalog.
      agentType: ACME_AGENT_ID,
      staticAgentId: null,
      runtimeCarrierAgentId: ACME_AGENT_ID,
      backendTarget: ACME_AGENT_TARGET,
      spawnBackendTarget: ACME_SPAWN_BACKEND_TARGET,
      permissionMode: 'default' as PermissionMode,
      modelMode: 'default' as ModelMode,
      promptStore: createNewSessionPromptStore(''),
      resumeSessionId: '',
      agentNewSessionOptions: null,
      machineEnvPresence,
      secrets: [],
      secretBindingsByProfileId: params.profile && params.selectedSecretId
        ? { [params.profile.id]: { SHARED_API_KEY: params.selectedSecretId } }
        : {},
      selectedSecretIdByProfileIdByEnvVarName: params.profile && params.selectedSecretId
        ? { [params.profile.id]: { SHARED_API_KEY: params.selectedSecretId } }
        : {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {},
      selectedMachineCapabilities: {},
      targetServerId: 'server-a',
      allowedTargetServerIds: ['server-a'],
      daemonMergedProjectionInputs: params.daemonMergedProjectionInputs as any,
    }),
  );
}

describe('useCreateNewSession (projection currentness admission)', () => {
  let harness: Awaited<ReturnType<typeof setupHarness>>;

  beforeAll(async () => {
    harness = await setupHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncSingletonBridge.current = null;
  });

  it('emits the exact qualified Agent identity of the current projection on the spawn payload', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = harness;
    const deferred = createDeferred<SessionSpawnNewResultV1>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => deferred.promise);

    const daemonMergedProjectionInputs = buildAcmeProjectionInputs();
    const hook = await renderCreateHook(useCreateNewSession, {
      daemonMergedProjectionInputs,
    });

    let createPromise: Promise<void> | void | null = null;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ turns: 2 });
      });

      expect(modalAlertSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1));
      const actionInput = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
      expect(actionInput?.agentTarget).toEqual(ACME_AGENT_TARGET);
      expect(actionInput?.agentTarget?.identity).toEqual({ pluginId: 'acme.review', localId: 'provider' });
    } finally {
      deferred.resolve({
        type: 'error',
        code: 'machine_offline',
        retryable: true,
      });
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it('does not issue a Session request while an authoring selection commit is pending', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = harness;
    const hook = await renderCreateHook(useCreateNewSession, {
      daemonMergedProjectionInputs: buildAcmeProjectionInputs(),
      authoringCommitPending: true,
    });
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
      expect(modalAlertSpy).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it('fails closed without emitting a spawn payload when the current projection cannot qualify the target', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = harness;

    const hook = await renderCreateHook(useCreateNewSession, {
      // Authoritative-only contract: null while the selected machine's
      // projection is loading/errored/unsupported or was retired.
      daemonMergedProjectionInputs: null,
    });

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects();

    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
    expect(hook.getCurrent()).toBeTruthy();

    await hook.unmount();
  });
});
