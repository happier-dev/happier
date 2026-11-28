import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import 'fake-indexeddb/auto';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES} from '@happier-dev/protocol/rpcErrors';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';
import type { HandleCreateSessionOptions } from './useCreateNewSession';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV2RequestSchema, ActionOperationGetV1ResponseSchema,
  type ActionOperationGetV2Request, type ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';

const localStorageBoundary = installLocalStorageMock();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary(socket => { configureConnectedServerSocketBoundary(socket); });

const newSessionPush = vi.hoisted(() => vi.fn<(route: unknown) => void>());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => false));
const nativeSpawnReview = vi.hoisted(() => ({ respond: false }));
const modalShowSpy = vi.hoisted(() => vi.fn((dialog: {
  props?: { onCancel?: () => void; onAnswer?: (confirmed: boolean) => void; confirmLabel?: string };
  chrome?: { testID?: string; title?: string; subtitle?: string };
}) => {
  if (dialog.chrome?.testID === 'actions.confirmation-review.modal' && nativeSpawnReview.respond) {
    queueMicrotask(() => dialog.props?.onAnswer?.(false));
    return 'test-spawn-confirmation';
  }
  if (dialog.chrome?.testID !== 'app-shell-transient-interaction-dialog') return '';
  queueMicrotask(() => dialog.props?.onCancel?.());
  return 'test-action-confirmation';
}));
const scopedSocketEmitWithAckSpy = vi.hoisted(() => vi.fn());
const nativeTriageActionHost = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/utils/platform/tauri/transferFetch', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/platform/tauri/transferFetch')>();
  return {
    ...actual,
    resolveTauriRuntimeFetch: async (...args: Parameters<typeof actual.resolveTauriRuntimeFetch>) =>
      nativeTriageActionHost.enabled ? (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)
        : actual.resolveTauriRuntimeFetch(...args),
  };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', async () => {
  // The canonical socket boundary stub keeps the client's lifecycle surface (on/off/disconnect);
  // only its acknowledged RPC emission is answered by this suite.
  const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
  return {
    createEphemeralServerSocketClient: vi.fn(async () => Object.assign(createSocketIoBoundaryStub().socket, {
      connected: true,
      timeout: () => ({ emitWithAck: scopedSocketEmitWithAckSpy }),
      emitWithAck: scopedSocketEmitWithAckSpy,
    })),
  };
});

installNewSessionScreenModelCommonModuleMocks({
  routerConfig: { router: { push: newSessionPush } },
  modal: async () => ({
    Modal: {
      alert: modalAlertSpy,
      alertAsync: vi.fn(async () => {}),
      confirm: modalConfirmSpy,
      hide: vi.fn(),
      hideAll: vi.fn(),
      prompt: vi.fn(async () => null),
      show: modalShowSpy,
      update: vi.fn(),
    },
  }),

});

