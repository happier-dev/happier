// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { AccountApiTokenSelfV1Schema, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, FeaturesResponseSchema, PendingLocalIdSchema, PendingRequestedActionV1Schema, SessionCurrentProjectionRecordV1Schema, SessionStoredMessageContentSchema, SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';

/** No Saved Secret is bound in these daemon-availability cases, so every ref resolves as deleted. */
const resolveSavedSecretReference = (ref: string): SavedSecretReferenceResolution => ({
  ref,
  kind: 'personal',
  status: 'deleted',
  entry: null,
  secret: null,
  revision: null,
  fingerprint: null,
});


vi.hoisted(() => { window.history.replaceState({}, '', '/embed/new'); });
// Global test setup may load the immutable boot-realm adapter before this file's
// URL is selected. Pin only that browser environment boundary to the frame realm.
vi.mock('@/embed/isEmbedWindowContext', () => ({ isEmbedWindowContext: () => true }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('socket.io-client', async () => {
  const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
  return { io: () => createSocketIoBoundaryStub({ autoConnect: false }).socket };
});

const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));
// Vite cannot execute the product loader's CommonJS require('../sync.ts').
// Adapt only that module-loading boundary; every call reaches the real Sync owner.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));

type NewSessionHarnessStorageState = ReturnType<(typeof import('@/sync/domains/state/storageStore'))['storage']['getState']>;

function spawnSuccess(sessionId: string): SessionSpawnNewResultV1 {
  return {
    type: 'success',
    disposition: 'created',
    sessionId,
    executionTarget: { serverId: 'server-a', machineId: 'm1' },
    organizationPlacement: { folderId: null, tagIds: [] },
    initialInput: { status: 'accepted', localId: `input-${sessionId}` },
  };
}

async function createHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const sessionSpawnNewActionBoundarySpy = vi.fn(async (_input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'error',
      code: 'machine_offline',
      retryable: true,
  }));
  let storageState: NewSessionHarnessStorageState;
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
    modal: async () => ({
      Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) },
    }),
  });
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  await selectNewSessionTestHome();
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
  storageState = storage.getState();
  vi.spyOn(storageState, 'upsertPendingMessage');
  vi.spyOn(storageState, 'markSessionOptimisticThinking');




  // Keep Action dispatch and local launch custody real; replace only daemon transport.
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, _method, input) =>
    await sessionSpawnNewActionBoundarySpy(SessionSpawnNewInputV2Schema.parse(input)));
  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  vi.spyOn(sync, 'sendMessage');
  await import('@/sync/ops/actions/defaultActionExecutor');

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  return {
    async reset() {
      modalAlertSpy.mockReset();
      sessionSpawnNewActionBoundarySpy.mockReset().mockResolvedValue({ type: 'error', code: 'machine_offline', retryable: true });
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
      storageState = storage.getState();
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      await selectNewSessionTestHome();
    },
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    get storageState() { return storageState; },
  };
}

let harness: Awaited<ReturnType<typeof createHarness>>;
let restoreBrowserLocks: (() => void) | undefined;
const runtimeCleanups: Array<() => void> = [];
async function setupHarness() {
  await harness.reset();
  return harness;
}

type CreateSessionParams = Parameters<(typeof import('./useCreateNewSession'))['useCreateNewSession']>[0];

function createRetryParams(settings: Settings, overrides: Partial<CreateSessionParams> = {}): CreateSessionParams {
  return {
    launchIntentSignature: 'test-launch-intent',
    router: { push: vi.fn(), replace: vi.fn() },
    selectedMachineId: 'm1',
    selectedMachine: createMachineFixture({ id: 'm1' }),
    selectedPath: '/tmp',
    draftScope: { serverId: 'server-a', accountId: 'account-a' },
    targetServerId: 'server-a',
    allowedTargetServerIds: ['server-a'],
    setIsCreating: vi.fn(),
    setIsResumeSupportChecking: vi.fn(),
    settings,
    useProfiles: false,
    selectedProfileId: null,
    profileMap: new Map(),
    recentMachinePaths: [],
    agentType: 'codex',
    permissionMode: 'default',
    modelMode: 'default',
    promptStore: createNewSessionPromptStore(''),
    resumeSessionId: '',
    agentNewSessionOptions: null,
    machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
    secrets: [],
    secretBindingsByProfileId: {},
    selectedSecretIdByProfileIdByEnvVarName: {},
    resolveSavedSecretReference,
    sessionOnlySecretValueByProfileIdByEnvVarName: {},
    selectedMachineCapabilities: {},
    ...overrides,
  };
}

