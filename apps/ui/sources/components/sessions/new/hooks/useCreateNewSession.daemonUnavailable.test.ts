import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import 'fake-indexeddb/auto';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema, SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { type AccountEncryptionCurrentnessResponse} from '@happier-dev/protocol/account/encryptionMode';
import { type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { DEFAULT_SESSION_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/sessionCapabilities';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

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


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const socketRpcBoundary = vi.hoisted(() => ({
  respond: null as ((method: string, input: unknown) => Promise<unknown>) | null,
  cipher: null as import('@/sync/encryption/machineEncryption').MachineEncryption | null,
}));
vi.mock('socket.io-client', () => ({ io: () => {
  const boundary = createSocketIoBoundaryStub();
  boundary.socket.emitWithAck.mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') throw new Error('Invalid test RPC payload');
    if (!socketRpcBoundary.respond) throw new Error('Test RPC boundary is not prepared');
    const raw = 'params' in payload ? payload.params : undefined;
    const encrypted = typeof raw === 'string' && socketRpcBoundary.cipher !== null;
    const { socketRpcCodec } = await import('@happier-dev/sync-client');
    const content = encrypted ? { mode: 'e2ee' as const, cipher: socketRpcBoundary.cipher! } : { mode: 'plain' as const };
    const method = payload.method.slice(payload.method.indexOf(':') + 1);
    const decoded = await socketRpcCodec.decodeRequestParams(content, raw, payload.method).catch(async error => {
      if (!encrypted) throw error;
      const opened: unknown = await socketRpcBoundary.cipher!.decryptRaw(raw);
      const sealedMethod = opened && typeof opened === 'object' && 'm' in opened ? opened.m : null;
      throw new Error(`Synthetic RPC binding mismatch: carrier=${payload.method}, sealed=${String(sealedMethod)}`, { cause: error });
    });
    const result = await socketRpcBoundary.respond(method, decoded.params);
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  });
  return boundary.socket;
} }));

const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));

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

function readDraftComposerText(snapshot: import('@/sync/ops/sessionDrafts/sessionDraftRepository').SessionDraftSnapshot | null) {
  if (!snapshot) return undefined;
  if (!('composer' in snapshot.document)) throw new Error('Expected a composer draft');
  return snapshot.document.composer.text.value;
}

async function expectSubmittedDraftRetired(scope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope, draftId: string) {
  const { getSessionDraftSnapshot, listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
  expect(listNewSessionDraftProjections(scope).map(draft => draft.draftId)).not.toContain(draftId);
  const retained = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
  // Local supplements may retain an unmaterialized scratch document after clearing.
  if (!retained) return;
  expect(retained.materialized).toBe(false);
  if (retained.document.target.kind !== 'newSession') throw new Error('Expected New Session draft');
  expect(retained.document.target.authoring).toEqual({});
  expect(readDraftComposerText(retained)).toBe('');
  if (!('composer' in retained.document)) throw new Error('Expected draft composer');
  expect(retained.document.composer.mentions.value).toEqual([]);
  expect(retained.document.composer.attachments.value).toEqual([]);
  expect(retained.localSupplement.launchUserAttemptId).toBeUndefined();
  expect(retained.localSupplement.launchCurrentnessCapture).toBeUndefined();
}

async function createHarness() {
  let machineRow = createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' });
  let serveMachineInventory = false;
  const additionalBoundary = {
    http: null as ((url: URL, init?: RequestInit) => Promise<Response | null>) | null,
    rpc: null as ((method: string, input: unknown) => Promise<unknown | undefined>) | null,
  };
  const plainCurrentness = createPlainAccountEncryptionCurrentnessFixture();
  const todoKv = {
    currentness: plainCurrentness as AccountEncryptionCurrentnessResponse,
    items: new Map<string, { key: string; value: string; version: number }>(),
    failWrite: false,
    conflictOnce: false,
    writes: [] as Array<{ key: string; value: string | null; version: number }>,
  };
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const sessionSpawnNewActionBoundarySpy = vi.fn(async (_input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'error',
      code: 'machine_offline',
      retryable: true,
  }));
  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
          if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
          if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
          if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
          if (key === 'errors.errorWithCode') return `${key}:${String(params?.code ?? '')}:${String(params?.message ?? '')}`;
          if (key === 'session.startFailure.requestId') return `${key}:${String(params?.id ?? '')}`;
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
  vi.spyOn(storage.getState(), 'upsertPendingMessage');
  vi.spyOn(storage.getState(), 'markSessionOptimisticThinking');




  // Keep Action dispatch and local launch custody real; replace only daemon transport.
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  const respondMachineRpc = async (method: string, input: unknown) => {
    const additional = await additionalBoundary.rpc?.(method, input);
    if (additional !== undefined) return additional;
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return createExistingSessionDirectoryPreflightResult(input);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
        claude: { id: 'claude', title: 'Claude', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude },
      } } };
    }
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
      return { protocolVersion: 1, ok: true, result: { source: 'static', configOptions: [
        { id: 'codexBackendMode', name: 'Runtime', type: 'select', options: [{ name: 'App server', value: 'appServer' }] },
      ] } };
    }
    if (method !== RPC_METHODS.SESSION_SPAWN_NEW) return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    return await sessionSpawnNewActionBoundarySpy(SessionSpawnNewInputV2Schema.parse(input));
  };
  socketRpcBoundary.respond = respondMachineRpc;
  const machineRpcSpy = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, input, options) => {
    options?.onIssued?.();
    return await respondMachineRpc(method, input);
  });
  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  let authProjection: Awaited<ReturnType<typeof renderScreen>> | null = null;
  const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
  const { createAccountKvHttpFixture } = await import('@/dev/testkit/fixtures/accountKvHttpFixture');
  const todoKvHttp = createAccountKvHttpFixture({ rows: todoKv.items });
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  const fetchBoundary = createSessionReadBatchFetchBoundary(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const memory = await authoringMemoryHttp.handle(input, init);
    if (memory) return memory;
    const url = String(input instanceof Request ? input.url : input);
    const additional = await additionalBoundary.http?.(new URL(url), init);
    if (additional) return additional;
    if (serveMachineInventory && new URL(url).pathname === '/v1/machines') return Response.json([machineRow]);
    if (url.endsWith('/v1/kv') && init?.method === 'POST') {
      const { mutations } = JSON.parse(String(init.body)) as { mutations: typeof todoKv.writes };
      todoKv.writes.push(...mutations);
      if (todoKv.failWrite) return Response.json({ error: 'task link unavailable' }, { status: 400 });
      if (todoKv.conflictOnce) {
        todoKv.conflictOnce = false;
        const row = todoKv.items.get(mutations[0]!.key)!;
        const { decodeBase64StoredJsonContentEnvelope, encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
        const envelope = decodeBase64StoredJsonContentEnvelope(row.value);
        if (envelope?.t !== 'plain') throw new Error('Plain conflict fixture expected');
        const item = envelope.v as Record<string, unknown>;
        row.value = encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { ...item, linkedSessions: { ...(item.linkedSessions as object), concurrent: { title: 'Another session', linkedAt: 2 } } } });
        row.version += 1;
      }
    }
    const kvResponse = await todoKvHttp.handleFetch(input, init);
    if (kvResponse) return kvResponse;
    const bootstrap = createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init);
    if (bootstrap) return bootstrap;
    if (url.endsWith('/v1/account/encryption/currentness')) return Response.json(todoKv.currentness);
    if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: todoKv.currentness.mode, updatedAt: 1 });
    if (url.endsWith('/v2/account/settings')) return Response.json(todoKv.currentness.mode === 'e2ee'
      ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 });
    if (new URL(url).pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
      return createMachineReadBatchResponseFixture(init.body, id => id === 'm1' ? machineRow : createPlainMachineRowFixture({ id, accountId: 'account-a' }));
    }
    const machineId = new URL(url).pathname.match(/^\/v1\/machines\/([^/]+)(?:\/access)?$/)?.[1];
    if (machineId && !url.endsWith('/access')) return Response.json({ machine: machineId === 'm1' ? machineRow : createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }) });
    // Session creation reads current Machine custody through the real HTTP owner.
    if (machineId && url.endsWith('/access')) return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
      machineId, custodian: { accountId: 'account-a', displayName: 'Test Account' },
      access: { custodian: { accountId: 'account-a', displayName: 'Test Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }));
    if (/^\/v1\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname)) {
      return Response.json({ messages: [], hasMore: false });
    }
    const sessionId = new URL(url).pathname.match(/^\/v2\/sessions\/([^/]+)$/)?.[1];
    if (sessionId) {
      const session = storage.getState().sessions[decodeURIComponent(sessionId)];
      if (!session) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ session: {
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, encryptionMode: session.encryptionMode,
        dataEncryptionKey: null, metadataLayoutVersion: 0, metadataVersion: session.metadataVersion,
        metadata: JSON.stringify(session.metadata), agentStateVersion: session.agentStateVersion,
        agentState: session.agentState === null ? null : JSON.stringify(session.agentState), share: null,
      } });
    }
    if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
  vi.spyOn(sync, 'sendMessage');
  await import('@/sync/ops/actions/defaultActionExecutor');

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  return {
    async reset(currentAccount = false, e2ee = false, originAtBirth = false) {
      await authProjection?.unmount();
      authProjection = null;
      todoKv.currentness = plainCurrentness;
      todoKv.items.clear();
      todoKv.failWrite = false;
      todoKv.conflictOnce = false;
      todoKv.writes = [];
      additionalBoundary.http = null;
      additionalBoundary.rpc = null;
      modalAlertSpy.mockClear();
      machineRpcSpy.mockClear();
      sessionSpawnNewActionBoundarySpy.mockReset().mockResolvedValue({ type: 'error', code: 'machine_offline', retryable: true });
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      authoringMemoryHttp.reset();
      setRuntimeFetch(fetchBoundary);
      vi.stubGlobal('fetch', fetchBoundary);
      await selectNewSessionTestHome();
      // The package harness clears browser storage before each test. Restore
      // credentials through its real owner before Account-scoped Action reads.
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
      const accountToken = currentAccount
        ? (await import('@/dev/testkit/harness/homeGovernanceHarness')).createAccountTokenForTests('account-a', { currentAccount: true })
        : token;
      const secret = new Uint8Array(32).fill(17);
      const machine = createMachineFixture({ id: 'm1', ...(originAtBirth ? {
        operationProtocolCapabilities: { sessionSpawnAuthoringOrigin: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
      } : {}) });
      machineRow = createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a', machine });
      serveMachineInventory = e2ee;
      socketRpcBoundary.cipher = null;
      if (e2ee) {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { createMachineDataEncryptionKeyV1 } = await import('@happier-dev/protocol/machines/machineStoredContent');
        const { encodeBase64 } = await import('@/encryption/base64');
        const writer = await Encryption.create(secret);
        const key = createMachineDataEncryptionKeyV1({ material: { type: 'legacy', secret },
          randomBytes: length => new Uint8Array(length).fill(5) });
        await writer.initializeMachines(new Map([['m1', key.encryptionKey]]));
        const cipher = writer.getMachineEncryption('m1');
        if (!cipher) throw new Error('Expected encrypted Machine boundary cipher');
        socketRpcBoundary.cipher = cipher;
        machineRow = { ...machineRow, metadata: await cipher.encryptMetadata(machine.metadata!),
          dataEncryptionKey: encodeBase64(key.dataEncryptionKey),
          access: {
            custodian: { accountId: 'account-a', displayName: 'Test Account' },
            role: 'manage', resourceMode: 'e2ee', accessState: 'ready',
          } };
      }
      if (e2ee) todoKv.currentness = (await import('@/dev/testkit/fixtures/accountEncryptionCurrentness')).createLegacyAccountEncryptionCurrentnessFixture({ secret });
      const credentials = { token: accountToken, ...(e2ee ? { secret: (await import('@/encryption/base64')).encodeBase64(secret) } : {}) };
      await TokenStorage.setCredentialsForServerUrl('https://server-a', { serverId: getActiveServerSnapshot().serverId }, credentials);
      await sync.switchServer(credentials);
      // Sync credentials alone do not authenticate the rendered UI. Let the
      // real auth projection supply the Action owner's credential provenance.
      authProjection = await renderScreen(React.createElement(InjectedAuthProvider, { credentials, children: null }));
      storage.getState().applySettings(storage.getState().settings, 1);
      storage.getState().applyMachines([machine], true, { sourceServerId: 'server-a' });
    },
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    todoKv,
    machineRpcSpy,
    additionalBoundary,
    async disposeAuth() { await authProjection?.unmount(); authProjection = null; },
    get storageState() { return storage.getState(); },
  };
}