type HarnessOptions = Readonly<{
  storageState?: Record<string, unknown>;
  promptTemplateBehavior?: 'insert' | 'insert_and_send';
  /** The Home's prompt-library rows never answer (a saturated server); everything else responds. */
  promptLibraryRowsNeverAnswer?: boolean;
}>;
let currentHarnessOptions: HarnessOptions | undefined;
async function createHarness() {
  const options = currentHarnessOptions;
  const fixedServerNowMs = Date.parse('2026-02-05T00:00:00.000Z');
  const createdSessions = new Map<string, ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>>();
  const temporaryDestinationSessions = new Map<string, ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>>();
  const temporaryDestinationCredentials: HomeCredentialWriteRollback[] = [];
  const sessionReadRequests: string[] = [];
  let temporaryDestinationToken: string | null = null;
  const artifactBoundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
  let promptLibraryBoundary = createPromptLibraryCatalogBoundary();
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
  const actionOperationGetRpcSpy = vi.fn(async (_input: ActionOperationGetV2Request): Promise<ActionOperationGetV1Response> => ({ kind: 'not_found' }));
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  const persistence = await import('@/sync/domains/state/persistence');
  const clearNewSessionDraftSpy = vi.spyOn(persistence, 'clearNewSessionDraft');
  await loadSyncSingletonForTests();
  const restoreAccount = () => restoreServerAccountForTest({
    serverUrl: 'https://server-a', accountId: 'account-a',
    additionalRequestOrigins: ['https://server-b'],
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      const target = new URL(String(url));
      const path = target.pathname;
      const sessionRows = target.origin === 'https://server-b' ? temporaryDestinationSessions : createdSessions;
      const artifactResponse = artifactBoundary.handle(path, init);
      if (artifactResponse) return await artifactResponse;
      if (currentHarnessOptions?.promptLibraryRowsNeverAnswer && path.startsWith('/v1/account/entity-rows/prompt-library')) {
        return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      }
      const promptLibraryResponse = await promptLibraryBoundary.handle(path, init);
      if (promptLibraryResponse) return promptLibraryResponse;
      if (path === '/v1/features' || path === '/v1/features/authenticated') {
        const features = createRootLayoutFeaturesResponse();
        // This manually added Home has no portable identity. Its real profile
        // scope stays server-a, matching the authenticated authoring fixture.
        return Response.json({ ...features, capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId: null } } });
      }
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/profile') return Response.json({ id: target.origin === 'https://server-b' ? 'account-b' : 'account-a' });
      if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
      if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json(createSessionListSourceFixture({
        sessions: [...sessionRows.values()], nextCursor: null, hasNext: false,
      }));
      const sessionRead = /^\/v2\/sessions\/([^/]+)$/.exec(path);
      if (sessionRead) {
        if (target.origin === 'https://server-b'
          && new Headers(init?.headers).get('authorization') !== `Bearer ${temporaryDestinationToken}`) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        sessionReadRequests.push(`${target.origin}${target.pathname}`);
        const session = sessionRows.get(decodeURIComponent(sessionRead[1]));
        return session ? Response.json({ session }) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => id === 'm1' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
      if (path === '/v1/machines/m1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }) });
      if (path === '/v1/machines/m1/access') {
        const custodian = { accountId: 'account-a', displayName: 'Account A' };
        return Response.json({ machineId: 'm1', custodian,
          access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
          canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    }),
  });
  let account = await restoreAccount();
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
  const publishModeSpy = vi.spyOn(sync, 'publishSessionAcpSessionModeOverrideToMetadata');
  const sendMessageSpy = vi.spyOn(sync, 'sendMessage');

  vi.doMock('@/sync/runtime/time', () => ({
    nowServerMs: vi.fn(() => fixedServerNowMs),
  }));

  // Exercise the real Action executor and custody owner through the daemon transport boundary.
  let reviewIssued = false;
  const spawn = async (raw: unknown) => {
    const input = SessionSpawnNewInputV2Schema.parse(raw);
    if (nativeSpawnReview.respond && !reviewIssued) {
      reviewIssued = true;
      return { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
        details: { reviewDigest: 'a'.repeat(43), review: { actionArgs: input, preview: { kind: 'session_spawn' } } } };
    }
    const result = await sessionSpawnNewRpcSpy(input);
    if (result.type === 'success') createdSessions.set(result.sessionId,
      createPlainSessionCurrentProjectionRecordFixture({ id: result.sessionId,
        metadata: { path: '/tmp', host: 'test-machine', machineId: result.executionTarget.machineId } }));
    return result;
  };
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, input, options) => {
    // This transport accepts the request before awaiting the daemon result.
    options?.onIssued?.();
    if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return await actionOperationGetRpcSpy(ActionOperationGetV2RequestSchema.parse(input));
    return method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
      ? createExistingSessionDirectoryPreflightResult(input)
      : await spawn(input);
  });
  await import('@/sync/ops/actions/defaultActionExecutor');
  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  let authProjection: Awaited<ReturnType<typeof renderScreen>> | null = null;
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  const defaultSpawn = sessionSpawnNewRpcSpy.getMockImplementation()!;
  return {
    async disposeAuth() { await authProjection?.unmount(); authProjection = null; },
    async dispose() {
      await authProjection?.unmount(); authProjection = null;
      for (const write of temporaryDestinationCredentials.splice(0).reverse()) await write.rollback();
      await account.dispose();
    },
    seedOwnedSession(sessionId: string) {
      createdSessions.set(sessionId, createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }));
    },
    async seedTemporaryDestination(sessionId: string) {
      const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const home = await upsertServerProfileOnly({ serverUrl: 'https://server-b', name: 'Temporary destination' });
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature` };
      const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, credentials);
      if (!write) throw new Error('Temporary destination Account credentials could not be stored');
      temporaryDestinationCredentials.push(write);
      temporaryDestinationToken = credentials.token;
      temporaryDestinationSessions.set(sessionId, createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }));
      return { serverId: home.id, accountId: 'account-b' };
    },
    async reset(options?: HarnessOptions) {
      await authProjection?.unmount();
      authProjection = null;
      // Each test's global cleanup retires its HTTP boundary. Re-enter the
      // canonical Account fixture before exercising another real launch.
      await account.dispose();
      for (const write of temporaryDestinationCredentials.splice(0).reverse()) await write.rollback();
      temporaryDestinationSessions.clear();
      temporaryDestinationToken = null;
      sessionReadRequests.length = 0;
      artifactBoundary.clear();
      promptLibraryBoundary = createPromptLibraryCatalogBoundary();
      account = await restoreAccount();
      currentHarnessOptions = options;
      createdSessions.clear();
      reviewIssued = false;
      nativeSpawnReview.respond = false;
      sessionSpawnNewRpcSpy.mockReset().mockImplementation(defaultSpawn);
      actionOperationGetRpcSpy.mockReset().mockResolvedValue({ kind: 'not_found' });
      scopedSocketEmitWithAckSpy.mockImplementation(async (event, input) => {
        expect(event).toBe('rpc-call');
        const request = input as Readonly<{ method: string; params: unknown }>;
        if (request.method === `m1:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
          return { ok: true, result: createExistingSessionDirectoryPreflightResult(request.params) };
        }
        if (request.method === `m1:${ACTION_OPERATION_RPC_METHODS_V2.get}`) {
          return { ok: true, result: await actionOperationGetRpcSpy(ActionOperationGetV2RequestSchema.parse(request.params)) };
        }
        expect(request.method).toBe(`m1:${RPC_METHODS.SESSION_SPAWN_NEW}`);
        return { ok: true, result: await spawn(request.params) };
      });
      publishModeSpy.mockClear();
      sendMessageSpy.mockClear();
      // Keep the Account lifetime just restored above; replaying the complete
      // initial snapshot would resurrect its retired credential authority.
      storage.setState({ sessions: {}, sessionPending: {}, artifacts: {} });
      storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: account.serverId });
      storage.getState().applySettings(
        { ...initialStore.settings, ...options?.storageState?.settings as Partial<Settings> },
        (storage.getState().settingsVersion ?? 0) + 1,
      );
      if (options?.promptTemplateBehavior) {
        const { withUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        // Store the document through its actual writer; only the Account's
        // Artifact and catalog HTTP endpoints are supplied by this fixture.
        const created = await withUiPromptLibraryArtifactStore(store => createPromptDocInLibrary({
          store, request: { title: 'QA Template', markdown: 'Expanded QA Template' },
        }), { serverId: account.serverId });
        promptLibraryBoundary = createPromptLibraryCatalogBoundary({ records: [{ key: 'invocations', value: {
          v: 1, entries: [{ id: 'tmpl_1', token: '/qa-check', title: 'QA Template',
            target: { kind: 'doc', artifactId: created.artifactId }, behavior: options.promptTemplateBehavior,
            allowArgs: true, availableIn: 'global' }],
        } }] });
      }
      for (const sessionId of Object.keys(options?.storageState?.sessions ?? {})) {
        storage.getState().applySessions([createSessionFixture({ id: sessionId })]);
      }
      if (options?.storageState?.artifacts) {
        storage.setState({ artifacts: options.storageState.artifacts as ReturnType<typeof storage.getState>['artifacts'] });
      }
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      await selectNewSessionTestHome();
      // Sync transport restoration and the rendered UI's Action identity are
      // separate owners. Publish the same genuine Account to both.
      authProjection = await renderScreen(React.createElement(InjectedAuthProvider, {
        credentials: account.credentials, children: null,
      }));
    },
    useCreateNewSession,
    publishModeSpy,
    sendMessageSpy,
    sessionSpawnNewRpcSpy,
    actionOperationGetRpcSpy,
    sessionReadRequests,
    clearNewSessionDraftSpy,
  };
}