function alertRetry(modalAlertSpy: Awaited<ReturnType<typeof setupHarness>>['modalAlertSpy']): () => void {
  const buttons = modalAlertSpy.mock.calls.at(-1)?.[2] as ReadonlyArray<{ text: string; onPress?: () => void }> | undefined;
  const retry = buttons?.find((button) => button.text === 'common.retry')?.onPress;
  expect(retry).toBeTypeOf('function');
  return retry!;
}

type NewSessionEmbeddedHost = import('@/components/sessions/new/navigation/newSessionHost').NewSessionEmbeddedHost;

/**
 * The embed's new chat (plan 05 U2N): the incumbent creation flow with the presentation host's
 * `onCreate` as its one spawn step. The flow's attempt identity, retry and completion are real; the
 * host's `onCreate` is the boundary.
 */
async function embeddedHost(input: Readonly<{
  onCreate: (draft: never, attempt: Readonly<{ attemptId: string }>) => Promise<unknown>;
  onHandedOff: () => void;
}>): Promise<NewSessionEmbeddedHost> {
  // Loaded after the harness installs its module graph, so the provider and the flow share it.
  const { createEmbeddedNewChatSpawnExecutor } = await import('@/components/sessions/shell/embedded/EmbeddedSessionNewChat');
  return {
    params: {},
    setParams: () => undefined,
    openDraft: () => undefined,
    onHandedOff: input.onHandedOff,
    demanded: true,
    executeSpawnAction: createEmbeddedNewChatSpawnExecutor({
      readOnCreate: () => input.onCreate as never,
      onSpawned: () => undefined,
    }),
    createdSessionPresentation: 'inPlace',
    creationProfile: { hostBindsMachine: true, machineId: 'm1' },
  };
}