// Load the real cold module graph during collection; setup's budget observes
// Account/HTTP/draft hydration, not compilation of the Action executor graph.
const harness = await createHarness();
// Call-through observation only: keep the real Action owner and returned values.
const spawnActionObservation = vi.spyOn(await import('@/sync/ops/actions/sessionSpawnNewAction'), 'executeSessionSpawnNewAction');
const scopedTransportObservation = vi.spyOn(await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport'), 'resolveServerScopedTransport');
// The composed cold graph belongs to collection, like the Action graph above;
// per-test time observes the journey, rather than compiling its UI owners.
const approvalAttachmentModules = await Promise.all([
  import('./screenModel/useNewSessionActionOperationReconciliation'),
  import('../attachments/useNewSessionAttachmentsController'),
  import('./screenModel/useNewSessionComposerDocument'),
  import('@/dev/testkit/harness/artifactStoreBoundary'),
  import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption'),
]);
let actionHomesBoundary: Awaited<ReturnType<typeof serveActionHomes>>;
let browserStorageBoundary: ReturnType<typeof installLocalStorageMock>;
let approvalAttachmentCase = 0;
async function setupHarness(currentAccount = false, e2ee = false, originAtBirth = false) {
  await harness.reset(currentAccount, e2ee, originAtBirth);
  return harness;
}

async function setupTaskHarness(options: Readonly<{ httpsHome?: boolean; currentAccount?: boolean; e2ee?: boolean; originAtBirth?: boolean }> = {}) {
  // The real cold connection owner awaits its initial-sync budget. Frozen timers
  // cannot settle that budget when unrelated bootstrap endpoints are unavailable.
  vi.useRealTimers();
  const result = await setupHarness(options.currentAccount, options.e2ee, options.originAtBirth);
  let homeConnectionDescriptor: import('@happier-dev/protocol/auth/accountDirectory').HomeConnectionDescriptorV1 | undefined;
  if (options.httpsHome) {
    const { HomeConnectionDescriptorV1Schema } = await import('@happier-dev/protocol/auth/accountDirectory');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { adoptHomeProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(getActiveServerSnapshot().serverId);
    if (!profile) throw new Error('The synthetic Home must exist before descriptor adoption');
    homeConnectionDescriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1,
      homeServerIdentityId: profile.serverIdentityId ?? 'srv_approval_fixture', canonicalServerUrl: profile.serverUrl,
      revision: (profile.homeConnectionDescriptor?.revision ?? 0) + 1,
      endpoints: [{ kind: 'https', url: profile.serverUrl }],
    });
    await adoptHomeProfile({ source: 'manual', descriptor: homeConnectionDescriptor });
  }
  const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  // reset() already initialized Sync. Apply descriptor adoption through the
  // warm switch owner so it rebinds the Account scope as well as the carrier.
  await switchConnectionToActiveServer();
  const { storage } = await import('@/sync/domains/state/storageStore');
  const scope = storage.getState().profileScope!;
  if (options.httpsHome) {
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    expect(await resolveServerCredentialAccountScope(scope.serverId)).toMatchObject({ kind: 'bound', scope });
  }
  storage.getState().applySettings(storage.getState().settings, 1);
  // Match the already-hydrated projection to the Machine content served by HTTP.
  storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: options.e2ee ? 'e2ee' : 'plain', ...(options.originAtBirth ? {
    operationProtocolCapabilities: { sessionSpawnAuthoringOrigin: { protocolVersions: [1] } },
    operationProtocolCapabilitiesRevision: 1,
  } : {}) })], true, { sourceServerId: scope.serverId });
  // Accepted creation also hydrates the destination through the real request
  // owner. Keep its propagation/recovery timers running through completion.
  return { ...result, scope, homeConnectionDescriptor, get storageState() { return storage.getState(); } };
}

/** Current Account launches use the installed HTTP Action carrier, not raw spawn RPC. */
async function setupCurrentAccountSessionActionHarness(custodian?: Readonly<{ accountId: string; displayName: string }>) {
  await selectNewSessionTestHome();
  const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
  const identified = await setServerProfileIdentityForUrl('https://server-a', 'srv_session_fixture');
  if (!identified) throw new Error('The synthetic Home identity must be established before Account restore');
  const context = await setupTaskHarness({ currentAccount: true });
  const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
  const profile = getServerProfileById(context.scope.serverId);
  if (!profile?.serverIdentityId) throw new Error('The synthetic Home must have its published identity');
  const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
  const boundary = await createExternalActionAccountHttpBoundary({
    serverUrl: profile.serverUrl, serverIdentityId: profile.serverIdentityId, accountId: context.scope.accountId,
    machineId: 'm1', actionId: 'session.spawn_new', tokenEpoch: 0, ...(custodian ? { custodian } : {}),
    execute: input => context.sessionSpawnNewActionBoundarySpy(admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(input))),
  });
  context.additionalBoundary.http = (url, init) => boundary.handle(url, init);
  return { ...context, machineAccess: boundary.machine.access };
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

async function setupApprovalAttachmentLaunch() {
  let phase = 'restore Account';
  const observedHttpPaths: string[] = [];
  const observedRpcMethods: string[] = [];
  onTestFailed(() => console.error('Attachment approval phase:', phase, 'HTTP paths:', [...new Set(observedHttpPaths)], 'RPC methods:', [...new Set(observedRpcMethods)]));
  const context = await setupTaskHarness({ httpsHome: true });
  spawnActionObservation.mockClear();
  scopedTransportObservation.mockClear();
  const actionFailures = async () => {
    const firstLine = (message: string) => message.split('\n')[0]!.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/header\.[\w-]+\.signature/g, '[redacted]');
    const results = await Promise.allSettled(spawnActionObservation.mock.results.map(result => result.value));
    return results.flatMap(result => result.status === 'fulfilled'
      ? result.value?.ok === false ? [{ code: result.value.errorCode, message: firstLine(result.value.error) }] : []
      : [{ code: 'thrown', message: result.reason instanceof Error ? firstLine(result.reason.message) : 'unknown' }]);
  };
  const transportObservations = async () => {
    const results = await Promise.allSettled(scopedTransportObservation.mock.results.map(result => result.value));
    const fact = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
    return scopedTransportObservation.mock.calls.map(([input], index) => {
      const descriptor = input.profile.homeConnectionDescriptor;
      const result = results[index];
      return { serverUrl: input.profile.serverUrl, canonicalServerUrl: input.profile.canonicalServerUrl,
        descriptorHomeId: descriptor?.homeServerIdentityId,
        endpoints: descriptor?.endpoints.map(endpoint => ({ kind: endpoint.kind,
          status: fact(Reflect.get(endpoint, 'status')), verified: fact(Reflect.get(endpoint, 'verified')),
          verification: fact(Reflect.get(endpoint, 'verification')) })),
        ...(result?.status === 'fulfilled' ? { carrier: result.value.carrier }
          : { refusal: result?.status === 'rejected' && result.reason instanceof Error ? result.reason.message.split('\n')[0] : 'unknown' }),
      };
    });
  };
  const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
  const profile = getServerProfileById(context.scope.serverId);
  if (!profile) throw new Error('The adopted synthetic Home must remain addressable');
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
  if (!credentials) throw new Error('The adopted synthetic Home must retain its Account credentials');
  const { resolveServerScopedTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport');
  const transport = await resolveServerScopedTransport({ profile, credentials });
  expect(transport.carrier, JSON.stringify({ endpointKinds: profile.homeConnectionDescriptor?.endpoints.map(endpoint => endpoint.kind),
    descriptorProvenance: profile.descriptorProvenance ?? 'established' })).toBe('https');
  await transport.release();
  phase = 'load composed owners';
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
  const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
  const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
  const [
    { useNewSessionActionOperationReconciliation },
    { useNewSessionAttachmentsController },
    { useNewSessionComposerDocument },
    { createArtifactStoreBoundary },
    { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope },
  ] = approvalAttachmentModules;
  const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
  const { encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { encodePlainMachineStoredContent } = await import('@happier-dev/protocol/machines/machineStoredContent');
  const [{ buildApprovalRequestArtifactHeaderV1}, { ApprovalRequestV2Schema}] = await Promise.all([import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1'), import('@happier-dev/protocol/approvals/approvalRequestV1')]);
  const { PreparedTransferRpcRequestV1Schema } = await import('@happier-dev/protocol/machines/transfer/preparedTransferRpcV1');
  const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
  const { writeNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts } = await import('@/components/sessions/new/attachments/newSessionAttachmentDraftStore');
  const draftId = `approval-attachment-draft-${++approvalAttachmentCase}`;
  const flowId = `approval-attachment-flow-${context.scope.serverId}-${approvalAttachmentCase}`;
  const selectedPath = `/tmp/${draftId}`;
  const promptStore = createNewSessionPromptStore('Inspect the attached note');
  writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: promptStore.getPrompt() }, materializationIntent: 'userEdit' });
  writeNewSessionAttachmentDrafts(flowId, [{ id: 'note-file', source: { kind: 'memory', name: 'note.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello') }, status: 'pending' }]);
  const features = createRootLayoutFeaturesResponse({ homeConnectionDescriptor: context.homeConnectionDescriptor,
    capabilities: { serverIdentity: { serverIdentityId: context.homeConnectionDescriptor!.homeServerIdentityId },
      session: { ...DEFAULT_SESSION_CAPABILITIES, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
      server: { canonicalServerUrl: profile.serverUrl } } });
  if (!tryWriteServerEnabledBitInPlace(features, 'machines.transfer', true)) throw new Error('Missing Machine transfer feature');
  if (!tryWriteServerEnabledBitInPlace(features, 'attachments.uploads', true)) throw new Error('Missing attachment upload feature');
  const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['ui'] } } });
  const settingsSnapshot = { ...storage.getState().settings, actionsSettingsV1, experiments: true,
    featureToggles: { ...storage.getState().settings.featureToggles, 'attachments.uploads': true } };
  storage.getState().applySettingsLocal(settingsSnapshot);
  const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => context.scope.accountId, encryptionMode: 'plain' });
  const uploadedBytes: number[] = [];
  const submittedMessages: unknown[] = [];
  const recipient = createTransferRecipientKeyPair();
  const machine = createMachineFixture({ id: 'm1', daemonState: { status: 'running', transfer: {
    supported: { import: true, export: true },
    listenerClasses: { loopback_http: { enabled: false, configured: false, active: false }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
  } } });
  const machineRow = { ...createPlainMachineRowFixture({ id: 'm1', accountId: context.scope.accountId }),
    metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState) };
  const approvedSessionRecord = () => createPlainSessionCurrentProjectionRecordFixture({ id: 'approved-note-session',
    metadata: { path: selectedPath, host: 'test', machineId: 'm1' } });
  context.additionalBoundary.http = async (url, init) => {
    observedHttpPaths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const artifactResponse = await artifacts.handle(`${url.pathname}${url.search}`, init);
    if (artifactResponse) return artifactResponse;
    if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
    if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settingsSnapshot }, version: 1 });
    if (url.pathname === '/v1/machines') return Response.json([machineRow]);
    if (url.pathname === '/v1/machines/m1') return Response.json({ machine: machineRow });
    // /active is a list resource, not a Session id. The generic detail fixture
    // would otherwise answer 503 and mark this healthy synthetic Home offline.
    if (url.pathname === '/v2/sessions/active') return Response.json(createSessionListSourceFixture({
      sessions: storage.getState().sessions['approved-note-session'] ? [approvedSessionRecord()] : [],
      nextCursor: null, hasNext: false,
    }));
    if (url.pathname === '/v2/sessions/approved-note-session') return Response.json({
      session: approvedSessionRecord(),
    });
    if (url.pathname.endsWith('/pending') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { localId: string; requestedAction: unknown; content: unknown };
      submittedMessages.push(body);
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId }, didWrite: true });
    }
    if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingCount: 0 });
    return null;
  };
  phase = 'admit server features';
  await getReadyServerFeatures({ serverId: context.scope.serverId, force: true });
  storage.getState().applyMachines([machine], true, { sourceServerId: context.scope.serverId });
  context.additionalBoundary.rpc = async (method, input) => {
    observedRpcMethods.push(method);
    if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) return {
      success: true, uploadId: 'approval-note-upload', destDisplayPath: '.happier/uploads/note.txt', expectedSizeBytes: 5,
      chunkSizeBytes: 2, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt: Date.now() + 60_000,
      endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/approval-note-upload', expiresAt: Date.now() + 60_000 }],
    };
    if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
      const phase = PreparedTransferRpcRequestV1Schema.parse(input);
      const index = Number(phase.path.split('/').at(-1));
      const chunk = phase.body;
      if (!chunk || typeof chunk !== 'object' || !('payloadBase64' in chunk) || !('encryptedDataKeyEnvelopeBase64' in chunk)
        || typeof chunk.payloadBase64 !== 'string' || typeof chunk.encryptedDataKeyEnvelopeBase64 !== 'string') throw new Error('Invalid encrypted upload chunk');
      uploadedBytes.push(...await decryptEncryptedTransferChunkEnvelope({ transferId: 'approval-note-upload', sequence: index,
        payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64, recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) };
    }
    if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) return { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true,
      finalized: { success: true, path: '.happier/uploads/note.txt', sizeBytes: 5 }, sha256: 'note-sha256' }) };
    if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT) return { success: true, aborted: true };
    return undefined;
  };
  let requestId: string | null = null;
  const settlement = vi.fn();
  const router = { push: vi.fn(), replace: vi.fn() };
  const disableDraftPersistence = vi.fn();
  const emptyAttachments: readonly import('@happier-dev/protocol/runtime/input/composerAttachmentV1').ComposerAttachmentDraftV1[] = [];
  const emptyEntries = {};
  const canSubmitRef = { current: true };
  let creationSettled = false;
  phase = 'render composed owners';
  const hook = await renderHook(() => {
    const [isCreating, setIsCreating] = React.useState(false);
    const [launchRequestId, setLaunchRequestId] = React.useState<string | null>(null);
    const reconciliation = useNewSessionActionOperationReconciliation({ draftId, draftScope: context.scope, requestId: launchRequestId,
      localCreationInFlight: isCreating, disableDraftPersistence, resetLaunchRequestId: setLaunchRequestId, router });
    const composerDocument = useNewSessionComposerDocument({ draftId, draftScope: context.scope, promptStore,
      persistedAttachments: emptyAttachments, composerAttachmentEntriesById: emptyEntries,
      scopeKey: `approval:${context.scope.serverId}:${context.scope.accountId}`, canSubmitRef, isSubmitting: isCreating });
    const creator = context.useCreateNewSession(createRetryParams(storage.getState().settings, {
      draftId, draftScope: context.scope, targetServerId: context.scope.serverId, allowedTargetServerIds: [context.scope.serverId],
      launchIntentSignature: draftId,
      selectedPath,
      selectedMachine: machine, promptStore, router, setIsCreating,
      onLaunchUserAttemptIdChange: id => { requestId = id; setLaunchRequestId(id); },
      onLaunchApprovalPending: reconciliation.launchApproval.request,
    }));
    const attachments = useNewSessionAttachmentsController({ flowId, isCreating, promptStore,
      selectedProfileId: null, selectedMachineId: 'm1', targetServerId: context.scope.serverId, selectedPath, composerDocument,
      handleCreateSession: opts => {
        creator.handleCreateSession({ ...opts, onAfterCreatedSettled: value => {
          creationSettled = true;
          settlement(value);
          opts?.onAfterCreatedSettled?.(value);
        } });
      },
    });
    return { attachments, reconciliation, composerDocument, isCreating };
  });
  phase = 'submit attachment';
  await act(async () => {
    hook.getCurrent().attachments.handleSend();
    await flushHookEffects({ cycles: 8, turns: 4 });
  });
  phase = 'await real Ask Artifact';
  await vi.waitFor(async () => expect(artifacts.list().length, JSON.stringify({
    actionFailures: await actionFailures(),
    transportObservations: await transportObservations(),
    alerts: context.modalAlertSpy.mock.calls,
    rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]),
    documentAvailable: hook.getCurrent().composerDocument.readCurrentDocumentSnapshot() !== null,
    attachmentsEnabled: hook.getCurrent().attachments.attachmentsUploadsEnabled,
    endpoint: { status: storage.getState().endpointStatus, reason: storage.getState().endpointReason,
      message: storage.getState().endpointLastErrorMessage },
  })).toBe(1));
  const artifactId = artifacts.list()[0]!.id;
  const publishApproval = async (status: 'open' | 'executed' | 'rejected' | 'canceled') => {
    phase = `observe ${status} approval`;
    const original = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
    if (!requestId || original.executionOriginV1.requestId !== requestId) throw new Error('Approval must retain the actual submitted request');
    const request = ApprovalRequestV2Schema.parse({ ...original, status, updatedAtMs: Date.now(),
      ...(status === 'executed' ? { decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 2, ok: true,
        result: { ...spawnSuccess('approved-note-session'), executionTarget: { serverId: context.scope.serverId, machineId: 'm1' }, initialInput: { status: 'notRequested' } } } } : {}),
      ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
    });
    const stored = artifacts.read(artifactId)!;
    artifacts.replaceStoredRow({ ...stored, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), headerVersion: status === 'open' ? 1 : 2,
      bodyVersion: status === 'open' ? 1 : 2, updatedAt: Date.now() });
    await act(async () => {
      if (status === 'executed') storage.getState().applySessions([createSessionFixture({ id: 'approved-note-session', serverId: context.scope.serverId,
        metadata: { path: selectedPath, host: 'test', machineId: 'm1' }, encryptionMode: 'plain' })]);
      storage.getState().updateArtifact({ id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: status === 'open' ? 1 : 2, bodyVersion: status === 'open' ? 1 : 2, seq: 1, createdAt: 1, updatedAt: Date.now(), isDecrypted: true });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
  };
  await publishApproval('open');
  phase = 'approval pending';
  return { ...context, artifactId, hook, settlement, router, uploadedBytes, submittedMessages, publishApproval, observedRpcMethods,
    draftSnapshot: () => getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }),
    fileDrafts: () => readNewSessionAttachmentDrafts(flowId),
    get creationSettled() { return creationSettled; },
    waitForCreation: async () => {
      await vi.waitFor(() => expect(creationSettled, JSON.stringify({ phase, uploadedBytes: uploadedBytes.length,
        submittedMessages: submittedMessages.length, settlements: settlement.mock.calls, alerts: context.modalAlertSpy.mock.calls,
        rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]) })).toBe(true));
    },
  };
}