let harness: Awaited<ReturnType<typeof createHarness>>;
let restoreActionExecutorModuleLoader: (() => void) | undefined;
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

// The cold Sync/Action module graph belongs to collection; the per-case reset
// below restores real Account custody before exercising each launch.
restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
harness = await createHarness();
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
await prepareSessionDraftPersistenceStorage();
afterAll(async () => {
  await harness?.dispose();
  restoreActionExecutorModuleLoader?.();
  vi.restoreAllMocks();
  localStorageBoundary.restore();
});

describe('useCreateNewSession (ACP mode seeding)', () => {
  beforeEach(() => {
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    modalConfirmSpy.mockResolvedValue(false);
    scopedSocketEmitWithAckSpy.mockReset();
  });

  afterEach(async () => {
    await harness?.disposeAuth();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps a Temporary computer Composer submission pending until its real first input is admitted', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, seedTemporaryDestination, sessionReadRequests } = await setupHarness();
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
    let followUpSignal: AbortSignal | undefined;
    const afterCreated = vi.fn(async (created: Parameters<NonNullable<HandleCreateSessionOptions['afterCreated']>>[0]) => {
      followUpSignal = created.signal;
      // Accepted first-input work belongs to creation custody, not the route
      // which presented the materialized Session.
      await hook.unmount();
    });
    const router = { push: vi.fn(), replace: vi.fn() };
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    // The active authoring Account and temporary destination are deliberately
    // different Homes and Accounts.
    const targetScope = await seedTemporaryDestination('runner-session-1');
    const prepareTemporaryComputerLaunchDraft = vi.fn(async () => undefined);
    const draftId = 'temporary-computer-completion-draft';
    const { getSessionComposerDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
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
    expect(sessionReadRequests).toContain('https://server-b/v2/sessions/runner-session-1');
    expect(afterCreated).not.toHaveBeenCalled();
    expect(onAfterCreatedSettled).not.toHaveBeenCalled();
    expect(getSessionComposerDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.composer.text.value)
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
    expect(followUpSignal).toBeInstanceOf(AbortSignal);
    expect(followUpSignal?.aborted).toBe(false);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(getSessionComposerDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.composer.text.value)
      .toBe('reviewed prompt');
    await hook.unmount();
  });

  it('launches a prompt that cannot be an invocation without waiting for the prompt-library catalog', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness({ promptLibraryRowsNeverAnswer: true });
    let handleCreateSession: null | (() => Promise<void>) = null;
    function Test() {
      handleCreateSession = useCreateNewSession(buildCreateSessionHookParams({
        promptStore: createNewSessionPromptStore('hello'),
      }) as any).handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }
    await renderScreen(React.createElement(Test));

    await act(async () => { void handleCreateSession?.(); });

    await vi.waitFor(() => expect(sessionSpawnNewRpcSpy, JSON.stringify(modalAlertSpy.mock.calls)).toHaveBeenCalledWith(
      expect.objectContaining({ initialInput: { text: 'hello' } }),
    ));
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
    expect(sessionSpawnNewRpcSpy, JSON.stringify(modalAlertSpy.mock.calls)).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: expect.any(String),
      executionTarget: { serverId: 'server-a', machineId: 'm1' },
      directory: { kind: 'path', path: '/tmp' },
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

  it.each([
    'agent', 'linked', 'refused', 'confirmation', 'account-mismatch',
    'docked-fix-start', 'docked-add-instructions', 'docked-investigate', 'docked-refused', 'docked-plain',
    'docked-fix-review', 'docked-add-instructions-review',
  ] as const)('settles a New Session draft with an ordinary Triage Action (%s)', async scenario => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, actionOperationGetRpcSpy, seedOwnedSession, seedTemporaryDestination } = await setupHarness();
    const docked = scenario.startsWith('docked-');
    const refused = scenario === 'refused' || scenario === 'docked-refused';
    const plain = scenario === 'docked-plain';
    const startsAnother = scenario === 'docked-add-instructions' || scenario === 'docked-add-instructions-review';
    const reviewCopy = scenario === 'docked-fix-review'
      ? { title: 'Direct fix', body: 'Start a new Session' }
      : scenario === 'docked-add-instructions-review'
        ? { title: 'Add instructions', body: 'Create a Session for Direct fix with the instructions from this draft.' }
        : undefined;
    const linksEntry = scenario === 'agent' || scenario === 'linked'
      || scenario === 'docked-fix-start' || scenario === 'docked-add-instructions' || scenario === 'docked-investigate';
    const { seedAndOpenNewSession } = await import('../newSessionSeedComposer');
    const { readNewSessionDraftFromRepository } = await import('../../composer/newSessionDraftRepositoryAdapter');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const { TRIAGE_PLUGIN } = await import('../../../../../../../packages/plugins/triage/src/definition');
    const { requestTriageNewSessionAuthoringV1 } = await import('../../../../../../../packages/plugins/triage/src/sessions/newSessionAuthoring');
    const { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, TriageLinkEntryToSessionInputV1Schema } =
      await import('../../../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
    const { createTestkitCorpusCollections } = await import('../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
    const { testkitEntryRef, testkitObservation } = await import('../../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
    const { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1: configuredActionId } =
      await import('../../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
    const { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1: entryDetailId } =
      await import('../../../../../../../packages/plugins/triage/src/actions/entryDetailProtocol');
    const { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1: reobserveId } =
      await import('../../../../../../../packages/plugins/triage/src/actions/reobserveEntryProtocol');
    const { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1: readActionsId } =
      await import('../../../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol');
    const { testkitConfiguredInstance, testkitReadOnlySourceSnapshot, TESTKIT_LINK_DISPLAY } =
      await import('../../../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support');
    const { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } =
      await import('../../../../../../../packages/plugins/triage/src/targetedContributions');
    const { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE,
      CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SESSION_LINKS_INDEX_ID, CORPUS_USER_MARKS_COLLECTION_ID } =
      await import('../../../../../../../packages/plugins/triage/src/corpus/collections/ids');
    const { toCorpusStoredValue } = await import('../../../../../../../packages/plugins/triage/src/corpus/collections/rowCodec');

    const actionId = TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1;
    const manifest = TRIAGE_PLUGIN.manifest;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected creator Account custody');
    const scope = accountLifetime.scope;
    const draftScope = scenario === 'account-mismatch' ? await seedTemporaryDestination('unused-session') : scope;
    let draftId = '00000000-0000-4000-8000-000000000058';
    const { collections, control } = createTestkitCorpusCollections();
    const entryRef = scenario === 'agent' ? testkitEntryRef({ kindId: 'issue' }) : testkitEntryRef();
    const configured = testkitConfiguredInstance();
    if (!refused) {
      control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
        sourceQualifiedId: entryRef.source.pluginId + '/' + entryRef.source.localId, configured }));
    }

    const invocations: unknown[] = [];
    let linkRequestId: string | undefined;
    const installed = await installPortableAccountPluginReleaseForTest({
      manifest: scenario === 'confirmation' ? {
        ...manifest,
        contributes: { ...manifest.contributes, actions: manifest.contributes?.actions?.map(action => action.id === actionId
          ? { ...action, dangerLevel: 'writesRemote' as const,
            confirmation: { title: 'Link this Triage entry?' },
            confirmationWhen: { presentUserUi: false, default: { op: 'eq' as const, path: 'sessionId', value: 'sess_new' } } }
          : action) },
      } : manifest,
      accountLifetime,
      publishProjection: true,
      activate(api) {
        return TRIAGE_PLUGIN.activateAccount({ ...api, actions: {
          register(id, handler, options) {
            if (scenario === 'agent' && id === configuredActionId) {
              api.actions.register(id, (value, context) => {
                const ui = context.ui;
                if (!ui) throw new Error('Expected the invoking App to provide UI authoring');
                // The source, Account catalog and project inventory are external reads.
                // Keep the configured Action, mounted openNewSession and spawn/link real.
                const executeAction = (async (reference: import('@happier-dev/plugin-sdk').PluginReference) => {
                  if (typeof reference !== 'string' && reference.localId === reobserveId) {
                    return { kind: 'observed', entryRef, observation: testkitObservation() };
                  }
                  if (typeof reference !== 'string' && reference.localId === entryDetailId) {
                    return { kind: 'read', instance: configured, linkedSessions: [] };
                  }
                  if (typeof reference !== 'string' && reference.localId === readActionsId) {
                    return { v: 1, availability: 'parsed', revision: '1', actions: [
                      { actionId: 'custom-fix', label: 'Fix', enabled: true, appliesTo: ['issue'], profileId: null,
                        workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null,
                          seededFallbackInstruction: 'Fix this issue.', delivery: 'compose' } },
                    ] };
                  }
                  if (reference === 'projects.list') return { items: [], truncated: false };
                  throw new Error('Unexpected read: ' + JSON.stringify(reference));
                }) as typeof ui.executeAction;
                return handler(value, { ...context, ui: { ...ui,
                  async context() {
                    const point = TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1;
                    const target = { pluginId: manifest.id, occurrenceId: 'triage-release',
                      sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } };
                    return { accountScope: context.accountScope, targetedContributions: { target, points: [{
                      pointId: point.id, protocols: [{ protocol: point.protocol,
                        contributions: testkitReadOnlySourceSnapshot().contributions.map(source => ({
                          contributor: { ...source.contributor, occurrenceId: 'test-source',
                            sourceCustody: { kind: 'development' as const, registeredRootId: 'test-source-root' } },
                          protocol: point.protocol, descriptor: source.descriptor, operations: [], surfaces: [],
                        })),
                      }],
                    }] } };
                  },
                  executeAction,
                } });
              }, options);
              return;
            }
            if (id !== actionId) {
              api.actions.register(id, handler, options);
              return;
            }
            api.actions.register(id, (value, context) => {
              const input = TriageLinkEntryToSessionInputV1Schema.parse(value);
              invocations.push({ sessionId: input.sessionId, accountScope: context.accountScope });
              linkRequestId = context.requestId;
              // Supply the source census and Account Collections at their service boundaries.
              const collection = ((definition: { id: string }) => {
                if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return collections.sourceInstances;
                if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return collections.sessionLinks;
                if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return collections.userMarks;
                throw new Error('Unexpected Collection ' + definition.id);
              }) as typeof context.services.storage.account.collection;
              return handler(value, { ...context, services: { ...context.services, storage: {
                account: { ...context.services.storage.account, collection },
              }, targetedContributions: { ...context.services.targetedContributions, observeForSelf: (() => ({
                readCurrent: async () => testkitReadOnlySourceSnapshot(), dispose() {},
              })) as typeof context.services.targetedContributions.observeForSelf } } });
            }, options);
          },
        } });
      },
    });

    try {
      // Exercise the normal desktop Account Action placement at its platform boundary.
      nativeTriageActionHost.enabled = true;
      const open = (seed: unknown) => {
        expect(seedAndOpenNewSession({ scope: draftScope, seed, pluginId: manifest.id, isCurrent: () => true,
          createDraftId: () => draftId, navigateToNewSession: () => {} }).kind).toBe('opened');
      };
      if (scenario === 'agent') {
        const callerSessionId = 'agent-session';
        seedOwnedSession(callerSessionId);
        const { createCurrentUiContributedActionRpcHandler } =
          await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const declaration = installed.projection.actionsById[manifest.id + '/' + configuredActionId];
        if (!declaration) throw new Error('Expected the configured Triage Action in the installing Account');
        const receive = createCurrentUiContributedActionRpcHandler({
          machineId: 'm1', ...scope, readProjection: () => installed.projection,
          isCurrent: accountLifetime.isCurrent, execute: createDefaultActionExecutor().execute,
        });
        const entry = { entryRef, sourceInstanceId: configured.instance.sourceInstanceId };
        newSessionPush.mockClear();
        const opened = await receive({
          v: 1, action: { pluginId: manifest.id, localId: configuredActionId }, surface: 'agent',
          input: { v: 1, handoff: { task: 'fix', configuredActionId: 'custom-fix',
            context: { kind: 'entry', entry }, evidence: [{ kind: 'entry', entry }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } },
          actionRequestId: 'agent-configured-triage', expectedContributorOccurrenceId: declaration.occurrenceId,
          invokingAccountAction: { accountId: scope.accountId,
            caller: { kind: 'session', sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({
          ok: true, result: { handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } },
        });
        const route = newSessionPush.mock.calls[0]?.[0];
        expect(route).toMatchObject({ pathname: '/new', params: { draftAccountId: scope.accountId, draftId: expect.any(String) } });
        if (!route || typeof route !== 'object' || !('params' in route) || !route.params || typeof route.params !== 'object'
            || !('draftId' in route.params) || typeof route.params.draftId !== 'string') throw new Error('Expected the authored draft route');
        draftId = route.params.draftId;
        expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
      } else if (plain) open({ prompt: 'Address this entry' });
      else {
        const authoring = {
          entries: [],
          linkEntry: { entryRef, display: TESTKIT_LINK_DISPLAY, sourceInstance: configured.instance },
          ...(reviewCopy === undefined ? {} : {
            creationReview: reviewCopy,
            actionDefault: { pluginId: manifest.id, configuredActionId: 'custom-fix', label: 'Direct fix', launchMode: 'start' as const },
          }),
          promptText: scenario === 'docked-investigate' ? 'Investigate this entry'
            : startsAnother ? 'Add instructions for this entry' : 'Fix this entry',
          profileId: null,
          checkoutIntent: 'none' as const,
          placement: null,
          candidates: [],
        };
        expect(await requestTriageNewSessionAuthoringV1({
          version: () => ({ methods: ['openNewSession'] }),
          openNewSession: async seed => {
            if (!reviewCopy && scenario !== 'docked-fix-start') return open(seed);
            const { createPluginOpenNewSessionHandler } = await import('@/components/plugins/surfaces/pluginOpenNewSessionHostApi');
            const caller = { pluginId: manifest.id, contributionLocalId: TRIAGE_APP_PAGE_LOCAL_ID_V1 };
            const handler = createPluginOpenNewSessionHandler({
              ...caller, accountLifetime, isCurrent: accountLifetime.isCurrent,
              executeSelectedOperation: async () => { throw new Error('No preparation is requested'); },
            });
            newSessionPush.mockClear();
            expect(await handler(seed)).toBeNull();
            const route = newSessionPush.mock.calls[0]?.[0];
            expect(route).toMatchObject({ pathname: '/new', params: { draftId: expect.any(String) } });
            draftId = (route as { params: { draftId: string } }).params.draftId;
          },
          selectActionInput: async () => { throw new Error('No preparation is requested'); },
        }, authoring))
          .toEqual({ status: 'seeded' });
      }
      expect(invocations).toEqual([]);
      const postCreateAction = readNewSessionDraftFromRepository({ scope: draftScope, draftId })?.postCreateAction;
      expect(Boolean(postCreateAction)).toBe(!plain);
      if (scenario === 'agent') {
        expect(postCreateAction).toMatchObject({ pluginId: manifest.id, contributionLocalId: configuredActionId });
      }
      const createRequestId = 'triage-docked-create';
      const operationId = 'triage-docked-spawn';
      const presentedWithInvocationCounts: number[] = [];
      const router = { push: vi.fn(), replace: vi.fn(() => presentedWithInvocationCounts.push(invocations.length)) };
      const { NewSessionEmbeddedHostProvider } = await import('../navigation/newSessionHost');
      const host = { kind: 'docked' as const, params: {}, demanded: true, createdSessionPresentation: 'inPlace' as const,
        setParams: vi.fn(), openDraft: vi.fn(), onHandedOff: vi.fn() };
      if (docked) {
        const terminal = sessionSpawnNewRpcSpy.getMockImplementation()!;
        sessionSpawnNewRpcSpy.mockImplementationOnce(async input => {
          const result = await terminal(input);
          if (result.type !== 'success' || !input.observeSessionCommit) return result;
          seedOwnedSession(result.sessionId);
          const operation = { ...input.executionTarget, operationId };
          actionOperationGetRpcSpy.mockResolvedValueOnce(ActionOperationGetV1ResponseSchema.parse({
            kind: 'found', operation: {
              version: 1, operationId, revision: 2, actionId: 'session.spawn_new', state: 'succeeded',
              scope: { accountId: scope.accountId, machineId: input.executionTarget.machineId }, title: 'Create session',
              requestId: createRequestId, createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported', result,
            },
          }));
          return { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true, operation, sessionId: result.sessionId };
        });
      }
      const params = buildCreateSessionHookParams({ draftId, draftScope, targetServerId: scope.serverId, router,
        onStartAnother: () => presentedWithInvocationCounts.push(invocations.length),
        ...(docked ? { launchUserAttemptId: createRequestId, selectedMachine: createMachineFixture({ id: 'm1',
          operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } },
        }) } : {}),
      });
      const hook = await renderHook(() => useCreateNewSession(params as never), docked ? {
        wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
      } : undefined);
      try {
        nativeSpawnReview.respond = reviewCopy !== undefined;
        await act(async () => { await hook.getCurrent().handleCreateSession(docked && !startsAnother ? { afterSend: 'open' } : undefined); });
        if (reviewCopy) {
          expect(modalShowSpy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'actions.confirmation-review.modal',
              title: reviewCopy.title, subtitle: expect.stringContaining(reviewCopy.body) }),
            props: expect.objectContaining({ confirmLabel: reviewCopy.title }),
          }));
          // A dismissed review never creates a Session or consumes the draft's post-create link.
          expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
          expect(invocations).toEqual([]);
          expect(readNewSessionDraftFromRepository({ scope: draftScope, draftId })?.postCreateAction).toEqual(postCreateAction);
          return;
        }
        expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
        if (docked) expect(presentedWithInvocationCounts).toEqual([plain ? 0 : 1]);
        if (plain) expect(actionOperationGetRpcSpy).toHaveBeenCalledWith({ operationId, waitForTerminal: true });
        expect(invocations, JSON.stringify({ alerts: modalAlertSpy.mock.calls, confirms: modalConfirmSpy.mock.calls,
          retainedIntent: Boolean(readNewSessionDraftFromRepository({ scope, draftId })?.postCreateAction) }))
          .toEqual(linksEntry || refused ? [{ sessionId: 'sess_new', accountScope: scope }] : []);
        const rows = await collections.sessionLinks.query({
          index: CORPUS_SESSION_LINKS_INDEX_ID.bySession, prefix: ['sess_new'], order: 'asc',
        });
        expect(rows.rows).toHaveLength(linksEntry ? 1 : 0);
        expect(readNewSessionDraftFromRepository({ scope: draftScope, draftId })?.postCreateAction).toBeUndefined();
        if (scenario === 'docked-fix-start') {
          // Exercise the browser relay with the reloaded seed and the Session
          // that actually settled. Only the final Account transport is a fixture.
          if (!postCreateAction) throw new Error('Expected the host-authored post-create Action');
          const { createUiAccountActionTransport } = await import('@/sync/ops/actions/accountActionTransport');
          const { createPluginActionCallerContext } = await import('@/components/plugins/surfaces/pluginActionCallerContext');
          const { bindPluginUiNewSessionPostCreateActionV1 } = await import('@happier-dev/protocol/plugins/ui');
          const { ACTION_INVOKE_ACTION_ID_V1 } = await import('@happier-dev/protocol/actions/actionIds');
          const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
          const account = await captureLazyActionAccountContext(scope.serverId);
          const receipt = { kind: 'accepted' };
          const relay = vi.fn(async () => receipt);
          const execute = createUiAccountActionTransport({
            account, resolveFallbackMachineId: () => 'm1', transport: relay,
          });
          const { pluginId, contributionLocalId } = postCreateAction;
          const input = bindPluginUiNewSessionPostCreateActionV1(postCreateAction.intent, 'sess_new');
          const executeLink = (caller: Parameters<typeof createPluginActionCallerContext>[0]) => execute({
            actionId: ACTION_INVOKE_ACTION_ID_V1, input,
            context: { ...createPluginActionCallerContext(caller), surface: 'ui', serverId: account.serverId,
              runtimeAccountId: scope.accountId, actionRequestId: linkRequestId },
          });
          try {
            await expect(executeLink({ pluginId })).resolves.toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            expect(relay).not.toHaveBeenCalled();
            await expect(executeLink({ pluginId, contributionLocalId })).resolves.toBe(receipt);
            expect(relay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
              accountId: scope.accountId, requestId: linkRequestId,
              payload: expect.objectContaining({ input: expect.objectContaining({ sessionId: 'sess_new' }) }),
              invocation: expect.objectContaining({ authority: 'account_automation',
                caller: expect.objectContaining({ kind: 'plugin', pluginId, contributionLocalId: TRIAGE_APP_PAGE_LOCAL_ID_V1 }),
              }),
            }));
          } finally {
            account.dispose();
          }
        }
        if (scenario === 'confirmation') expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
          chrome: expect.objectContaining({ testID: 'app-shell-transient-interaction-dialog' }),
        }));
        if (linksEntry || scenario === 'account-mismatch') {
          expect(modalConfirmSpy).not.toHaveBeenCalled();
          expect(modalShowSpy).not.toHaveBeenCalled();
        }
        if (scenario === 'account-mismatch') {
          expect(modalAlertSpy).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('action_account_scope_changed'), undefined);
        }
        if (refused) {
          expect(linkRequestId).toBeTruthy();
          expect(linkRequestId).not.toBe(createRequestId);
          const notice = modalAlertSpy.mock.calls.find(([, message]) =>
            typeof message === 'string' && message.includes('sessionLinksSourceInstanceUnavailable'));
          expect(notice?.[1]).toContain(linkRequestId);
        }
      } finally {
        await hook.unmount();
      }
    } finally {
      nativeTriageActionHost.enabled = false;
      await installed.dispose();
    }
  });

  it('preserves the authored Team context and access in the final spawn payload', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy } = await setupHarness();
    const access = {
      grants: [{ subject: { kind: 'team' as const, teamId: 'team-acme' }, accessLevel: 'view' as const, canApprovePermissions: false }],
    };
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    expect(await getServerFeaturesSnapshot({ serverId: 'server-a', force: true })).toMatchObject({
      status: 'ready', features: { features: { sharing: { session: { enabled: true } } } },
    });
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      authoringDraft: { access, primaryTeamId: 'team-acme' },
      targetServerId: 'server-a',
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
    const { getSessionComposerDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
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
      await createPromise;
    });

    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(getSessionComposerDraftSnapshot(
      draftScope,
      { kind: 'newSession', draftId },
    )?.composer.text?.value ?? '').toBe('');
    expect(disableDraftPersistence).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    await hook.unmount();
  });


  it.each(['accepted', 'unavailable', 'missing', 'failed'] as const)(
    'preserves canonical daemon custody across observer socket loss (%s)', async (operationState) => {
    const {
      useCreateNewSession,
      sessionSpawnNewRpcSpy,
    } = await setupHarness();
    const { markRpcRequestDisposition } = await import('@happier-dev/sync-client');
    const observer = createDeferred<never>();
    sessionSpawnNewRpcSpy.mockReturnValueOnce(observer.promise);
    const requestId = `request-owned-by-daemon-${operationState}`;
    const operationId = `operation-owned-by-daemon-${operationState}`;
    const setIsCreating = vi.fn();
    const onAfterCreatedSettled = vi.fn();
    const hook = await renderHook(() => useCreateNewSession(buildCreateSessionHookParams({
      setIsCreating,
      draftScope: { serverId: 'server-a', accountId: 'account-a' },
      launchUserAttemptId: requestId,
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
    if (operationState !== 'missing') {
      act(() => actionOperationStore.mergeSnapshots({ serverId: 'server-a', snapshots: [{
        version: 1,
        operationId,
        revision: 1,
        actionId: 'session.spawn_new',
        state: operationState === 'failed' ? 'failed' : 'accepted',
        scope: { accountId: 'account-a', machineId: 'm1' },
        title: 'Create session',
        requestId,
        createdAt: 1,
        cancellation: 'supported',
        ...(operationState === 'failed' ? {
          settledAt: 2, error: { errorCode: 'spawn_failed', error: 'spawn_failed' },
        } : {}),
      }] }));
      if (operationState === 'unavailable') {
        act(() => actionOperationStore.setMachineObservation({ serverId: 'server-a', machineId: 'm1' }, 'unavailable'));
      }
    }
    expect(sessionSpawnNewRpcSpy.mock.calls[0]?.[0].creationKey).toBe(`manual:${requestId}`);
    const { readManualSessionSpawnOperation } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
    const readOperation = () => readManualSessionSpawnOperation(
      { serverId: 'server-a', accountId: 'account-a' },
      requestId,
    );
    if (operationState === 'missing') expect(readOperation()).toBeNull();
    else expect(readOperation()).toMatchObject({ operationId, state: operationState === 'failed' ? 'failed' : 'accepted' });
    await hook.unmount();
    await act(async () => {
      // This is loss of an already-issued observation, not an unsent request
      // that the real transport may safely retry through another route.
      observer.reject(markRpcRequestDisposition(new Error('Socket not connected'), 'outcomeUnknown'));
      await createPromise;
    });

    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    if (operationState === 'accepted' || operationState === 'unavailable') {
      expect(onAfterCreatedSettled).not.toHaveBeenCalledWith({ status: 'rejected' });
      expect(readOperation()).toMatchObject({ operationId, state: 'accepted' });
    } else {
      expect(onAfterCreatedSettled).toHaveBeenCalledTimes(1);
      expect(onAfterCreatedSettled).toHaveBeenCalledWith({ status: 'rejected' });
      if (operationState === 'missing') expect(readOperation()).toBeNull();
      else expect(readOperation()).toMatchObject({ operationId, state: 'failed' });
    }
    actionOperationStore.reset();
    await hook.unmount();
  });

  it.each(['unmount', 'edit'] as const)('retains canonical custody when the observer retires during an accepted operation (%s)', async (retire) => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, actionOperationGetRpcSpy } = await setupHarness();
    const requestId = 'request-owned-by-accepted-operation';
    const operationId = 'accepted-operation-observer';
    const operationReply = createDeferred<ActionOperationGetV1Response>();
    actionOperationGetRpcSpy.mockReturnValueOnce(operationReply.promise);
    sessionSpawnNewRpcSpy.mockResolvedValueOnce({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const operation = {
      version: 1 as const, operationId, revision: 1, actionId: 'session.spawn_new', state: 'accepted' as const,
      scope: { accountId: 'account-a', machineId: 'm1' }, title: 'Create session', requestId,
      createdAt: 1, cancellation: 'supported' as const,
    };
    act(() => actionOperationStore.mergeSnapshots({ serverId: 'server-a', snapshots: [operation] }));
    const afterCreated = vi.fn();
    const onAfterCreatedSettled = vi.fn();
    const router = { push: vi.fn(), replace: vi.fn() };
    let launchIntentSignature = 'test-launch-intent';
    const hook = await renderHook(() => {
      const [isCreating, setIsCreating] = React.useState(false);
      const creator = useCreateNewSession(buildCreateSessionHookParams({
        router, launchUserAttemptId: requestId, launchIntentSignature, setIsCreating,
      }) as any);
      return { ...creator, isCreating };
    });
    let createPromise: Promise<void> | undefined;
    try {
      await act(async () => {
        createPromise = Promise.resolve(hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated, onAfterCreatedSettled }));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(actionOperationGetRpcSpy).toHaveBeenCalledWith({ operationId, waitForTerminal: true }));
      expect(sessionSpawnNewRpcSpy.mock.calls[0]?.[0].creationKey).toBe(`manual:${requestId}`);
      expect(hook.getCurrent().isCreating).toBe(true);
      if (retire === 'unmount') {
        await hook.unmount();
      } else {
        launchIntentSignature = 'updated-launch-intent';
        await hook.rerender();
      }
      await act(async () => {
        operationReply.resolve(ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: { ...operation, revision: 2, state: 'succeeded', startedAt: 1, settledAt: 2,
          result: { type: 'success', disposition: 'created', sessionId: 'pending-created-session',
            executionTarget: { serverId: 'server-a', machineId: 'm1' }, organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' } },
        } }));
        await createPromise;
      });
      expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
      expect(afterCreated).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(modalAlertSpy).not.toHaveBeenCalled();
      expect(onAfterCreatedSettled).not.toHaveBeenCalledWith({ status: 'rejected' });
      if (retire === 'edit') expect(hook.getCurrent().isCreating).toBe(false);
      const { readManualSessionSpawnOperation } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
      expect(readManualSessionSpawnOperation({ serverId: 'server-a', accountId: 'account-a' }, requestId))
        // The unmounted launcher consumed nothing (asserted above); the canonical record keeps the
        // operation and mirrors its received terminal snapshot.
        .toMatchObject({ operationId, state: 'succeeded' });
    } finally {
      await hook.unmount();
      operationReply.resolve({ kind: 'not_found' });
      await createPromise;
      actionOperationStore.reset();
    }
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
    scopedSocketEmitWithAckSpy.mockImplementation(async (_event, input) => {
      const request = input as Readonly<{ method: string; params: unknown }>;
      if (request.method === `m1:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
        return { ok: true, result: createExistingSessionDirectoryPreflightResult(request.params) };
      }
      await sessionSpawnNewRpcSpy(SessionSpawnNewInputV2Schema.parse(request.params)).catch(() => undefined);
      return { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
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

    // Both active and scoped transports reach this daemon boundary. An issued
    // strict request is not replayed through an incidental alternative route.
    expect(sessionSpawnNewRpcSpy).toHaveBeenCalledTimes(1);
    for (const [event, input] of scopedSocketEmitWithAckSpy.mock.calls) {
      expect(event).toBe('rpc-call');
      // Socket.IO is the untyped transport boundary; payload schemas stay real.
      const request = input as Readonly<{ method: string; params: unknown }>;
      if (request.method === `m1:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
        createExistingSessionDirectoryPreflightResult(request.params);
      } else {
        expect(request.method).toBe(`m1:${RPC_METHODS.SESSION_SPAWN_NEW}`);
        SessionSpawnNewInputV2Schema.parse(request.params);
      }
    }
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'newSession.actionMethodUnavailable',
      undefined,
    );
    expect(await TokenStorage.removeCredentialsForServerUrl(
      activeServer.serverUrl,
      { serverId: activeServer.serverId },
    )).toBe(true);
  });

  it('carries agent mode through the strict V2 Action for staticAgentModes (Claude)', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, publishModeSpy, sendMessageSpy } = await setupHarness();
    // Claude installs through its vendor's recipe: Create asks once before an Agent the Machine lacks.
    modalConfirmSpy.mockResolvedValueOnce(true);

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
      agentInstallConsent: { vendorRecipe: true },
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('carries agent mode through the strict V2 Action for Codex', async () => {
    const { useCreateNewSession, sessionSpawnNewRpcSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
    (await import('@/sync/domains/state/storageStore')).storage.getState().applySettingsLocal(settings);
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
    (await import('@/sync/domains/state/storageStore')).storage.getState().applySettingsLocal(settings);
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
      promptTemplateBehavior: 'insert_and_send',
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
      promptTemplateBehavior: 'insert',
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
    modalConfirmSpy.mockReset();
    modalConfirmSpy.mockResolvedValue(false);
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