describe('useCreateNewSession (embedded new chat)', () => {
  it('keeps a CLI setup failure informational when the host presents the chat in place', async () => {
    const { useCreateNewSession, storageState, modalAlertSpy } = await setupHarness();
    const params = createRetryParams(storageState.settings, { directoryKind: 'managed' });
    const host: NewSessionEmbeddedHost = {
      ...await embeddedHost({ onCreate: vi.fn(), onHandedOff: vi.fn() }),
      executeSpawnAction: async () => ({ ok: true, result: { type: 'error', code: 'agent_cli_missing', agentId: 'codex', retryable: false } }),
    };
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const hook = await renderHook(() => useCreateNewSession(params), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
    });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    const buttons = modalAlertSpy.mock.calls.at(-1)?.[2] as ReadonlyArray<{ onPress?: () => void }> | undefined;
    expect(buttons).toHaveLength(1);
    expect(buttons?.some((button) => typeof button.onPress === 'function')).toBe(false);
    expect(params.router.push).not.toHaveBeenCalled();
    await hook.unmount();
  });
  beforeAll(async () => {
    restoreBrowserLocks = installWebLockManagerMock().restore;
    harness = await createHarness();
    // This real presentation host is used by every case. Load its screen graph
    // during canonical harness setup, not inside the first timed contract.
    await import('@/components/sessions/shell/embedded/EmbeddedSessionNewChat');
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
  }, 180_000);
  afterAll(() => {
    restoreBrowserLocks?.();
    syncSingletonBridge.current = null;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });
  afterEach(async () => {
    for (const dispose of runtimeCleanups.splice(0)) dispose();
    const { resetRuntimeFetch } = await import('@/sync/http/client');
    resetRuntimeFetch();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('admits a host-bound machine without an Account record, then sends through canonical custody before handoff', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy } = await setupHarness();
    const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
    const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/sync/http/client');
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applyMachines([], true, { sourceServerId: 'server-a' });
    const endpointUrl = 'https://server-a';
    const creationSelf = AccountApiTokenSelfV1Schema.parse({
      accountId: 'account-a', accountEncryptionMode: 'plain',
      credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
      grant: { v: 1, actions: { families: [], ids: ['session.spawn_new'] },
        targets: { sessions: [], machines: ['m1'] }, approve: false, origins: ['https://parent.example'],
        models: null, permissionModes: null,
        create: { machineId: 'm1', agentTargetKey: 'agent:happier.agent.codex/codex', directory: 'managed',
          placement: { folderId: null, tagIds: [] } } },
      embedConfig: { v: 1, ui: { attachments: true }, newChat: { enabled: true },
        organization: { folderId: null, tagIds: [] }, style: null },
    });
    const sessionSelf = AccountApiTokenSelfV1Schema.parse({ ...creationSelf,
      credentialId: '00000000-0000-4000-8000-000000000002', parentTokenId: creationSelf.credentialId,
      grant: { ...creationSelf.grant, create: null,
        actions: { families: [], ids: ['session.transcript.get', 'session.message.send'] },
        targets: { sessions: ['embed-created'], machines: [] } },
    });
    const spawnRequests: Record<string, unknown>[] = [];
    const pendingRequests: Readonly<Record<string, unknown>>[] = [];
    const pendingRows: Readonly<Record<string, unknown>>[] = [];
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const json = (value: unknown) => new Response(JSON.stringify(value));
      if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return json(
        new Headers(init?.headers).get('authorization') === 'Bearer session-child' ? sessionSelf : creationSelf);
      if (path === '/v1/actions/action.options.resolve') return json({ v: 1, actionId: 'action.options.resolve',
        execution: { ok: true, result: { actionId: 'session.spawn_new', fieldPath: 'modelSelection',
          optionsSourceId: null, options: [] } } });
      if (path === '/v1/actions/session.spawn_new') {
        spawnRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ v: 1, actionId: 'session.spawn_new', execution: { ok: true,
          result: { ...spawnSuccess('embed-created'), initialInput: { status: 'notRequested' } } } });
      }
      if (path === '/v1/features/authenticated') return json(FeaturesResponseSchema.parse({ features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 3 } } } }));
      if (path === '/v2/cursor') return json({ cursor: 0 });
      // Frame hydration negotiates the current detail projection. Mirror that
      // HTTP contract rather than feeding the real reader a legacy detail row.
      if (path === '/v2/sessions/embed-created') return json({ session: SessionCurrentProjectionRecordV1Schema.parse({
        id: 'embed-created', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ path: '/managed', host: 'test', machineId: 'm1', flavor: 'codex' }),
        agentStateVersion: 0, agentState: null, share: null,
        effectiveAccess: { v: 1, level: 'edit', sources: [],
          capabilities: createSessionAccessFixture('edit', { editSessionRecords: false }).capabilities },
        responsibleAccountId: null, responsibleAccount: null,
      }) });
      if (path === '/v1/sessions/embed-created/messages') return json({ messages: [], hasMore: false });
      if (path === '/v1/sessions/embed-created/turns') return new Response(null, { status: 404 });
      if (path === '/v2/sessions/embed-created/pending') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          pendingRequests.push(body);
          const pending = {
            localId: PendingLocalIdSchema.parse(body.localId),
            content: SessionStoredMessageContentSchema.parse(body.content),
            messageRole: 'user', requestedAction: PendingRequestedActionV1Schema.parse(body.requestedAction),
            status: 'queued', deliveryState: null, position: pendingRows.length,
            createdAt: Date.now(), updatedAt: Date.now(), discardedAt: null, discardedReason: null,
          };
          pendingRows.push(pending);
          return json({ requestedAction: pending.requestedAction, pending });
        }
        return json({ pending: pendingRows });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
    runtimeCleanups.push(runtime.dispose);
    const requestCredential = vi.fn(async (_request: import('@happier-dev/protocol/embed').EmbedCredentialRequestV1) => ({ token: 'session-child', expiresAt: '2100-01-01T00:00:00.000Z' }));
    runtime.attachBridge({ requestCredential, sessionCreated: () => {} });
    await runtime.initialize({ parentOrigin: 'https://parent.example', credential: {
      token: 'creation-child', expiresAt: '2100-01-01T00:00:00.000Z',
    } });
    const creationScope = runtime.getSnapshot().creationConfig?.draftScope;
    if (!creationScope) throw new Error('The admitted creation host did not publish its draft scope');
    const onCreate = vi.fn(runtime.createSession);
    const params = createRetryParams(storageState.settings, {
      draftScope: creationScope,
      directoryKind: 'managed',
      selectedMachine: null,
      targetServerId: endpointUrl,
      allowedTargetServerIds: [endpointUrl],
      promptStore: createNewSessionPromptStore('Qualify this lead'),
    });
    const handedOffPendingLocalIds: unknown[] = [];
    vi.mocked(params.router.replace).mockImplementation(() => {
      handedOffPendingLocalIds.push(...pendingRows.map((row) => row.localId));
    });
    const host = await embeddedHost({ onCreate, onHandedOff: vi.fn() });
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const { useNewSessionAttachmentsController } = await import('@/components/sessions/new/attachments/useNewSessionAttachmentsController');
    // The production Send controller intentionally has a void entrypoint and
    // defers creation on web. Observe its forwarded real promise and public
    // first-turn context; the controller's original callback still owns Send.
    const creationCompleted = createDeferred<void>();
    let firstTurnLocalId: string | undefined;
    const hook = await renderHook(() => {
      const creation = useCreateNewSession(params);
      const attachments = useNewSessionAttachmentsController({
        isCreating: false, promptStore: params.promptStore,
        handleCreateSession: (options) => {
          const afterCreated = options?.afterCreated;
          creationCompleted.resolve(creation.handleCreateSession(afterCreated ? {
            ...options,
            afterCreated: async (context) => {
              firstTurnLocalId = context.launchAttempt.firstTurnLocalId;
              await afterCreated(context);
            },
          } : options));
        },
        selectedProfileId: params.selectedProfileId,
        selectedMachineId: params.selectedMachineId,
        targetServerId: endpointUrl,
      });
      return { ...creation, handleSend: attachments.handleSend };
    }, {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
    });
    await act(async () => {
      hook.getCurrent().handleSend();
      await vi.advanceTimersByTimeAsync(0);
      await creationCompleted.promise;
    });
    await flushHookEffects({ cycles: 8, turns: 4 });
    const { sync } = await import('@/sync/syncEngine');
    expect(modalAlertSpy.mock.calls, JSON.stringify({ phase: runtime.getSnapshot().phase,
      error: runtime.getSnapshot().error, hostCreates: onCreate.mock.calls.length, serverSpawns: spawnRequests.length })).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', displayedSessionId: 'embed-created' });
    // Read the server's acknowledged queue through the real owner, rather than
    // requiring a transient optimistic projection to remain in the store.
    await act(async () => { await sync.fetchPendingMessages('embed-created'); });

    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledTimes(1);
    const [draft, attempt] = onCreate.mock.calls[0] as unknown as [SessionSpawnNewInputV2, { attemptId: string }];
    expect(draft.directory).toEqual({ kind: 'managed' });
    expect(draft.initialInput).toBeUndefined();
    expect(firstTurnLocalId).toBeTypeOf('string');
    expect(firstTurnLocalId).not.toBe('');
    expect(storage.getState().sessionPending['embed-created']?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Qualify this lead', localId: firstTurnLocalId }),
    ]));
    expect(spawnRequests).toHaveLength(1);
    expect(spawnRequests[0].input).not.toHaveProperty('initialInput');
    expect(pendingRequests).toEqual([expect.objectContaining({ localId: firstTurnLocalId })]);
    expect(handedOffPendingLocalIds).toEqual([firstTurnLocalId]);
    // The frame's admitted Account, not saved ambient credentials, binds the
    // reached existing-session composer repository and attachment owner.
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { useDraft } = await import('@/hooks/session/useDraft');
    const { createComposerTextStore } = await import('@/components/sessions/agentInput/composerTextStore');
    const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
    const successorText = createComposerTextStore('Successor draft');
    const scopeHook = await renderHook(() => {
      const state = useServerCredentialAccountScopeBinding(endpointUrl);
      const draftOwner = useDraft('embed-created', successorText, {
        accountLifetime: state.binding, session: storage.getState().sessions['embed-created'] ?? null,
        active: true, retainProjectionOnAccountRetirement: true,
      });
      return { ...state, draftOwner };
    });
    await flushHookEffects({ cycles: 4, turns: 2 });
    const binding = scopeHook.getCurrent().binding;
    expect(binding?.scope).toEqual({ serverId: endpointUrl, accountId: 'account-a' });
    expect(binding?.isCurrent()).toBe(true);
    if (!binding) throw new Error('The admitted frame did not bind its composer Account');
    await sync.materializeExistingSessionDraft('embed-created', binding);
    await act(async () => { scopeHook.getCurrent().draftOwner.setDraftValue('Newest successor draft'); });
    expect(credentialRead).not.toHaveBeenCalled();
    const retired = vi.fn();
    binding?.onRetire(retired);
    const admittedContext = sync.getEmbedSessionRequestContext();
    const renewalCredential = createDeferred<{ token: string; expiresAt: string }>();
    requestCredential.mockImplementationOnce(async () => await renewalCredential.promise);
    const renewal = runtime.retry();
    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(admittedContext?.isCurrent()).toBe(true);
    expect(binding?.isCurrent()).toBe(true);
    expect(retired).not.toHaveBeenCalled();
    expect(successorText.getPrompt()).toBe('Newest successor draft');
    renewalCredential.resolve({ token: 'session-child', expiresAt: '2100-01-01T00:00:00.000Z' });
    await renewal;
    expect(admittedContext?.isCurrent()).toBe(false);
    expect(sync.getEmbedSessionRequestContext()?.isCurrent()).toBe(true);
    expect(binding?.isCurrent()).toBe(false);
    expect(retired).toHaveBeenCalledTimes(1);
    await scopeHook.rerender();
    await flushHookEffects({ cycles: 4, turns: 2 });
    expect(scopeHook.getCurrent().binding?.scope).toEqual(binding?.scope);
    expect(scopeHook.getCurrent().binding?.isCurrent()).toBe(true);
    expect(scopeHook.getCurrent().binding).not.toBe(binding);
    expect(successorText.getPrompt()).toBe('Newest successor draft');
    expect(credentialRead).not.toHaveBeenCalled();
    credentialRead.mockRestore();
    await scopeHook.unmount();
    expect(requestCredential.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ reason: 'created', createdByTokenId: creationSelf.credentialId }),
      expect.objectContaining({ reason: 'rejected', sessionId: 'embed-created' }),
    ]);
    expect(requestCredential.mock.calls[1]?.[0]).not.toHaveProperty('createdByTokenId');
    expect(draft.creationKey).toContain(attempt.attemptId);
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    // The flow presents the created Session through its router's `replace`, which the embedded
    // host turns into an in-place hand-off (`newSessionHost`); it never pushes a route itself.
    expect(params.router.push).not.toHaveBeenCalled();
    expect(params.router.replace).toHaveBeenCalledTimes(1);
    await hook.unmount();
    runtime.dispose();
    resetRuntimeFetch();
  });

  it('retries a failed onCreate with the same attempt identity and the draft intact', async () => {
    const { useCreateNewSession, storageState } = await setupHarness();
    const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
    const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/sync/http/client');
    const { AccountApiTokenSelfV1Schema, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1 } = await import('@happier-dev/protocol');
    const spawnRequests: unknown[] = [];
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(AccountApiTokenSelfV1Schema.parse({
        accountId: 'account-a', accountEncryptionMode: 'plain',
        credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
        grant: { v: 1, actions: { families: [], ids: ['session.spawn_new'] },
          targets: { sessions: [], machines: ['m1'] }, approve: false, origins: ['https://parent.example'],
          models: null, permissionModes: null,
          create: { machineId: 'm1', agentTargetKey: 'agent:happier.agent.codex/codex', directory: 'managed',
            placement: { folderId: null, tagIds: [] } } },
        embedConfig: { v: 1, ui: { attachments: true }, newChat: { enabled: true },
          organization: { folderId: null, tagIds: [] }, style: null },
      })));
      if (path === '/v1/actions/action.options.resolve') return new Response(JSON.stringify({ v: 1,
        actionId: 'action.options.resolve', execution: { ok: true, result: { actionId: 'session.spawn_new',
          fieldPath: 'modelSelection', optionsSourceId: null, options: [] } } }));
      if (path === '/v1/actions/session.spawn_new') {
        spawnRequests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: { ok: true,
          result: { ...spawnSuccess('embed-created'), initialInput: { status: 'notRequested' } } } }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl: 'https://home.example' });
    runtimeCleanups.push(runtime.dispose);
    const requestCredential = vi.fn(async () => { throw new Error('credential_unavailable'); });
    runtime.attachBridge({ requestCredential, sessionCreated: () => {} });
    await runtime.initialize({ parentOrigin: 'https://parent.example', credential: {
      token: 'child', expiresAt: '2100-01-01T00:00:00.000Z',
    } });
    const creationScope = runtime.getSnapshot().creationConfig?.draftScope;
    if (!creationScope) throw new Error('The admitted creation host did not publish its draft scope');
    const onCreate = vi.fn(runtime.createSession);
    const params = createRetryParams(storageState.settings, {
      draftScope: creationScope,
      targetServerId: creationScope.serverId,
      allowedTargetServerIds: [creationScope.serverId],
      directoryKind: 'managed',
      promptStore: createNewSessionPromptStore('Keep me'),
    });
    const host = await embeddedHost({ onCreate, onHandedOff: vi.fn() });
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const hook = await renderHook(() => useCreateNewSession(params), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
    });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(onCreate).toHaveBeenCalledTimes(2);
    const attempts = onCreate.mock.calls.map((call) => (call as unknown as [unknown, { attemptId: string }])[1].attemptId);
    expect(attempts[0]).toBeTruthy();
    expect(attempts[1]).toBe(attempts[0]);
    expect(params.promptStore.getPrompt()).toBe('Keep me');
    expect(spawnRequests).toHaveLength(1);
    expect(requestCredential).toHaveBeenCalledTimes(2);
    await hook.unmount();
    runtime.dispose();
    resetRuntimeFetch();
  });

  it.each([
    // The runtime's typed refusal: the host says it will not create, whatever the code.
    { label: 'a typed non-retryable refusal', error: () => Object.assign(new Error('create_not_granted'), { code: 'create_not_granted', retryable: false }) },
    // An untyped grant refusal still ends the attempt: the protocol owns that code's retryability.
    { label: 'an untyped grant refusal', error: () => new Error('model_not_granted') },
    { label: 'an untyped permission-mode refusal', error: () => new Error('permission_mode_not_granted') },
  ])('ends $label so a later Send uses a fresh attempt', async ({ error }) => {
    const { useCreateNewSession, storageState } = await setupHarness();
    const onCreate = vi.fn(async () => { throw error(); });
    const params = createRetryParams(storageState.settings, {
      directoryKind: 'managed', promptStore: createNewSessionPromptStore('Keep me'),
    });
    const host = await embeddedHost({ onCreate, onHandedOff: vi.fn() });
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const hook = await renderHook(() => useCreateNewSession(params), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
    });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    const attempts = onCreate.mock.calls.map((call) => (call as unknown as [unknown, { attemptId: string }])[1].attemptId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    expect(params.promptStore.getPrompt()).toBe('Keep me');
    await hook.unmount();
  });
});
