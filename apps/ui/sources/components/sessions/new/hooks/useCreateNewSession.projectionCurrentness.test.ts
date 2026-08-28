import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

type NewSessionHarnessStorageState = {
  settings: Record<string, unknown>;
  machines: Record<string, { id: string }>;
  sessions: Record<string, { id: string }>;
  upsertPendingMessage: ReturnType<typeof vi.fn>;
  markSessionOptimisticThinking: ReturnType<typeof vi.fn>;
  updateSessionPermissionMode: ReturnType<typeof vi.fn>;
  updateSessionModelMode: ReturnType<typeof vi.fn>;
};

type SessionSpawnNewActionBoundaryOutcome =
  | Readonly<{
      type: 'error';
      errorCode: typeof SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE;
      errorMessage: string;
      spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
    }>
  | Readonly<{
      type: 'success';
      sessionId: string;
      spawnAttemptCustody?: SpawnAttemptCustodyTestResult;
    }>;

type SpawnAttemptCustodyTestResult = Readonly<{
  userAttemptId: string;
  spawnNonce: string;
}>;

const ACME_AGENT_ID = 'acme.review.provider';
const ACME_IDENTITY = { pluginId: 'acme.review', localId: 'provider' } as const;
const ACME_AGENT_TARGET = { kind: 'agent' as const, identity: ACME_IDENTITY };
const ACME_SPAWN_BACKEND_TARGET = { kind: 'backend' as const, backendId: ACME_AGENT_ID };

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

const activeHarnessStorageState: { current: NewSessionHarnessStorageState | null } = { current: null };

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const sessionSpawnNewActionBoundarySpy = vi.fn(async (_input: unknown): Promise<SessionSpawnNewActionBoundaryOutcome> => ({
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Daemon RPC is not available',
  }));
  const storageState: NewSessionHarnessStorageState = {
    settings: {},
    machines: { m1: { id: 'm1' } },
    sessions: {} as Record<string, { id: string }>,
    upsertPendingMessage: vi.fn(),
    markSessionOptimisticThinking: vi.fn(),
    updateSessionPermissionMode: vi.fn(),
    updateSessionModelMode: vi.fn(),
  };
  activeHarnessStorageState.current = storageState;

  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string) => key,
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
      acquireUserRequestLease: vi.fn(() => () => {}),
      getCredentials: vi.fn(() => ({ secret: 'test-secret' })),
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
    saveLocalSettings: () => ({}),
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
    saveSessionMaterializedMaxSeqById: () => ({}),
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
  vi.doMock('@/sync/ops', () => ({}));
  vi.doMock('@/sync/ops/actions/sessionSpawnNewAction', async () => {
    const actual = await vi.importActual<typeof import('@/sync/ops/actions/sessionSpawnNewAction')>(
      '@/sync/ops/actions/sessionSpawnNewAction',
    );
    return {
      ...actual,
      executeManualSessionSpawnNewAction: async (input: any, _context: any, params: any) => {
        const outcome = await sessionSpawnNewActionBoundarySpy(input);
        const custody = {
          v: 3 as const,
          scope: params.scope,
          machineId: input.executionTarget.machineId,
          targetFingerprint: 'test-fingerprint',
          userAttemptId: outcome.spawnAttemptCustody?.userAttemptId ?? params.userAttemptId,
          nonce: outcome.spawnAttemptCustody?.spawnNonce ?? params.seedNonce,
          submissionState: 'submitted' as const,
          createdSessionId: outcome.type === 'success' ? outcome.sessionId : null,
          firstTurnLocalId: `spawn-first-turn:${params.seedNonce}`,
          attachmentMessageLocalId: `spawn-attachment:${params.seedNonce}`,
        };
        if (outcome.type === 'success') {
          return {
            status: 'executed' as const,
            action: {
              ok: true as const,
              result: {
                type: 'success' as const,
                disposition: 'created' as const,
                sessionId: outcome.sessionId,
                executionTarget: input.executionTarget,
                organizationPlacement: input.organizationPlacement ?? { folderId: null, tagIds: [] },
                initialInput: input.initialInput
                  ? { status: 'accepted' as const, localId: `input-${outcome.sessionId}` }
                  : { status: 'notRequested' as const },
              },
            },
            custody,
          };
        }
        return {
          status: 'executed' as const,
          action: {
            ok: true as const,
            result: {
              type: 'error' as const,
              code: outcome.errorCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE
                ? 'machine_offline' as const
                : 'spawn_failed' as const,
              retryable: true,
            },
          },
          custody,
        };
      },
      completeManualSessionSpawnNewActionCustody: async () => true,
    };
  });

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  return {
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    storageState,
  };
}

async function renderCreateHook(
  useCreateNewSession: ReturnType<typeof setupHarness>['useCreateNewSession'],
  params: Readonly<{ daemonMergedProjectionInputs: Record<string, unknown> | null }>,
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
      router: { push: vi.fn(), replace: vi.fn() },
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
      secretBindingsByProfileId: {},
      selectedSecretIdByProfileIdByEnvVarName: {},
      sessionOnlySecretValueByProfileIdByEnvVarName: {},
      selectedMachineCapabilities: {},
      targetServerId: 'server-a',
      allowedTargetServerIds: ['server-a'],
      daemonMergedProjectionInputs: params.daemonMergedProjectionInputs as any,
    }),
  );
}

describe('useCreateNewSession (projection currentness admission)', () => {
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

  it('emits the exact qualified Agent identity of the current projection on the spawn payload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();
    const deferred = createDeferred<SessionSpawnNewActionBoundaryOutcome>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => deferred.promise);

    const hook = await renderCreateHook(useCreateNewSession, {
      daemonMergedProjectionInputs: buildAcmeProjectionInputs(),
    });

    let createPromise: Promise<void> | void | null = null;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ turns: 2 });
      });

      expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
      const actionInput = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
        agentTarget?: { kind?: string; identity?: { pluginId?: string; localId?: string } };
      };
      expect(actionInput?.agentTarget).toEqual(ACME_AGENT_TARGET);
      expect(actionInput?.agentTarget?.identity).toEqual({ pluginId: 'acme.review', localId: 'provider' });
    } finally {
      deferred.resolve({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        errorMessage: 'Daemon RPC is not available',
      });
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it('fails closed without emitting a spawn payload when the current projection cannot qualify the target', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const hook = await renderCreateHook(useCreateNewSession, {
      // Authoritative-only contract: null while the selected machine's
      // projection is loading/errored/unsupported or was retired.
      daemonMergedProjectionInputs: null,
    });

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runAllTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
    expect(hook.getCurrent()).toBeTruthy();

    await hook.unmount();
  });
});