describe('useCreateNewSession (daemon unavailable UX)', () => {
  beforeAll(async () => {
    // beforeAll precedes the package's per-test browser Storage installation.
    browserStorageBoundary = installLocalStorageMock();
    actionHomesBoundary = await serveActionHomes({ homes: [{ key: 'task', serverUrl: 'https://server-a', accountId: 'account-a' }], route: () => undefined });
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
  });
  afterAll(async () => {
    await actionHomesBoundary?.dispose();
    browserStorageBoundary?.restore();
    syncSingletonBridge.current = null;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    // Launches use real asynchronous batch dispatch; only the asserted clock is synthetic.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(async () => {
    await standardCleanup();
    await harness?.disposeAuth();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('requires vendor consent before first Session readiness and restores the editable draft when declined', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupCurrentAccountSessionActionHarness();
    const { Modal } = await import('@/modal');
    const confirm = vi.mocked(Modal.confirm);
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { useNewSessionComposerDocument } = approvalAttachmentModules[2];
    const draftId = 'canceled-vendor-consent';
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Read this project' }, materializationIntent: 'userEdit' });
    const promptStore = createNewSessionPromptStore('Read this project');
    const persistedAttachments: readonly import('@happier-dev/protocol/runtime/input/composerAttachmentV1').ComposerAttachmentDraftV1[] = [];
    const composerAttachmentEntriesById = {};
    const canSubmitRef = { current: true };
    const hook = await renderHook(() => {
      const [isCreating, setIsCreating] = React.useState(false);
      const composerDocument = useNewSessionComposerDocument({
        draftId, draftScope: scope, promptStore, persistedAttachments, composerAttachmentEntriesById,
        scopeKey: `consent:${scope.serverId}:${scope.accountId}`, canSubmitRef, isSubmitting: isCreating,
      });
      const creator = useCreateNewSession(createRetryParams(storageState.settings, {
        agentType: 'claude', modelMode: 'claude-haiku-4-5', promptStore, draftId, draftScope: scope,
        targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId], setIsCreating,
      }));
      return { ...creator, isCreating, composerDocument };
    });
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
      expect(confirm, JSON.stringify({ alerts: modalAlertSpy.mock.calls, spawnCount: sessionSpawnNewActionBoundarySpy.mock.calls.length })).toHaveBeenCalledTimes(1);
      expect(hook.getCurrent().isCreating, 'Cancel must unlock the New Session composer').toBe(false);
      expect(hook.getCurrent().composerDocument.readCurrentDocumentSnapshot()).toMatchObject({
        text: 'Read this project', state: { editable: true, submitting: false, submittable: true },
      });
      expect(promptStore.getPrompt()).toBe('Read this project');
      expect(readDraftComposerText(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))).toBe('Read this project');
      promptStore.setPrompt('Read this project and explain it');
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).toMatchObject({
        agentInstallConsent: { vendorRecipe: true },
      });
    } finally {
      await hook.unmount();
    }
  });

  it.each(['pending', 'failed'] as const)('creates the Session and shows the optional Agent update notice (%s)', async status => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupCurrentAccountSessionActionHarness();
    const sessionId = `session-update-${status}`;
    storageState.applySessions([createSessionFixture({ id: sessionId, serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ ...spawnSuccess(sessionId),
      executionTarget: { serverId: scope.serverId, machineId: 'm1' }, agentUpdate: { agentId: 'codex', status } });
    const router = { push: vi.fn(), replace: vi.fn() };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      router, draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
    })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/session/${sessionId}?serverId=${scope.serverId}`, expect.anything()));
      expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
      expect(modalAlertSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    } finally { await hook.unmount(); }
  });

  it('starts a current vendor Agent without install consent', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, scope, modalAlertSpy, machineAccess } = await setupCurrentAccountSessionActionHarness({ accountId: 'machine-owner', displayName: 'Alex' });
    const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
    const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
    const { Modal } = await import('@/modal');
    const key = serverAccountScopedResourceKey(scope, 'machine-agents', 'm1');
    const item = { agentId: 'claude', title: 'Claude', installed: true, version: '2.0.0', latestVersion: '2.0.0',
      update: { supported: true, command: null }, signIn: { status: 'signedIn' as const, loginSupport: 'login_terminal' as const },
      platform: { supported: true as const }, install: { available: true, mode: 'vendor_recipe' as const, sizeBytes: null, guideUrl: null }, dependencies: [] };
    machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: Date.now() });
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      agentType: 'claude', selectedMachine: createMachineFixture({ id: 'm1', access: machineAccess }),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
    })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(Modal.confirm).not.toHaveBeenCalled();
      expect(sessionSpawnNewActionBoundarySpy, JSON.stringify(modalAlertSpy.mock.calls)).toHaveBeenCalled();
      expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].agentInstallConsent).toBeUndefined();
    } finally {
      await hook.unmount();
      machineAgentInventoryStore.publish(key, { status: 'idle', items: [{ ...item, installed: false }], lastCheckedAt: null });
    }
  });

  it('completes the retained attachment and first turn only after the launch approval executes', async () => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.hook.getCurrent().attachments.attachmentsUploadsEnabled).toBe(true);
    expect(launch.hook.getCurrent().reconciliation.launchApproval.pending?.artifactId).toBe(launch.artifactId);
    expect(launch.hook.getCurrent().isCreating, 'The retained local launch owns completion while approval is pending').toBe(true);
    expect(launch.creationSettled).toBe(false);
    expect(launch.settlement).not.toHaveBeenCalled();
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    await launch.publishApproval('executed');
    await launch.waitForCreation();
    await vi.waitFor(() => expect(launch.settlement, JSON.stringify({ alerts: launch.modalAlertSpy.mock.calls,
      rpcMethods: launch.observedRpcMethods, uploadedBytes: launch.uploadedBytes.length,
      submittedMessages: launch.submittedMessages.length })).toHaveBeenCalledWith({ status: 'accepted', sessionId: 'approved-note-session' }));
    expect(launch.uploadedBytes).toEqual([...new TextEncoder().encode('hello')]);
    expect(launch.submittedMessages).toEqual([expect.objectContaining({ content: expect.objectContaining({
      t: 'plain', v: expect.objectContaining({
        content: { type: 'text', text: 'Inspect the attached note' },
        meta: expect.objectContaining({ happier: { kind: 'attachments.v1', payload: {
          attachments: [expect.objectContaining({ id: 'note-file', path: '.happier/uploads/note.txt', name: 'note.txt', sizeBytes: 5 })],
        } } }),
      }),
    }) })]);
    await vi.waitFor(() => expect(readDraftComposerText(launch.draftSnapshot()) ?? '').toBe(''));
    expect(launch.fileDrafts()).toEqual([]);
    // The approver already created the Session elsewhere; this origin never spawns it again.
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    await launch.hook.unmount();
  });

  it.each(['rejected', 'canceled'] as const)('keeps the submitted attachment draft after its launch approval is %s', async status => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.settlement).not.toHaveBeenCalled();
    await launch.publishApproval(status);
    await launch.waitForCreation();
    expect(launch.settlement).toHaveBeenCalledWith({ status: 'rejected' });
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    expect(launch.fileDrafts()).toHaveLength(1);
    expect(launch.router.replace).not.toHaveBeenCalled();
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    await launch.hook.unmount();
  });

  it('releases the pending attachment launch when its original surface unmounts', async () => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.creationSettled).toBe(false);
    await launch.hook.unmount();
    await vi.waitFor(() => expect(launch.creationSettled).toBe(true));
    await launch.publishApproval('executed');
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    expect(launch.fileDrafts()).toHaveLength(1);
    expect(launch.router.replace).not.toHaveBeenCalled();
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
  });

  it('commits submitted authoring before capturing launch revisions and keeps later edits after completion', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, scope } = await setupTaskHarness();
    const { writeNewSessionAuthoringDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftId = 'submitted-selections-draft';
    const submitted = {
      input: '', selectedMachineId: 'm1', selectedPath: '/submitted', targetServerId: scope.serverId,
      selectedProfileId: null, selectedSecretId: null, agentType: 'codex', permissionMode: 'read-only',
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.5' }, updatedAt: 10 },
      acpSessionModeId: null, updatedAt: Date.now(),
    } satisfies import('@/sync/domains/state/persistence').NewSessionDraft;
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Original draft' }, materializationIntent: 'userEdit' });
    writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...submitted, selectedPath: '/older', permissionMode: 'default', modelSelection: null } });
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.selectedPath).toBe('/older');
    const creation = createDeferred<void>();
    const enteredSpawn = createDeferred<void>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      enteredSpawn.resolve(undefined);
      await creation.promise;
      harness.storageState.applySessions([createSessionFixture({ id: 'submitted-session', serverId: scope.serverId, encryptionMode: 'plain' })]);
      return { ...spawnSuccess('submitted-session'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } };
    });
    const params = createRetryParams(storageState.settings, {
      draftId, draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      selectedPath: submitted.selectedPath, permissionMode: submitted.permissionMode,
      modelMode: submitted.modelSelection.ref.modelId,
      flushAuthoringDraft: () => writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: submitted }),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const settled = createDeferred<void>();
    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', onAfterCreatedSettled: () => settled.resolve(undefined) });
      await enteredSpawn.promise;
    });
    expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
      selectedPath: submitted.selectedPath, permissionMode: submitted.permissionMode, modelSelection: submitted.modelSelection,
    });
    // A later text edit is a successor, whereas the submitted selection fields
    // must be cleared with the accepted launch, not misclassified as successors.
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Follow up after launch' }, materializationIntent: 'userEdit' });
    creation.resolve(undefined);
    // Acceptance is reported before the launch owner finishes revision-safe clearing.
    await act(async () => { await createPromise; });
    await settled.promise;
    const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
    expect(readDraftComposerText(snapshot)).toBe('Follow up after launch');
    if (snapshot?.document.target.kind !== 'newSession') throw new Error('Expected successor draft');
    expect(snapshot.document.target.authoring).not.toHaveProperty('directory');
    expect(snapshot.document.target.authoring).not.toHaveProperty('permissionMode');
    expect(snapshot.document.target.authoring).not.toHaveProperty('modelSelection');
    await hook.unmount();
  });

  it('ignores retired Zen launch metadata and leaves task links with the Tasks orchestrator', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, todoKv, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const source = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const draftId = seedNewSessionDraftV1({
      scope, seed: { prompt: { text: 'Fix task', mode: 'replace' },
        placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'm1', directory: '/tmp' } },
      createDraftId: () => 'retired-task-draft',
    })!;
    storage.setState({ sessions: { ...storage.getState().sessions, 'task-session': createSessionFixture({ id: 'task-session', serverId: scope.serverId }) } });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ ...spawnSuccess('task-session'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    const params = createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore('Fix task'),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      // Retained callers cannot revive the retired task-specific completion path.
      ...{ zenTaskSource: source }, targetAccountScope: scope,
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const afterCreated = vi.fn(async () => {});
    await act(async () => { await hook.getCurrent().handleCreateSession({ afterCreated }); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(todoKv.writes).toEqual([]);
    expect(storage.getState().todoState!.todos['task-1']).not.toHaveProperty('linkedSessions');
    expect(afterCreated).toHaveBeenCalledTimes(1);
    await expectSubmittedDraftRetired(scope, draftId);
    await hook.unmount();
  });

  it('refuses a deleted task or a foreign Account/Home instead of recreating or retargeting it', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { linkTaskToSession } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { taskId: 'deleted', scope, title: 'Deleted task' } as const;
    const link = { source, session: { scope, sessionId: 'accepted-session' } };
    // The new link contract is an intent, not a replacement map.
    const linkIntent = linkTaskToSession;
    await expect(linkIntent(link)).rejects.toMatchObject({ code: 'task_deleted' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, accountId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, serverId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    expect(todoKv.writes).toEqual([]);
  });

  it('retries a Temporary-computer follow-up without reviving retired task linking or another activation', async () => {
    const { useCreateNewSession, todoKv, scope, storageState, sessionSpawnNewActionBoundarySpy } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
    const source = { kind: 'zen_task', taskId: 'temporary-task', title: 'Temporary task', scope } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    const draftId = seedNewSessionDraftV1({ scope, seed: { prompt: { text: todo.title, mode: 'replace' } }, createDraftId: () => 'temporary-task-draft' })!;
    storage.setState({ sessions: { ...storage.getState().sessions, 'temporary-session': createSessionFixture({ id: 'temporary-session', serverId: scope.serverId }) } });
    const settlements: Array<import('./useCreateNewSession').TemporaryComputerCreatorSettlement> = [];
    const params = createRetryParams(storageState.settings, {
      draftScope: scope, draftId, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      temporaryComputerTargetScope: scope,
      ...{ zenTaskSource: source }, targetAccountScope: scope,
      authoringDraft: buildNewSessionAuthoringDraftFromResolvedInputs({
        executionTarget: { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } },
        directory: '', prompt: todo.title, connectedServices: null,
      }),
      // Remote activation settles later. Exercise the actual accepted-Session
      // settlement port rather than substituting completion or task logic.
      temporaryComputerLaunch: async (_submission, settlement) => { settlements.push(settlement); },
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const afterCreated = vi.fn(async () => {}).mockRejectedValueOnce(new Error('follow_up_unavailable'));
    await act(async () => {
      await hook.getCurrent().handleCreateSession({
        afterCreated,
        temporaryComputerSubmission: {
          composer: {
            revision: 1, ref: { kind: 'newSession', instanceId: draftId }, text: todo.title,
            references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
          },
          reviewComments: null, attachmentDrafts: [],
          attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
          maxFileBytes: 1024,
        },
      });
    });
    expect(settlements).toHaveLength(1);
    await act(async () => {
      await expect(settlements[0]!.complete('temporary-session', [])).rejects.toMatchObject({ stage: 'follow_up' });
    });
    expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toBeNull();
    expect(todoKv.writes).toEqual([]);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe(todo.title);
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(todoKv.writes).toEqual([]);
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(todoKv.writes).toEqual([]);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'temporary-session', sessionTarget: { ...scope, sessionId: 'temporary-session' },
    }));
    expect(settlements).toHaveLength(1);
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    // No successor edits exist, so acceptance retires the submitted authoring draft.
    await expectSubmittedDraftRetired(scope, draftId);
    await hook.unmount();
  });

  it('keeps same-id Sessions on different Homes distinct and makes repeated link acceptance a no-op', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { taskId: 'task-1', scope, title: 'Task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const input = { source, session: { scope, sessionId: 'same-id' } };
    const linkIntent = linkTaskToSession;
    await linkIntent(input);
    await linkIntent({ ...input, session: { scope: { serverId: 'server-b', accountId: 'account-b' }, sessionId: 'same-id' } });
    const before = todoKv.items.get('todo.task-1');
    const writeCount = todoKv.writes.length;
    await linkIntent(input);
    expect(todoKv.items.get('todo.task-1')).toEqual(before);
    expect(todoKv.writes).toHaveLength(writeCount);
    expect(getSessionsForTask('task-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...scope, sessionId: 'same-id' }),
      expect.objectContaining({ serverId: 'server-b', accountId: 'account-b', sessionId: 'same-id' }),
    ]));
  });

  it('links E2EE tasks with real Account crypto and rejects mode mismatches before writing', async () => {
    const { todoKv, scope } = await setupTaskHarness({ e2ee: true });
    const { sync } = await import('@/sync/syncEngine');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { taskId: 'e2ee-task', scope, title: 'Private task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    // Raw ciphertext is the pinned 0.2-produced reader input; the real codec owns new writes.
    todoKv.items.set('todo.e2ee-task', { key: 'todo.e2ee-task', value: await sync.encryption!.encryptRaw(todo), version: 1 });
    await linkTaskToSession({ source, session: { scope, sessionId: 'private-session' } });
    const row = todoKv.items.get('todo.e2ee-task')!;
    expect(row.value).not.toContain(source.title);
    expect(await sync.encryption!.decryptRaw(row.value)).toMatchObject({ done: false });
    expect(getSessionsForTask(todo.id)).toEqual([expect.objectContaining({ ...scope, sessionId: 'private-session' })]);
    const writes = todoKv.writes.length;
    todoKv.items.set(row.key, { ...row, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }) });
    await expect(linkTaskToSession({ source, session: { scope, sessionId: 'another' } })).rejects.toMatchObject({ code: 'task_link_failed', cause: { code: 'todo_stored_content_unavailable', reason: 'account_mode_mismatch' } });
    expect(todoKv.writes).toHaveLength(writes);
  });

  it('retries the same creation identity from the daemon-unavailable Retry action', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const params = createRetryParams(storageState.settings);
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    const retry = alertRetry(modalAlertSpy);
    // The daemon rejects a reused Action request id whose input differs, so a
    // later retry of the same attempt must replay byte-identical input.
    vi.setSystemTime(new Date('2026-02-05T00:05:00.000Z'));
    await act(async () => { retry(); });
    await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2));
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
    await hook.unmount();
  });

  it('retains Provider launch errors and their explicit retry alongside Profile refusal presentation', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState, scope } = await setupTaskHarness({ httpsHome: true });
    const { createProviderErrorV1 } = await import('@happier-dev/protocol/providers/errors');
    const providerError = createProviderErrorV1('provider_not_enabled_on_machine');
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'spawn_failed', retryable: false, providerError });
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, { draftScope: scope,
      targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId] })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy.mock.calls, JSON.stringify(modalAlertSpy.mock.calls)).not.toHaveLength(0);
      await vi.waitFor(() => expect(hook.getCurrent().providerLaunchError).toEqual(providerError));
      await act(async () => { hook.getCurrent().retryProviderLaunch(); });
      await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(hook.getCurrent().providerLaunchError).toEqual(providerError));
    } finally { await hook.unmount(); }
  });

  it('retains a refused remembered Profile on its draft until the Profile or target changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, additionalBoundary, storageState, scope } = await setupTaskHarness({ httpsHome: true });
    const { SessionSpawnNewResultV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { sync } = await import('@/sync/sync');
    const { AIBackendProfileSchema } = await import('@/sync/domains/profiles/profileCompatibility');
    const profileId = 'remembered-refused-profile';
    const profile = AIBackendProfileSchema.parse({ id: profileId, name: 'Remembered Profile',
      compatibility: { codex: true }, createdAt: 1, updatedAt: 1 });
    const profileMap = new Map([[profileId, profile]]);
    const { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRowsListResponseV1Schema,
      ProfileReferenceGuardReadResponseV1Schema } = await import('@happier-dev/protocol/profiles/profileRecordV1');
    const { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } = await import('@happier-dev/protocol/profiles/profileTransferV1');
    const transferControl = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: {
      v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [],
    } } });
    const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
    // Real Profile admission reads the Account catalog before sending to the daemon.
    additionalBoundary.http = async (url, init) => {
      const artifactResponse = await artifacts.handle(`${url.pathname}${url.search}`, init);
      if (artifactResponse) return artifactResponse;
      if (url.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json(transferControl);
      if (url.pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json(ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 'absent' }));
      if (url.pathname !== PROFILE_ROWS_ROUTE_V1) return null;
      return Response.json(ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ id: profileId, revision: 1,
        content: { t: 'plain', v: { v: 1, id: profileId, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {},
          definition: { kind: 'legacy', profile } } } }], nextCursor: null, complete: true,
        referenceGuardRevision: 'absent', transferControl, diagnostics: [] }));
    };
    await sync.applyAuthoringMemoryDelta({ lastUsedProfile: profileId }, {
      expectedSettingsScope: scope,
    });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiProfileActionExecuteV1 } = await import('@/sync/ops/actions/profileActionDeps');
    const { parseProfileActionRequestV1 } = await import('@happier-dev/protocol/profiles/profileActionsV1');
    const account = await captureLazyActionAccountContext(scope.serverId);
    try {
      const profileRead = await createUiProfileActionExecuteV1(account)(parseProfileActionRequestV1('launch_profiles.read', { id: profileId }), {});
      expect(profileRead, JSON.stringify(profileRead))
        .toMatchObject({ ok: true, result: { status: 'present' } });
    } finally { account.dispose(); }
    const refusal = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code: 'profile_launch_unavailable', message: 'The selected Profile changed.',
        profileRefusal: { profileId, reason: 'profile_overlay_mismatch' } },
    });
    if (refusal.type !== 'error') throw new Error('Expected Profile refusal fixture');
    sessionSpawnNewActionBoundarySpy.mockResolvedValue(refusal);
    let selectedProfileId: string | null = profileId;
    let selectedMachineId = 'm1';
    let modelMode: ModelMode = 'default';
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      useProfiles: true, selectedProfileId, selectedMachineId, modelMode, profileMap, draftScope: scope,
      targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
    })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy.mock.calls, JSON.stringify(modalAlertSpy.mock.calls)).not.toHaveLength(0);
      await vi.waitFor(() => expect(hook.getCurrent().profileLaunchFailure?.profileId).toBe(profileId));
      expect(hook.getCurrent().profileLaunchFailure?.message).toContain('profile_overlay_mismatch');
      expect(storage.getState().authoringMemory.lastUsedProfile).toBe(profileId);
      const refusedSpawnCount = sessionSpawnNewActionBoundarySpy.mock.calls.length;
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(refusedSpawnCount);
      expect(hook.getCurrent().profileLaunchFailure?.profileId).toBe(profileId);

      modelMode = 'haiku';
      await hook.rerender();
      expect(hook.getCurrent().profileLaunchFailure?.profileId).toBe(profileId);

      profileMap.set(profileId, { ...profile, updatedAt: 2 });
      await hook.rerender();
      expect(hook.getCurrent().profileLaunchFailure).toBeNull();
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      await vi.waitFor(() => expect(hook.getCurrent().profileLaunchFailure?.profileId).toBe(profileId));

      await act(async () => { selectedProfileId = null; });
      await hook.rerender();
      expect(hook.getCurrent().profileLaunchFailure).toBeNull();
      expect(storage.getState().authoringMemory.lastUsedProfile).toBe(profileId);

      await act(async () => { selectedProfileId = profileId; });
      await hook.rerender();
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      await vi.waitFor(() => expect(hook.getCurrent().profileLaunchFailure?.profileId).toBe(profileId));
      await act(async () => { selectedMachineId = 'm2'; });
      await hook.rerender();
      expect(hook.getCurrent().profileLaunchFailure).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('creates a no-folder session: managed directory, no checkout, no recent folder written', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      // Accepted creation exposes the destination before the real route handoff.
      storage.getState().applySessions([
        createSessionFixture({ id: 'session-managed', serverId: 'server-a' }),
      ]);
      return spawnSuccess('session-managed');
    });
    const recentBefore = storageState.authoringMemory.recentMachinePaths;
    const params = createRetryParams(storageState.settings, {
      // The remembered folder and its checkout draft stay in the draft; neither reaches the spawn.
      selectedPath: '/tmp/remembered',
      directoryKind: 'managed',
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-x', baseRef: null },
      promptStore: createNewSessionPromptStore('Write a haiku'),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(modalAlertSpy.mock.calls.map((call) => call[1])).not.toContain('newSession.noPathSelected');
    const request = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(request?.directory).toEqual({ kind: 'managed' });
    expect(request?.checkoutCreationDraft ?? null).toBeNull();
    expect(storage.getState().authoringMemory.recentMachinePaths).toEqual(recentBefore);
    await hook.unmount();
  });

  it('replays the exact persisted attempt input after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'reload-retry-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Reload retry' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
    const paramsFor = (launchUserAttemptId: string | null) => createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Reload retry'),
      launchUserAttemptId,
    });

    const firstHook = await renderHook(() => useCreateNewSession(paramsFor(null)));
    await act(async () => { await firstHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await firstHook.unmount();

    vi.setSystemTime(new Date('2026-02-05T00:10:00.000Z'));
    const persistedAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    expect(persistedAttemptId).toBeTruthy();
    const reloadedHook = await renderHook(() => useCreateNewSession(paramsFor(persistedAttemptId)));
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
  });

  it('preserves the draft and gives host setup recovery for a non-retryable terminal-host failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-host-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Keep this draft' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'incompatible_target', retryable: false,
      terminalHostError: { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' } });
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore('Keep this draft'),
      spawnBackendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'newSession.terminalHostUnavailableTitle', 'newSession.terminalHostUnavailableBody',
    ]);
    expect(readDraftComposerText(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId }))).toBe('Keep this draft');
    await hook.unmount();
  });

  it('mints a fresh attempt after a terminal spawn failure, in place and after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-failure-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Terminal failure' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'spawn_failed', retryable: false });
    let durableUserAttemptId: string | null = null;
    const createHook = () => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Terminal failure'),
      launchUserAttemptId: durableUserAttemptId,
      onLaunchUserAttemptIdChange: (next) => { durableUserAttemptId = next; },
    }));
    const creationKeyAt = (index: number) => sessionSpawnNewActionBoundarySpy.mock.calls[index]?.[0].creationKey;

    const hook = await renderHook(createHook);
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.rerender();
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.unmount();

    durableUserAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    const reloadedHook = await renderHook(createHook);
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(3);
    expect(new Set([creationKeyAt(0), creationKeyAt(1), creationKeyAt(2)]).size).toBe(3);
  });

  it('invalidates daemon-unavailable Retry after Home, Account, Machine, path, or launch intent changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const changes = [
      ['Home', { targetServerId: 'server-b', draftScope: { serverId: 'server-b', accountId: 'account-a' } }],
      ['Account', { draftScope: { serverId: 'server-a', accountId: 'account-b' } }],
      ['Machine', { selectedMachineId: 'm2', selectedMachine: createMachineFixture({ id: 'm2' }) }],
      ['path', { selectedPath: '/other' }],
      ['launch intent', { launchIntentSignature: 'changed-intent' }],
    ] satisfies ReadonlyArray<readonly [string, Partial<CreateSessionParams>]>;
    for (const [name, overrides] of changes) {
      sessionSpawnNewActionBoundarySpy.mockClear();
      modalAlertSpy.mockClear();
      const initial = createRetryParams(storageState.settings);
      const hook = await renderHook((params: CreateSessionParams) => useCreateNewSession(params), { initialProps: initial });
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      const retry = alertRetry(modalAlertSpy);
      await hook.rerender({ ...initial, ...overrides });
      await act(async () => { retry(); });
      await flushHookEffects({ cycles: 8, turns: 4 });
      expect(sessionSpawnNewActionBoundarySpy, name).toHaveBeenCalledTimes(1);
      await hook.unmount();
    }
  });

  it('offers manual Retry for a typed daemon-unavailable Action without automatically retrying', async () => {
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(modalAlertSpy).toHaveBeenCalled();
    const args = modalAlertSpy.mock.calls[0] ?? [];
    expect(args).toEqual([
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    ]);
    await hook.unmount();
  });

  it('does not keep the single-flight guard latched after a local validation failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

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
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedMachineId: null as string | null } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

    await hook.rerender({ selectedMachineId: 'm1' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('uses the latest selectedPath immediately after a rerender (no stale ref window)', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

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
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
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
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/tmp' });

    await hook.unmount();
  });

  it('uses the latest requested path getter even before the committed selectedPath rerenders', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise!;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/home/happier/projects/subdir' });

    await hook.unmount();
  });

  it('does not automatically retry a typed Action rejection while offering explicit recovery', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();

    expect(modalAlertSpy).toHaveBeenCalledWith(
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    );

    await hook.unmount();
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry in the hook before showing the daemon-unavailable alert', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'error',
      code: 'machine_offline',
      retryable: true,
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });

  it('admits and projects the accepted first prompt before opening the created session route', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ ...spawnSuccess('session-created'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    const router = {
      push: vi.fn(),
      replace: vi.fn(() => {
        expect(storage.getState().sessionPending['session-created']?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ localId: 'input-session-created', text: 'Start here', deliveryStatus: 'accepted' }),
        ]));
      }),
    };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      router, promptStore: createNewSessionPromptStore('Start here'),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId], targetAccountScope: scope,
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).toMatchObject({
      creationKey: expect.stringMatching(/^manual:/), initialInput: { text: 'Start here' },
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it.each(['stable', 'newer-Session-push', 'e2ee-Codex-pool', 'e2ee-Codex-pool-birth'] as const)('L12-DEL-SMALL composes Project authoring through Send and cold created-Session hydration (%s)', async publication => {
    const e2ee = publication.startsWith('e2ee');
    const originAtBirth = publication === 'e2ee-Codex-pool-birth';
    const context = await setupTaskHarness({ httpsHome: true, currentAccount: true, e2ee, originAtBirth });
    spawnActionObservation.mockClear();
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const hydration = vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute');
    const rpcObservation = vi.spyOn(await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'), 'machineRpcWithServerScope');
    const { createProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
    const { WorkspaceRefV1WriteSchema } = await import('@happier-dev/protocol/workspaces/workspaceRefV1');
    const { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
    const { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } = await import('@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1');
    const { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { ProjectDefinitionInspectOutputSchema } = await import('@happier-dev/protocol/actions/projectDefinitionActionFamily');
    const { SessionAuthoringOpenResultV1Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { openProjectSetupAuthoring } = await import('@/components/projects/projectSetup/projectSetupAuthoring');
    const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const ref = WorkspaceRefV1WriteSchema.parse({ id: 'L12-DEL-SMALL-setup', serverId: context.scope.serverId,
      machineId: 'm1', rootPath: '/tmp/L12-DEL-SMALL-setup', createdAtMs: 1 });
    const workspace = { serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath };
    const projectRows = createPlainProjectAccountRowListFixture({ workspaceRefs: [ref] });
    if (e2ee) {
      const { createProjectAccountRowCipherV1 } = await import('@happier-dev/protocol/projects/projectAccountRowCipherV1');
      const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
        randomBytes: length => new Uint8Array(length).fill(9) });
      for (const row of projectRows.rows) {
        if (row.content?.t !== 'plain') throw new Error('Expected plain fixture payload before sealing');
        row.content = cipher.seal(row.content.v);
      }
    }
    let created: ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture> | null = null;
    let draftOrigin: import('@happier-dev/protocol/plugins/ui').PluginUiNewSessionSeedOriginV1 | undefined;
    let displayConflicts = 0;
    let racedPublication = false;
    context.additionalBoundary.http = async (url, init) => {
      if (url.pathname === '/v1/actions/projects.inspect') {
        const execution = { ok: true as const, result: ProjectDefinitionInspectOutputSchema.parse({
          definition: { basis: { kind: 'absent' }, document: null },
          detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }) };
        if (e2ee) {
          const { ExternalActionRequestEnvelopeV2Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
          const { openExternalActionRequestV2, prepareExternalActionResponseV2 } = await import('@happier-dev/protocol/actions/externalActionEncryption');
          const { Encryption } = await import('@/sync/encryption/encryption');
          const request = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
          const writer = await Encryption.create(new Uint8Array(32).fill(17));
          const material = { type: 'dataKey' as const, machineKey: writer.getContentPrivateKey() };
          const binding = { serverIdentityId: context.homeConnectionDescriptor!.homeServerIdentityId,
            accountId: context.scope.accountId, authentication: { kind: 'account' as const, tokenEpoch: 0 },
            actionId: 'projects.inspect' as const, requestId: request.requestId, target: request.target };
          expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).not.toBeNull();
          return Response.json(prepareExternalActionResponseV2({ binding, material, request, execution, executedMachineId: 'm1',
            randomBytes: length => new Uint8Array(length).fill(13) }).response);
        }
        const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
        return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect', requestId: request.requestId, execution }));
      }
      if (url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
        const value = { enabled: true, destination: { kind: 'machine', machineId: 'm1' }, unavailable: 'fail',
          allowAdHoc: false, scriptOverrides: {}, services: {} };
        if (!e2ee) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: value } });
        const { buildWorkspaceExecutionConfigRowIdV1, WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1 } =
          await import('@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1');
        const { sealAccountScopedBlobCiphertext } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
        return Response.json({ status: 'present', revision: 1, content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
          kind: WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1,
          material: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
          payload: { rowId: buildWorkspaceExecutionConfigRowIdV1({ serverId: workspace.serverId, refId: workspace.workspaceId }), value },
          randomBytes: length => new Uint8Array(length).fill(11),
        }) } });
      }
      if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(projectRows);
      if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/authoring-session`) return Response.json({ status: 'recorded',
        row: { ...projectRows.rows[0],
          authoringSession: { serverId: context.homeConnectionDescriptor!.homeServerIdentityId, sessionId: 'L12-DEL-SMALL-created' } } });
      if (url.pathname === '/v2/sessions/L12-DEL-SMALL-created' && created) {
        if (init?.method === 'PATCH') {
          if (e2ee) {
            const { SessionMetadataTuplePatchV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
            const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
            if (patch.mode !== 'owner') throw new Error('Expected owner metadata write');
            created = { ...created, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
              metadataVersion: created.metadataVersion + 1, agentState: patch.agentState.ciphertext,
              agentStateVersion: created.agentStateVersion + 1,
              ...(patch.displayProjectionV1 ? { displayProjectionV1: patch.displayProjectionV1 } : {}) };
            return Response.json({ success: true, metadataLayoutVersion: 1,
              sharedMetadata: { version: created.metadataVersion }, agentState: { version: created.agentStateVersion } });
          }
          displayConflicts++;
          return Response.json({ code: 'session_active' }, { status: 409 });
        }
        const response = Response.json({ session: created });
        if (publication === 'newer-Session-push' && hydration.mock.calls.length > 0 && !racedPublication) {
          racedPublication = true;
          // A real push may publish the native first turn's newer Session while
          // the already-issued route read is returning its older full snapshot.
          const metadata = { path: ref.rootPath, machineId: ref.machineId, host: 'worker',
            work: { authoringOriginV1: draftOrigin }, summary: { text: 'First turn completed', updatedAt: 2 } };
          created = createPlainSessionCurrentProjectionRecordFixture({ id: created.id, seq: created.seq + 1,
            updatedAt: created.updatedAt + 1, metadataVersion: created.metadataVersion + 1,
            active: true, metadata });
          storage.getState().applySessions([createSessionFixture({ id: created.id, serverId: context.scope.serverId,
            seq: created.seq, updatedAt: created.updatedAt, metadataVersion: created.metadataVersion,
            metadataLayoutVersion: 1, metadata: JSON.parse(created.metadata), ownerMetadataView: metadata })]);
        }
        return response;
      }
      return null;
    };
    context.additionalBoundary.rpc = async method => method === 'projects.worker.status'
      ? { eligible: true, candidate: { serverId: ref.serverId, machineId: ref.machineId }, load: { kind: 'unknown' }, explanation: 'load_unknown' }
      : undefined;
    storage.getState().activateProjectAccountRowsScope(context.scope);
    storage.getState().applyProjectAccountRowsForScope(context.scope, createProjectAccountRowsFixture(context.scope, { workspaceRefs: [ref] }));
    const opened = await openProjectSetupAuthoring({ workspace });
    if (!opened.ok) throw new Error(`${opened.errorCode}: ${opened.error}`);
    const acknowledgement = SessionAuthoringOpenResultV1Schema.parse(opened.result);
    if (acknowledgement.kind !== 'opened') throw new Error('Expected authoring draft');
    const draft = readNewSessionDraftProjectionFromRepository({ scope: context.scope, draftId: acknowledgement.draftId })?.draft;
    if (!draft) throw new Error('Expected real authoring draft');
    draftOrigin = draft.authoringOrigin;
    expect(context.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    let committed = createPlainSessionCurrentProjectionRecordFixture({ id: 'L12-DEL-SMALL-created', active: true,
      metadata: { path: ref.rootPath, machineId: ref.machineId, host: 'worker', work: { authoringOriginV1: draft.authoringOrigin } } });
    if (e2ee) {
      const { Encryption } = await import('@/sync/encryption/encryption');
      const { encodeBase64 } = await import('@/encryption/base64');
      const { sealEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
      const { sealSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
      const { createSessionOwnerMetadataV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
      const { SessionCurrentProjectionRecordV1Schema} = await import('@happier-dev/protocol/sessions/listing/response');
      const secret = new Uint8Array(32).fill(17);
      const dataKey = new Uint8Array(32).fill(8);
      const writer = await Encryption.create(secret);
      await writer.initializeSessions(new Map([[committed.id, dataKey]]));
      const cipher = writer.getSessionEncryption(committed.id)!;
      const owner = createSessionOwnerMetadataV1({ metadata: { path: ref.rootPath, machineId: ref.machineId,
        host: 'worker', work: { authoringOriginV1: draft.authoringOrigin } } });
      if (!owner.ok) throw new Error('Expected authoring owner metadata');
      committed = SessionCurrentProjectionRecordV1Schema.parse({ ...committed, encryptionMode: 'e2ee',
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: writer.contentDataKey,
          randomBytes: length => new Uint8Array(length).fill(3) })),
        metadata: await cipher.encryptRaw(JSON.parse(committed.metadata)),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
          ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(7) }),
      });
    }
    context.sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async input => {
      created = committed;
      return { ...spawnSuccess(created.id), executionTarget: input.executionTarget };
    });
    const router = { push: vi.fn(), replace: vi.fn() };
    const promptStore = createNewSessionPromptStore(draft.input);
    const hook = await renderHook(() => context.useCreateNewSession(createRetryParams(context.storageState.settings, {
      router, promptStore, draftId: acknowledgement.draftId, authoringOrigin: draft.authoringOrigin,
      selectedMachineId: ref.machineId, selectedPath: ref.rootPath,
      ...(originAtBirth ? { selectedMachine: createMachineFixture({ id: ref.machineId,
        operationProtocolCapabilities: { sessionSpawnAuthoringOrigin: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
      }) } : {}),
      backendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
      ...(e2ee ? { modelMode: 'gpt-6-luna', agentNewSessionOptions: { connectedServices: {
        v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'group', groupId: 'codex-pool',
        } },
      } } } : {}),
      draftScope: context.scope, targetServerId: context.scope.serverId, targetAccountScope: context.scope,
      allowedTargetServerIds: [context.scope.serverId],
    })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(context.sessionSpawnNewActionBoundarySpy, JSON.stringify({ alerts: context.modalAlertSpy.mock.calls,
        scope: storage.getState().profileScope, expectedScope: context.scope,
        spawn: await Promise.all(spawnActionObservation.mock.results.map(async result => {
          const value = await result.value;
          return value.ok ? { ok: true, result: value.result } : { code: value.errorCode };
        })),
        rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]),
        machineCapabilities: Object.fromEntries(Object.entries(storage.getState().machineListByServerId).map(([serverId, machines]) =>
          [serverId, machines.map(machine => ({ id: machine.id, capabilities: machine.operationProtocolCapabilities }))])),
        scopedRpc: await Promise.all(rpcObservation.mock.results.map(async result => {
          try { await result.value; return { ok: true }; }
          catch (error) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { type: typeof error }; }
        })),
      })).toHaveBeenCalledTimes(1);
      expect(context.modalAlertSpy.mock.calls, JSON.stringify(await Promise.all(hydration.mock.results.map(result => result.value)))).toEqual([]);
      expect(router.replace).toHaveBeenCalledTimes(1);
      const visible = storage.getState().sessions['L12-DEL-SMALL-created'];
      expect(visible).toMatchObject({ id: 'L12-DEL-SMALL-created', encryptionMode: e2ee ? 'e2ee' : 'plain' });
      const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
      expect(readSessionOwnerMetadataView(visible!)).toMatchObject({ path: ref.rootPath,
        work: { authoringOriginV1: draft.authoringOrigin } });
      if (e2ee) expect(context.sessionSpawnNewActionBoundarySpy.mock.calls[0]![0]).toMatchObject({
        agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
        connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'group', groupId: 'codex-pool',
        } } },
      });
      expect(context.sessionSpawnNewActionBoundarySpy.mock.calls[0]![0].authoringOrigin).toEqual(originAtBirth ? draft.authoringOrigin : undefined);
      if (e2ee) expect(displayConflicts).toBe(0);
      if (!e2ee) expect(displayConflicts).toBeGreaterThan(0);
      expect(racedPublication).toBe(publication === 'newer-Session-push');
    } finally { rpcObservation.mockRestore(); hydration.mockRestore(); await hook.unmount(); }
  });

  it('publishes the first prompt as a launch attempt while spawn is unresolved', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const spawnDeferred = createDeferred<SessionSpawnNewResultV1>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => spawnDeferred.promise);
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
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
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

      await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1));
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
      harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
      spawnDeferred.resolve(spawnSuccess('session-created'));
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it('shows a default-account launch refusal with the submitted Action request identity', async () => {
    const context = await setupTaskHarness({ httpsHome: true });
    const { buildManualSessionCreationKey } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
    spawnActionObservation.mockClear();
    const requestId = 'default-account-launch-request';
    const code = 'connected_account_purpose_catalog_unavailable';
    context.sessionSpawnNewActionBoundarySpy.mockResolvedValue({
      type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { kind: 'launch_error', code, message: code, failureCause: {
        code, phase: 'authentication', failureReason: 'unknown', connectedServicesDefault: {
          v: 1, source: 'account_default', reason: code, phase: 'purpose_binding', catalogReason: 'unreachable',
        },
      } },
    });
    const hook = await renderHook(() => context.useCreateNewSession(createRetryParams(context.storageState.settings, {
      draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
      allowedTargetServerIds: [context.scope.serverId], launchUserAttemptId: requestId,
    })));
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
      expect(context.sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].creationKey).toBe(buildManualSessionCreationKey(requestId));
      expect(spawnActionObservation.mock.calls[0]?.[1]?.actionRequestId).toBe(requestId);
      expect(context.modalAlertSpy).toHaveBeenCalledTimes(1);
      const message = context.modalAlertSpy.mock.calls[0]?.[1];
      expect(message).toContain(code);
      expect(message).toContain('purpose_binding');
      expect(message).toContain('unreachable');
      expect(message).toContain(requestId);
    } finally { await hook.unmount(); }
  });

  it('settles a terminal directory preflight refusal without waiting for a spawn operation', async () => {
    const context = await setupTaskHarness();
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { awaitManualSessionSpawnOperation } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
    const draftId = 'directory-refusal-draft';
    const userAttemptId = 'directory-refusal-attempt';
    const prompt = 'Keep my first input';
    writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: prompt }, materializationIntent: 'userEdit' });
    const methods: string[] = [];
    context.additionalBoundary.rpc = async method => {
      methods.push(method);
      if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return {
        error: 'filesystem_identity_custody_unavailable', errorCode: 'filesystem_identity_custody_unavailable',
        details: { reason: 'requester_identity_unavailable' },
      };
      return undefined;
    };
    const settlement = vi.fn();
    const attempts = vi.fn();
    const promptStore = createNewSessionPromptStore(prompt);
    const hook = await renderHook(() => {
      const [isCreating, setIsCreating] = React.useState(false);
      const launch = context.useCreateNewSession(createRetryParams(context.storageState.settings, {
        draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
        allowedTargetServerIds: [context.scope.serverId], draftId, launchUserAttemptId: userAttemptId,
        promptStore, onLaunchAttemptChange: attempts, setIsCreating,
      }));
      return { ...launch, isCreating };
    });
    try {
      await act(async () => { await hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: settlement }); });
      expect(hook.getCurrent().isCreating).toBe(false);
      expect(settlement).toHaveBeenCalledWith({ status: 'rejected' });
      expect(context.modalAlertSpy).toHaveBeenCalledTimes(1);
      expect(attempts.mock.calls.at(-1)?.[0]).toBeNull();
      expect(context.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
      await expect(awaitManualSessionSpawnOperation(context.scope, userAttemptId,
        new AbortController().signal, 'm1')).resolves.toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false,
          launchError: { code: 'filesystem_identity_custody_unavailable' } });
      expect(methods.filter(method => method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toHaveLength(1);
      expect(methods).not.toContain(ACTION_OPERATION_RPC_METHODS_V2.list);
      expect(methods).not.toContain(ACTION_OPERATION_RPC_METHODS_V2.get);
      const retained = getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId });
      expect(readDraftComposerText(retained)).toBe(prompt);
      expect(retained?.localSupplement.launchUserAttemptId).toBeUndefined();
    } finally { await hook.unmount(); }
  });

  it.each(['accepted', 'refused'] as const)('presents the committed Session at commit with a launch-owned first message, then settles it %s on the destination', async outcome => {
    const context = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { projectSessionSpawnNewActionResultV1 } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
    const { resolveSessionSpawnNewResultFailureMessage } = await import('@/sync/ops/actions/sessionSpawnFailurePresentation');
    const sessionId = 'spawnui-committed-session';
    const draftId = 'spawnui-draft';
    const prompt = 'Start here';
    writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: prompt }, materializationIntent: 'userEdit' });
    context.storageState.applySessions([createSessionFixture({ id: sessionId, serverId: context.scope.serverId, encryptionMode: 'plain' })]);
    const address = { serverId: context.scope.serverId, machineId: 'm1', operationId: 'spawnui-operation' };
    const terminal = createDeferred<unknown>();
    let heldGets = 0;
    context.additionalBoundary.rpc = async (method) => {
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return undefined;
      heldGets += 1;
      return await terminal.promise;
    };
    context.sessionSpawnNewActionBoundarySpy.mockImplementation(async (input) => input.observeSessionCommit === true
      ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', sessionId, operation: address }
      : { type: 'error', code: 'machine_offline', retryable: true });
    const machine = createMachineFixture({ id: 'm1',
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } }, operationProtocolCapabilitiesRevision: 1 });
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();
    const hook = await renderHook(() => context.useCreateNewSession(createRetryParams(context.storageState.settings, {
      draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId, setIsCreating,
      allowedTargetServerIds: [context.scope.serverId], draftId, launchUserAttemptId: 'spawnui-attempt', selectedMachine: machine,
      promptStore: createNewSessionPromptStore(prompt), router,
    })));
    const firstMessage = () => storage.getState().sessionPending[sessionId]?.messages.find(message => message.text === prompt);
    const httpSeen: string[] = [];
    context.additionalBoundary.http = async (url, init) => { httpSeen.push(`${init?.method ?? 'GET'} ${url.pathname}`); return null; };
    const capture = vi.spyOn(await import('@/utils/system/sentry'), 'captureExceptionIfEnabled');
    onTestFailed(() => console.error('SPAWNUI-DIAG', JSON.stringify({ httpSeen: httpSeen.slice(-25),
      captured: capture.mock.calls.map(([error]) => String(error instanceof Error ? error.stack?.split('\n').slice(0, 5).join(' | ') : error)),
      alerts: context.modalAlertSpy.mock.calls.map(call => call.slice(0, 2)) })));
    let createPromise: Promise<void> | undefined;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ cycles: 8, turns: 4 });
      });
      // Presented at commit, while the launch is still held on its one exact-operation read.
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      await vi.waitFor(() => expect(heldGets).toBe(1), { timeout: 20_000 });
      expect(router.replace).toHaveBeenCalledWith(expect.stringContaining(`/session/${sessionId}`), expect.anything());
      expect(firstMessage()).toMatchObject({ source: 'local_outbound', pendingLaunch: { state: 'starting' } });
      expect(firstMessage()?.deliveryStatus).toBeUndefined();
      expect(storage.getState().markSessionOptimisticThinking).not.toHaveBeenCalled();
      const firstTurnLocalId = firstMessage()!.localId!;
      // The destination replaces the New Session screen: the launch completes without its launcher.
      await hook.unmount();

      const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
        launchError: { kind: 'launch_error' as const, code: 'provider_model_not_found', message: 'provider_model_not_found' } };
      const settled = outcome === 'accepted'
        ? { ...spawnSuccess(sessionId), executionTarget: { serverId: context.scope.serverId, machineId: 'm1' },
          initialInput: { status: 'accepted' as const, localId: firstTurnLocalId } }
        : refusal;
      terminal.resolve({ kind: 'found', operation: { version: 1, operationId: address.operationId, revision: 3,
        actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: context.scope.accountId, machineId: 'm1' },
        requestId: 'spawnui-request', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
        cancellation: 'supported', result: projectSessionSpawnNewActionResultV1(settled) } });
      await act(async () => { await createPromise; });

      expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
      expect(heldGets).toBe(1);
      expect(router.replace).toHaveBeenCalledTimes(1);
      const { sync } = await import('@/sync/sync');
      expect(sync.sendMessage).not.toHaveBeenCalled();
      if (outcome === 'accepted') {
        expect(firstMessage()).toMatchObject({ localId: firstTurnLocalId, deliveryStatus: 'accepted' });
        expect(firstMessage()?.pendingLaunch).toBeUndefined();
        expect(storage.getState().markSessionOptimisticThinking).toHaveBeenCalledWith(sessionId);
        expect(context.modalAlertSpy).not.toHaveBeenCalled();
      } else {
        expect(firstMessage()).toMatchObject({ localId: firstTurnLocalId, text: prompt,
          pendingLaunch: { state: 'failed', message: resolveSessionSpawnNewResultFailureMessage(refusal), draftId } });
        expect(storage.getState().markSessionOptimisticThinking).not.toHaveBeenCalled();
        // The row carries the typed reason; a non-retryable refusal offers no Retry anywhere.
        expect(context.modalAlertSpy).not.toHaveBeenCalled();
        expect(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId })).toBeTruthy();
      }
    } finally {
      terminal.resolve({ kind: 'not_found' });
      await createPromise?.catch(() => undefined);
      await hook.unmount();
    }
  });

  it.each(['succeeded', 'retired'] as const)('retains requester acceptance without custodian-only operation pushes through %s and ignores a mis-wired neighbor', async terminalState => {
    const context = await setupTaskHarness();
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { readManualSessionSpawnOperation } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
    const { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV2RequestSchema } = await import('@happier-dev/protocol/actions/operations/v1');
    const userAttemptId = 'requester-start-without-push';
    const result = { ...spawnSuccess('requester-start-session'), executionTarget: { serverId: context.scope.serverId, machineId: 'm1' } };
    const operation = {
      version: 1 as const, operationId: 'requester-start-operation', revision: 1,
      actionId: 'session.spawn_new' as const, state: 'running' as const,
      scope: { accountId: context.scope.accountId, machineId: 'm1' },
      requestId: userAttemptId, title: 'Create session', createdAt: 1, startedAt: 2,
      cancellation: 'supported' as const,
    };
    const terminal = createDeferred<unknown>();
    let waitingForTerminal = false;
    context.additionalBoundary.rpc = async (method, input) => {
      if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return {
        items: [{ ...operation, operationId: 'neighbor', requestId: 'another-click' }, operation], nextCursor: null,
      };
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return undefined;
      expect(ActionOperationGetV2RequestSchema.parse(input)).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
      waitingForTerminal = true;
      return await terminal.promise;
    };
    context.sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
    const router = { push: vi.fn(), replace: vi.fn() };
    const settlement = vi.fn();
    const hook = await renderHook(() => context.useCreateNewSession(createRetryParams(context.storageState.settings, {
      draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
      allowedTargetServerIds: [context.scope.serverId], draftId: 'requester-start-draft', launchUserAttemptId: userAttemptId,
      promptStore: createNewSessionPromptStore('One requester prompt'), router,
    })));
    let createPromise: ReturnType<ReturnType<typeof hook.getCurrent>['handleCreateSession']> | undefined;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: settlement });
        await flushHookEffects({ cycles: 8, turns: 4 });
      });
      await vi.waitFor(() => expect(waitingForTerminal).toBe(true));
      expect(settlement).not.toHaveBeenCalled();
      if (terminalState === 'retired') {
        await hook.unmount();
        terminal.resolve({ kind: 'found', operation: { ...operation, state: 'succeeded', revision: 2, settledAt: 3, result } });
        await createPromise;
        expect(settlement).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(context.modalAlertSpy).not.toHaveBeenCalled();
        expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
        expect(readManualSessionSpawnOperation(context.scope, userAttemptId)?.operationId).toBe(operation.operationId);
        expect(Array.from(actionOperationStore.getSnapshot().operationsByKey.values())
          .some(candidate => candidate.snapshot.operationId === 'neighbor')).toBe(false);
        return;
      }
      await act(async () => {
        context.storageState.applySessions([createSessionFixture({ id: result.sessionId, serverId: context.scope.serverId, encryptionMode: 'plain' })]);
        terminal.resolve({ kind: 'found', operation: { ...operation, state: 'succeeded', revision: 2, settledAt: 3, result } });
      });
      await vi.waitFor(() => expect(settlement).toHaveBeenCalledWith({ status: 'accepted', sessionId: result.sessionId }));
      await createPromise;
      expect(router.replace).toHaveBeenCalledWith(expect.stringContaining('/session/requester-start-session'), expect.anything());
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
      expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    } finally {
      terminal.resolve({ kind: 'not_found' });
      await createPromise;
      await hook.unmount();
    }
  });

  it.each(['succeeded', 'failed', 'cancelled', 'retired'] as const)('joins a daemon-qualified manual start through canonical %s settlement without warning or replay', async terminalState => {
    const context = await setupTaskHarness();
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftId = 'accepted-start-draft';
    const userAttemptId = 'accepted-start-attempt';
    const daemonServerId = 'stack_agent-qa-machine-resources__id_default';
    const prompt = 'Keep the accepted first input';
    writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: prompt }, materializationIntent: 'userEdit' });
    const operation = {
      version: 1 as const, operationId: 'accepted-start-operation', revision: 1,
      actionId: 'session.spawn_new' as const, state: 'running' as const,
      scope: { accountId: context.scope.accountId, machineId: 'm1' },
      requestId: `manual:${userAttemptId}`, title: 'Create session', createdAt: 1, startedAt: 2,
      cancellation: 'supported' as const,
    };
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const terminal = createDeferred<unknown>();
    let operationDetailReads = 0;
    context.additionalBoundary.rpc = async (method, input) => {
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return undefined;
      operationDetailReads += 1;
      expect(input).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
      return await terminal.promise;
    };
    context.sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      actionOperationStore.mergeSnapshots({ serverId: context.scope.serverId, snapshots: [operation] });
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
        operation: { serverId: daemonServerId, machineId: 'm1', operationId: operation.operationId } };
    });
    const router = { push: vi.fn(), replace: vi.fn() };
    const settlement = vi.fn();
    const attempts = vi.fn();
    const promptStore = createNewSessionPromptStore(prompt);
    const hook = await renderHook(() => {
      const [isCreating, setIsCreating] = React.useState(false);
      const launch = context.useCreateNewSession(createRetryParams(context.storageState.settings, {
        draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
        allowedTargetServerIds: [context.scope.serverId], draftId, launchUserAttemptId: userAttemptId,
        promptStore, router, onLaunchAttemptChange: attempts, setIsCreating,
      }));
      return { ...launch, isCreating };
    });
    await act(async () => {
      hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: settlement });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
    await vi.waitFor(() => expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(operationDetailReads).toBe(1));
    expect(context.modalAlertSpy).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(hook.getCurrent().isCreating).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    expect(attempts.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'spawning' });
    expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
    if (terminalState === 'retired') {
      await hook.unmount();
      terminal.resolve({ kind: 'not_found' });
      expect(router.replace).not.toHaveBeenCalled();
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
      expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
      return;
    }
    const result = { ...spawnSuccess('accepted-start-session'), executionTarget: { serverId: daemonServerId, machineId: 'm1' } };
    const observedDetailHttp: string[] = [];
    context.additionalBoundary.http = async (url, init) => {
      observedDetailHttp.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return null;
    };
    await act(async () => {
      context.storageState.applySessions([createSessionFixture({ id: result.sessionId, serverId: context.scope.serverId, encryptionMode: 'plain' })]);
      actionOperationStore.mergeSnapshots({ serverId: context.scope.serverId, snapshots: [{ ...operation,
        state: terminalState, revision: 2, settledAt: 3,
        // The real daemon list deliberately omits settled result bodies. The
        // qualified get owner retains the actual first-input disposition.
        ...(terminalState === 'failed' ? { error: { errorCode: 'spawn_failed', error: 'Runner failed' } } : {}),
      }] });
      terminal.resolve({ kind: 'found', operation: { ...operation, state: terminalState, revision: 2, settledAt: 3,
        ...(terminalState === 'succeeded' ? { result } : {}),
        ...(terminalState === 'failed' ? { error: { errorCode: 'spawn_failed', error: 'Runner failed' } } : {}),
      } });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
    await vi.waitFor(async () => {
      await flushHookEffects({ cycles: 8, turns: 4 });
      expect(settlement.mock.calls.length, JSON.stringify({ alerts: context.modalAlertSpy.mock.calls,
        rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]), detailHttp: observedDetailHttp,
        operationDetailReads, latestAttempt: attempts.mock.calls.at(-1)?.[0]?.status,
        routed: router.replace.mock.calls.length,
        endpointStatus: context.storageState.endpointStatus, endpointReason: context.storageState.endpointReason })).toBe(1);
      if (terminalState === 'succeeded') expect(router.replace).toHaveBeenCalledTimes(1);
    });
    expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    if (terminalState === 'succeeded') {
      expect(router.replace).toHaveBeenCalledWith(expect.stringContaining('/session/accepted-start-session'), expect.anything());
      expect(settlement).toHaveBeenCalledWith({ status: 'accepted', sessionId: result.sessionId });
      expect(context.storageState.sessionPending[result.sessionId]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ localId: 'input-accepted-start-session', text: prompt, deliveryStatus: 'accepted' }),
      ]));
      const { sync } = await import('@/sync/sync');
      expect(sync.sendMessage).not.toHaveBeenCalled();
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
    } else {
      expect(router.replace).not.toHaveBeenCalled();
      expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
    }
    await hook.unmount();
  });

  it('keeps a pending Action unresolved without duplicating creation', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
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
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const creationKey = (sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as any)?.creationKey;
    expect(creationKey).toEqual(expect.stringMatching(/^manual:new-session-attempt-/));
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      expect.stringContaining('newSession.launchStillPendingBody'),
    );

    await hook.unmount();
  });

  it.each([
    {
      initialInput: { status: 'outcomeUnknown' as const, localId: 'input-session-created', code: 'transport_unavailable' },
      // The Session exists and the draft is kept: the title says what to do, never a bare "Error".
      expectedTitle: 'newSession.initialInputNotConfirmedTitle',
      expectedLabel: 'newSession.initialInputNotConfirmed',
    },
    {
      initialInput: { status: 'rejected' as const, code: 'session_input_idempotency_conflict' as const },
      expectedTitle: 'newSession.initialInputRejectedTitle',
      expectedLabel: 'session.pendingMessages.admissionRejected.idempotencyConflict',
    },
    {
      initialInput: { status: 'rejected', code: 'session_input_storage_unavailable' } as const,
      expectedTitle: 'newSession.initialInputRejectedTitle',
      expectedLabel: 'session.pendingMessages.admissionRejected.storageUnavailable',
    },
  ])('preserves and explains a $initialInput.status ($initialInput.code) first prompt without sending it twice', async ({ initialInput, expectedTitle, expectedLabel }) => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupTaskHarness();
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      ...spawnSuccess('session-created'),
      type: 'success', disposition: 'created', sessionId: 'session-created',
      executionTarget: { serverId: scope.serverId, machineId: 'm1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput,
    });
    let firstPromptAtNavigation: string | undefined;
    let warnedBeforeNavigation = false;
    const router = { push: vi.fn(), replace: vi.fn(() => {
      firstPromptAtNavigation = readDraftComposerText(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'session-created' }));
      warnedBeforeNavigation = modalAlertSpy.mock.calls.some((call) => typeof call[1] === 'string'
        && call[1].includes(expectedLabel) && call[1].includes(initialInput.code));
    }) };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      promptStore: createNewSessionPromptStore('Keep this first prompt'), router,
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      targetAccountScope: scope,
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls, JSON.stringify({ alerts: modalAlertSpy.mock.calls, rpc: harness.machineRpcSpy.mock.calls })).toHaveLength(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].initialInput).toEqual({ text: 'Keep this first prompt' });
    expect(readDraftComposerText(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'session-created' }))).toBe('Keep this first prompt');
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith(expectedTitle, expect.stringContaining(initialInput.code));
    expect(modalAlertSpy).toHaveBeenCalledWith(expectedTitle, expect.stringContaining(expectedLabel));
    expect(warnedBeforeNavigation).toBe(true);
    expect(firstPromptAtNavigation).toBe('Keep this first prompt');
    await hook.unmount();
  });

  it('retries an outcome-unknown Action with the same creation identity', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
      scope,
    } = await setupCurrentAccountSessionActionHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-after-retry', serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-after-retry'));

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
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry same nonce'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        draftScope: scope,
        targetServerId: scope.serverId,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects();

    expect(router.replace).not.toHaveBeenCalled();
    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    expect(firstSpawnOptions).not.toHaveProperty('initialPrompt');
    await act(async () => { await hook.getCurrent().handleCreateSession(); });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      creationKey: firstSpawnOptions.creationKey,
    }));
    expect(router.replace).toHaveBeenCalledWith(`/session/session-after-retry?serverId=${scope.serverId}`, expect.anything());

    await hook.unmount();
  });

  it('retains the real custody creation identity across remount after an unknown outcome', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({
      id: 'session-from-operation-settlement',
      serverId: 'server-a',
      encryptionMode: 'plain',
    })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-from-operation-settlement'));

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
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry after route stall'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
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
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const secondHook = await renderHook(createHook);
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(secondSpawnOptions.creationKey).toBe(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].creationKey);
    expect(secondSpawnOptions.creationKey).toMatch(/^manual:.+/);
  });

  it('keeps the unresolved launch barrier after remounting with a changed prompt on the same launch scope', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
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
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(sessionPrompt),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      });

    const firstHook = await renderHook(() => createHook('First timed-out prompt'));
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    const secondHook = await renderHook(() => createHook('Changed prompt after timeout'));
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);
  });

  it('rotates the action identity when the canonical launch intent changes on the same mounted screen', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
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
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore('Unchanged prompt'),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
          launchUserAttemptId: 'persisted-attempt-a',
          launchIntentSignature,
        }),
      { initialProps: { launchIntentSignature: 'intent-a' } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    await hook.rerender({ launchIntentSignature: 'intent-b' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);

    await hook.unmount();
  });

  it('offers Retry for daemon-unavailable post-create follow-up failures without creating another session', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls.some((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    })).toBe(true));
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    expect(modalAlertSpy.mock.calls.some((call) => call[0] === 'common.error')).toBe(false);
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      effectiveSpawnServerId: 'server-a',
      launchAttempt: expect.objectContaining({
        attachmentMessageLocalId: expect.stringMatching(/^plugin-input-v1:/),
      }),
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('drops duplicate create requests while a launch is already in flight', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValue(spawnSuccess('session-created'));
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
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

    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);

    resolveAfterCreated();
    await firstCreate;
    await secondCreate;

    await hook.unmount();
  });

  it('does not navigate when launch scope changes before completion', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
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
          resolveSavedSecretReference,
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
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ targetServerId: 'server-b' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(router.replace).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenLastCalledWith(false);

    await hook.unmount();
  });

  it('keeps routing when macOS resolves a /tmp launch path to its /private/tmp canonical path', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
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
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedPath: '/tmp/happier-ruqa-late-opencode-hqzCRl' } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ selectedPath: '/private/tmp/happier-ruqa-late-opencode-hqzCRl' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('keeps launch pending and routes when the created session hydrates after an initial route-readiness miss', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState, scope, additionalBoundary } = await setupTaskHarness();
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ ...spawnSuccess('session-created'),
      executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    let sessionPublished = false;
    let observedMissingSession = false;
    additionalBoundary.http = async url => {
      if (url.pathname !== '/v2/sessions/session-created') return null;
      if (!sessionPublished) {
        observedMissingSession = true;
        return Response.json({ error: 'Session not found' }, { status: 404 });
      }
      return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-created',
        metadata: { path: '/tmp', host: 'devbox', machineId: 'm1' } }) });
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();
    const params = createRetryParams(storageState.settings, {
      router, setIsCreating, draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      promptStore: createNewSessionPromptStore(''),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => {
      hook.getCurrent().handleCreateSession({ initialMessage: 'skip' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(observedMissingSession).toBe(true));
    expect(router.replace).not.toHaveBeenCalled();
    sessionPublished = true;
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/session/session-created?serverId=${scope.serverId}`, expect.anything()));
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenCalledWith(true);
    expect(setIsCreating).not.toHaveBeenCalledWith(false);

    await hook.unmount();
  });

  it('treats profile-mode changes as launch scope changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
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
          useProfiles,
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
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { useProfiles: false } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ useProfiles: true });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('retries post-create follow-up failures against the created session without respawning', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    const retryPresented = createDeferred<void>();
    modalAlertSpy.mockImplementationOnce(() => retryPresented.resolve(undefined));
    const spawnDispatch = createDeferred<SessionSpawnNewInputV2>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async (input) => {
      spawnDispatch.resolve(input);
      return spawnSuccess('session-created');
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
      await spawnDispatch.promise;
      await retryPresented.promise;
      await flushHookEffects({ runOnlyPendingTimers: true });
    });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
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
      await flushHookEffects({ runOnlyPendingTimers: true });
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      launchAttempt: expect.objectContaining({
        createdSessionId: 'session-created',
      }),
      sessionTarget: { serverId: 'server-a', accountId: 'account-a', sessionId: 'session-created' },
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('shows the generic follow-up error when retry fails for a non-daemon reason', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
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
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls.some((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    })).toBe(true));

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
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(2));

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls).toContainEqual([
      'common.error',
      'Attachment validation failed',
    ]));

    await hook.unmount();
  });


});
