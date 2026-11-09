// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { AccountApiTokenSelfV1Schema, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1} from '@happier-dev/protocol/auth/accountApiTokens';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { PendingLocalIdSchema} from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingRequestedActionV1Schema} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionStoredMessageContentSchema} from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { sealEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

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

function spawnSuccess(sessionId: string): Extract<SessionSpawnNewResultV1, { type: 'success' }> {
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

// Link the real Session/Sync/presentation graph during collection, before timed
// contracts and fake timers. Cold linking must not outlive a setup hook.
restoreBrowserLocks = installWebLockManagerMock().restore;
harness = await createHarness();
await import('@/components/sessions/shell/embedded/EmbeddedSessionNewChat');
await import('@/embed/runtime/createEmbedSessionRuntime');
await import('@/embed/encryption/createEmbedEncryption');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
await prepareSessionDraftPersistenceStorage();

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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the spawn-only child projection for bound-machine admission and model choices', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
    const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
    const { setRuntimeFetch } = await import('@/sync/http/client');
    const endpointUrl = 'https://server-a';
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    storage.getState().applyMachines([], true, { sourceServerId: 'server-a' });
    setRuntimeFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(AccountApiTokenSelfV1Schema.parse({
        accountId: 'account-a', accountEncryptionMode: 'plain',
        credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
        grant: { v: 1, actions: { families: [], ids: ['session.spawn_new'] },
          targets: { sessions: [], machines: ['m1'] }, approve: false, origins: ['https://parent.example'],
          models: [{ agentTargetKey, providerConnectionId: null, modelId: 'gpt-6-luna' }], permissionModes: null,
          create: { machineId: 'm1', agentTargetKey, directory: 'managed',
            placement: { folderId: null, tagIds: [] } } },
        embedConfig: { v: 1, ui: { attachments: true }, newChat: { enabled: true },
          organization: { folderId: null, tagIds: [] }, style: null },
      })));
      if (path === '/v1/actions/action.options.resolve') return new Response(JSON.stringify({ v: 1,
        actionId: 'action.options.resolve', execution: { ok: true, result: { actionId: 'session.spawn_new',
          fieldPath: 'modelSelection', optionsSourceId: 'agents.models.available', options: [
            { value: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Fast model' },
          ] } } }));
      throw new Error(`Unexpected request: ${path}`);
    });
    const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
    runtimeCleanups.push(runtime.dispose);
    runtime.attachBridge({ requestCredential: async () => { throw new Error('not used'); }, sessionCreated: () => {} });
    await runtime.initialize({ parentOrigin: 'https://parent.example', credential: {
      token: 'creation-child', expiresAt: '2100-01-01T00:00:00.000Z',
    } });
    const creation = runtime.getSnapshot().creationConfig;
    if (!creation?.machineId || !creation.agentTargetKey) throw new Error('Missing admitted creation projection');
    const host: NewSessionEmbeddedHost = {
      params: { draftId: creation.draftId, machineId: creation.machineId,
        backendTargetKey: creation.agentTargetKey, spawnServerId: endpointUrl },
      setParams: () => undefined,
      openDraft: () => undefined,
      onHandedOff: () => undefined,
      demanded: true,
      executeSpawnAction: async () => ({ ok: true, result: { type: 'error', code: 'agent_cli_missing', agentId: 'codex', retryable: false } }),
      createdSessionPresentation: 'inPlace',
      creationProfile: { hostBindsMachine: true, draftScope: creation.draftScope, machineId: creation.machineId,
        agentTargetKey: creation.agentTargetKey, allowedModels: creation.allowedModels,
        modelCatalog: creation.modelCatalog, permissionModes: creation.permissionModes, attachments: creation.attachments },
    };
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
    const hook = await renderHook(() => useNewSessionScreenModel({ draftId: creation.draftId, fixedDirectoryIntent: { kind: 'managed' } }), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionEmbeddedHostProvider, { host, children }),
    });
    await flushHookEffects({ cycles: 8, turns: 4 });
    const model = hook.getCurrent();
    expect(model.variant).toBe('simple');
    if (model.variant !== 'simple') throw new Error('Expected embedded simple composer');
    expect(model.simpleProps.connectionStatus).toBeUndefined();
    expect(model.simpleProps.canCreate).toBe(true);
    const picker = model.simpleProps.modelPickerProps;
    expect(picker).toMatchObject({
      nativeModels: [{ value: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Fast model' }],
    });
    expect(picker?.probe?.failed).not.toBe(true);
    const { buildSessionModelPickerSections } = await import('@/components/sessions/modelPicker/buildSessionModelPickerSections');
    if (!picker?.declarationContext) throw new Error('Expected the creation model picker declaration context');
    const grantedOption = buildSessionModelPickerSections({
      ...picker,
      declarationContext: picker.declarationContext,
      hiddenNativeModelKeys: picker.hiddenNativeModelKeys ?? new Set(),
    }).flatMap((section) => section.options).find((option) => option.label === 'GPT-6 Luna');
    expect(grantedOption).toBeDefined();
    expect(grantedOption?.disabled).not.toBe(true);
    await hook.unmount();
  });

  it.each([
    { label: 'direct create result', createResult: 'direct', encryptionMode: 'plain' },
    { label: 'recovered create result', createResult: 'recovered', encryptionMode: 'plain' },
    { label: 'cold E2EE worker startup failure', createResult: 'direct', encryptionMode: 'e2ee' },
  ] as const)('admits a host-bound machine and sends once through canonical custody ($label)', async ({ createResult, encryptionMode }) => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy } = await setupHarness();
    const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
    const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/sync/http/client');
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applyMachines([], true, { sourceServerId: 'server-a' });
    const endpointUrl = 'https://server-a';
    const embedEncryption = await createEmbedEncryption();
    const sessionDataKey = new Uint8Array(32).fill(61);
    const sessionKey = encryptionMode === 'e2ee' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: decodeBase64(embedEncryption.embedPublicKey, 'base64url'),
      randomBytes: (length) => new Uint8Array(length).fill(62),
    }), 'base64') : undefined;
    const sessionMetadata = encryptionMode === 'plain'
      ? JSON.stringify({ path: '/managed', host: 'test', machineId: 'm1', flavor: 'codex' })
      : await (async () => {
          const { Encryption } = await import('@/sync/encryption/encryption');
          const writer = await Encryption.create(new Uint8Array(32).fill(63));
          await writer.initializeSessions(new Map([['embed-created', sessionDataKey]]));
          const ciphertext = await writer.getSessionEncryption('embed-created')!.encryptRaw({
            path: '/managed', host: 'test', machineId: 'm1', flavor: 'codex',
          });
          writer.removeSessionEncryption('embed-created');
          return ciphertext;
        })();
    const stalledWorkers: Array<{ terminated: boolean }> = [];
    if (encryptionMode === 'e2ee') {
      class StalledStartupWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        terminated = false;
        constructor() { stalledWorkers.push(this); }
        postMessage() {}
        terminate() { this.terminated = true; }
      }
      vi.stubGlobal('Worker', StalledStartupWorker);
      embedEncryption.encryption.configureNativeCryptoWorker({
        routing: { mode: 'auto', minPayloadBytes: 0, timeoutMs: 100 },
      });
    }
    const creationSelf = AccountApiTokenSelfV1Schema.parse({
      accountId: 'account-a', accountEncryptionMode: encryptionMode,
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
      grant: { ...creationSelf.grant, create: null, approve: true,
        actions: { families: [], ids: ['session.transcript.get', 'session.message.send', 'approval.request.list', 'approval.request.get'] },
        targets: { sessions: ['embed-created'], machines: [] } },
    });
    const spawnRequests: Record<string, unknown>[] = [];
    let operationReads = 0;
    const pendingRequests: Readonly<Record<string, unknown>>[] = [];
    const pendingRows: Readonly<Record<string, unknown>>[] = [];
    const approvalInventory = createDeferred<void>();
    let approvalInventoryReads = 0;
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
        // The HTTP Action boundary returns the public sectionId projection; the UI owner reads it back to folderId.
        return json({ v: 1, actionId: 'session.spawn_new', execution: { ok: true,
          result: createResult === 'direct'
            ? projectSessionSpawnNewActionResultV1({ ...spawnSuccess('embed-created'), initialInput: { status: 'notRequested' } })
            : { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
              operation: { serverId: endpointUrl, machineId: 'm1', operationId: 'embed-spawn' } } } });
      }
      if (path === '/v1/actions/action.operations.get') {
        operationReads += 1;
        return json({ v: 1, actionId: 'action.operations.get', execution: { ok: true, result: {
          kind: 'found', operation: { version: 1, operationId: 'embed-spawn', revision: 2,
            actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: 'account-a', machineId: 'm1' },
            title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            result: projectSessionSpawnNewActionResultV1({ ...spawnSuccess('embed-created'), initialInput: { status: 'notRequested' } }),
          },
        } } });
      }
      // Session-bound credentials cannot read the Account-only descriptor.
      // Public discovery still owns the pending-input protocol capability.
      if (path === '/v1/features/authenticated') return new Response(null, { status: 403 });
      if (path === '/v1/features') return json(FeaturesResponseSchema.parse({ features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 3 } } } }));
      if (path === '/v1/actions/approval.request.list') {
        approvalInventoryReads += 1;
        if (createResult === 'direct') await approvalInventory.promise;
        return json({
        v: 1,
        actionId: 'approval.request.list',
        execution: {
          ok: true,
          result: {
            items: [],
            nextCursor: null,
            queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false },
          },
        },
        });
      }
      if (path === '/v2/cursor') return json({ cursor: 0 });
      // Frame hydration negotiates the current detail projection. Mirror that
      // HTTP contract rather than feeding the real reader a legacy detail row.
      if (path === '/v2/sessions/embed-created') return json({ session: SessionCurrentProjectionRecordV1Schema.parse({
        id: 'embed-created', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
        encryptionMode, dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: sessionMetadata,
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
          const storedContent = body.content ?? (typeof body.ciphertext === 'string'
            ? { t: 'encrypted', c: body.ciphertext }
            : body.content);
          const pending = {
            localId: PendingLocalIdSchema.parse(body.localId),
            content: SessionStoredMessageContentSchema.parse(storedContent),
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
    const runtimeNavigatePendingLocalIds: unknown[] = [];
    const runtime = createEmbedSessionRuntime({
      encryption: embedEncryption,
      endpointUrl,
      navigate: (sessionId) => {
        if (sessionId) runtimeNavigatePendingLocalIds.push(...pendingRows.map((row) => row.localId));
      },
    });
    runtimeCleanups.push(runtime.dispose);
    const requestCredential = vi.fn(async (_request: import('@happier-dev/protocol/embed').EmbedCredentialRequestV1) => ({
      token: 'session-child', expiresAt: '2100-01-01T00:00:00.000Z', ...(sessionKey ? { sessionKey } : {}),
    }));
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
      runtime.presentCreatedSession('embed-created');
    });
    const host = await embeddedHost({
      onCreate,
      onHandedOff: () => undefined,
    });
    const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
    const { useNewSessionAttachmentsController } = await import('@/components/sessions/new/attachments/useNewSessionAttachmentsController');
    const { useServerCredentialAccountScopeResolution } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    // The production Send controller intentionally has a void entrypoint and
    // defers creation on web. Observe its forwarded real promise and public
    // first-turn context; the controller's original callback still owns Send.
    const creationCompleted = createDeferred<void>();
    let firstTurnLocalId: string | undefined;
    const hook = await renderHook(() => {
      // The real screen gains its target Account binding when the host admits
      // the newly created Session. That is the same Account as the draft, not
      // retirement of the Send already held by this launch.
      React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
      const targetScope = useServerCredentialAccountScopeResolution(endpointUrl);
      const creation = useCreateNewSession({ ...params,
        targetAccountScope: targetScope.kind === 'bound' ? targetScope.scope : null,
      });
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
    if (encryptionMode === 'e2ee') vi.useRealTimers();
    await act(async () => {
      hook.getCurrent().handleSend();
      if (encryptionMode === 'plain') await vi.advanceTimersByTimeAsync(0);
      if (createResult === 'direct') {
        try {
          // Approval inventory can remain in flight without withholding the
          // authored first turn. No wall-clock performance assertion is needed.
          await vi.waitFor(() => expect(pendingRequests).toHaveLength(1));
          expect(approvalInventoryReads).toBe(1);
        } finally { approvalInventory.resolve(); }
      }
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
    expect(operationReads).toBe(createResult === 'recovered' ? 1 : 0);
    expect(spawnRequests[0].input).not.toHaveProperty('initialInput');
    expect(pendingRequests).toEqual([expect.objectContaining({ localId: firstTurnLocalId })]);
    if (encryptionMode === 'e2ee') {
      expect(pendingRequests[0]).toEqual(expect.objectContaining({ ciphertext: expect.any(String) }));
      expect(pendingRequests[0]?.ciphertext).not.toBe('');
      expect(stalledWorkers).toEqual([expect.objectContaining({ terminated: true })]);
    }
    expect(handedOffPendingLocalIds).toEqual([firstTurnLocalId]);
    expect(runtimeNavigatePendingLocalIds).toEqual([firstTurnLocalId]);
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
    const renewalCredential = createDeferred<{ token: string; expiresAt: string; sessionKey?: string }>();
    requestCredential.mockImplementationOnce(async () => await renewalCredential.promise);
    const renewal = runtime.retry();
    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(admittedContext?.isCurrent()).toBe(true);
    expect(binding?.isCurrent()).toBe(true);
    expect(retired).not.toHaveBeenCalled();
    expect(successorText.getPrompt()).toBe('Newest successor draft');
    renewalCredential.resolve({ token: 'session-child', expiresAt: '2100-01-01T00:00:00.000Z', ...(sessionKey ? { sessionKey } : {}) });
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
    const { AccountApiTokenSelfV1Schema, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1} = await import('@happier-dev/protocol/auth/accountApiTokens');
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
        // Keep the lost-response fixture on the public Action result contract; retry identity is the behavior under test.
        return new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: { ok: true,
          result: projectSessionSpawnNewActionResultV1({ ...spawnSuccess('embed-created'), initialInput: { status: 'notRequested' } }) } }));
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
