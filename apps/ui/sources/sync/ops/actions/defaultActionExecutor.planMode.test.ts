import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ExecutionRunStartResponseSchema} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema, SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import {
  SessionSpawnNewInputV2Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import {
  sealSessionOwnerMetadataEnvelopeV1, openSessionOwnerMetadataEnvelopeV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonSessionGoalGetRequestV1Schema, DaemonSessionGoalSetRequestV1Schema, DaemonSessionGoalSetRequestV2Schema,
  DaemonSessionGoalClearRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionFixture, createSessionAccessFixture, createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { supportsEditableSessionGoals } from '@/agents/registry/registryUiBehavior';
import { createPlainAccountEncryptionCurrentnessFixture, createDataKeyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { Encryption } from '@/sync/encryption/encryption';
import { SESSION_OWNER_METADATA_PROJECTION, readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { bindMachineAccessActionHttpRequestV1, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { answerExternalActionAccountForHome, createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { SessionStopResultSchema, isSessionStopConfirmed } from '@happier-dev/protocol/sessions/control/contract';
import { readSessionExplicitStopV1FromMetadata, resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildSessionModelDiscoveryContext } from '@/sync/ops/sessionModelDiscovery';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { writeDynamicModelProbeCacheSuccess } from '@/sync/domains/models/dynamicModelProbeCache';
import { normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// A real product platform is required for executing-client evidence. The
// generic Node RN stub intentionally has no client category.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
// These transport assertions exercise the request after the present user
// accepts the real shared confirmation policy at its presentation boundary.
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

const outgoing: SocketRpcRequestPayload[] = [];
// Native file APIs are an OS boundary, outside this HTTP/Action journey.
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
const configureSessionSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = (socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed socket RPC request');
    }
    const request: SocketRpcRequestPayload = { method: payload.method, params: payload.params };
    outgoing.push(request);
    return { ok: true, result: await daemonAnswer(request) };
  });
};
installDisconnectedServerSocketBoundary(configureSessionSocket);
const homes = createHomeGovernanceHarness();
const readBatchRequest = createSessionReadBatchFetchBoundary(homes.request);
const httpBoundary = { ...homes, request: readBatchRequest };
installHomeGovernanceBoundaries(httpBoundary);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
// UI entry graph loading belongs to collection, outside Delete's behavior deadline.
await import('@/components/sessions/actions/sessionActionExecution');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

function installSession(id: string, partialMetadata: Partial<NonNullable<ReturnType<typeof createSessionFixture>['metadata']>>, ownerServerId = serverId, layout: 0 | 1 = 0,
  initialRow?: ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>) {
  const metadata = { path: '/repo', host: 'tester.local', ...partialMetadata };
  const session = createSessionFixture({ id, serverId: ownerServerId, active: true, metadata });
  storage.setState({ sessions: { ...storage.getState().sessions, [id]: session } });
  let row = SessionCurrentProjectionRecordV1Schema.parse({
    ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
    effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
    agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
  });
  if (layout === 1) row = initialRow ?? createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata });
  const answer = { select: (input: unknown) => {
    if (input === undefined || input === null) return { body: { session: row } };
    const patch = SessionMetadataTuplePatchV1Schema.parse(input);
    if (patch.mode === 'shared_editor') throw new Error('Owner mode change used shared-editor metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    // Mirror the real tuple producer: owner-only metadata changes do not bump
    // AgentState when its stored ciphertext is unchanged (sessionWriteService).
    const agentStateChanged = patch.mode === 'owner_migration' || row.agentState !== target.agentState.ciphertext;
    row = SessionCurrentProjectionRecordV1Schema.parse({ ...row,
      metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
      ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
      metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + (agentStateChanged ? 1 : 0),
    });
    return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
  } };
  homes.answer(ownerServerId, `/v2/sessions/${id}`, answer);
  homes.answer(ownerServerId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
  return () => row;
}

/** Hold actual HTTP body bytes after headers, retaining the request's abort semantics. */
function holdSessionResponseBody(sessionId: string, suffix = '', method = 'GET') {
  const reading = createDeferred<void>();
  const released = createDeferred<void>();
  let held = false;
  setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input, init) => {
    const response = await homes.request(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (held || (init?.method ?? 'GET') !== method || url.pathname !== `/v2/sessions/${sessionId}${suffix}`) return response;
    held = true;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading.resolve();
        await released.promise;
        if (init?.signal?.aborted) {
          controller.error(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
  }));
  return { reading: reading.promise, release: () => released.resolve(),
    restore: () => installHomeGovernanceBoundaries(httpBoundary) };
}

const modes = (agentId: string, currentModeId: string, ids: readonly string[]) => ({
  v: 1 as const, agentId, updatedAt: 1, currentModeId,
  availableModes: ids.map((id) => ({ id, name: id === 'default' ? 'Default' : id === 'build' ? 'Build' : 'Plan' })),
});
const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, serverId });

function installActionSettings(actions: unknown, voiceCanApproveRequests?: boolean, approvalWaivedSurfaces?: unknown,
  profiles?: Readonly<{ approvalProfiles?: unknown; machineApprovalProfiles?: unknown }>) {
  const current = storage.getState().settings;
  const settings = settingsParse({ ...current, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions,
    ...(approvalWaivedSurfaces === undefined ? {} : { approvalWaivedSurfaces }), ...profiles }),
    ...(voiceCanApproveRequests === undefined ? {} : normalizeVoiceSettingsLocalDelta({
      voice: { ...current.voice, canApproveRequests: voiceCanApproveRequests },
    }, current)) });
  const version = (storage.getState().settingsVersion ?? 0) + 1;
  const boundary = createAccountSettingsHttpBoundary({ serverUrl: 'https://mode-actions.test', initialAccounts: [{
    accountId: 'alice', snapshot: { content: { t: 'plain', v: settings }, version },
  }] });
  // Use the scoped persistence/version owner so an older in-flight bootstrap
  // response cannot undo a later person-authored Settings Action.
  storage.getState().applySettingsForScope({ serverId: connection!.serverId, accountId: 'alice' }, settings, version);
  homes.answer(serverId, '/v2/account/settings', { select: async (_input, request) => {
    const response = boundary.handle(request.url, request.init);
    if (!response) throw new Error('Unexpected Account settings method');
    return { status: response.status, body: await response.json() };
  } });
}

async function setVoiceApprovalDelegation(value: boolean) {
  const result = await createDefaultActionExecutor().execute('settings.set', {
    anchor: 'voiceConversations.canApproveRequests', value,
  }, context());
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(storage.getState().settings.voice.canApproveRequests).toBe(value);
}

async function installRevocableVoiceSettings(approvalWaivedSurfaces?: unknown) {
  installActionSettings({}, true, approvalWaivedSurfaces);
  const features = createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } });
  homes.answer(serverId, '/v1/features', { body: features });
  homes.answer(serverId, '/v1/features/authenticated', { body: features });
  const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
}

describe('default Action executor mode and catalog contracts', () => {
  it.each(['enabled', 'dependency_opt_out', 'home_opt_out'] as const)('admits Runner creation through the runtime decision and retains read/cancel (%s)', async policy => {
    const activationId = '00000000-0000-4000-8000-000000000007';
    const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const input = { v: 1 as const, activationId, draftId: 'runner-draft', homeServerIdentityId: 'srv_mode_home',
      activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'), activationExpiresAt: null,
      workspace: { kind: 'choose_on_endpoint' as const }, authoringCommitment: 'A'.repeat(43),
      artifact: { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) },
      endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'alice' } };
    const activation = { ...input, creatorAccountId: 'alice', creatorTokenEpoch: 0,
      sessionId: 'runner-session', machineId: 'runner-machine', state: 'pending', closeReason: null, claim: null, endpointFacts: null };
    const { v: _version, ...projection } = activation;
    const features = createRootLayoutFeaturesResponse({ features: { machines: { enabled: true }, sessions: { enabled: true,
      drafts: { enabled: policy !== 'dependency_opt_out' }, ephemeralRunner: { enabled: policy !== 'home_opt_out' } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const settings = storage.getState().settings;
    storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, 100);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 100 } });
    const path = `/v1/ephemeral-runners/activations/${activationId}`;
    homes.answer(serverId, '/v1/ephemeral-runners/activations', { body: { status: 'created', activation: projection } });
    homes.answer(serverId, path, { select: (_body, request) => ({ body: request.init?.method === 'DELETE'
      ? { ...projection, state: 'closed', closeReason: 'canceled' } : projection }) });
    const executor = createDefaultActionExecutor();
    const created = await executor.execute('sessions.runner.activation.create', input, context());
    expect(created, JSON.stringify(created)).toMatchObject(policy === 'enabled'
      ? { ok: true, result: { activationId, state: 'pending' } }
      : { ok: false, errorCode: 'runner_unavailable' });
    expect(homes.requestsFor('/v1/ephemeral-runners/activations')).toHaveLength(policy === 'enabled' ? 1 : 0);
    expect(await executor.execute('sessions.runner.activation.get', { activationId }, context())).toMatchObject({ ok: true, result: { activationId, state: 'pending' } });
    expect(await executor.execute('sessions.runner.activation.cancel', { activationId }, context())).toMatchObject({ ok: true, result: { activationId, closed: true } });
  });

  it('uses the calling Session approval profile while a present user can change a target Session profile', async () => {
    const sessionId = 'approval-profile-session';
    // No own choice: the caller Session follows the person's default for its Machine.
    await installActionSettings({}, undefined, undefined, { machineApprovalProfiles: { 'machine-a': 'careful' },
      approvalProfiles: [{ id: 'careful', name: 'Careful agent',
        actions: { 'session.status.set_reason': { approvalRequiredSurfaces: ['agent'] } } }] });
    const read = installSession(sessionId, { machineId: 'machine-a', flavor: 'claude' });
    const executor = createDefaultActionExecutor();
    const called = await executor.execute('session.status.set_reason', { reason: 'Investigating' }, {
      ...context(), surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
      actionRequestId: 'session-profile-action',
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    });
    expect(called, JSON.stringify(called)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const changed = await executor.execute('session.approval_profile.set', {
      sessionId, serverId, expectedMetadataRevision: read().metadataVersion, approvalProfileId: 'builtin:apply-safe',
    }, { ...context(), defaultSessionId: sessionId });
    expect(changed).toMatchObject({ ok: true, result: { ok: true, sessionId, approvalProfileId: 'builtin:apply-safe' } });
    const owner = read().ownerMetadata;
    expect(owner).toMatchObject({ t: 'plain', v: { runtime: { approvalProfileId: 'builtin:apply-safe' } } });
  });

  it.each([
    ['plain', 'memory'], ['plain', 'context'], ['e2ee', 'memory'], ['e2ee', 'context'],
  ] as const)('returns the committed %s %s receipt and admits its owner projection through the consumed Memory UI client', async (mode, field) => {
    const sessionId = 'ui-committed-intent';
    const metadata = { path: '/repo', host: 'tester.local', work: { memoryEnabled: false,
      promptStack: [{ id: 'notes', ref: { kind: 'doc', artifactId: 'notes', serverId }, enabled: true, placement: 'system_append' }] },
    } satisfies Parameters<typeof installSession>[1];
    const keys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(37));
    // Metadata and AgentState have independent versions; do not make an ACK
    // mapper that confuses the two look correct by seeding equal counters.
    let initialRow = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true, metadata,
      metadataVersion: 8, agentStateVersion: 3 });
    if (mode === 'e2ee') {
      await connection?.dispose();
      const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }), encryption: {
        publicKey: encodeBase64(keys.publicKey), machineKey: encodeBase64(keys.secretKey),
      } };
      const serverUrl = 'https://encrypted-intent.test';
      serverId = await homes.addHome({ name: 'Encrypted intent', serverUrl, accountId: 'alice', credentials,
        accountEncryptionMode: 'e2ee', currentAccount: true });
      homes.answer(serverId, '/v1/account/encryption/currentness', { body: createDataKeyAccountEncryptionCurrentnessFixture({
        publicKey: keys.publicKey, machineKey: keys.secretKey,
      }) });
      connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials,
        request: readBatchRequest, configureSocket: configureSessionSocket });
      storage.getState().activateProfileScope({ serverId: connection.serverId, accountId: 'alice' });
      await storage.getState().activateSettingsScope({ serverId: connection.serverId, accountId: 'alice' });
      const encryption = await Encryption.createFromContentKeyPair({ publicKey: keys.publicKey, machineKey: keys.secretKey });
      encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
      const dataKey = new Uint8Array(32).fill(9);
      await encryption.initializeSessions(new Map([[sessionId, dataKey]]));
      if (typeof initialRow.metadata !== 'string' || initialRow.ownerMetadata?.t !== 'plain') throw new Error('Invalid encrypted intent fixture');
      initialRow = SessionCurrentProjectionRecordV1Schema.parse({ ...initialRow, encryptionMode: 'e2ee',
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })),
        metadata: await encryption.getSessionEncryption(sessionId)!.encryptRaw(JSON.parse(initialRow.metadata)),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'dataKey', machineKey: keys.secretKey },
          ownerMetadata: initialRow.ownerMetadata.v, randomBytes: nacl.randomBytes }),
      });
    }
    const read = installSession(sessionId, metadata, serverId, 1, initialRow);
    const expectedMetadataRevision = read().metadataVersion;
    const { memoryDocumentActions } = await import('@/sync/ops/promptLibrary/memoryDocuments');
    const target = { sessionId, serverId, expectedMetadataRevision };
    // The live report starts with an admitted owner projection, not a cold
    // tuple. Prime it through the real no-op Action before changing the field.
    const unchanged = field === 'memory'
      ? await memoryDocumentActions.setSessionMemory(target, false)
      : await memoryDocumentActions.updateSessionContext(target, { kind: 'detach', entryId: 'absent' });
    expect(unchanged).toMatchObject({ ok: true, result: { sessionId, version: expectedMetadataRevision } });
    expect(read().metadataVersion).toBe(expectedMetadataRevision);
    expect(storage.getState().sessions[sessionId]?.[SESSION_OWNER_METADATA_PROJECTION]?.admittedMetadataVersion).toBe(expectedMetadataRevision);
    const result = field === 'memory'
      ? await memoryDocumentActions.setSessionMemory(target, true)
      : await memoryDocumentActions.updateSessionContext(target, { kind: 'detach', entryId: 'notes' });
    // Assert the Home's commit separately from the caller's receipt and store.
    expect(read().metadataVersion).toBe(expectedMetadataRevision + 1);
    const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode, envelope: read().ownerMetadata,
      material: mode === 'e2ee' ? { type: 'dataKey', machineKey: keys.secretKey } : null });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Committed owner metadata unavailable');
    expect(opened.ownerMetadata.work).toMatchObject(field === 'memory' ? { memoryEnabled: true } : { promptStack: [] });
    expect(result).toMatchObject({ ok: true, result: {
      sessionId, version: read().metadataVersion, ...(field === 'memory' ? { enabled: true } : { updated: true }),
    } });
    const session = storage.getState().sessions[sessionId];
    expect(session?.metadataVersion).toBe(read().metadataVersion);
    expect(session?.[SESSION_OWNER_METADATA_PROJECTION]?.admittedMetadataVersion).toBe(read().metadataVersion);
    expect(readSessionOwnerMetadataView(session!)).toMatchObject({ work: field === 'memory'
      ? { memoryEnabled: true } : { promptStack: [] } });
  });

  it('resolves managed birth from a cold Account without hydrating 1,000 unrelated Sessions', async () => {
    const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
    const actionId = ActionIdSchema.parse('machines.managed.birth.get');
    storage.setState({ sessions: {} });
    const unrelated = Array.from({ length: 1_000 }, (_, index) =>
      createPlainSessionCurrentProjectionRecordFixture({ id: `unrelated-${index}`, active: index % 2 === 0,
        metadata: { path: '/repo', host: 'test.local', machineId: 'machine-a' } }));
    homes.answer(serverId, '/v2/sessions', { body: { sessions: unrelated.slice(0, 500), nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/archived', { body: { sessions: unrelated.slice(500), nextCursor: null, hasNext: false } });
    homes.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', { body: { source: { kind: 'session', sessionId: 'archived-birth' } } });
    const before = homes.requests.length;
    const result = await createDefaultActionExecutor().execute(actionId, { homeId: 'srv_mode_home', managedId: 'managed' }, context());
    const reads = homes.requests.slice(before);
    expect(reads.filter(request => /^\/v[12]\/sessions(?:[/?]|$)/.test(request.path))).toHaveLength(0);
    expect(reads.filter(request => request.path === '/v1/machines/managed/actions/birth.get')).toHaveLength(1);
    expect(result).toEqual({ ok: true, result: { source: { kind: 'session', sessionId: 'archived-birth' } } });
    expect(storage.getState().sessions).toEqual({});
  });
  it('leaves a missing stored relationship unknown without scanning retained private Session provenance', async () => {
    const { readManagedCreationScopeBirthSource } = await import('./managedCreationScopeBinding');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { SessionCreationCorrespondenceV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1');
    const { deriveSessionCreationTagV1 } = await import('@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing Account lifetime');
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'retained-managed-birth' }),
      recipe: { execution: { machineId: 'machine-a', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'example.agent', localId: 'test' } },
        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
        connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
        agentSessionStartupInstructionsMarkerV1: null, checkout: null,
        managedCreation: { homeId: 'srv_mode_home', managedId: 'managed',
          controller: { machineId: 'original-controller', installationId: 'original-installation' } } } });
    const birth = createPlainSessionCurrentProjectionRecordFixture({ id: 'retained-birth', active: false,
      metadata: { path: '/repo', host: 'test.local', machineId: 'machine-a', sessionCreationCorrespondenceV1: correspondence } });
    homes.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', { body: { source: null } });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/archived', { body: { sessions: [birth], nextCursor: null, hasNext: false } });
    const before = homes.requests.length;
    expect(await readManagedCreationScopeBirthSource({ machine: { homeId: 'srv_mode_home', id: 'managed' },
      accountLifetime: lifetime, signal: new AbortController().signal })).toBeNull();
    expect(homes.requests.slice(before).filter(request =>
      ['/v2/sessions', '/v2/sessions/archived'].includes(request.path.split('?')[0]!))).toHaveLength(0);
  });
  it.each([403, 'malformed'] as const)('does not scan private Sessions after a %s managed birth lookup refusal', async refusal => {
    const { readManagedCreationScopeBirthSource } = await import('./managedCreationScopeBinding');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing Account lifetime');
    homes.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', refusal === 'malformed'
      ? { body: {} } : { status: refusal, body: { error: 'forbidden' } });
    const before = homes.requests.length;
    await expect(readManagedCreationScopeBirthSource({ machine: { homeId: 'srv_mode_home', id: 'managed' },
      accountLifetime: lifetime, signal: new AbortController().signal })).rejects.toBeDefined();
    expect(homes.requests.slice(before).filter(request =>
      ['/v2/sessions', '/v2/sessions/archived'].includes(request.path.split('?')[0]!))).toHaveLength(0);
  });
  it('does not downgrade a refused managed birth Action into Session discovery', async () => {
    const { readManagedCreationScopeBirthSource } = await import('./managedCreationScopeBinding');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing Account lifetime');
    homes.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', { status: 403, body: { error: 'forbidden' } });
    const before = homes.requests.length;
    await expect(readManagedCreationScopeBirthSource({ machine: { homeId: 'srv_mode_home', id: 'managed' },
      accountLifetime: lifetime, signal: new AbortController().signal })).rejects.toBeDefined();
    expect(homes.requests.slice(before).filter(request => /^\/v[12]\/sessions(?:[/?]|$)/.test(request.path))).toHaveLength(0);
  });
  it.each(['manual-profile', 'exact-descriptor'] as const)(
    'resumes an owned stopped Session through the actual verified custom-localhost Home transport (%s)', async descriptorKind => {
    await connection?.dispose();
    const serverUrl = 'http://happier-resume-owner.localhost:3028';
    const identity = 'srv_resume_verified_home';
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Resume Home', serverUrl, serverIdentityId: identity,
      accountId: 'alice', credentials });
    const { reconcileServerProfileHomeConnectionDescriptor } = await import('@/sync/domains/server/serverProfiles');
    if (descriptorKind === 'exact-descriptor') {
      expect(await reconcileServerProfileHomeConnectionDescriptor({ serverUrl, observedServerIdentityId: identity,
        descriptor: { v: 1, homeServerIdentityId: identity, canonicalServerUrl: serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: serverUrl }] }, observation: 'exact',
      })).toMatchObject({ kind: 'applied' });
    }
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: identity, accountId: 'alice', credentials,
      request: readBatchRequest, configureSocket: configureSessionSocket });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/connectionManager');
    const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
    expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
    expect(areServerProfileIdentifiersEquivalent(getAppliedActiveServerSnapshot().serverId, serverId)).toBe(true);
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: machineRow.id, activeAt: machineRow.activeAt,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    homes.answer(serverId, '/v1/machines', { body: [machineRow] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [machineRow] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
    const access = bindMachineAccessActionHttpRequestV1('machines.access.grants.list', { serverId, machineId: machineRow.id });
    homes.answer(serverId, access.path, { body: MachineAccessGrantsListResponseV1Schema.parse({
      machineId: machineRow.id, custodian: machineRow.access!.custodian, access: machineRow.access,
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    const hold = writeSessionExplicitStopV1ToMetadata({}, {
      v: 1, cause: 'explicit_stop', requestId: 'verified-home-stop', requestedAtMs: 1000,
    });
    const sessionId = 'verified-home-resume';
    const readSession = installSession(sessionId, { machineId: machineRow.id, flavor: 'claude', claudeSessionId: 'native-existing',
      ...hold });
    const stoppedRow = SessionCurrentProjectionRecordV1Schema.parse({ ...readSession(), active: false });
    homes.answer(serverId, `/v2/sessions/${sessionId}`, { body: { session: stoppedRow } });
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: stoppedRow } });
    storage.getState().applySessions([{ ...storage.getState().sessions[sessionId]!, active: false }]);
    daemonAnswer = request => {
      if (request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION}`)
        || request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`)) return { type: 'success', sessionId };
      if (request.method.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)) {
        return createExistingSessionDirectoryPreflightResult(request.params);
      }
      return { ok: true };
    };
    const result = await createDefaultActionExecutor().execute('session.open', {
      sessionId, serverId, intent: 'resume',
    }, { ...context(), expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'opened', sessionId } });
    const starts = outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION}`)
      || request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`));
    expect(starts).toHaveLength(1);
    expect(starts[0]!.params).toMatchObject({ sessionId, directory: '/repo', resume: 'native-existing' });
    const reads = [...homes.requestsFor(`/v2/sessions/${sessionId}`),
      ...homes.requestsFor(`/v2/sessions/${sessionId}?accessProjectionVersion=1`)];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(request => request.serverId === serverId)).toBe(true);
    // A still-applied carrier is not permission to override the Home supervisor's
    // independent unavailable fact. This refusal must issue no second native start.
    storage.setState({ endpointStatus: 'offline' });
    expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
    const unavailable = await createDefaultActionExecutor().execute('session.open', {
      sessionId, serverId, intent: 'resume',
    }, { ...context(), expectedAccountId: 'alice' });
      expect(unavailable).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION}`)
      || request.method.endsWith(`:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`))).toHaveLength(1);
    expect(storage.getState().sessions[sessionId]?.metadata?.sessionExplicitStopV1).toMatchObject({ requestId: 'verified-home-stop' });
  });

  it('sends structured ordinary input to an exact cold Session on the active Home without warming the Session store', async () => {
    installSession('cold-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
      session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const structuredInput = { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:source', token: '@source' }] };
    homes.answer(serverId, '/v2/sessions/cold-session/pending', { select: body => {
      const input = StrictJsonValueSchema.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected Pending mutation object');
      if (!('requestedAction' in input) || !('localId' in input)) throw new Error('Expected Pending mutation identity');
      expect(input).toMatchObject({ localId: 'cold-input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: { content: { text: '@source inspect it.' }, meta: { happierStructuredInputV1: structuredInput } } } });
      return { body: { requestedAction: input.requestedAction, pending: { localId: input.localId } } };
    } });
    const result = await createDefaultActionExecutor().execute('session.message.send', {
      sessionId: 'cold-session', message: '@source inspect it.', reply: 'none', localId: 'cold-input', structuredInput,
      requestedAction: { v: 1, kind: 'send_now' },
    }, context());
    expect(result).toEqual({ ok: true, result: { status: 'accepted', localId: 'cold-input' } });
    expect(storage.getState().sessions['cold-session']).toBeUndefined();
    expect(homes.requestsFor('/v2/sessions/cold-session/pending')).toHaveLength(1);
  });
  it('keeps attachment preflight guidance through the real wrapper and Action consumer', async () => {
    const sessionId = 'attachment-preflight';
    installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const { createSessionDraftMessageExecute } = await import('@/components/sessions/composer/submitSessionDraft');
    const { describeUploadFailure } = await import('@/components/transfers/describeUploadFailure');
    const { readSessionComposerMessagingOutcome } = await import('@/components/sessions/composer/sessionComposerMessaging');
    const { t } = await import('@/text');
    const execute = createSessionDraftMessageExecute({
      sessionTarget: { serverId, accountId: 'alice', sessionId },
      sourceComposerRef: { kind: 'session', sessionId }, originalMessage: 'Inspect this', isCurrent: () => true,
      drafts: [{ id: 'oversized', status: 'pending', source: { kind: 'memory', name: 'note.txt', bytes: new Uint8Array(2) } }],
      config: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false, maxFileBytes: 1 },
    });
    const result = await execute('session.message.send', { sessionId, message: 'Inspect this', reply: 'none',
      localId: 'attachment-input', requestedAction: { v: 1, kind: 'send_now' },
      structuredInput: { v: 1, sessionAttachments: [] } }, context());
    expect(result).toMatchObject({ ok: false, errorCode: 'attachment_too_large' });
    expect(readSessionComposerMessagingOutcome(result)).toEqual({ kind: 'unaccepted',
      error: describeUploadFailure('tooLarge', t('common.machine')) });
    expect(homes.requestsFor(`/v2/sessions/${sessionId}/pending`)).toHaveLength(0);
  });
  it('retires default ACP metadata publication while the captured Session body is held', async () => {
    const sessionId = 'retired-acp-body';
    installSession(sessionId, { path: '/private/captured-account', flavor: 'opencode' });
    storage.setState({ sessions: {} });
    const body = holdSessionResponseBody(sessionId);
    const { sync } = await import('@/sync/sync');
    const publication = sync.publishSessionAcpSessionModeOverrideToMetadata({ sessionId, modeId: 'plan', updatedAt: 2 })
      .then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
    try {
      await Promise.race([body.reading, publication.then(() => { throw new Error('ACP publication completed before the held Session body'); })]);
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await disconnectActiveServerConnection();
      await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      body.release();
      const outcome = await publication;
      expect(storage.getState().sessions[sessionId]).toBeUndefined();
      expect(homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null)).toEqual([]);
      expect(outcome).toMatchObject({ status: 'rejected', error: expect.any(Error) });
    } finally {
      body.release();
      await publication;
      body.restore();
    }
  });
  it('retires a basic Action send before outbox custody while the captured Session body is held', async () => {
    const sessionId = 'retired-send-body';
    const localId = 'retired-send-input';
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const originalScope = captureActiveServerAccountScopeLifetime()!.scope;
    installSession(sessionId, { path: '/private/captured-account', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
      session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, `/v2/sessions/${sessionId}/pending`, { status: 503, body: { error: 'unavailable' } });
    const body = holdSessionResponseBody(sessionId);
    const send = createDefaultActionExecutor().execute('session.message.send', {
      sessionId, message: 'Do not send after logout.', reply: 'none', localId,
      requestedAction: { v: 1, kind: 'send_now' },
    }, context());
    const { loadPendingOutboxForSession, removePendingOutboxMessage } = await import('@/sync/domains/state/pendingOutboxPersistence');
    try {
      await Promise.race([body.reading, send.then(() => { throw new Error('Basic Action send completed before the held Session body'); })]);
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await disconnectActiveServerConnection();
      await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      body.release();
      const outcome = await send;
      expect({ pendingRequests: homes.requestsFor(`/v2/sessions/${sessionId}/pending`).length,
        outboxRows: (await loadPendingOutboxForSession(sessionId, originalScope)).length,
      }).toEqual({ pendingRequests: 0, outboxRows: 0 });
      expect(outcome).toMatchObject({ ok: false, errorCode: 'stale_response' });
    } finally {
      body.release();
      await send.catch(() => undefined);
      await removePendingOutboxMessage(sessionId, localId, originalScope);
      body.restore();
    }
  });
  it.each([true, false])('clears reviewer override %s without a redundant metadata publication', async enabled => {
    const sessionId = 'reviewer-clear';
    const read = installSession(sessionId, { flavor: 'codex' }, serverId, 1);
    const executor = createDefaultActionExecutor();
    const write = (value: boolean | null) => executor.execute('session.approval_reviewer.set', { sessionId, enabled: value }, context());
    const metadata = () => {
      const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Expected plain owner metadata');
      return projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    };
    expect(await write(enabled)).toMatchObject({ ok: true });
    expect(metadata().approvalReviewerEnabled).toBe(enabled);
    expect(await write(null)).toMatchObject({ ok: true });
    expect(metadata()).not.toHaveProperty('approvalReviewerEnabled');
    const writes = () => homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null).length;
    const published = writes();
    expect(await write(null)).toMatchObject({ ok: true });
    expect(writes()).toBe(published);
  });
  it('publishes instrument context refresh to its Home while a same-id Session is active elsewhere', async () => {
    const targetServerId = await homes.addHome({ name: 'Context refresh Home', serverUrl: 'https://context-refresh.test',
      serverIdentityId: 'srv_context_refresh', accountId: 'bob', currentAccount: true });
    const sessionId = 'context-refresh-same-id';
    const readTarget = installSession(sessionId, { flavor: 'claude' }, targetServerId, 1);
    const readActive = installSession(sessionId, { flavor: 'claude' }, serverId, 1);
    installHomeGovernanceBoundaries(httpBoundary);
    const { useInstrumentStripModel } = await import('@/components/sessions/agentInput/instrumentStrip/useInstrumentStripModel');
    const hook = await renderHook(() => useInstrumentStripModel({
      sessionId, serverId: targetServerId, agentId: null, metadata: null,
    }));
    const metadata = (read: typeof readTarget) => {
      const row = read();
      const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Expected plain owner metadata');
      return projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: owner.v });
    };
    try {
      await act(async () => hook.getCurrent().refreshContextUsage());
      await vi.waitFor(() => expect(metadata(readTarget).acpConfigOptionOverridesV1).toMatchObject({
        overrides: { context_usage_refresh: { value: expect.any(String) } },
      }));
      expect(metadata(readActive).acpConfigOptionOverridesV1).toBeUndefined();
      const writes = homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(request => request.serverId === targetServerId)).toBe(true);
    } finally {
      await hook.unmount();
    }
  });

  it.each(['focus-switch', 'credential-replacement'] as const)(
    'keeps explicit Home metadata authority independent from ambient %s', async change => {
    // Published Homes carry a portable identity, so their Account encryption scopes are comparable.
    const targetServerId = await homes.addHome({ name: 'Target metadata Home', serverUrl: 'https://target-metadata.test',
      serverIdentityId: 'srv_target_metadata', accountId: 'bob', currentAccount: true });
    const nextServerId = await homes.addHome({ name: 'Next ambient Home', serverUrl: 'https://next-ambient.test',
      serverIdentityId: 'srv_next_ambient', accountId: 'carol', currentAccount: true });
    const sessionId = 'explicit-home-metadata';
    const read = installSession(sessionId, { path: '/private/target-account', flavor: 'claude' }, targetServerId, 1);
    storage.setState({ sessions: {} });
    const body = holdSessionResponseBody(sessionId);
    const publication = createDefaultActionExecutor().execute('session.approval_reviewer.set', {
      sessionId, enabled: true,
    }, { ...context(), serverId: targetServerId });
    try {
      await Promise.race([body.reading, publication.then(() => { throw new Error('Explicit Home publication completed before the held Session body'); })]);
      if (change === 'focus-switch') {
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await setActiveServerId(nextServerId, { scope: 'device' });
        await switchConnectionToActiveServer();
      } else {
        await homes.switchAccount(targetServerId, 'replacement', { currentAccount: true });
        homes.answer(targetServerId, `/v2/sessions/${sessionId}`, { status: 403, body: { error: 'Forbidden' } });
        homes.answer(targetServerId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { status: 403, body: { error: 'Forbidden' } });
      }
      body.release();
      const result = await publication;
      const writes = homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null);
      if (change === 'focus-switch') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every(request => request.serverId === targetServerId)).toBe(true);
        const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v })
          .approvalReviewerEnabled).toBe(true);
      } else {
        expect(writes).toHaveLength(0);
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(result).toMatchObject({ ok: false });
      }
    } finally {
      body.release();
      await publication.catch(() => undefined);
      body.restore();
    }
  });
  it('withdraws acquired metadata writer authority on a same-Home semantic invalidation before CAS', async () => {
    const sessionId = 'retired-metadata-writer';
    installSession(sessionId, { path: '/private/captured-account', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const { sync } = await import('@/sync/sync');
    const { invalidateAccountEncryptionModeCacheForChanges } = await import('@/sync/api/account/apiAccountEncryptionMode');
    const publication = sync.patchSessionMetadataWithRetry(sessionId, metadata => {
      // The real tuple has already been acquired. An unknown self hint is a
      // conservative encryption withdrawal, including between read and CAS.
      expect(homes.requests.some(request => request.path.split('?')[0] === `/v2/sessions/${sessionId}`
        && request.input === null)).toBe(true);
      invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self' }]);
      return { ...metadata, approvalReviewerEnabled: true };
    }, { serverId });
    await expect(publication).rejects.toMatchObject({ code: 'account_encryption_currentness_changed' });
    expect(homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null)).toHaveLength(0);
  });
  it.each(['success', 'malformed', 'unmatched', 'unmatched-agent-before', 'unmatched-agent-after', 'retired-conflict'] as const)(
    'retains only a matched metadata commit receipt without projecting after semantic withdrawal during ACK consumption (%s)', async ack => {
    const sessionId = 'committed-metadata-before-withdrawal';
    const metadata = { path: '/private/captured-account', host: 'test.local', flavor: 'claude' };
    const read = installSession(sessionId, metadata, serverId, 1, createPlainSessionCurrentProjectionRecordFixture({
      id: sessionId, metadata, metadataVersion: 7, agentStateVersion: 3,
    }));
    const originalProjection = storage.getState().sessions[sessionId];
    const initialRevision = read().metadataVersion;
    const initialAgentStateVersion = read().agentStateVersion!;
    const committed: number[] = [];
    if (ack === 'retired-conflict') {
      const answer = { select: (input: unknown) => input === null || input === undefined
        ? { body: { session: read() } }
        : { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({
          code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: initialRevision + 1 }, agentState: { version: (read().agentStateVersion ?? 0) + 1 },
        }) } };
      homes.answer(serverId, `/v2/sessions/${sessionId}`, answer);
      homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    }
    const { invalidateAccountEncryptionModeCacheForChanges } = await import('@/sync/api/account/apiAccountEncryptionMode');
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input, init) => {
      const response = await homes.request(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method !== 'PATCH' || url.pathname !== `/v2/sessions/${sessionId}`) return response;
      // The real Home has committed and returned its strict success envelope.
      // Deliver a semantic wake while the client consumes those ACK bytes.
      const bytes = ack === 'malformed' ? new TextEncoder().encode(JSON.stringify({ success: true }))
        : ack === 'unmatched' ? new TextEncoder().encode(JSON.stringify(SessionMetadataTuplePatchSuccessV1Schema.parse({
          success: true, metadataLayoutVersion: 1, sharedMetadata: { version: initialRevision + 99 },
          agentState: { version: (read().agentStateVersion ?? 0) + 99 },
        }))) : ack === 'unmatched-agent-before' || ack === 'unmatched-agent-after'
          ? new TextEncoder().encode(JSON.stringify(SessionMetadataTuplePatchSuccessV1Schema.parse({
            success: true, metadataLayoutVersion: 1, sharedMetadata: { version: read().metadataVersion },
            agentState: { version: initialAgentStateVersion + (ack === 'unmatched-agent-before' ? -1 : 2) },
          }))) : new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self' }], { serverId });
          controller.enqueue(bytes);
          controller.close();
        },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    }));
    try {
      const { sync } = await import('@/sync/sync');
      const publication = sync.patchSessionMetadataWithRetry(sessionId,
        metadata => ({ ...metadata, approvalReviewerEnabled: true }),
        { serverId, onMetadataCommitted: revision => committed.push(revision) },
      );
      if (ack === 'success') {
        await expect(publication).resolves.toBeUndefined();
        expect(committed).toEqual([read().metadataVersion]);
      } else {
        await expect(publication).rejects.toBeInstanceOf(Error);
        expect(committed).toEqual([]);
      }
      expect(read().metadataVersion).toBe(initialRevision + (ack === 'retired-conflict' ? 0 : 1));
      expect(storage.getState().sessions[sessionId]).toBe(originalProjection);
      const requests = homes.requests.filter(request => request.path.split('?')[0] === `/v2/sessions/${sessionId}`);
      expect(requests.filter(request => request.input === null)).toHaveLength(1);
      expect(requests.filter(request => request.input !== null)).toHaveLength(1);
    } finally {
      installHomeGovernanceBoundaries(httpBoundary);
    }
  });
  it('resolves a manager selector from the exact authorized Session projection', async () => {
    installSession('manager-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const readWorker = installSession('worker-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const worker = SessionCurrentProjectionRecordV1Schema.parse({ ...readWorker(), manager: { sessionId: 'manager-session' } });
    homes.answer(serverId, '/v2/sessions/worker-session', { body: { session: worker } });
    homes.answer(serverId, '/v2/sessions/worker-session?accessProjectionVersion=1', { body: { session: worker } });
    const result = await createDefaultActionExecutor().execute('session.status.get', {
      sessionId: { selector: 'manager', of: 'worker-session' },
    }, context());
    expect(result).toMatchObject({ ok: true, result: { session: { id: 'manager-session' } } });
  });
  it('controls only the selected check-in revision through its captured Home', async () => {
    installSession('exchange-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    const observedRevision = 'session-message-row-revision:v1:3';
    homes.answer(serverId, '/v2/sessions/exchange-session/exchanges/original-input', { select: body => {
      if (body === undefined || body === null) return { body: { state, observedRevision } };
      expect(body).toEqual({ control: 'continue_more_10', observedRevision });
      return { status: 409, body: { error: 'exchange_revision_conflict' } };
    } });
    const result = await createDefaultActionExecutor().execute('session.exchange.control', {
      sessionId: 'exchange-session', originInputLocalId: 'original-input', decision: 'continue_more',
    }, context());
    expect(result).toMatchObject({ ok: false, errorCode: 'exchange_revision_conflict' });
    expect(homes.requestsFor('/v2/sessions/exchange-session/exchanges/original-input').map(request => request.input))
      .toEqual([null, { control: 'continue_more_10', observedRevision }]);
  });
  it.each(['continue', 'continue_more_10', 'stop'] as const)('keeps the displayed exchange root/revision for banner %s without silently preparing a newer revision', async control => {
    const { controlSessionExchange } = await import('@/sync/ops/sessions/sessionExchangeActions');
    installSession('banner-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    const displayed = 'session-message-row-revision:v1:3';
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: body => {
      if (body == null) return { body: { state, observedRevision: 'session-message-row-revision:v1:4' } };
      expect(body).toEqual({ control, observedRevision: displayed });
      return { status: 409, body: { error: 'exchange_revision_conflict' } };
    } });
    const result = await controlSessionExchange({ address: { serverId, sessionId: 'banner-session' },
      accountId: 'alice', originInputLocalId: 'root-1', status: { state, observedRevision: displayed } }, control);
    expect(result).toMatchObject({ ok: false, errorCode: 'exchange_revision_conflict' });
    expect(homes.requestsFor('/v2/sessions/banner-session/exchanges/root-1').map(request => request.input))
      .toEqual([{ control, observedRevision: displayed }]);
  });
  it('loads a check-in banner only for the selected original, retaining its observation on failed refresh and dropping it on root change', async () => {
    const { useSessionExchangeControl } = await import('@/hooks/session/useSessionExchangeControl');
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    let failing = false;
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: () => failing
      ? { status: 503, body: {} } : { body: { state, observedRevision: 'session-message-row-revision:v1:3' } } });
    const hook = await renderHook<ReturnType<typeof useSessionExchangeControl>, { root: string | null }>(({ root }) => useSessionExchangeControl({
      serverId, sessionId: 'banner-session' }, root), { initialProps: { root: null } });
    try {
      expect(homes.requestsFor('/v2/sessions/banner-session/exchanges/root-1')).toHaveLength(0);
      await hook.rerender({ root: 'root-1' });
      await flushHookEffects();
      expect(hook.getCurrent()).toMatchObject({ admission: 'check_in', observation: { originInputLocalId: 'root-1',
        address: { serverId, sessionId: 'banner-session' }, status: { observedRevision: 'session-message-row-revision:v1:3' } } });
      const before = hook.getCurrent().observation;
      failing = true;
      await act(async () => { await hook.getCurrent().refresh(); });
      expect(hook.getCurrent()).toMatchObject({ error: 'exchange_unavailable', observation: before });
      await hook.rerender({ root: null });
      expect(hook.getCurrent().observation).toBeNull();
    } finally { await hook.unmount(); }
  });
  it('keeps a newer selected exchange observation when an earlier root control completes late', async () => {
    const { useSessionExchangeControl } = await import('@/hooks/session/useSessionExchangeControl');
    installSession('banner-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: body => ({ body: {
      state, observedRevision: body == null ? 'session-message-row-revision:v1:3' : 'session-message-row-revision:v1:4' } }) });
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-2', { body: { state, observedRevision: 'session-message-row-revision:v1:8' } });
    const hook = await renderHook(({ root }: { root: string }) => useSessionExchangeControl({ serverId, sessionId: 'banner-session' }, root),
      { initialProps: { root: 'root-1' } });
    await vi.waitFor(() => expect(hook.getCurrent().observation?.originInputLocalId).toBe('root-1'));
    const held = holdSessionResponseBody('banner-session', '/exchanges/root-1', 'POST');
    let operation: Promise<unknown> | undefined;
    try {
      await act(async () => { operation = hook.getCurrent().control('continue'); await held.reading; });
      await hook.rerender({ root: 'root-2' });
      await vi.waitFor(() => expect(hook.getCurrent().observation?.originInputLocalId).toBe('root-2'));
      await act(async () => { held.release(); await operation; });
      expect(hook.getCurrent().observation).toMatchObject({ originInputLocalId: 'root-2',
        status: { observedRevision: 'session-message-row-revision:v1:8' } });
    } finally { held.release(); held.restore(); await hook.unmount(); }
  });
  it('delivers an attributed approval receipt through its Session machine admission', async () => {
    installSession('receipt-session', { machineId: 'machine-a', path: '/repo' });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const machine = { ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' }),
      installationId: 'receipt-installation', installationPublicKey: encodeBase64(installation.publicKey),
      operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine } });
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const { buildApprovalRequestArtifactHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
    const { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
    const attribution = { requestRef: 'original-input', requester: { serverId: 'srv_mode_home', accountId: 'alice' },
      persona: { serverId: 'srv_mode_home', sessionId: 'receipt-session' }, origin: null };
    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'agent', sessionId: 'receipt-session' }, requestedSurface: 'agent',
      approval: { flow: 'deferred', result: 'optional' }, actionId: 'session.status.set_reason',
      actionArgs: { reason: 'Completed' }, summary: 'Set status',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: 'receipt-session', starterDepth: 0, turnDepth: 0 },
        serverId, serverIdentityId: 'srv_mode_home', accountId: 'alice', machineId: 'machine-a',
        actionId: 'session.status.set_reason', requestId: 'receipt-request', actionRequestAttributionV1: attribution },
      decision: { kind: 'approve', decidedAtMs: 1, authority: 'present_user' },
      execution: { executedAtMs: 2, ok: true, result: { ok: true, sessionId: 'receipt-session', reason: 'Completed', version: 2 } },
    });
    const artifactId = 'approved-receipt';
    expect((await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: artifactId,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) }))?.ok).toBe(true);
    for (const actionId of ['action.spec.get', 'session.message.send'] as const) {
      homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: { v: 1, token: 'receipt-root', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: 'srv_mode_home', machineId: 'machine-a', installationId: 'receipt-installation', custodianAccountId: 'alice',
          accountEncryptionMode: 'plain', actionId, requestId: authorized.envelope.requestId,
          target: authorized.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(authorized.envelope) } } };
      } });
    }
    homes.answer(serverId, '/v1/actions/action.spec.get', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, actionId: 'action.spec.get', requestId: authorized.envelope.requestId, execution: { ok: true,
        result: { actionSpec: actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface: 'mcp', includeOutputSchema: false }) } } } };
    } });
    homes.answer(serverId, '/v1/actions/session.message.send', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(authorized.envelope).toMatchObject({ target: { kind: 'machine', machineId: 'machine-a' }, input: {
        sessionId: 'receipt-session', localId: `approval-result:${artifactId}`, reply: 'none', requestedAction: { v: 1, kind: 'enqueue' },
        message: expect.stringContaining(artifactId) } });
      expect(openExternalActionRequesterAccountContextV1({ authorization: authorized.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'receipt-installation', serverIdentityId: 'srv_mode_home',
        installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({ invocation: {
          caller: { kind: 'host' }, surface: 'mcp', authority: 'account_automation', actionRequestAttributionV1: attribution } });
      return { body: { v: 1, actionId: 'session.message.send', requestId: authorized.envelope.requestId,
        execution: { ok: true, result: { status: 'accepted', localId: `approval-result:${artifactId}` } } } };
    } });
    const result = await createDefaultActionExecutor().replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user',
      currentAccount: { accountId: 'alice', serverId, serverIdentityId: 'srv_mode_home' } });
    expect(homes.requestsFor('/v2/sessions/receipt-session/pending')).toHaveLength(0);
    expect(homes.requestsFor('/v1/actions/session.message.send'), JSON.stringify(result)).toHaveLength(1);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  });
  it.each(['ui', 'repeated_send', 'human_return', 'composer', 'composer_wait', 'composer_group', 'composer_presentation_retired', 'composer_account_retired', 'voice', 'legacy', 'schema_legacy', 'extended_send', 'triage_send', 'triage_schema_unavailable', 'native_command', 'schema_nested_legacy', 'schema_nested_legacy_none', 'review_send'] as const)('keeps an Ask on the canonical daemon send owner with its exact input and observation intent (%s)', async client => {
    const triage = client === 'triage_send' || client === 'triage_schema_unavailable';
    const surface = client === 'voice' ? 'voice' : triage ? 'plugin' : 'ui';
    const triageCaller = { kind: 'plugin' as const, pluginId: 'happier.triage', contributionLocalId: 'sessions/run-configured-v1',
      occurrenceId: '["@happier-dev/plugins-triage","happier.triage","0.0.0"]' };
    const retiring = client === 'composer_presentation_retired' || client === 'composer_account_retired';
    const group = client === 'composer_group' || retiring;
    const reply = client === 'human_return' || client === 'composer' || group ? 'return' : client === 'extended_send' || triage || client === 'native_command' || client === 'schema_nested_legacy_none' || client === 'review_send' ? 'none' : 'wait';
    const humanReturn = client === 'human_return' || client === 'composer' || group ? { returnToSessionId: 'origin-session' } : {};
    const presentation = new AbortController();
    const accepted = createDeferred<void>();
    const lateReceipt = createDeferred<void>();
    const withReview = client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none' || client === 'review_send';
    const withStructuredInput = client === 'ui' || client === 'repeated_send' || client === 'schema_legacy' || withReview;
    const overrides = client === 'extended_send' ? { modelOverride: 'provider/claude-sonnet',
      providerConnectionId: 'pc_01J00000000000000000000000' } : {};
    installSession('ask-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude',
      hostPid: 101, hostProcessStartTimeMs: 10, hostProcessInstanceFingerprint: 'ask-occurrence-1' });
    if (group) {
      for (const id of ['refused-session', 'pass-session']) installSession(id, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
      homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: ['ask-session', 'refused-session', 'pass-session'].map(id => ({
          ...createPlainSessionCurrentProjectionRecordFixture({ id, manager: { sessionId: 'origin-session' }, metadata: { path: '/repo', host: 'tester.local', machineId: 'machine-a', flavor: 'claude' } }),
          viewer: createSessionViewerFixture(),
        })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) });
    }
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const messagingMachine = { ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' }),
      installationId: 'ask-installation', installationPublicKey: encodeBase64(installation.publicKey),
      ...(client === 'legacy' || client === 'extended_send' || client === 'native_command' ? {} : { operationProtocolCapabilities: {
        sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] },
      }, operationProtocolCapabilitiesRevision: 1 }) };
    homes.answer(serverId, '/v1/machines', { body: [messagingMachine] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: messagingMachine } });
    if (client === 'extended_send' || triage || client === 'native_command' || client === 'schema_nested_legacy_none' || client === 'review_send') {
      const sessions = { ...storage.getState().sessions };
      delete sessions['ask-session'];
      storage.setState({ sessions });
      const baseline = createRootLayoutFeaturesResponse();
      const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
        session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
      const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
      homes.answer(serverId, '/v2/sessions/ask-session/pending', { select: body => {
        const input = StrictJsonValueSchema.parse(body);
        if (!input || typeof input !== 'object' || !('localId' in input) || !('requestedAction' in input)) throw new Error('Expected Pending input');
        return { body: { requestedAction: input.requestedAction, pending: { localId: input.localId } } };
      } });
    }
    for (const actionId of ['action.spec.get', 'session.message.send'] as const) homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, token: 'ask-root', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
        serverIdentityId: 'srv_mode_home', machineId: 'machine-a', installationId: 'ask-installation', custodianAccountId: 'alice',
        accountEncryptionMode: 'plain', actionId, requestId: authorized.envelope.requestId,
        target: authorized.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(authorized.envelope) } } };
    } });
    const definition = actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface, includeOutputSchema: false });
    function withoutAdvertisedReviewMember(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(withoutAdvertisedReviewMember);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'reviewComments')
        .map(([key, item]) => [key, withoutAdvertisedReviewMember(item)]));
    }
    let legacyOccurrence = false;
    homes.answer(serverId, '/v1/actions/action.spec.get', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (client === 'triage_schema_unavailable') return { body: { v: 1, actionId: 'action.spec.get',
        requestId: authorized.envelope.requestId, execution: { ok: false,
          errorCode: 'plugin_action_execution_placement_unavailable', error: 'plugin_action_execution_placement_unavailable' } } };
      return { body: { v: 1, actionId: 'action.spec.get', requestId: authorized.envelope.requestId, execution: { ok: true,
        result: { actionSpec: client === 'schema_legacy' || legacyOccurrence ? { ...definition, inputSchema: { type: 'object', properties: {
          sessionId: { type: 'string' }, message: { type: 'string' }, reply: { enum: ['none', 'wait', 'return'] },
        }, additionalProperties: true } } : client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none'
          ? { ...definition, inputSchema: withoutAdvertisedReviewMember(definition.inputSchema) } : definition } } } };
    } });
    const structuredInput = withReview ? { v: 1 as const,
      reviewComments: { sessionId: 'source-session', comments: [] } }
      : { v: 1 as const, mentions: [{ kind: 'happier.session', ref: 'session:source', token: 'find' }] };
    const outcome = SessionMessageSendResultV1Schema.parse(client === 'composer_wait' ? { status: 'replied', localId: 'ask-input',
      outcome: { kind: 'answer', text: 'Inline answer', messageRef: { kind: 'session', session: { serverId, sessionId: 'ask-session' }, messageId: 'inline-answer' } },
    } : { status: 'accepted', localId: 'ask-input' });
    let boundaryFailure: unknown;
    const sentTo: string[] = [];
    let retrying = false;
    homes.answer(serverId, '/v1/actions/session.message.send', { select: async body => {
      try {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (authorized.envelope.v !== 1) throw new Error('Expected the plain Ask fixture envelope');
      const receiver = group && authorized.envelope.input && typeof authorized.envelope.input === 'object'
        && 'sessionId' in authorized.envelope.input ? authorized.envelope.input.sessionId : 'ask-session';
      if (typeof receiver !== 'string' || !['ask-session', 'refused-session', 'pass-session'].includes(receiver)) throw new Error('Unexpected exact receiver');
      sentTo.push(receiver);
      expect(authorized.envelope).toMatchObject({ target: { kind: 'machine', machineId: 'machine-a' }, input: triage ? {
        sessionId: 'ask-session', message: 'What did you find?', idempotencyKey: 'triage-receipt-input',
      } : client === 'native_command' ? {
        sessionId: 'ask-session', kind: 'sessionSubagentCommand', command: { kind: 'agent_team_delete', teamId: 'team-1' },
        localId: 'ask-input', idempotencyKey: 'native-command-1',
      } : {
        sessionId: receiver, message: 'What did you find?', reply, localId: client === 'repeated_send' ? expect.any(String) : 'ask-input', timeoutSeconds: 61,
        ...humanReturn,
        requestedAction: { v: 1, kind: 'send_now' },
        ...overrides,
        ...(withStructuredInput ? { structuredInput } : {}),
      } });
      expect(openExternalActionRequesterAccountContextV1({ authorization: authorized.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'ask-installation', serverIdentityId: 'srv_mode_home',
        installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({ invocation: {
          caller: triage ? triageCaller : { kind: 'host' }, surface,
          authority: surface === 'plugin' ? 'account_automation' : 'present_user' } });
      if (retiring && !retrying && sentTo.length === 3) {
        // All concrete effects have reached the real transport; hold only the
        // last receipt while the presenting composer leaves.
        accepted.resolve();
        await lateReceipt.promise;
      }
      return { body: { v: 1, actionId: 'session.message.send', requestId: authorized.envelope.requestId, execution:
        receiver === 'refused-session' && !retrying ? { ok: false, errorCode: 'permission_denied', error: 'Unavailable' } : { ok: true, result: outcome } } };
      } catch (error) { boundaryFailure = error; throw error; }
    } });
    const input = triage ? {
      sessionId: 'ask-session', message: 'What did you find?', idempotencyKey: 'triage-receipt-input',
    } as const : client === 'native_command' ? {
      sessionId: 'ask-session', kind: 'sessionSubagentCommand', command: { kind: 'agent_team_delete', teamId: 'team-1' },
      localId: 'ask-input', idempotencyKey: 'native-command-1',
    } as const : {
      sessionId: group ? { selector: 'workers', of: 'origin-session' } : 'ask-session', message: 'What did you find?', reply, localId: 'ask-input', timeoutSeconds: 61,
      ...humanReturn,
      requestedAction: { v: 1, kind: 'send_now' },
      ...overrides,
      ...(withStructuredInput ? { structuredInput } : {}),
    } as const;
    let sourceEntry: unknown;
    let composerScope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | undefined;
    const { createSessionDraftRepository } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftValues = new Map<string, string>();
    const createDrafts = () => createSessionDraftRepository({ storage: {
      getString: key => draftValues.get(key), getAllKeys: () => [...draftValues.keys()], set: (key, value) => { draftValues.set(key, value); }, delete: key => { draftValues.delete(key); },
    }, cipher: { seal: async () => { throw new Error('Local retry custody must never be uploaded'); }, open: async () => null },
      syncEnabled: false, randomUUID: () => 'ask-input' });
    let drafts = createDrafts();
    const composerSubmit = async () => {
      const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
      const scope = await runWithServerRequestAuthorityForServerAccountScope({ serverId,
        activeRequest: async () => { throw new Error('Composer fixture requires its captured Home authority'); },
      }, async authority => authority.scope);
      expect(scope.accountId).toBe('alice');
      composerScope = scope;
      drafts.writeExistingSessionDraft({ scope, sessionId: 'origin-session', patch: { text: 'What did you find?' } });
      const draftIntent = { kind: 'ask', target: group ? { selector: 'workers' as const, of: 'origin-session' } : 'ask-session',
        reply: client === 'composer_wait' ? 'wait' : 'return' } as const;
      drafts.getOrCreateSessionMessagingDraftMutationAttempt({ scope, sessionId: 'origin-session', intent: draftIntent,
        currentness: drafts.captureSessionDraftCurrentness({ scope, address: { kind: 'session', sessionId: 'origin-session' } }) });
      installSession('origin-session', { path: '/repo', machineId: 'machine-a' }, serverId, 1);
      homes.answer(serverId, '/v2/sessions/origin-session/messages', { select: body => {
        sourceEntry = body;
        if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') throw new Error('Source write requires its exact localId');
        return { body: { didWrite: true, message: { id: 'composer-source-entry', localId: body.localId, seq: 1, createdAt: 10 } } };
      } });
      const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
      const { submitSessionComposerMessagingAction, readSessionComposerMessagingHandoff } = await import('@/components/sessions/composer/sessionComposerMessaging');
      const { submitComposerSnapshot } = await import('@/components/sessions/composer/composerSubmissionCoordinator');
      let actionResult: Awaited<ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>> | undefined;
      const ref = { kind: 'session', sessionId: 'origin-session' } as const;
      const { ComposerSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/composer');
      const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
      const account = captureActiveServerAccountScopeLifetime();
      if (!account) throw new Error('Composer requires a captured Account lifetime');
      const submission = submitComposerSnapshot({ signal: presentation.signal, snapshot: ComposerSnapshotV1Schema.parse({ ref, revision: 1, text: 'What did you find?', references: [], attachments: [],
        layout: 'wrap', capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: true, editable: true, submittable: true, submitting: false, running: false } }),
        clearAcceptedSnapshot: () => true, route: { kind: 'session', ref, admit: async (snapshot, handoff) => {
          actionResult = await submitSessionComposerMessagingAction({ execute: createFrontDoorActionExecute(createDefaultActionExecutor()),
            draftRepository: drafts,
            actionInput: input, context: { ...context(), signal: presentation.signal }, scope, sessionId: 'origin-session', localId: 'ask-input',
            text: snapshot.text, intent: { kind: 'ask', target: group ? { selector: 'workers', of: 'origin-session' } : 'ask-session', reply: client === 'composer_wait' ? 'wait' : 'return' },
            isCurrent: () => account.isCurrent() && !presentation.signal.aborted, isAccountCurrent: account.isCurrent });
          if (presentation.signal.aborted) return { status: 'rejected' };
          if (readSessionComposerMessagingHandoff(actionResult) !== 'accepted') return { status: 'rejected' };
          handoff.accept(); return { status: 'accepted' };
        } } });
      if (retiring) {
        // Attach rejection handling before retiring the real captured authority.
        const settled = submission.then(value => ({ value }), error => ({ error }));
        try {
          await accepted.promise;
          presentation.abort();
          installSession('newly-focused-session', { path: '/elsewhere', machineId: 'machine-a' }, serverId, 1);
          if (client === 'composer_account_retired') {
            const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            retireActiveServerAccountScopeLifetime();
          }
        } finally { lateReceipt.resolve(); }
        const outcome = await settled;
        if (client === 'composer_account_retired') {
          expect('error' in outcome).toBe(true);
          expect(homes.requestsFor('/v2/sessions/origin-session/messages')).toHaveLength(0);
          expect(homes.requestsFor('/v2/sessions/newly-focused-session/messages')).toHaveLength(0);
          drafts = createDrafts();
          expect(drafts.readSessionMessagingDraftMutationAttempt({ scope, sessionId: 'origin-session' })?.custody?.results).toEqual([]);
          return null;
        }
        if ('error' in outcome) throw outcome.error;
        expect(outcome.value.status).toBe('rejected');
        expect(homes.requestsFor('/v2/sessions/origin-session/messages')).toHaveLength(1);
        expect(homes.requestsFor('/v2/sessions/newly-focused-session/messages')).toHaveLength(0);
        drafts = createDrafts();
        expect(drafts.readSessionMessagingDraftMutationAttempt({ scope, sessionId: 'origin-session' })?.custody?.results).toHaveLength(3);
      } else {
        expect(await submission).toMatchObject(group ? { status: 'rejected', snapshot: { text: 'What did you find?' } } : { status: 'accepted', cleared: true });
      }
      const expectedTargets = [
          { target: { serverId: group ? serverId : scope.serverId, sessionId: 'ask-session' }, localId: 'ask-input', immediate: client === 'composer_wait'
            ? { status: 'replied', outcome: 'answer', resultRef: { messageId: 'inline-answer' } } : { status: 'accepted' } },
          ...(group ? [
            { target: { serverId, sessionId: 'pass-session' }, localId: 'ask-input', immediate: { status: 'accepted' } },
            { target: { serverId, sessionId: 'refused-session' }, localId: 'ask-input', immediate: { status: 'rejected', code: 'permission_denied' } },
          ] : []),
        ];
      expect(sourceEntry).toMatchObject({ messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: {
        type: 'message', message: 'What did you find?', sessionMessageInvocationV1: { localId: 'ask-input', reply: client === 'composer_wait' ? 'wait' : 'return',
          targets: group ? expect.arrayContaining(expectedTargets) : expectedTargets },
      } } } } });
      if (!actionResult) throw new Error('Composer must publish its Action result');
      return actionResult;
    };
    // Account bootstrap deliberately refreshes the complete Machine census;
    // measure only the sends after that fixture-owned acquisition has settled.
    const machineListReadsBeforeSend = homes.requests.filter(request => request.path.split('?')[0] === '/v1/machines').length;
    const result = client === 'composer' || client === 'composer_wait' || group ? await composerSubmit() : surface === 'voice'
      ? JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({
          resolveSessionId: explicit => explicit ?? 'origin-session', currentSessionAddress: { serverId, sessionId: 'origin-session' },
        }).action_execute({ actionId: 'session.message.send', input }, { serverId }))
      : await createDefaultActionExecutor().execute('session.message.send', input, triage
        ? { ...context(), surface, authority: 'account_automation', actionCaller: { ...triageCaller, pluginVersion: '0.0.0' } }
        : context());
    if (client === 'legacy' || client === 'schema_legacy' || client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none' || client === 'triage_schema_unavailable') {
      // A known refusal before dispatch is a domain rejection; the plugin SDK
      // must not throw it into Triage's genuinely ambiguous transport catch.
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'rejected',
        code: client === 'triage_schema_unavailable' ? 'session_input_target_unavailable' : 'session_input_target_update_required' } });
      expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(0);
      expect(homes.requestsFor('/v2/sessions/ask-session/pending')).toHaveLength(0);
      expect(outgoing.some(request => request.method.endsWith(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM))).toBe(false);
      return;
    }
    expect(boundaryFailure).toBeUndefined();
    if (client === 'composer_account_retired') return;
    if (group) {
      expect(result).toMatchObject({ ok: true, result: { kind: 'fanout', results: expect.arrayContaining([
        { target: { serverId, sessionId: 'refused-session' }, result: expect.objectContaining({ ok: false, errorCode: 'permission_denied' }) },
      ]) } });
      const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
      const { reducer, createReducer } = await import('@happier-dev/session-core/reducer');
      const record = StrictJsonValueSchema.parse(sourceEntry);
      if (!record || typeof record !== 'object' || !('content' in record)) throw new Error('Composer must persist its plain source entry');
      const content = record.content;
      if (!content || typeof content !== 'object' || !('v' in content)) throw new Error('Composer source requires its plain content envelope');
      const raw = normalizeRawMessage('reloaded-source', 'source-entry', 10, content.v, { messageRole: 'event', seq: 1 });
      if (!raw) throw new Error('Persisted source must normalize');
      const sourceState = createReducer();
      const message = reducer(sourceState, [raw]).messages[0];
      if (!message) throw new Error('Persisted source must reload');
      homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: () => ({ body: { results: [
        { sessionId: 'ask-session', localId: 'ask-input', reply: { v: 1, status: 'available', progress: { v: 1, mode: 'return',
          humanOrigin: { sessionId: 'origin-session' }, disposition: 'returned', outcome: { kind: 'answer', result: { sessionId: 'ask-session', messageId: 'later-answer' } } } } },
        { sessionId: 'pass-session', localId: 'ask-input', reply: { v: 1, status: 'available', progress: { v: 1, mode: 'return',
          humanOrigin: { sessionId: 'origin-session' }, disposition: 'returned', outcome: { kind: 'pass' } } } },
      ] } }) });
      const { useSessionMessageInvocation } = await import('@/components/sessions/transcript/references/useSessionMessageInvocation');
      if (!composerScope) throw new Error('Composer must retain its actual captured Home scope');
      homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: 'new-worker', manager: { sessionId: 'origin-session' } }), viewer: createSessionViewerFixture() }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) });
      const membershipReads = homes.requestsFor('/v2/sessions/query').length;
      const hook = await renderHook(useSessionMessageInvocation, { initialProps: {
        scope: composerScope, sessionId: 'origin-session', message, active: true,
      } });
      await flushHookEffects({ cycles: 20 });
      expect(hook.getCurrent()).toMatchObject({ status: 'ready', targets: expect.arrayContaining([
        { target: { serverId, sessionId: 'ask-session' }, localId: 'ask-input', requestBound: true, status: 'answered', resultRef: { kind: 'session', session: { serverId, sessionId: 'ask-session' }, messageId: 'later-answer' }, replyStatus: 'available' },
        { target: { serverId, sessionId: 'pass-session' }, localId: 'ask-input', requestBound: true, status: 'passed', resultRef: null, replyStatus: 'available' },
        { target: { serverId, sessionId: 'refused-session' }, localId: 'ask-input', requestBound: false, status: 'failed', code: 'permission_denied', resultRef: null, replyStatus: 'not_requested' },
      ]) });
      const current = hook.getCurrent();
      const { ActionSessionFanoutResultV1Schema } = await import('@happier-dev/protocol/actions/sessionTargetV1');
      if (current.status !== 'ready' || !result.ok) throw new Error('Composer group requires its source invocation and Action results');
      expect(current.targets).toHaveLength(3);
      expect(current.invocation.targets.map(row => row.target)).toEqual(ActionSessionFanoutResultV1Schema.parse(result.result).results.map(row => row.target));
      expect(homes.requestsFor('/v2/sessions/query')).toHaveLength(membershipReads);
      // Reload the private owner, then retry after the worker membership changed.
      // The public transcript remains presentation, and supplies no executable operands.
      drafts = createDrafts();
      retrying = true;
      sentTo.length = 0;
      const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
      const { submitSessionComposerMessagingAction, readSessionComposerMessagingHandoff } = await import('@/components/sessions/composer/sessionComposerMessaging');
      const retryScope = composerScope;
      const retry = () => submitSessionComposerMessagingAction({ execute: createFrontDoorActionExecute(createDefaultActionExecutor()),
        draftRepository: drafts, actionInput: input, context: context(), scope: retryScope, sessionId: 'origin-session', localId: 'ask-input',
        text: 'What did you find?', intent: { kind: 'ask', target: { selector: 'workers', of: 'origin-session' }, reply: 'return' },
        isCurrent: () => true, isAccountCurrent: () => true });
      const retried = await retry();
      expect(homes.requestsFor('/v2/sessions/query')).toHaveLength(membershipReads);
      expect(sentTo).toEqual(['refused-session']);
      expect(readSessionComposerMessagingHandoff(retried)).toBe('accepted');
      const retriedRecord = StrictJsonValueSchema.parse(sourceEntry);
      if (!retriedRecord || typeof retriedRecord !== 'object' || !('content' in retriedRecord)) throw new Error('Retry source entry required');
      const retriedContent = retriedRecord.content;
      if (!retriedContent || typeof retriedContent !== 'object' || !('v' in retriedContent)) throw new Error('Retry plain source content required');
      const retriedRaw = normalizeRawMessage('reloaded-source', 'source-entry', 10, retriedContent.v, { messageRole: 'event', seq: 1 });
      if (!retriedRaw) throw new Error('Retry source must normalize');
      const corrected = reducer(sourceState, [{ ...retriedRaw, isAuthoritativeUpdate: true }]).messages;
      expect(corrected).toHaveLength(1);
      expect(sourceState.messages.size).toBe(1);
      await hook.rerender({ scope: composerScope, sessionId: 'origin-session', message: corrected[0]!, active: true });
      await flushHookEffects({ cycles: 20 });
      expect(hook.getCurrent()).toMatchObject({ status: 'ready', sourceRowId: message.id, targets: expect.arrayContaining([
        expect.objectContaining({ target: { serverId, sessionId: 'ask-session' }, status: 'answered' }),
        expect.objectContaining({ target: { serverId, sessionId: 'pass-session' }, status: 'passed' }),
        expect.objectContaining({ target: { serverId, sessionId: 'refused-session' }, requestBound: true, status: 'queued' }),
      ]) });
      expect(retried).toMatchObject({ ok: true, result: { kind: 'fanout', results: expect.arrayContaining([
        { target: { serverId, sessionId: 'ask-session' }, result: { ok: true, result: outcome } },
        { target: { serverId, sessionId: 'pass-session' }, result: { ok: true, result: outcome } },
        { target: { serverId, sessionId: 'refused-session' }, result: { ok: true, result: outcome } },
      ]) } });
      expect(await retry()).toEqual(retried);
      expect(sentTo).toEqual(['refused-session']);
      expect(drafts.clearSessionMessagingDraftMutationAttempt({ scope: composerScope, sessionId: 'origin-session', localId: 'ask-input' })).toBe(true);
      expect(drafts.readSessionMessagingDraftMutationAttempt({ scope: composerScope, sessionId: 'origin-session' })).toBeNull();
      return;
    }
    expect(result, JSON.stringify(homes.requestsFor('/v1/actions/session.message.send').map(request => request.path))).toMatchObject({ ok: true, result: outcome });
    expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(1);
    expect(homes.requestsFor('/v2/sessions/ask-session/pending')).toHaveLength(0);
    if (client === 'repeated_send') {
      let sendNumber = 0;
      const send = () => createDefaultActionExecutor().execute('session.message.send', { ...input, localId: `ask-input-${++sendNumber}` }, context());
      for (const sent of await Promise.all([send(), send()])) expect(sent).toEqual({ ok: true, result: outcome });
      expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(3);
      // Repeated waited sends know their host: no Machine census per input.
      expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/machines')).toHaveLength(machineListReadsBeforeSend);
      const selectedReads = homes.requestsFor('/v1/machines/read-batch');
      expect(selectedReads.length).toBeGreaterThan(0);
      for (const read of selectedReads) expect(read.input).toEqual({ machineIds: ['machine-a'] });
      expect(homes.requestsFor('/v1/actions/action.spec.get')).toHaveLength(1);
      const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
      publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: 'machine-a' }, 'authority');
      for (const sent of await Promise.all([send(), send()])) expect(sent).toEqual({ ok: true, result: outcome });
      expect(homes.requestsFor('/v1/actions/action.spec.get')).toHaveLength(2);
      expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(5);
      legacyOccurrence = true;
      const metadata = { path: '/repo', host: 'tester.local', machineId: 'machine-a', flavor: 'claude',
        hostPid: 102, hostProcessStartTimeMs: 20, hostProcessInstanceFingerprint: 'ask-occurrence-2' };
      installSession('ask-session', metadata, serverId, 1, createPlainSessionCurrentProjectionRecordFixture({
        id: 'ask-session', active: true, metadata, metadataVersion: 10 }));
      const changed = await send();
      expect(changed, JSON.stringify({ specReads: homes.requestsFor('/v1/actions/action.spec.get').length,
        sessionReads: homes.requestsFor('/v2/sessions/ask-session').length,
        originalExecution: getActionSpec('session.message.send').originalExecution })).toMatchObject({ ok: true, result: { status: 'rejected', code: 'session_input_target_update_required' } });
      expect(homes.requestsFor('/v1/actions/action.spec.get')).toHaveLength(3);
      expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(5);
    }
  });
  it('inspects an exact continuation through the selected Session daemon', async () => {
    installSession('inspect-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const selection = { v: 1, agentId: 'codex' };
    daemonAnswer = () => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const result = await createDefaultActionExecutor().execute('session.continuation.inspect', { sessionId: 'inspect-session', selection }, context());
    expect(result, JSON.stringify(result))
      .toMatchObject({ ok: true, result: { status: 'answered', inspection: { type: 'available' } } });
    expect(outgoing).toEqual([{ method: `machine-a:${RPC_METHODS.SESSION_CONTINUATION_INSPECT}`,
      params: { v: 1, sourceSessionId: 'inspect-session', selection } }]);
  });
  it('switches an ordinary layout1 Session to qualified Pi before its owner control projection is resident', async () => {
    const sessionId = 'cold-pi-session';
    installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' }, serverId, 1);
    const unresolved = buildSessionListRenderableFromSession({ ...storage.getState().sessions[sessionId],
      metadataLayoutVersion: 1, ownerMetadataView: null });
    storage.setState({ sessions: {}, sessionListRowsByServerId: { [serverId]: { [sessionId]: unresolved } } });
    const request = { sessionId, expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'happier.agent.pi/pi', modelId: 'openai/fake-model' },
      input: { localId: 'cold-pi-input', text: 'Continue with the same history', meta: {} } };
    let received: unknown;
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId: 'machine-a', tokenEpoch: 0, actionId: 'session.agent.transition',
      execute: (input, { target }) => {
        expect(target).toEqual({ kind: 'machine', machineId: 'machine-a' });
        received = input;
        return { type: 'accepted', localId: request.input.localId };
      },
    });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({ presentUserActionConfirmation: async () => true }));
    const result = await execute.confirmed('session.agent.transition', request, {
      ...context(), actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'accepted', localId: request.input.localId } });
    expect(received).toEqual(request);
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
  });
  it.each(['accepted', 'rejected', 'agent_signed_out', 'credential_scope_denied', 'action_outcome_unknown'] as const)('switches through the same Session daemon without replacing the exact first input (%s)', async outcomeKind => {
    installSession('switch-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const selection = { v: 1, agentId: 'codex' };
    const request = { sessionId: 'switch-session', expectedCurrentAgentId: 'claude', selection,
      input: { localId: 'retained-input', text: 'Expanded prompt', meta: { displayText: 'Attachment', reasoningEffort: 'high' } } };
    let transitionInput: unknown;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://mode-actions.test',
      serverIdentityId: 'srv_mode_home', accountId: 'alice', machineId: 'machine-a', tokenEpoch: 0,
      actionId: 'session.agent.transition',
      failure: () => outcomeKind === 'credential_scope_denied' || outcomeKind === 'action_outcome_unknown'
        ? { errorCode: outcomeKind, error: outcomeKind } : null,
      execute: (input, { invocation }) => {
        expect(invocation).toMatchObject({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
        transitionInput = input;
        return outcomeKind === 'agent_signed_out' ? { type: 'partially_applied', localId: 'retained-input', applied: 'current_view_committed',
          code: 'target_start_failed', errorDetail: { kind: 'launch_error', code: 'agent_signed_out', message: 'Sign in',
            failureCause: { requestId: 'retained-input', phase: 'authentication', failureReason: 'authentication_required' } } }
          : outcomeKind === 'accepted' ? { type: 'accepted', localId: 'retained-input' }
          : { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' };
      } });
    homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: boundary.machine } });
    for (const path of ['/v1/machines/read-batch', '/v1/actions/session.agent.transition/execution-authorization',
      '/v1/actions/session.agent.transition']) homes.answer(serverId, path, { select: async (_input, request) => {
      const response = await boundary.handle(new URL(request.url), request.init);
      if (!response) throw new Error('Unrecognized external Action fixture request');
      return { status: response.status, body: await response.json() };
    } });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    daemonAnswer = rpc => rpc.method.endsWith(RPC_METHODS.SESSION_CONTINUATION_INSPECT)
      ? { type: 'available', protocolVersion: 1, sameSessionTransition: true }
      : { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' };
    const execute = createDefaultActionExecutor().execute;
    expect(await execute('session.continuation.inspect', { sessionId: request.sessionId, selection }, context()))
      .toMatchObject({ ok: true, result: { status: 'answered', inspection: { type: 'available' } } });
    const { continueSessionWithArmedAgent } = await import('@/sync/domains/session/input/continueSessionWithArmedAgent');
    const switched = await continueSessionWithArmedAgent({ status: 'ready', submission: {
      machineId: 'machine-a', serverId, sessionId: request.sessionId, localId: request.input.localId,
      sourceAgentLabel: 'Claude', targetAgentLabel: 'Codex', input: request.input,
      intent: { v: 1, mode: 'same_session', sourceAgentId: 'claude', selection: { v: 1, agentId: 'codex' } },
    } });
    expect(outgoing.map(rpc => rpc.method)).toEqual([`machine-a:${RPC_METHODS.SESSION_CONTINUATION_INSPECT}`]);
    expect(transitionInput).toEqual(request);
    expect(storage.getState().sessions['switch-session']?.metadata?.flavor).toBe('claude');
    if (outcomeKind === 'agent_signed_out') {
      expect(switched.result).toMatchObject({ type: 'partially_applied', code: 'target_start_failed',
        errorDetail: { code: 'agent_signed_out' } });
      expect(switched.disposition.notice?.message).toContain('agent_signed_out');
      return;
    }
    expect(switched.result).toEqual(outcomeKind === 'accepted' ? { type: 'accepted', localId: 'retained-input' }
      : outcomeKind === 'rejected' ? { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' }
      : outcomeKind === 'action_outcome_unknown' ? { type: 'outcome_unknown', localId: 'retained-input' } : null);
    expect(switched.disposition.draft).toBe(outcomeKind === 'accepted' ? 'clear' : 'preserve');
    expect(switched.disposition.send).toBe(outcomeKind === 'action_outcome_unknown' ? 'block' : 'allow');
    if (outcomeKind === 'credential_scope_denied') {
      const { resolveActionExecutionFailureMessage } = await import('./resolveActionExecutionFailureMessage');
      expect(switched.disposition.notice?.message).toBe(resolveActionExecutionFailureMessage(
        { ok: false, errorCode: outcomeKind, error: outcomeKind }, outcomeKind));
    }
  });
  it.each([
    { active: false, listOnly: false },
    { active: true, listOnly: false },
    { active: true, listOnly: true },
  ])('executes goal get, wake and clear through the selected Session daemon (%j, no native controls)', async ({ active, listOnly }) => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'codex', codexSessionId: 'native-thread' });
    const session = storage.getState().sessions['goal-session'];
    storage.setState({ sessions: { ...storage.getState().sessions, 'goal-session': { ...session, active } },
      machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: { ...createMachineFixture().metadata!, host: 'goal.test', daemonSessionGoalControlsSupported: true } }) } });
    if (listOnly) {
      const retained = { ...storage.getState().sessions['goal-session'], metadata: {
        ...session.metadata!, flavor: 'opencode',
      } };
      expect(supportsEditableSessionGoals({ agentId: 'opencode', session: retained, daemonGoalControlsSupported: true })).toBe(true);
      storage.setState({ sessions: {},
        sessionListRowsByServerId: { [serverId]: { 'goal-session': buildSessionListRenderableFromSession(retained) } },
        ordinarySessionListMembershipByServerId: { [serverId]: ['goal-session'] },
        sessionListIndexByServerId: { [serverId]: [{ type: 'session', sessionId: 'goal-session', serverId, serverName: 'Mode Home' }] },
      });
    }
    daemonAnswer = request => {
      if (request.method.startsWith('goal-session:')) return { ok: false,
        errorCode: 'unsupported_session_runtime_method', error: `unsupported_session_runtime_method:${request.method.split(':')[1]}` };
      const schema = request.method.endsWith(RPC_METHODS.DAEMON_SESSION_GOAL_GET) ? DaemonSessionGoalGetRequestV1Schema
        : request.method.endsWith(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR) ? DaemonSessionGoalClearRequestV1Schema
          : DaemonSessionGoalSetRequestV2Schema;
      expect(schema.parse(request.params)).toMatchObject({ sessionId: 'goal-session' });
      return { workState: null };
    };
    const executor = createDefaultActionExecutor();
    const goalSet = await executor.execute('session.goal.set', { sessionId: 'goal-session', objective: 'Finish the task', tokenBudget: null }, context());
    expect(goalSet, JSON.stringify(goalSet)).toMatchObject({ ok: true, result: { ok: true } });
    const goalGet = await executor.execute('session.goal.get', { sessionId: 'goal-session' }, context());
    expect(goalGet, JSON.stringify(goalGet))
      .toMatchObject({ ok: true, result: { workState: null } });
    expect(await executor.execute('session.goal.clear', { sessionId: 'goal-session' }, context()))
      .toMatchObject({ ok: true });
    expect(outgoing.map(request => request.method)).toEqual([
      'machine-a:daemon.sessionGoal.set.v2', `machine-a:${RPC_METHODS.DAEMON_SESSION_GOAL_GET}`,
      `machine-a:${RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR}`,
    ]);
    expect(outgoing[0]?.params).toMatchObject({ sessionId: 'goal-session', objective: 'Finish the task',
      tokenBudget: null, resumeInactiveWithInitialGoal: true });
  });
  it.each([
    { status: 'blocked' as const },
    { objective: 'Finish the task', status: 'blocked' as const },
    { status: 'cancelled' as const },
  ])('preserves the canonical Goal mutation at the daemon boundary (%j)', async mutation => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { ...createMachineFixture().metadata!, daemonSessionGoalControlsSupported: true } }) } });
    let refuse = false;
    daemonAnswer = request => {
      const parsed = request.method.endsWith(RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2)
        ? DaemonSessionGoalSetRequestV2Schema.parse(request.params)
        : DaemonSessionGoalSetRequestV1Schema.parse(request.params);
      expect(parsed).toMatchObject({ sessionId: 'goal-session', ...mutation });
      return refuse ? { ok: false, errorCode: 'session_goal_control_unsupported', error: 'session_goal_control_unsupported' }
        : { workState: null };
    };
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('session.goal.set', { sessionId: 'goal-session', ...mutation }, context()))
      .toMatchObject({ ok: true });
    expect(outgoing.at(-1)?.params).toMatchObject({ sessionId: 'goal-session', ...mutation });
    refuse = true;
    expect(await executor.execute('session.goal.set', { sessionId: 'goal-session', ...mutation }, context()))
      .toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
  });
  it.each(['ui', 'cli'] as const)('retains Follow approval before Session authoring on %s', async surface => {
    installSession('source', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    installSession('destination', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    homes.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({
      features: { sessions: { enabled: true, following: { enabled: true } } },
    }) });
    await getServerFeaturesSnapshot({ serverId, force: true });
    installActionSettings({ 'follow.set': { approvalRequiredSurfaces: [surface] } });
    homes.answer(serverId, '/v2/sessions/destination/follows/sessions/source', { body: { changed: true, source: {
      sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'quiet' },
      deliveryState: 'eligible', hasPendingUpdates: false,
    } } });
    const input = { receiver: { kind: 'session' as const, sessionId: 'destination' },
      source: { kind: 'session' as const, sessionId: 'source' }, policy: { preset: 'quiet' as const } };
    if (surface === 'ui') {
      const { setSessionFollowSource } = await import('@/sync/api/session/sessionFollowSourcesApi');
      expect(await setSessionFollowSource({ serverId, sourceSessionId: 'source', destinationSessionId: 'destination', policy: input.policy }))
        .toMatchObject({ kind: 'failed', actionFailure: { errorCode: 'approval_request_created' } });
    } else {
      const result = await createDefaultActionExecutor().execute('follow.set', input, { ...context(), surface,
        actionCaller: { kind: 'host' }, actionRequestId: 'follow-policy-test' });
      expect(result, JSON.stringify(result))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    }
    expect(homes.artifacts(serverId).list().length).toBeGreaterThan(0);
    expect(homes.requestsFor('/v2/sessions/destination/follows/sessions/source')).toEqual([]);
    expect(outgoing).toEqual([]);
  });
  it('retains admitted Goal operations beyond the generic Machine RPC acknowledgement cutoff', async () => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { ...createMachineFixture().metadata!, daemonSessionGoalControlsSupported: true } }) } });
    const executor = createDefaultActionExecutor();
    vi.useFakeTimers();
    try {
      for (const actionId of ['session.goal.set', 'session.goal.get', 'session.goal.clear'] as const) {
        let acknowledge!: (value: unknown) => void;
        daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
        let settled = false;
        const signal = new AbortController().signal;
        const pending = executor.execute(actionId, { sessionId: 'goal-session',
          ...(actionId === 'session.goal.set' ? { objective: 'Finish the task' } : {}) }, { ...context(), signal })
          .then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
        // The daemon may still be preparing or publishing the native Goal.
        // Its admitted receipt belongs to this operation, even after the
        // transport's unqualified 30-second default would have elapsed.
        await vi.advanceTimersByTimeAsync(31_000);
        expect(settled, actionId).toBe(false);
        acknowledge({ workState: null });
        expect(await pending).toMatchObject({ ok: true, result: actionId === 'session.goal.get'
          ? { workState: null } : { ok: true } });
      }
      let acknowledge!: (value: unknown) => void;
      daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
      const abort = new AbortController();
      const cancelled = executor.execute('session.goal.get', { sessionId: 'goal-session' }, { ...context(), signal: abort.signal });
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      abort.abort();
      await cancellation;
    } finally {
      vi.useRealTimers();
    }
  });
  it('retires a signal-free Goal Action wait with its captured Account', async () => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { ...createMachineFixture().metadata!, daemonSessionGoalControlsSupported: true } }) } });
    let acknowledge!: (value: unknown) => void;
    daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
    let settled = false;
    const pending = createDefaultActionExecutor().execute('session.goal.get', { sessionId: 'goal-session' }, context())
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      await disconnectActiveServerConnection();
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      await vi.waitFor(() => expect(settled, 'Account retirement must release its Goal wait').toBe(true));
    } finally {
      acknowledge?.({ workState: null });
      await pending.catch(() => {});
    }
  });
  it('runs a prepared API-token Action once across concurrent and repeated calls', async () => {
    const response = createDeferred<Response>();
    const issued = createDeferred<void>();
    let requests = 0;
    let acknowledged: unknown;
    const executor = createDefaultActionExecutor({ apiTokenAction: {
      target: { kind: 'session', sessionId: 'external-control' },
      request: async (path) => {
        expect(path).toBe('/v1/actions/session.permission_mode.set');
        requests += 1;
        issued.resolve();
        return (await response.promise).clone();
      },
      onActionAcknowledged: (_actionId, result) => { acknowledged = result; },
    } });
    const prepared = await executor.prepare('session.permission_mode.set', {
      sessionId: 'external-control', permissionMode: 'read_only',
    }, { surface: 'ui' });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('API-token Action was not prepared');
    expect(requests).toBe(0);
    const first = prepared.invocation.run();
    const second = prepared.invocation.run();
    try {
      await issued.promise;
      expect(requests).toBe(1);
    } finally {
      response.resolve(Response.json({ v: 1, actionId: 'session.permission_mode.set', execution: {
        ok: true, result: { ok: true, sessionId: 'external-control', permissionMode: 'read-only', updatedAt: 321 },
      } }));
      await Promise.all([first, second]);
    }
    const result = await first;
    expect(result).toMatchObject({ ok: true, result: { permissionMode: 'read-only', updatedAt: 321 } });
    expect(await second).toBe(result);
    expect(await prepared.invocation.run()).toBe(result);
    expect(acknowledged).toBe(result.ok ? result.result : undefined);
    expect(requests).toBe(1);
  });
  it('preserves definitive API-token send outcomes at the transcript boundary', async () => {
    const read = installSession('external-send', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    if (!connection) throw new Error('Missing connected Home fixture');
    const { sync } = await import('@/sync/sync');
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const http = await import('@/sync/http/client');
    const previousAuth = getCurrentAuth();
    let outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
    const sentInputs: unknown[] = [];
    // The endpoint HTTP adapter is the genuine boundary. Scope lifetime,
    // bootstrap, public Action transport, output parsing and the source stay real.
    vi.spyOn(http, 'createServerFetchAtEndpoint').mockImplementation(({ endpointUrl }) => async (path: string, init?: RequestInit) => {
      const url = new URL(path, endpointUrl);
      if (url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      if (url.pathname === '/v2/sessions/external-send') return Response.json({ session: read() });
      if (url.pathname === '/v1/sessions/external-send/turns') return Response.json({ v: 1, sessionId: 'external-send', updatedAt: 1, turns: [] });
      if (url.pathname === '/v1/sessions/external-send/messages') return Response.json({ messages: [], hasMore: false });
      if (url.pathname === '/v2/sessions/external-send/pending') return Response.json({ pending: [], count: 0, version: 0 });
      if (url.pathname === '/v1/actions/session.message.send') {
        sentInputs.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        return Response.json({ v: 1, actionId: 'session.message.send', execution: { ok: true, result: outcome } });
      }
      if (url.pathname === '/v1/actions/session.permission_mode.set') {
        return Response.json({ v: 1, actionId: 'session.permission_mode.set', execution: {
          ok: false, errorCode: 'unsupported_action', error: 'endpoint-owned-refusal',
        } });
      }
      throw new Error(`Unexpected embed HTTP request: ${url.pathname}`);
    });
    const refuseCredentialMutation = async (): Promise<never> => { throw new Error('Injected credential'); };
    setCurrentAuth({ isAuthenticated: true, credentials: connection.credentials, credentialAuthorityKind: 'api_token',
      login: refuseCredentialMutation, loginWithCredentials: refuseCredentialMutation, logout: refuseCredentialMutation,
      refreshFromActiveServer: async () => {} });
    try {
      // An embed frame starts with its own Session projection, not the main
      // app's profile-id-addressed row for the same Session identifier.
      storage.setState({ sessions: {} });
      await sync.create(connection.credentials, null, undefined, { scope: { kind: 'embedSession', sessionId: 'external-send' },
        accountId: 'alice', endpointUrl: 'https://mode-actions.test', accountMode: 'plain', approvalGranted: false, isCurrent: () => true });
      const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
      const actions = createAppSessionTranscriptActions('external-send', serverId);
      for (const result of [
        { status: 'rejected', code: 'session_input_unauthorized' },
        { status: 'failed', localId: 'real-input', code: 'session_input_turn_failed' },
        { status: 'failed', localId: 'real-input', code: 'resume_failed',
          admissionResult: { status: 'accepted', localId: 'real-input' },
          errorDetail: { kind: 'launch_error', code: 'agent_startup_model_reconciliation_failed',
            message: 'Review the selected model.', failureCause: { code: 'agent_startup_model_reconciliation_failed',
              phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } },
        { status: 'cancelled', localId: 'real-input', code: 'session_input_turn_cancelled' },
      ]) {
        outcome = SessionMessageSendResultV1Schema.parse(result);
        await expect(actions.submitMessage('Message')).rejects.toMatchObject({ code: result.code, details: outcome });
      }
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
      await expect(actions.submitMessage('Message', { permissionModeOverride: 'read-only' })).resolves.toBeUndefined();
      expect(sentInputs.at(-1)).toMatchObject({ input: { permissionModeOverride: 'read-only' } });
      const { submitAppSessionComposerMessage } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
      const { createSyncBackedSubmitPort } = await import('@/sync/domains/session/input/syncBackedSubmitPort');
      let handedOff = false;
      const composerOptions = { sessionId: 'external-send', serverId,
        session: createSessionFixture({ id: 'external-send', serverId }), text: 'Composer message',
        configuredMode: 'agent_queue' as const, resumeCapabilityOptions: {}, metaOverrides: { permissionMode: 'read-only' },
        onOutboundHandoff: () => { handedOff = true; } };
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'outcomeUnknown', localId: 'real-input', code: 'session_input_pending' });
      expect(await submitAppSessionComposerMessage(createSyncBackedSubmitPort(sync), composerOptions))
        .toMatchObject({ type: 'rejected', persistence: 'none' });
      expect(handedOff).toBe(false);
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'alreadyAccepted', localId: 'real-input' });
      expect(await submitAppSessionComposerMessage(createSyncBackedSubmitPort(sync), composerOptions))
        .toMatchObject({ type: 'success', localId: 'real-input' });
      expect(handedOff).toBe(true);
      expect(sentInputs.at(-1)).toMatchObject({ input: { permissionModeOverride: 'read-only' } });
      const composerExecutor = createDefaultActionExecutor({ sessionMessageComposerSubmission: {
        sourceComposerRef: { kind: 'session', sessionId: 'source-composer' }, isCurrent: () => true,
      } });
      const attachment = ComposerAttachmentDraftV1Schema.parse({ v: 1, instanceId: 'media-attachment',
        attachment: { pluginId: 'com.example.media', localId: 'image' }, key: 'photo', value: {},
        presentation: { label: 'Photo', typeLabel: 'Image' }, content: { kind: 'stagedMedia', handle: {
          v: 1, id: 'captured-source-media', executionTarget: { serverId, machineId: 'source-machine' },
          owner: { pluginId: 'com.example.media', localId: 'image' }, mediaKind: 'image', mimeType: 'image/png',
          name: 'photo.png', sizeBytes: 7, sha256: 'a'.repeat(64),
        } } });
      const composerInput = { sessionId: 'external-send', message: 'Targeted media', localId: 'composer-token-input',
        structuredInput: { composerAttachments: [attachment] } };
      const inputsBeforePrivateComposer = sentInputs.length;
      const executed = await composerExecutor.execute('session.message.send', composerInput, { surface: 'ui' });
      const prepared = await composerExecutor.prepare('session.message.send', composerInput, { surface: 'ui' });
      expect({ executed, prepared }).toMatchObject({
        executed: { ok: false, errorCode: 'session_input_target_unavailable' },
        prepared: { kind: 'settled', result: { ok: false, errorCode: 'session_input_target_unavailable' } },
      });
      expect(sentInputs.slice(inputsBeforePrivateComposer)).toEqual([]);
      expect(await composerExecutor.execute('session.permission_mode.set', {
        sessionId: 'external-send', permissionMode: 'read-only',
      }, { surface: 'ui' })).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'endpoint-owned-refusal' });
    } finally {
      sync.disposeEmbedSession();
      setCurrentAuth(previousAuth);
    }
  });
  it.each(['stopped', 'refused', 'lost-ack', 'disabled'] as const)(
    'archives active Section membership through the UI front door and real Stop admission (%s)', async outcome => {
    const sessionId = 'section-active-member';
    installSession(sessionId, { machineId: 'machine-a', flavor: 'codex' });
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] },
      'session.stop': { disabledSurfaces: outcome === 'disabled' ? ['ui'] : [], approvalRequiredSurfaces: [] } });
    const sectionId = 'section-active';
    homes.answer(serverId, 'GET /v2/session-organization', { body: { snapshot: {
      schemaVersion: 1, version: 1, pins: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
      folders: [{ folderId: sectionId, folderKey: sectionId, parentFolderId: null, parentFolderKey: null,
        sortKey: 'a0', display: { t: 'plain', v: { name: 'Release', icon: null } },
        archivedAt: null, createdAt: 1, updatedAt: 1 }],
      folderAssignments: [{ sessionId: 'section-inactive-member', folderId: sectionId }, { sessionId, folderId: sectionId }],
    } } });
    let active = true;
    const effects: string[] = [];
    const archived = new Set<string>();
    for (const memberId of ['section-inactive-member', sessionId]) {
      homes.answer(serverId, `POST /v2/sessions/${memberId}/archive`, { select: () => {
        effects.push(`archive:${memberId}`);
        if (memberId === sessionId && active) return { status: 409, body: { code: 'session_active' } };
        archived.add(memberId);
        return { body: { success: true, archivedAt: 42 } };
      } });
    }
    daemonAnswer = request => {
      expect(request).toEqual({ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } });
      effects.push(`stop:${sessionId}`);
      if (outcome === 'lost-ack') throw new Error('socket has been disconnected');
      if (outcome === 'refused') return { status: 'incomplete', reason: 'destroy_failed' };
      active = false;
      return { status: 'stopped' };
    };
    const { sessionOrganizationActions } = await import('@/sync/ops/sessionOrganization/sessionOrganizationActions');
    const result = await sessionOrganizationActions.archiveSection(sectionId, { serverId, expectedAccountId: 'alice' });
    expect(result).toMatchObject({ ok: true, result: {
      archivedSessionIds: outcome === 'stopped' ? ['section-inactive-member', sessionId] : ['section-inactive-member'],
      failures: outcome === 'stopped' ? [] : [{ sessionId, code: outcome === 'disabled' ? 'action_disabled'
        : outcome === 'refused' ? 'session_stop_failed' : 'session_stop_requested' }],
      unknownSessionIds: [],
    } });
    expect([...archived]).toEqual(outcome === 'stopped' ? ['section-inactive-member', sessionId] : ['section-inactive-member']);
    expect(effects).toEqual(['archive:section-inactive-member', `archive:${sessionId}`,
      ...(outcome === 'disabled' ? [] : [`stop:${sessionId}`]), ...(outcome === 'stopped' ? [`archive:${sessionId}`] : [])]);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it.each(['stopped', 'refused'] as const)('clears native Voice History through reviewed Session deletion (%s)', async outcome => {
    const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
    const { SessionMessagesPageV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1');
    const { buildRealtimeConversationRawRecord } = await import('@/voice/transcript/VoiceTranscriptProjector');
    const { createDefaultVoiceHistoryConsumer } = await import('@/voice/history/defaultVoiceHistoryConsumer');
    const sessionId = 'native-voice-history';
    const read = installSession(sessionId, { machineId: 'machine-a', flavor: 'opencode',
      ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) });
    await installRevocableVoiceSettings();
    let deleted = false;
    const effects: string[] = [];
    homes.answer(serverId, '/v2/sessions', { select: () => ({ body: {
      sessions: deleted ? [] : [read()], hasNext: false, nextCursor: null,
    } }) });
    homes.answer(serverId, '/v2/sessions/archived', { body: { sessions: [], hasNext: false, nextCursor: null } });
    homes.answer(serverId, `/v1/sessions/${sessionId}/messages`, { body: SessionMessagesPageV1Schema.parse({
      messages: [{ id: 'answer', localId: null, seq: 1, createdAt: 1, messageRole: 'agent',
        content: { t: 'plain', v: buildRealtimeConversationRawRecord({ id: 'answer', role: 'assistant', text: 'Paris.' }) } }],
      hasMore: false, nextBeforeSeq: null,
    }) });
    // The Machine is the external boundary here. Its lifecycle executor owns
    // Stop/cleanup/Home deletion; Clear forwards the original Action once.
    const boundary = await answerExternalActionAccountForHome(homes, serverId, {
      machineId: 'machine-a', actionId: 'session.delete', tokenEpoch: 0,
      execute(input, context) {
        expect(input).toEqual({ sessionId });
        expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user' });
        effects.push('native-delete');
        if (outcome === 'refused') return { ok: false, errorCode: 'session_stop_failed', error: 'session_stop_failed' };
        deleted = true;
        return { success: true };
      },
      failure: result => result && typeof result === 'object' && Reflect.get(result, 'ok') === false
        ? { errorCode: 'session_stop_failed', error: 'session_stop_failed' } : null,
    });
    homes.answer(serverId, 'GET /v1/machines', { body: [boundary.machine] });
    const consumer = createDefaultVoiceHistoryConsumer();
    const executor = createDefaultActionExecutor({ voiceHistory: { consumer, saveExportArtifact: async () => {} } });
    const search = await executor.execute('ui.voice_global.history.search', { query: 'Paris', refresh: true }, context());
    expect(search, JSON.stringify(search)).toMatchObject({ ok: true, result: { rows: [{ text: 'Paris.' }] } });
    const result = await executor.execute('ui.voice_global.history.clear', {}, { ...context(),
      presentUserConfirmation: { actionId: 'ui.voice_global.history.clear' } });
    expect(result, JSON.stringify({ result, effects, requests: homes.requests.map(({ path, method }) => ({ path, method })) })).toMatchObject(outcome === 'stopped'
      ? { ok: true, result: { cleared: true } } : { ok: false, errorCode: 'session_stop_failed' });
    expect(effects).toEqual(['native-delete']);
    expect(outgoing).toEqual([]);
    expect(homes.requestsFor(`/v1/sessions/${sessionId}`)).toHaveLength(0);
    expect(deleted).toBe(outcome === 'stopped');
    expect(consumer.read().rows.map(row => row.text)).toEqual(outcome === 'stopped' ? [] : ['Paris.']);
  });

  it('refuses a disabled stop through the shared lifecycle adapter used by single and bulk commands', async () => {
    installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    installActionSettings({ 'session.stop': { disabledSurfaces: ['ui'] } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .toMatchObject({ success: false });
    expect(outgoing).toEqual([]);
  });
  it.each([0, 1] as const)('renames and gently stops an owned Session through the real lifecycle Action (layout %s)', async layout => {
    const sessionId = 'person-renamed-session';
    // A daemon clock can be ahead of this device. An explicit rename must use
    // the title binding's monotonic user-write policy, as the CLI Action does.
    const read = installSession(sessionId, { machineId: 'machine-a', summary: { text: 'Ready', updatedAt: Date.now() + 60_000 },
      sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 0, currentModelId: 'gpt-5.6-luna',
        activeSelectionV1: { v: 2, selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna' },
          source: 'runtime_apply', runner: { pid: 631353, processStartTimeMs: 1122862470 },
          teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'shared-resource', teamId: 'team', expectedResourceRevision: 0,
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.6-luna', deliveryMode: 'brokered' } },
        availableModels: [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }] },
    }, serverId, layout);
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { getSessionName } = await import('@/utils/sessions/sessionUtils');
    expect(await executeSessionLifecycleAction('session.title.set', sessionId, { serverId }, 'QA43 Codex via Team share'))
      .toEqual({ success: true });
    expect(getSessionName(storage.getState().sessions[sessionId]!, serverId)).toBe('QA43 Codex via Team share');
    const row = read();
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Expected plain owner metadata');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata!), ownerMetadata: owner.v }).summary)
      .toMatchObject({ text: 'QA43 Codex via Team share' });
    daemonAnswer = () => ({ status: 'stopped' });
    expect(await executeSessionLifecycleAction('session.stop', sessionId, { serverId })).toEqual({ success: true });
  });
  it('records Stop and dispatches its Machine RPC without waiting for streaming metadata to settle', async () => {
    const sessionId = 'stop-during-streaming-metadata';
    const read = installSession(sessionId, { machineId: 'machine-a', flavor: 'codex',
      summary: { text: 'Streaming', updatedAt: 1 } }, serverId, 1);
    let row = SessionCurrentProjectionRecordV1Schema.parse({ ...read(), thinking: true, thinkingAt: Date.now() });
    storage.getState().applySessions([{ ...storage.getState().sessions[sessionId]!, thinking: true, thinkingAt: row.thinkingAt! }]);
    let attempts = 0;
    let streamedUpdates = 0;
    let stream: ReturnType<typeof setInterval> | undefined;
    const advanceStream = () => {
      streamedUpdates += 1;
      row = SessionCurrentProjectionRecordV1Schema.parse({ ...row,
        metadata: JSON.stringify({ ...JSON.parse(row.metadata!),
          summary: { text: `Streaming ${streamedUpdates}`, updatedAt: streamedUpdates + 1 } }),
        metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1,
      });
    };
    // Only the Home's HTTP/CAS and Machine socket boundaries are simulated.
    // The Action, Account admission, sync engine and tuple retry owner stay real.
    const answer = { select: (input: unknown) => {
      if (input === null || input === undefined) return { body: { session: row } };
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'owner') throw new Error('Expected current owner tuple');
      attempts += 1;
      if (attempts === 1) {
        // A real competing publisher wins the initial read/commit race, then
        // keeps publishing while the retry clock advances. It never ends a turn.
        advanceStream();
        stream = setInterval(advanceStream, 25);
      }
      if (patch.sharedMetadata.expectedVersion !== row.metadataVersion
        || patch.agentState.expectedVersion !== row.agentStateVersion) {
        return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({
          code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion },
        }) };
      }
      row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, ownerMetadata: patch.ownerMetadata,
        metadata: patch.sharedMetadata.ciphertext, agentState: patch.agentState.ciphertext,
        metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1,
      });
      return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion },
      }) };
    } };
    homes.answer(serverId, `/v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    daemonAnswer = request => {
      expect(request.method).toBe(`machine-a:${RPC_METHODS.STOP_SESSION}`);
      expect(row.active).toBe(true);
      expect(row.thinking).toBe(true);
      const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      if (envelope.t !== 'plain') throw new Error('Expected plain owner metadata');
      expect(readSessionExplicitStopV1FromMetadata(envelope.v.runtime)).toMatchObject({ cause: 'explicit_stop' });
      return { status: 'stopped' };
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let settled = false;
      const stopping = createDefaultActionExecutor().execute('session.stop', { sessionId }, context())
        .finally(() => { settled = true; });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5000 });
      const result = await stopping;
      // One collided attempt plus one fresh retry; no wait for producer idleness.
      expect(attempts).toBe(2);
      expect(result).toMatchObject({ ok: true, result: { stopped: true, success: true } });
      expect(streamedUpdates).toBeGreaterThan(1);
      expect(row.active).toBe(true);
      expect(row.thinking).toBe(true);
      expect(outgoing).toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
    } finally {
      clearInterval(stream);
      vi.useRealTimers();
    }
  });
  it.each([
    { reason: 'socket-reconnect', change: 'unchanged' },
    { reason: 'app-foreground', change: 'unchanged' },
    { reason: 'server-reachable', change: 'unchanged' },
    { reason: 'manual', change: 'unchanged' },
    { reason: 'socket-reconnect', change: 'mode' },
    { reason: 'socket-reconnect', change: 'denied' },
  ] as const)(
    'revalidates the gentle Stop hold across a same-Home $reason refresh ($change)', async ({ reason, change }) => {
    const sessionId = 'stop-across-resume';
    const read = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'codex' });
    const { sync } = await import('@/sync/sync');
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    // Finish restoration before capturing this operation's own HTTP witness.
    await sync.resumeSync('manual');
    const body = holdSessionResponseBody(sessionId);
    daemonAnswer = () => {
      if (change === 'unchanged') {
        const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
        if (envelope.t !== 'plain') throw new Error('Expected plain owner metadata');
        expect(readSessionExplicitStopV1FromMetadata(envelope.v.runtime)).toMatchObject({ cause: 'explicit_stop' });
      }
      return { status: 'stopped' };
    };
    const stopping = executeSessionLifecycleAction('session.stop', sessionId, { serverId });
    try {
      await Promise.race([body.reading, stopping.then(() => { throw new Error('Stop completed before the held metadata read'); })]);
      const before = homes.requestsFor('/v1/account/encryption/currentness').length;
      const currentness = createPlainAccountEncryptionCurrentnessFixture();
      if (change !== 'unchanged') homes.answer(serverId, '/v1/account/encryption/currentness', change === 'denied'
        ? { status: 403, body: { error: 'forbidden' } }
        : { body: { ...currentness,
          ...(change === 'mode' ? { mode: 'e2ee', signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content',
            recipientEnvelopeReadiness: { status: 'available' } } : {}),
        } });
      await sync.resumeSync(reason);
      body.release();
      const result = await stopping;
      if (change !== 'unchanged') {
        expect(result).toMatchObject({ success: false, code: 'session_metadata_update_failed',
          details: { stopped: true, holdRecorded: false, holdFailure: 'session_metadata_update_failed' } });
        expect(homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null)).toHaveLength(0);
        expect(outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.STOP_SESSION}`)))
          .toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
        return;
      }
      expect(result).toEqual({ success: true });
      expect(homes.requestsFor('/v1/account/encryption/currentness').length).toBeGreaterThan(before);
      expect(outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.STOP_SESSION}`)))
        .toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
    } finally {
      body.release();
      await stopping;
      body.restore();
    }
  });
  it('retires the old Stop capture and admits a fresh Stop after an Account switch on the same Home', async () => {
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const oldSessionId = 'previous-account-stop';
    installSession(oldSessionId, { machineId: 'machine-a', flavor: 'codex' });
    const body = holdSessionResponseBody(oldSessionId);
    const stopping = executeSessionLifecycleAction('session.stop', oldSessionId, { serverId });
    try {
      await Promise.race([body.reading, stopping.then(() => { throw new Error('Stop completed before the held metadata read'); })]);
      await homes.switchAccount(serverId, 'bob', { currentAccount: true });
      body.release();
      expect(await stopping).toMatchObject({ success: false });
      expect(outgoing).toEqual([]);
      expect(homes.requestsFor(`/v2/sessions/${oldSessionId}`).filter(request => request.input !== null)).toHaveLength(0);
      body.restore();
      storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
      await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
      const sessionId = 'restored-account-stop';
      installSession(sessionId, { machineId: 'machine-a', flavor: 'codex' });
      const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'bob' });
      const machine = createMachineFixture({ id: machineRow.id, activeAt: machineRow.activeAt,
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
      storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
      homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
      daemonAnswer = () => ({ status: 'stopped' });
      expect(await executeSessionLifecycleAction('session.stop', sessionId, { serverId })).toEqual({ success: true });
      expect(outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.STOP_SESSION}`)))
        .toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
    } finally {
      body.release();
      await stopping;
      body.restore();
    }
  });
  it('renames a shared admin Session through the declared shared-editor intent without owner metadata', async () => {
    const sessionId = 'admin-renamed-session';
    const access = createSessionAccessFixture('admin');
    const source = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
      metadata: { path: '/repo', host: 'tester.local', summary: { text: 'Ready', updatedAt: 1 } } });
    const { ownerMetadata: _privateOwnerMetadata, ...sharedSource } = source;
    let row = SessionCurrentProjectionRecordV1Schema.parse({ ...sharedSource,
      effectiveAccess: { v: 1, level: 'admin', sources: [{ kind: 'direct', shareId: 'share' }], capabilities: access.capabilities },
      share: { accessLevel: 'admin', canApprovePermissions: false, grantableAccessLevel: 'admin' },
    });
    storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId, access, accessLevel: 'admin',
      metadataLayoutVersion: 1, metadata: JSON.parse(row.metadata!), ownerMetadataView: null })]);
    const answer = { select: (input: unknown) => {
      if (input === undefined || input === null) return { body: { session: row } };
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'shared_editor' || patch.mutationIntent !== 'rename_session') {
        return { status: 403, body: { error: 'Forbidden' } };
      }
      row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: row.metadataVersion + 1 });
      return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion } }) };
    } };
    homes.answer(serverId, `/v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.title.set', sessionId, { serverId }, 'Shared rename')).toEqual({ success: true });
    expect(JSON.parse(row.metadata!).summary.text).toBe('Shared rename');
    expect(row).not.toHaveProperty('ownerMetadata');
  });
  it('keeps an issued Stop with a lost native ACK pending through the real lifecycle Action', async () => {
    const sessionId = 'stop-lost-ack';
    installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'codex' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    daemonAnswer = request => {
      expect(request.method).toBe(`machine-a:${RPC_METHODS.STOP_SESSION}`);
      // This is the native Socket.IO boundary, after the real request was emitted.
      throw new Error('socket has been disconnected');
    };

    expect(await executeSessionLifecycleAction('session.stop', sessionId, { serverId })).toMatchObject({
      success: false, code: 'session_stop_requested', recovery: 'wait_for_inactive',
    });
    expect(outgoing).toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
    expect(storage.getState().sessions[sessionId]?.active).toBe(true);
  });
  it('preserves current daemon stop confirmation and failure detail through the real Action adapter', async () => {
    const readRow = installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');

    daemonAnswer = () => {
      const row = readRow();
      const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      expect(envelope.t).toBe('plain');
      if (envelope.t !== 'plain') throw new Error('Expected plain owner metadata');
      expect(readSessionExplicitStopV1FromMetadata(envelope.v.runtime)).toMatchObject({
        v: 1, cause: 'explicit_stop', requestId: expect.any(String), requestedAtMs: expect.any(Number),
      });
      return { status: 'stopped' };
    };
    await expect(executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .resolves.toEqual({ success: true });
    const publicStop = await createDefaultActionExecutor().execute('session.stop', { sessionId: 'stop-session' }, context());
    expect(publicStop).toMatchObject({ ok: true, result: { success: true } });
    if (!publicStop.ok) throw new Error('Expected confirmed Stop');
    expect(SessionStopResultSchema.parse(publicStop.result)).toMatchObject({ sessionId: 'stop-session', stopped: true });
    expect(outgoing).toContainEqual(expect.objectContaining({
      method: `machine-a:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'stop-session' },
    }));

    outgoing.length = 0;
    daemonAnswer = () => ({ status: 'incomplete', reason: 'destroy_failed' });
    await expect(executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .resolves.toMatchObject({
        success: false,
        code: 'session_stop_failed',
        message: 'Session stop incomplete: destroy_failed',
      });
  });
  it.each(['stopped', 'incomplete'] as const)('settles the mounted UI Stop through the real Action and Machine RPC (%s)', async status => {
    const sessionId = 'mounted-stop';
    installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'codex' });
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { SESSION_ACTION_STOP_ID } = await import('@/components/sessions/actions/sessionActionIds');
    const { useHappyAction } = await import('@/hooks/ui/useHappyAction');
    const { Modal } = await import('@/modal');
    const alert = vi.mocked(Modal.alert);
    alert.mockClear();
    const entered = createDeferred<void>();
    const reply = createDeferred<unknown>();
    daemonAnswer = async request => {
      expect(request.method).toBe(`machine-a:${RPC_METHODS.STOP_SESSION}`);
      entered.resolve();
      return await reply.promise;
    };
    const target = createSessionActionTarget({ session: storage.getState().sessions[sessionId]!, serverId });
    let failure: unknown;
    const stop = async () => {
      try {
        await executeSessionAction({ actionId: SESSION_ACTION_STOP_ID, target });
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    const hook = await renderHook(() => useHappyAction(stop));
    try {
      await act(async () => { hook.getCurrent()[1](); });
      await entered.promise;
      expect(hook.getCurrent()[0]).toBe(true);
      await act(async () => {
        reply.resolve(status === 'stopped' ? { status } : { status, reason: 'destroy_failed' });
        await flushHookEffects();
      });
      await vi.waitFor(async () => {
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toBe(false);
      });
      if (status === 'incomplete') {
        expect(failure).toMatchObject({ name: 'HappyError', code: 'session_stop_failed' });
        expect(alert).toHaveBeenCalled();
      } else {
        expect(failure).toBeUndefined();
        expect(alert).not.toHaveBeenCalled();
      }
      expect(outgoing.map(request => request.method)).toEqual([`machine-a:${RPC_METHODS.STOP_SESSION}`]);
    } finally {
      reply.resolve({ status: 'stopped' });
      await hook.unmount();
    }
  });
  it('preserves automatic Stop authorship without creating a person hold through the real Action adapter', async () => {
    const readRow = installSession('automatic-stop', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    daemonAnswer = () => ({ status: 'stopped' });
    const result = await createDefaultActionExecutor().execute('session.stop', { sessionId: 'automatic-stop' }, {
      ...context(), authority: 'account_automation', actionCaller: { kind: 'host' },
    });
    expect(result).toMatchObject({ ok: true, result: { stopped: true, success: true } });
    expect(readRow().metadataLayoutVersion).toBe(0);
    expect(readSessionExplicitStopV1FromMetadata(JSON.parse(readRow().metadata))).toBeNull();
  });
  it.each([
    ['Info Stop', 'explicit_stop', 'held_by_person'],
    ['resource Stop', 'lifecycle_control', 'eligible'],
  ] as const)('preserves next ordinary-message admission after %s through the real UI Action', async (_surface, stopIntent, expectedAdmission) => {
    const sessionId = 'stop-next-message';
    const readRow = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' }, serverId, 1);
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    daemonAnswer = request => {
      expect(request.method).toBe(`machine-a:${RPC_METHODS.STOP_SESSION}`);
      return { status: 'stopped' };
    };
    const stopOptions = { serverId, stopIntent };
    expect(await executeSessionLifecycleAction('session.stop', sessionId, stopOptions)).toEqual({ success: true });
    const row = readRow();
    const envelope = row.metadataLayoutVersion === 1 ? SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata) : null;
    if (envelope && envelope.t !== 'plain') throw new Error('Expected readable owner metadata');
    const metadata = envelope ? projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: envelope.v })
      : JSON.parse(row.metadata);
    expect(resolveSessionAutoResumeAdmissionV1({ metadata, archivedAt: null, authorityAvailable: true, machineAvailable: true }))
      .toBe(expectedAdmission);
    const writes = homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null);
    expect(writes).toHaveLength(stopIntent === 'explicit_stop' ? 1 : 0);
  });
  it.each([true, false])('confirms an already-stopped Session through a fresh Home read after exact daemon absence (cached active=%s)', async (cachedActive) => {
    const sessionId = 'stop-already-inactive';
    const readRow = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const session = storage.getState().sessions[sessionId];
    storage.setState({ sessions: { ...storage.getState().sessions, [sessionId]: { ...session, active: cachedActive } } });
    let daemonStopReturned = false;
    let freshReads = 0;
    const answer = { select: () => {
      if (daemonStopReturned) freshReads++;
      return { body: { session: { ...readRow(), active: !daemonStopReturned } } };
    } };
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `GET /v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    daemonAnswer = (request) => {
      if (request.method !== `machine-a:${RPC_METHODS.STOP_SESSION}`) throw new Error('No runner remains to stop');
      daemonStopReturned = true;
      return { status: 'not_found' };
    };
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionLifecycleAction('session.stop', sessionId, { serverId })).resolves.toEqual({ success: true });
    const publicStop = await createDefaultActionExecutor().execute('session.stop', { sessionId }, context());
    expect(publicStop).toMatchObject({ ok: true, result: { success: true } });
    if (!publicStop.ok) throw new Error('Expected already-stopped confirmation');
    const parsed = SessionStopResultSchema.parse(publicStop.result);
    expect(parsed).toMatchObject({ sessionId, stopped: false,
      stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } });
    expect(isSessionStopConfirmed(parsed)).toBe(true);
    expect(freshReads).toBeGreaterThan(0);
    expect(outgoing.map(request => request.method)).toEqual([`machine-a:${RPC_METHODS.STOP_SESSION}`, `machine-a:${RPC_METHODS.STOP_SESSION}`]);
  });

  it.each(['active', 'unknown', 'unavailable', 'ambiguous'] as const)('does not confirm an absent runtime from %s Home or transport evidence', async (evidence) => {
    const sessionId = 'stop-unconfirmed';
    const readRow = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const session = storage.getState().sessions[sessionId];
    storage.setState({ sessions: { ...storage.getState().sessions, [sessionId]: { ...session, active: false } } });
    let daemonStopReturned = false;
    let confirmationReadFailed = false;
    const answer = { select: () => {
      if (daemonStopReturned && evidence === 'unavailable' && !confirmationReadFailed) {
        confirmationReadFailed = true;
        return { status: 500, body: { error: 'Session projection temporarily unavailable' } };
      }
      return { body: { session: { ...readRow(), active: evidence === 'unknown' && daemonStopReturned ? undefined : evidence !== 'ambiguous' } } };
    } };
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `GET /v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    daemonAnswer = (request) => {
      if (request.method === `machine-a:${RPC_METHODS.STOP_SESSION}`) {
        daemonStopReturned = true;
        if (evidence === 'ambiguous') throw Object.assign(new Error('Stop acknowledgement lost'), { rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
      }
      if (evidence === 'unavailable' && request.method === `${sessionId}:killSession`) return { status: 'requested' };
      return { status: 'not_found' };
    };
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const result = await executeSessionLifecycleAction('session.stop', sessionId, { serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ success: false,
      ...(evidence === 'unavailable' ? { code: 'session_stop_requested' } : {}) });
    if (evidence === 'unavailable') expect(outgoing.map(request => request.method)).toEqual([
      `machine-a:${RPC_METHODS.STOP_SESSION}`, `${sessionId}:killSession`,
    ]);
    if (evidence === 'ambiguous') expect(outgoing.map(request => request.method)).toEqual([`machine-a:${RPC_METHODS.STOP_SESSION}`]);
  });

  it('retains an explicit Ask policy for Stop after removing UI-local confirmation', async () => {
    installSession('stop-ask', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    installActionSettings({ 'session.stop': { approvalRequiredSurfaces: ['ui'] } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionLifecycleAction('session.stop', 'stop-ask', { serverId }))
      .resolves.toMatchObject({ success: false, code: 'approval_request_created' });
    expect(outgoing).toEqual([]);
  });
  it('retains next-prompt mode in the draft without invoking the immediate Action', async () => {
    const { applyPermissionModeSelection } = await import('@/sync/domains/permissions/permissionModeApply');
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
    const read = installSession('mode-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const draftScope = storage.getState().settingsScope;
    if (!draftScope) throw new Error('Expected the restored Account draft scope');
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'safe-yolo', applyTiming: 'next_prompt',
      draftScope,
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).not.toBe('safe-yolo');
    const retainedDraft = getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: 'mode-session' });
    if (!retainedDraft || !('extensions' in retainedDraft.document)) throw new Error('Expected Session composer draft');
    expect(retainedDraft.document.extensions.happier?.nextPromptPermissionModeV1?.value).toBe('safe-yolo');
    expect(read().metadataVersion).toBe(1);
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'read-only', applyTiming: 'immediate',
      draftScope,
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).toBe('read-only');
    expect(read().metadataVersion).toBeGreaterThan(1);
  });

  it('refuses disabled transcript permission and answer Actions before reaching the daemon', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('prompt-session', 'read-only');
    installActionSettings({
      'session.permission.respond': { disabledSurfaces: ['ui'] },
      'session.user_action.answer': { disabledSurfaces: ['ui'] },
      'session.message.send': { disabledSurfaces: ['ui'] },
    });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await expect(actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' })).rejects.toThrow();
    await expect(actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } })).rejects.toThrow();
    await expect(actions.submitMessage('Selected option', { callerSurface: 'message_option' })).rejects.toThrow();
    expect(storage.getState().sessions['prompt-session']?.permissionMode).toBe('read-only');
    expect(outgoing).toEqual([]);
  });
  it('preserves permission decisions, client evidence and multi-select answers through transcript Actions', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('prompt-session', 'read-only');
    daemonAnswer = () => ({ ok: true });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' });
    expect(storage.getState().sessions['prompt-session']?.permissionMode).toBe('safe-yolo');
    await actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } });
    await actions.answerUserAction({ id: 'q2', decision: 'reject' });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
      params: expect.objectContaining({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits',
        answeringClientCategory: 'web' }) }));
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: expect.objectContaining({ id: 'q1', approved: true, answers: { Question: ['One', 'Two'] },
        answeringClientCategory: 'web' }) }));
    const dismissal = outgoing.find(message => message.method === `prompt-session:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`
      && (message.params as { id?: string }).id === 'q2');
    expect(dismissal?.params).toMatchObject({ id: 'q2', approved: false, answeringClientCategory: 'web' });
    expect(dismissal?.params).not.toHaveProperty('answers');
  });
  it.each(['approved', 'denied'] as const)('sends a confirmed Voice %s decision through the native permission RPC', async decision => {
    installSession('voice-permission', { machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('voice-permission', 'read-only');
    daemonAnswer = () => ({ ok: true });
    const result = await createDefaultActionExecutor().executeConfirmed('session.permission.respond', {
      sessionId: 'voice-permission', requestId: 'permission-1', turnId: 'turn-1', decision,
      ...(decision === 'approved' ? { mode: 'acceptEdits' } : {}),
    }, { surface: 'voice', serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(outgoing).toEqual([{ method: `voice-permission:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
      params: { id: 'permission-1', turnId: 'turn-1', approved: decision === 'approved', decision,
        ...(decision === 'approved' ? { mode: 'acceptEdits' } : {}), answeringClientCategory: 'web' } }]);
    expect(storage.getState().sessions['voice-permission']?.permissionMode)
      .toBe(decision === 'approved' ? 'safe-yolo' : 'read-only');
  });
  it.each(['approved', 'denied'] as const)('keeps an opted-out Voice %s decision away from the native permission RPC', async decision => {
    installSession('voice-permission', { machineId: 'machine-a', flavor: 'claude' });
    installActionSettings({}, false);
    const result = await createDefaultActionExecutor().execute('session.permission.respond', {
      sessionId: 'voice-permission', requestId: 'permission-1', turnId: 'turn-1', decision,
    }, { surface: 'voice', serverId, authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(outgoing).toEqual([]);
  });
  it.each(['narrowed_voice', 'cli'] as const)('uses the admitted permission authority for %s', async actor => {
    installSession('voice-permission', { machineId: 'machine-a', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true });
    const result = await createDefaultActionExecutor().execute('session.permission.respond', {
      sessionId: 'voice-permission', requestId: 'permission-1', turnId: 'turn-1', decision: 'approved',
    }, actor === 'narrowed_voice'
      ? { surface: 'voice', serverId, authority: 'account_automation' }
      : { surface: 'cli', serverId, authority: 'present_user' });
    expect(result).toMatchObject(actor === 'cli' ? { ok: true } : { ok: false, errorCode: 'present_user_required' });
    expect(outgoing).toHaveLength(actor === 'cli' ? 1 : 0);
  });
  it('requires confirmation before admitting a Voice permission approval', async () => {
    await installRevocableVoiceSettings();
    installSession('voice-approval-review', { machineId: 'machine-a', flavor: 'claude' });
    const prepared = await createDefaultActionExecutor().prepare('session.permission.respond', {
      sessionId: 'voice-approval-review', requestId: 'permission-1', turnId: 'turn-1', decision: 'approved',
    }, { surface: 'voice', serverId });
    expect(prepared).toMatchObject({ kind: 'settled', result: {
      ok: true, result: { kind: 'approval_request_created' },
    } });
    expect(outgoing).toEqual([]);
  });
  const voiceDecisions = [
    { actionId: 'session.permission.respond', response: 'approve',
      method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
      input: { requestId: 'permission-1', turnId: 'turn-1', decision: 'approved' } },
    { actionId: 'session.permission.respond', response: 'deny',
      method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
      input: { requestId: 'permission-1', turnId: 'turn-1', decision: 'denied' } },
    { actionId: 'session.user_action.answer', response: 'answer',
      method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
      input: { requestId: 'question-1', answers: [{ question: 'Which revision?', values: ['42'] }] } },
  ] as const;
  it.each(voiceDecisions.filter(({ response }) => response !== 'approve'))('finishes a prepared Voice $actionId $response after delegation is turned off', async ({ actionId, method, input }) => {
    const waiver = actionId === 'session.user_action.answer' ? { [actionId]: ['voice'] } : undefined;
    await installRevocableVoiceSettings(waiver);
    installSession('voice-revocation', { machineId: 'machine-a', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true });
    const prepared = await createDefaultActionExecutor().prepare(actionId, { sessionId: 'voice-revocation', ...input }, {
      surface: 'voice', serverId,
    });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Voice decision was not prepared');
    expect(outgoing).toEqual([]);
    await setVoiceApprovalDelegation(false);
    expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
    const result = await prepared.invocation.run();
    expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true } });
    expect(outgoing).toEqual([expect.objectContaining({ method: `voice-revocation:${method}`,
      params: expect.objectContaining({ id: input.requestId }) })]);
  });
  it.each(voiceDecisions)('finishes Voice $actionId $response when delegation is turned off during its held Session target read', async ({ actionId, method, input }) => {
    const waiver = actionId === 'session.user_action.answer' ? { [actionId]: ['voice'] } : undefined;
    await installRevocableVoiceSettings(waiver);
    const sessionId = 'voice-revocation';
    installSession(sessionId, { machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const body = holdSessionResponseBody(sessionId);
    daemonAnswer = () => ({ ok: true });
    const pending = createDefaultActionExecutor().executeConfirmed(actionId, { sessionId, ...input }, { surface: 'voice', serverId });
    try {
      await Promise.race([body.reading, pending.then(result => {
        throw new Error('Voice decision settled before its held Session target read: ' + JSON.stringify(result));
      })]);
      expect(outgoing).toEqual([]);
      await setVoiceApprovalDelegation(false);
      expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
      body.release();
      const result = await pending;
      expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true } });
      expect(outgoing).toEqual([expect.objectContaining({ method: `${sessionId}:${method}`,
        params: expect.objectContaining({ id: input.requestId }) })]);
    } finally {
      body.release();
      await pending;
      body.restore();
    }
  });
  it.each(['approved', 'denied'] as const)('preserves an issued native Voice %s receipt when delegation is revoked before its reply', async decision => {
    await installRevocableVoiceSettings();
    installSession('voice-issued', { machineId: 'machine-a', flavor: 'claude' });
    const issued = createDeferred<void>();
    const reply = createDeferred<unknown>();
    daemonAnswer = () => { issued.resolve(); return reply.promise; };
    const pending = createDefaultActionExecutor().executeConfirmed('session.permission.respond', {
      sessionId: 'voice-issued', requestId: 'permission-1', turnId: 'turn-1', decision,
    }, { surface: 'voice', serverId });
    try {
      await Promise.race([issued.promise, pending.then(result => {
        throw new Error('Voice decision settled without native dispatch: ' + JSON.stringify(result));
      })]);
      await setVoiceApprovalDelegation(false);
      reply.resolve({ ok: true });
      expect(await pending).toMatchObject({ ok: true });
      expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]).toMatchObject({ method: `voice-issued:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
        params: { id: 'permission-1', approved: decision === 'approved', decision } });
    } finally {
      reply.resolve({ ok: true });
      await pending;
    }
  });
  it.each(['ui', 'voice'] as const)('preserves question pass-up through the %s Action authority boundary', async surface => {
    installSession('question-worker', { machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: { ...storage.getState().sessions, 'question-worker': createSessionFixture({
      ...storage.getState().sessions['question-worker'], agentState: { requests: {
        'question-1': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Which revision?' }] } },
      } },
    }) } });
    daemonAnswer = () => ({ ok: true });
    const input = { sessionId: 'question-worker', requestId: 'question-1', disposition: 'pass_up', reason: 'Needs a person' };
    const result = surface === 'ui'
      ? await createDefaultActionExecutor().execute('session.user_action.answer', input, context())
      : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: explicit => explicit ?? null })
        .action_execute!({ actionId: 'session.user_action.answer', input }, { serverId }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(outgoing).toContainEqual({ method: `question-worker:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: { id: 'question-1', disposition: 'pass_up', reason: 'Needs a person' } });
    daemonAnswer = () => ({ ok: false, errorCode: 'present_user_required' });
    const refused = surface === 'ui'
      ? await createDefaultActionExecutor().execute('session.user_action.answer', input, context())
      : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: explicit => explicit ?? null })
        .action_execute!({ actionId: 'session.user_action.answer', input }, { serverId }));
    expect(refused).toMatchObject({ ok: false, errorCode: 'present_user_required' });
  });
  it.each(['ui', 'voice'] as const)('publishes exact answer and pass through the %s Action and preserves publisher refusals', async surface => {
    installActionSettings({}, true);
    installSession('reply-receiver', { machineId: 'machine-a', flavor: 'claude' });
    const invoke = async (reply: { kind: 'answer'; message: string } | { kind: 'pass' }) => {
      const input = { sessionId: 'reply-receiver', requestLocalId: 'original-input', reply };
      return surface === 'ui'
        ? createDefaultActionExecutor().execute('session.message.reply', input, context())
        : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: () => null })
          .action_execute!({ actionId: 'session.message.reply', input }, { serverId }));
    };
    const progress = { v: 1, mode: 'wait', acceptedTurnId: 'accepted-turn', disposition: 'observing', outcome: { kind: 'pass' } };
    daemonAnswer = () => ({ v: 1, ok: true, progress });
    for (const reply of [{ kind: 'answer', message: 'Use revision 42.' }, { kind: 'pass' }] as const) {
      const result = await invoke(reply);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { v: 1, ok: true, progress } });
      expect(outgoing.at(-1)).toEqual({ method: 'reply-receiver:session.message.reply',
        params: { sessionId: 'reply-receiver', requestLocalId: 'original-input', reply } });
    }
    daemonAnswer = () => ({ v: 1, ok: false, error: 'conflict' });
    const refused = await invoke({ kind: 'pass' });
    expect(refused, JSON.stringify(refused)).toMatchObject(surface === 'ui'
      ? { ok: true, result: { v: 1, ok: false, error: 'conflict' } }
      : { ok: false, errorCode: 'conflict' });
  });
  it.each((['generic', 'question'] as const).flatMap(entry => [
    { entry, response: 'answer' as const }, { entry, response: 'reject' as const },
  ]))('requires person approval before a $entry Voice question $response returns to its exact daemon', async ({ entry, response }) => {
    installActionSettings({}, false);
    installSession('question-worker', { machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: { ...storage.getState().sessions, 'question-worker': createSessionFixture({
      ...storage.getState().sessions['question-worker'], agentState: { requests: {
        'question-1': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Which revision?' }] } },
      } },
    }) } });
    const { ApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const tools = (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: () => 'question-worker' });
    const input = { sessionId: 'question-worker', requestId: 'question-1', ...(response === 'answer'
      ? { answers: [{ question: 'Which revision?', values: ['42'] }] } : { decision: 'reject' as const }) };
    daemonAnswer = () => ({ ok: true });
    const result = JSON.parse(await (entry === 'generic'
      ? tools.action_execute!({ actionId: 'session.user_action.answer', input }, { serverId, effectId: `voice-answer-${entry}` })
      : tools.answerUserActionRequest!(input, { serverId, effectId: `voice-answer-${entry}` })));
    expect(result, JSON.stringify(result)).toMatchObject(entry === 'generic'
      ? { ok: true, result: { kind: 'approval_request_created' } }
      : { ok: true, kind: 'approval_request_created' });
    expect(outgoing).toEqual([]);
    const approval = homes.artifacts(serverId).list().find(row => {
      const body = homes.artifacts(serverId).readPlainBody(row.id);
      return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
    });
    if (!approval) throw new Error('Voice answer did not create an approval');
    expect(ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(approval.id) ?? 'null')))
      .toMatchObject({ status: 'open', actionId: 'session.user_action.answer', actionArgs: input,
        executionOriginV1: { authority: 'account_automation', surface: 'voice', accountId: 'alice', machineId: 'machine-a' } });
    // The opted-out Voice agent cannot decide its own proposal.
    expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: approval.id, decision: 'approve' },
      { surface: 'voice', serverId })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(outgoing).toEqual([]);
    const decisions: unknown[] = [];
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://mode-actions.test',
      serverIdentityId: 'srv_mode_home', accountId: 'alice', tokenEpoch: 0, machineId: 'machine-a',
      actionId: 'approval.request.decide', requesterInvocation: 'none', execute: input => {
        decisions.push(input);
        return { status: 'executed' };
      } });
    homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: boundary.machine } });
    for (const path of ['/v1/machines/read-batch', '/v1/actions/approval.request.decide/execution-authorization', '/v1/actions/approval.request.decide']) {
      homes.answer(serverId, path, { select: async (_input, request) => {
        const result = await boundary.handle(new URL(request.url), request.init);
        if (!result) throw new Error('Unexpected approval decision HTTP request');
        return { status: result.status, body: await result.json() };
      } });
    }
    const approved = await createDefaultActionExecutor().execute('approval.request.decide',
      { artifactId: approval.id, decision: 'approve' }, context());
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(decisions).toEqual([{ artifactId: approval.id, decision: 'approve',
      serverIdentityId: 'srv_mode_home', originServerId: serverId }]);
    expect(outgoing).toEqual([]);
  });
  it('keeps permission feedback and title state unchanged while explicit UI approval is pending', async () => {
    const read = installSession('approval-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('approval-session', 'read-only');
    installActionSettings({
      'session.permission.respond': { approvalRequiredSurfaces: ['ui'] },
      'session.title.set': { approvalRequiredSurfaces: ['ui'] },
    });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    await expect(createAppSessionTranscriptActions('approval-session', serverId).respondToPermission({
      id: 'p1', approved: true, mode: 'acceptEdits',
    })).rejects.toMatchObject({ code: 'approval_request_created' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.title.set', 'approval-session', { serverId }, 'Pending title'))
      .toMatchObject({ success: false, code: 'approval_request_created' });
    expect(storage.getState().sessions['approval-session']?.permissionMode).toBe('read-only');
    expect(read().metadataVersion).toBe(1);
    expect(outgoing).toEqual([]);
  });

  it('refuses disabled session-delete before reaching its HTTP transport', async () => {
    const session = createSessionFixture({ id: 'delete-session', serverId, active: false });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    installActionSettings({ 'session.delete': { disabledSurfaces: ['ui'] } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    let deleted = false;
    homes.answer(serverId, `/v1/sessions/${session.id}`, { select: () => { deleted = true; return { body: { success: true } }; } });
    await expect(executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session, serverId,
      currentUserId: 'alice', isConnected: true, isPinned: false }) })).rejects.toThrow();
    expect(deleted).toBe(false);
  });
  it('refuses disabled active Delete before stopping the Session', async () => {
    const sessionId = 'disabled-active-delete';
    installSession(sessionId, { machineId: 'machine-a', flavor: 'codex' });
    installActionSettings({ 'session.delete': { disabledSurfaces: ['ui'] } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionAction({ actionId: 'ui.session.delete',
      target: createSessionActionTarget({ session: storage.getState().sessions[sessionId]!, serverId, isConnected: true }),
      context: { confirmed: true },
    })).rejects.toMatchObject({ code: 'action_disabled' });
    expect(outgoing).toEqual([]);
    expect(homes.requestsFor(`/v1/sessions/${sessionId}`)).toHaveLength(0);
  });

  it('cancels stop-and-delete when its Account retires and never issues a late Delete', async () => {
    const sessionId = 'retired-stop-and-delete';
    installSession(sessionId, { machineId: 'machine-a', flavor: 'codex',
      terminal: { mode: 'plain', controlServiceabilityV1: { v: 1, state: 'servable', observedAt: 1 } } });
    const stopped = createDeferred<void>();
    const releaseStop = createDeferred<void>();
    daemonAnswer = async () => { stopped.resolve(); await releaseStop.promise; return { status: 'stopped' }; };
    let deletes = 0;
    homes.answer(serverId, `/v1/sessions/${sessionId}`, { select: () => {
      deletes += 1; return { status: 400, body: { error: 'Session is active' } };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const session = storage.getState().sessions[sessionId]!;
    const deleting = executeSessionAction({ actionId: 'ui.session.delete',
      target: createSessionActionTarget({ session, serverId, isConnected: true }),
      context: { confirmed: true },
    }).then(() => null, error => error);
    try {
    await Promise.race([stopped.promise, deleting.then(error => { throw error ?? new Error('Delete completed before Stop'); })]);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
    releaseStop.resolve();
    expect(await deleting).toBeInstanceOf(Error);
    expect(deletes).toBe(1);
    } finally { releaseStop.resolve(); await deleting; }
  });

  it('sends only Delete from the UI and lets its reviewed active refusal own Stop and the retry', async () => {
    const sessionId = 'stop-and-delete-session';
    installSession(sessionId, { machineId: 'machine-a', flavor: 'codex',
      terminal: { mode: 'plain', controlServiceabilityV1: { v: 1, state: 'servable', observedAt: 1 } } });
    let active = true;
    const effects: string[] = [];
    const stopped = createDeferred<void>();
    daemonAnswer = () => {
      effects.push('stop');
      active = false;
      // The native boundary publishes its observed Stop. No UI waiter owns deletion.
      const current = storage.getState().sessions[sessionId]!;
      const ownerMetadata = readSessionOwnerMetadataView(current)!;
      const retired = { ...ownerMetadata, terminal: { ...ownerMetadata.terminal,
        controlServiceabilityV1: { v: 1 as const, state: 'unknown' as const, observedAt: 2, retired: true } } };
      storage.getState().applySessions([{ ...current, active: false, activeAt: 0, presence: 0,
        metadata: retired, ownerMetadataView: retired, metadataVersion: current.metadataVersion + 1, updatedAt: current.updatedAt + 1 }]);
      stopped.resolve();
      return { status: 'stopped' };
    };
    homes.answer(serverId, `/v1/sessions/${sessionId}`, { select: () => {
      effects.push('delete');
      return active ? { status: 400, body: { error: 'Session is active' } } : { body: { success: true } };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const target = createSessionActionTarget({ session: storage.getState().sessions[sessionId]!, serverId, isConnected: true });
    let settled = false;
    const deleting = executeSessionAction({ actionId: 'ui.session.delete', target,
      context: { confirmed: true } })
      .then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
    await Promise.race([stopped.promise, deleting.then(error => { throw error ?? new Error('Delete completed before Stop'); })]);
    expect(effects.slice(0, 2)).toEqual(['delete', 'stop']);
    expect(await deleting).toBeNull();
    expect(effects).toEqual(['delete', 'stop', 'delete']);
    expect(outgoing.filter(request => request.method.endsWith(`:${RPC_METHODS.STOP_SESSION}`)))
      .toEqual([{ method: `machine-a:${RPC_METHODS.STOP_SESSION}`, params: { sessionId } }]);
    expect(homes.requests.some(request => request.path.endsWith(`/${sessionId}/archive`))).toBe(false);
    } finally {
      if (!settled) {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      }
      await deleting;
    }
  });

  it('executes an Info-confirmed Delete through the real Action front door without creating another approval', async () => {
    const session = createSessionFixture({ id: 'confirmed-delete-session', serverId, active: false, activeAt: 0, presence: 0, archivedAt: 42,
      metadata: { path: '/repo', host: 'tester.local', terminal: {
        controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 1, retired: true } } } });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    let deleteRequests = 0;
    homes.answer(serverId, `/v1/sessions/${session.id}`, { select: () => {
      deleteRequests += 1;
      return { body: { success: true } };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');

    const failure = await executeSessionAction({
      actionId: 'ui.session.delete',
      target: createSessionActionTarget({ session, serverId, currentUserId: 'alice', isConnected: false, isPinned: false }),
      context: { confirmed: true },
    }).then(() => null, error => error);
    expect(failure, JSON.stringify({ deleteRequests, requests: homes.requests.slice(-12).map(request => request.path),
      scope: storage.getState().profileScope })).toBeNull();
    expect(deleteRequests).toBe(1);
  });
  it('retains the Home delete conflict payload at the UI error boundary', async () => {
    const session = createSessionFixture({ id: 'conflict-session', serverId, active: false, activeAt: 0, presence: 0,
      metadata: { path: '/repo', host: 'tester.local', terminal: {
        controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 1, retired: true } } } });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    const details = { error: 'Session delete condition was lost' };
    homes.answer(serverId, `/v1/sessions/${session.id}`, { status: 409, body: details });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const failure = await executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session,
      serverId, currentUserId: 'alice', isConnected: false, isPinned: false }),
      context: { confirmed: true } }).then(() => null, error => error);
    expect(failure, JSON.stringify({ requests: homes.requests.slice(-12).map(request => request.path),
      scope: storage.getState().profileScope })).toMatchObject({ code: 'session_delete_conflict', details, message: details.error });
  });
  it.each(['ui.session.archive', 'ui.session.unarchive', 'ui.session.rename'] as const)(
    'refuses disabled sibling %s before mutating the selected Session', async (actionId) => {
      const read = installSession('sibling-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
      const disabled = actionId === 'ui.session.rename' ? 'session.title.set'
        : actionId === 'ui.session.archive' ? 'session.archive' : 'session.unarchive';
      installActionSettings({
        [disabled]: { disabledSurfaces: ['ui'] },
      });
      let wroteArchive = false;
      homes.answer(serverId, '/v2/sessions/sibling-session/archive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: 10 } };
      } });
      homes.answer(serverId, '/v2/sessions/sibling-session/unarchive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: null } };
      } });
      const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
      const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
      const session = { ...storage.getState().sessions['sibling-session']!, active: false };
      await expect(executeSessionAction({ actionId, input: { title: 'Refused title' }, target: createSessionActionTarget({
        session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
      }) })).rejects.toThrow();
      expect(wroteArchive).toBe(false);
      expect(read().metadataVersion).toBe(1);
    },
  );
  it.each(['archive', 'unarchive'] as const)('keeps a Home database refusal through the real UI %s Action without replay', async action => {
    installActionSettings({ [`session.${action}`]: { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const archivedAt = action === 'archive' ? null : 10;
    const session = createSessionFixture({ id: `archive-database-${action}`, serverId, owner: 'alice', active: false, archivedAt });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: session.id, active: false, archivedAt });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: row } });
    const path = `/v2/sessions/${session.id}/${action}`;
    homes.answer(serverId, path, { status: 503, body: { error: 'database_transaction_timeout' } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { t } = await import('@/text');
    await expect(executeSessionAction({ actionId: action === 'archive' ? 'ui.session.archive' : 'ui.session.unarchive',
      target: createSessionActionTarget({ session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false }),
    })).rejects.toMatchObject({ code: 'database_transaction_timeout', message: t('approvals.transientFailureTitle') });
    expect(storage.getState().sessions[session.id]?.archivedAt).toBe(archivedAt);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
    expect(homes.requests.filter(request => request.path === path)).toHaveLength(1);
  });

  it.each(['offline', 'online'] as const)('presents pending Stop from the real Archive Action receipt only (%s)', async machineState => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const session = createSessionFixture({ id: `archive-action-receipt-${machineState}`, serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: session.id, active: false, archivedAt: null });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: row } });
    homes.answer(serverId, `/v2/sessions/${session.id}/archive`, { body: { success: true, archivedAt: 42,
      ...(machineState === 'offline' ? { stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' } } : {}),
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
    const { t } = await import('@/text');
    retirePresentationNotice();
    try {
      await executeSessionAction({ actionId: 'ui.session.archive', target: createSessionActionTarget({
        session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
      }) });
      expect(storage.getState().sessions[session.id]?.archivedAt).toBe(42);
      expect(readPresentationNotice()?.message ?? null)
        .toBe(machineState === 'offline' ? t('workflows.run.stopWhenMachineReconnectsUnknown') : null);
    } finally {
      retirePresentationNotice();
    }
  });

  it('keeps the owned archive timeout code and uses the translated UI failure through the real Action front door', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const session = createSessionFixture({ id: 'archive-timeout-localized', serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: session.id, active: false });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: row } });
    const entered = createDeferred<void>();
    const response = createDeferred<void>();
    homes.answer(serverId, `/v2/sessions/${session.id}/archive`, { select: () => {
      entered.resolve(); return { body: { success: true, archivedAt: 42 }, respondAfter: response.promise };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { t } = await import('@/text');
    vi.useFakeTimers();
    const pending = executeSessionAction({ actionId: 'ui.session.archive', target: createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    }) }).then(() => null, (error: unknown) => error);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(75_000);
      expect(await pending).toMatchObject({ code: 'session_archive_timeout', message: t('sessionInfo.failedToArchiveSession') });
      expect(storage.getState().sessionArchiveOperations).toEqual({});
      expect(storage.getState().sessions[session.id]?.archivedAt).toBeNull();
    } finally {
      response.resolve();
      await pending;
      vi.useRealTimers();
    }
  });

  it('shares archive progress and admission with a report archived by the real Action cascade', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'admitted-cascade-lead';
    const childId = 'admitted-cascade-child';
    const sessions = [leadId, childId].map(id => createSessionFixture({
      id, serverId, owner: 'alice', active: false, archivedAt: null,
    }));
    storage.getState().applySessions(sessions);
    const rows = sessions.map(session => createPlainSessionCurrentProjectionRecordFixture({
      id: session.id, active: false,
      ...(session.id === childId ? { manager: { sessionId: leadId } } : {}),
    }));
    const releaseChild = createDeferred<void>();
    let childArchiveRequests = 0;
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        if (row.id === childId) childArchiveRequests += 1;
        return { body: { success: true, archivedAt: 42 },
          ...(row.id === childId ? { respondAfter: releaseChild.promise } : {}) };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: createSessionListSourceFixture({
        sessions: [{ ...rows[1], viewer: createSessionViewerFixture() }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const target = (session: typeof sessions[number]) => createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    });
    const cascade = executeSessionAction({ actionId: 'ui.session.archive', target: target(sessions[0]!),
      input: { alsoArchiveReports: true } });
    let duplicate: Promise<void | false> | undefined;
    let duplicateSettled = false;
    let duplicateSkipped = false;
    try {
      await vi.waitFor(() => expect(childArchiveRequests).toBe(1));
      const childPending = isSessionArchivePending({ serverId, sessionId: childId });
      duplicate = executeSessionAction({ actionId: 'ui.session.archive', target: target(sessions[1]!) })
        .then(result => { duplicateSettled = true; duplicateSkipped = result === false; return result; });
      await vi.waitFor(() => expect(duplicateSettled || childArchiveRequests > 1).toBe(true));
      expect({ childPending, childArchiveRequests, duplicateSkipped })
        .toEqual({ childPending: true, childArchiveRequests: 1, duplicateSkipped: true });
    } finally {
      releaseChild.resolve();
      await Promise.all([cascade, duplicate]);
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('keeps an active report Stop inside shared archive admission', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'admitted-stop-lead';
    const childId = 'admitted-stop-child';
    const lead = createSessionFixture({ id: leadId, serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([lead]);
    const readChild = installSession(childId, { machineId: 'machine-a', flavor: 'claude' });
    const child = storage.getState().sessions[childId]!;
    const leadRow = createPlainSessionCurrentProjectionRecordFixture({ id: leadId, active: false });
    homes.answer(serverId, `/v2/sessions/${leadId}`, { body: { session: leadRow } });
    homes.answer(serverId, `/v2/sessions/${leadId}?accessProjectionVersion=1`, { body: { session: leadRow } });
    for (const id of [leadId, childId]) {
      homes.answer(serverId, `/v2/sessions/${id}/archive`, { body: { success: true, archivedAt: 42 } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: createSessionListSourceFixture({
        sessions: [{ ...readChild(), manager: { sessionId: leadId }, viewer: createSessionViewerFixture() }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const releaseStop = createDeferred<void>();
    let childStopRequests = 0;
    daemonAnswer = async request => {
      if (request.method !== `machine-a:${RPC_METHODS.STOP_SESSION}`) throw new Error(`Unexpected daemon method: ${request.method}`);
      expect(request.params).toMatchObject({ sessionId: childId });
      childStopRequests += 1;
      await releaseStop.promise;
      return { status: 'stopped' };
    };
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const target = (session: typeof lead) => createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    });
    const cascade = executeSessionAction({ actionId: 'ui.session.archive', target: target(lead),
      input: { alsoArchiveReports: true } });
    let duplicate: Promise<void | false> | undefined;
    let duplicateSettled = false;
    let duplicateSkipped = false;
    try {
      await vi.waitFor(() => expect(childStopRequests).toBe(1));
      const childPending = isSessionArchivePending({ serverId, sessionId: childId });
      duplicate = executeSessionAction({ actionId: 'ui.session.archive', target: target(child) })
        .then(result => { duplicateSettled = true; duplicateSkipped = result === false; return result; });
      await vi.waitFor(() => expect(duplicateSettled || childStopRequests > 1).toBe(true));
      expect({ childPending, childStopRequests, duplicateSkipped })
        .toEqual({ childPending: true, childStopRequests: 1, duplicateSkipped: true });
    } finally {
      releaseStop.resolve();
      await Promise.all([cascade, duplicate]);
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it.each(['ui', 'action'] as const)('ends a completed report archive while another report is still pending (%s)', async (entry) => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'settled-report-lead';
    const firstId = 'settled-report-first';
    const secondId = 'settled-report-second';
    const sessions = [leadId, firstId, secondId].map(id => createSessionFixture({
      id, serverId, owner: 'alice', active: false, archivedAt: null,
    }));
    storage.getState().applySessions(sessions);
    const rows = sessions.map(session => createPlainSessionCurrentProjectionRecordFixture({
      id: session.id, active: false, ...(session.id === leadId ? {} : { manager: { sessionId: leadId } }),
    }));
    const releaseSecond = createDeferred<void>();
    let secondArchiveRequests = 0;
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        if (row.id === secondId) secondArchiveRequests += 1;
        return { body: { success: true, archivedAt: 42 },
          ...(row.id === secondId ? { respondAfter: releaseSecond.promise } : {}) };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: createSessionListSourceFixture({
        sessions: rows.slice(1).map(row => ({ ...row, viewer: createSessionViewerFixture() })),
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const cascade = entry === 'ui'
      ? executeSessionAction({ actionId: 'ui.session.archive', input: { alsoArchiveReports: true },
        target: createSessionActionTarget({ session: sessions[0]!, serverId, currentUserId: 'alice', isConnected: true, isPinned: false }) })
      : createDefaultActionExecutor().execute('session.archive', { sessionId: leadId, alsoArchiveReports: true }, context());
    try {
      await vi.waitFor(() => expect(secondArchiveRequests).toBe(1));
      expect({ lead: isSessionArchivePending({ serverId, sessionId: leadId }),
        first: isSessionArchivePending({ serverId, sessionId: firstId }),
        second: isSessionArchivePending({ serverId, sessionId: secondId }) }).toEqual({ lead: true, first: false, second: true });
    } finally {
      releaseSecond.resolve();
      await cascade;
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('borrows an inherited archive proof after its Home identity is promoted', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const serverUrl = 'https://archive-proof-promotion.test';
    const legacyId = await homes.addHome({ name: 'Archive proof Home', serverUrl, accountId: 'alice', active: false,
      credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) } });
    // The focused Account restore's single-origin boundary does not own this remote Home.
    installHomeGovernanceBoundaries(httpBoundary);
    homes.answer(legacyId, '/v2/account/settings', { body: { content: { t: 'plain', v: storage.getState().settings }, version: 1 } });
    const sessionId = 'promoted-archive-proof';
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: false });
    homes.answer(legacyId, `/v2/sessions/${sessionId}`, { body: { session: row } });
    homes.answer(legacyId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: row } });
    const releaseArchive = createDeferred<void>();
    let archiveRequests = 0;
    homes.answer(legacyId, `/v2/sessions/${sessionId}/archive`, { select: () => {
      archiveRequests += 1;
      return { body: { success: true, archivedAt: 42 }, respondAfter: releaseArchive.promise };
    } });
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    const { archiveSessionWithPendingState } = await import('@/components/sessions/sessionStopArchiveFlow');
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const canonicalId = 'srv_archive_proof_promoted';
    const pending = archiveSessionWithPendingState({ serverId: legacyId, sessionId }, async operation => {
      expect(operation.serverId).toBe(legacyId);
      await setServerProfileIdentityForUrl(serverUrl, canonicalId);
      const result = await executeSessionLifecycleAction('session.archive', sessionId, {
        serverId: canonicalId, archiveOperation: operation,
      });
      // The inner Action borrows the exact proof; its caller still owns completion.
      expect(storage.getState().sessionArchiveOperations[legacyId]?.[sessionId]).toBe(operation);
      return result;
    }).then(result => ({ result }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(archiveRequests).toBe(1));
    } finally {
      releaseArchive.resolve();
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
    }
    const outcome = await pending;
    if ('error' in outcome) throw outcome.error;
    expect(outcome.result).toMatchObject({ success: true, sessionId });
    expect(archiveRequests).toBe(1);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('refuses a retired archive proof without borrowing or finishing its replacement', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const sessionId = 'retired-archive-proof';
    const session = createSessionFixture({ id: sessionId, serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: false });
    homes.answer(serverId, `/v2/sessions/${sessionId}`, { body: { session: row } });
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: row } });
    const address = { serverId, sessionId };
    const retired = storage.getState().beginSessionArchive(address);
    if (!retired) throw new Error('Expected initial archive admission');
    storage.getState().clearSessionArchiveOperations(serverId);
    const replacement = storage.getState().beginSessionArchive(address);
    if (!replacement) throw new Error('Expected replacement archive admission');
    let archiveRequests = 0;
    homes.answer(serverId, `/v2/sessions/${sessionId}/archive`, { select: () => {
      archiveRequests += 1;
      return { body: { success: true, archivedAt: 42 } };
    } });
    try {
      const result = await createDefaultActionExecutor().execute('session.archive', { sessionId }, {
        ...context(), archiveOperation: retired,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'archive_pending' });
      expect(archiveRequests).toBe(0);
      expect(storage.getState().sessionArchiveOperations[replacement.serverId]?.[sessionId]).toBe(replacement);
    } finally {
      storage.getState().finishSessionArchive(replacement);
    }
  });

  it('composes the archive choice through the real HTTP list/archive owners and strict UI consumer', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const rows = ['cascade-lead', 'cascade-child', 'cascade-refused', 'cascade-last', 'cascade-grandchild'].map(id =>
      createPlainSessionCurrentProjectionRecordFixture({ id, active: false,
        ...(id !== 'cascade-lead' ? { manager: { sessionId: id === 'cascade-grandchild' ? 'cascade-child' : 'cascade-lead' } } : {}),
      }));
    const archived: string[] = [];
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        archived.push(row.id);
        return row.id === 'cascade-refused' ? { status: 403, body: { error: 'Forbidden' } }
          : { body: { success: true, archivedAt: 10 } };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      const query = SessionListQueryV1Schema.parse(input);
      expect(query).toMatchObject({ storage: 'active', underSessionId: 'cascade-lead' });
      return { body: createSessionListSourceFixture({ sessions: rows.slice(1).map(row => ({
        ...row, viewer: createSessionViewerFixture(),
      })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
    } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const result = await executeSessionLifecycleAction('session.archive', 'cascade-lead', { serverId, alsoArchiveReports: true });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, sessionId: 'cascade-lead', reports: [
      { sessionId: 'cascade-child', status: 'archived' },
      { sessionId: 'cascade-refused', status: 'failed' },
      { sessionId: 'cascade-last', status: 'archived' },
    ] });
    const archiveOutputSchema = getActionSpec('session.archive')?.outputSchema;
    if (!archiveOutputSchema) throw new Error('Session archive output schema is unavailable');
    expect(archiveOutputSchema.parse(result)).toEqual(result);
    expect(archived).toEqual(['cascade-lead', 'cascade-child', 'cascade-refused', 'cascade-last']);
  });
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    storage.setState(originalState, true);
    await homes.reset();
    resetDynamicModelProbeCacheForTests();
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Mode Home', serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials,
      request: readBatchRequest, configureSocket: configureSessionSocket });
    storage.getState().activateProfileScope({ serverId: connection.serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId: connection.serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: machineRow.id, activeAt: machineRow.activeAt,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines', { body: [machineRow] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
    homes.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) });
    const access = bindMachineAccessActionHttpRequestV1('machines.access.grants.list', { serverId, machineId: machineRow.id });
    homes.answer(serverId, access.path, { body: MachineAccessGrantsListResponseV1Schema.parse({
      machineId: machineRow.id, custodian: machineRow.access!.custodian, access: machineRow.access,
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
    await sync.refreshMachines();
    outgoing.length = 0;
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    storage.setState(originalState, true);
    webLocks?.restore();
    webLocks = undefined;
    vi.restoreAllMocks();
  });

  it('limits the real backend catalog instead of dropping the requested limit', async () => {
    const execute = createDefaultActionExecutor().execute;
    const full = await execute('agents.backends.list', { includeDisabled: true }, context());
    const limited = await execute('agents.backends.list', { includeDisabled: true, limit: 2 }, context());
    expect(full.ok, JSON.stringify(full)).toBe(true);
    expect(limited.ok).toBe(true);
    if (!full.ok || !limited.ok) throw new Error('Catalog action failed');
    const parse = (value: unknown) => import('@happier-dev/protocol/actions/agentBackendInventory').then(({ AgentsBackendsListOutputSchema }) => AgentsBackendsListOutputSchema.parse(value));
    expect((await parse(full.result)).items.length).toBeGreaterThan(2);
    expect((await parse(limited.result)).items).toEqual((await parse(full.result)).items.slice(0, 2));
  });

  it.each([
    { agentId: 'claude', machineId: 'machine-a', limit: 3 },
    { backendTargetKey: 'acpBackend:review-bot', machineId: 'machine-a', limit: 2 },
  ])('limits model results from the requested daemon target: $agentId $backendTargetKey', async (input) => {
    daemonAnswer = () => ({ ok: true, result: {
      availableModels: ['one', 'two', 'three', 'four'].map((id) => ({ id, name: id })), supportsFreeform: false,
    } });
    const result = await createDefaultActionExecutor().execute('agents.models.list', input, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toMatchObject({ source: 'preflight', items: [
      { modelId: 'default', label: 'Default' },
      ...['one', 'two'].slice(0, input.limit - 1).map((modelId) => ({ modelId, label: modelId })),
    ] });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: expect.stringContaining('machine-a:'),
      params: expect.objectContaining({ method: 'probeModels' }) }));
    if (input.backendTargetKey) expect(outgoing).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
      params: expect.objectContaining({ backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } }),
    }) }));
  });

  it.each(([false, true, undefined] as const).flatMap(isShared => (['create', 'preview'] as const).map(phase => ({ isShared, phase }))))(
    'sends strict V2 spawn input with one custody read only when uncertain ($phase isShared=$isShared)', async ({ isShared, phase }) => {
    if (phase === 'preview') await homes.requireUiApproval(serverId, 'session.spawn_new');
    const existing = storage.getState().machineListByServerId[serverId]?.find(machine => machine.id === 'machine-a');
    if (!existing) throw new Error('Expected the scoped Machine inventory');
    const machine = { ...existing, isShared };
    storage.getState().applyMachines([machine], true, { sourceServerId: connection!.serverId });
    const access = bindMachineAccessActionHttpRequestV1('machines.access.grants.list', { serverId, machineId: machine.id });
    const readsBefore = homes.requestsFor(access.path).length;
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: `manual:voice-v2-contract:${phase}:${String(isShared)}`,
      executionTarget: { serverId, machineId: 'machine-a' }, directory: { kind: 'path', path: '/tmp/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialInput: { text: 'Inspect this project.' } });
    const spawnResult = { type: 'success', disposition: 'created', sessionId: 'session-new', executionTarget: input.executionTarget,
      organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'message-new' } };
    daemonAnswer = request => request.method === `machine-a:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`
      ? createExistingSessionDirectoryPreflightResult(request.params) : spawnResult;
    let previewed = false;
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async ({ preview }) => {
      expect(preview).toMatchObject({ actionId: 'session.spawn_new' });
      previewed = true;
      return false;
    } });
    if (phase === 'create') {
      const result = await executor.execute('session.spawn_new', input, { ...context(), signal: new AbortController().signal });
      expect(result).toEqual({ ok: true, result: spawnResult });
      expect(outgoing).toContainEqual(expect.objectContaining({ method: `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`, params: input }));
    } else {
      const result = await executor.execute('session.spawn_new', input, context());
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
      expect(previewed).toBe(true);
      expect(outgoing.some(request => request.method === `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`)).toBe(false);
    }
    expect(homes.requestsFor(access.path)).toHaveLength(readsBefore + (isShared === false ? 0 : 1));
  });

  it('clears the terminal composer with the expected state at the Session RPC boundary', async () => {
    installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true, status: 'cleared', sessionId: 's1' });
    const result = await createDefaultActionExecutor().execute('session.terminalComposer.clear',
      { sessionId: 's1', expectedStateAtMs: 1234 }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'cleared', sessionId: 's1' } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `s1:${SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR}`,
      params: { sessionId: 's1', expectedStateAtMs: 1234 } }));
  });

  it('starts a planner run without changing the parent Session mode', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' }, serverId, 1);
    const originalOwnerMetadata = read().ownerMetadata;
    const accepted = ExecutionRunStartResponseSchema.parse({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' });
    daemonAnswer = () => accepted;
    const result = await createDefaultActionExecutor().execute('subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan the changes.' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { intent: 'plan', results: [{ ok: true, result: accepted }] } });
    expect(outgoing).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
      start: expect.objectContaining({ intent: 'plan', permissionMode: 'read_only' }),
    }) }));
    expect(read().ownerMetadata).toEqual(originalOwnerMetadata);
  });

  it.each([
    ['claude', { flavor: 'claude' }, 'plan', 'plan'],
    ['opencode', { flavor: 'opencode', acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']), acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', null],
    ['codex', { flavor: 'codex', sessionModesV1: modes('codex', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', 'default'],
    ['codebuddy', { flavor: 'codebuddy', sessionModesV1: modes('codebuddy', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, '', null],
  ] as const)('publishes %s mode intent through the real owner metadata tuple', async (_agent, metadata, modeId, expectedModeId) => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', ...metadata });
    const result = await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(read().metadataLayoutVersion).toBe(1);
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpSessionModeOverrideV1 ?? flat.sessionModeOverrideV1).toMatchObject({ v: 1, modeId: expectedModeId });
    // The first write migrates to layout 1. The picker must still authorize
    // the next selection from its owner view, as on a replied live Session.
    expect(await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId }, context()))
      .toMatchObject({ ok: true });
  });

  it('rejects an unavailable mode without writing metadata', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    expect(await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId: 'not-a-real-mode' }, context()))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataLayoutVersion).toBe(0);
    expect(homes.requestsFor('/v2/sessions/s1').filter((request) => request.input != null)).toEqual([]);
  });

  it('publishes a validated Composer config-option choice through the Action owner', async () => {
    const read = installSession('s1', {
      path: '/tmp/project',
      host: 'localhost',
      flavor: 'opencode',
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 1,
        configOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        }],
      },
    });
    const result = await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'high',
    }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpConfigOptionOverridesV1).toMatchObject({
      overrides: { reasoning_effort: { value: 'high' } },
    });
  });

  it.each([false, true])('withdraws a config-option override when its control is unavailable (disabled=%s)', async disabled => {
    const read = installSession('s1', {
      path: '/tmp/project', host: 'localhost', flavor: 'opencode',
      sessionConfigOptionsV1: {
        v: 1, agentId: 'opencode', updatedAt: 1,
        configOptions: disabled ? [
          { id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium',
            options: [{ value: 'medium', name: 'Medium' }] },
          { id: 'automatic', name: 'Automatic', type: 'boolean', currentValue: 'true',
            overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'medium' } },
        ] : [],
      },
      acpConfigOptionOverridesV1: {
        v: 1, updatedAt: 2,
        overrides: { reasoning_effort: { value: 'low', updatedAt: 2 }, telemetry: { value: 'true', updatedAt: 2 } },
      },
    }, serverId, 1);
    const initialMetadataVersion = read().metadataVersion;
    expect(await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'low',
    }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataVersion).toBe(initialMetadataVersion);
    const result = await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: null,
    }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { valueId: null } });
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpConfigOptionOverridesV1).toMatchObject({ overrides: {
      reasoning_effort: { value: null }, telemetry: { value: 'true', updatedAt: 2 },
    } });
  });

  describe('a Provider-bound Session\'s model option', () => {
    const effort = {
      id: 'reasoning_effort', name: 'Thinking', type: 'select' as const, currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
    };
    const binding = {
      v: 1 as const, connectionId: 'pc_work', contributionKey: null, connectionRevision: 1,
      model: { id: 'provider-model', name: 'Provider model', modelOptions: [effort], capabilities: { reasoningControls: 'supported' as const } },
      protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
      compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
      displaySnapshot: { providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const },
    };
    const install = (modelId: string, machineId?: string) => installSession('s1', {
      path: '/tmp/project', host: 'localhost', flavor: 'codex', ...(machineId ? { machineId } : {}),
      providerBindingV1: binding,
      modelSelectionIntentV1: { v: 1, updatedAt: 2, selection: {
        agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId,
      } },
    } as never, serverId, 1);
    const readOverride = (read: ReturnType<typeof install>) => {
      const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
      return projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v })
        .acpConfigOptionOverridesV1;
    };

    it('accepts a value the running Provider model declares and refuses one it does not', async () => {
      const read = install('provider-model');
      const initialMetadataVersion = read().metadataVersion;
      expect(await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId: 'reasoning_effort', valueId: 'xhigh',
      }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(read().metadataVersion).toBe(initialMetadataVersion);
      const result = await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId: 'reasoning_effort', valueId: 'medium',
      }, context());
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(readOverride(read)).toMatchObject({ overrides: { reasoning_effort: { value: 'medium' } } });
      expect(outgoing).toEqual([]);
    });

    it('uses the pending Provider model descriptor for an inactive Session effort choice', async () => {
      // Live Muse: a personal model is armed after a stopped Team-backed run; no new launch binding exists yet.
      const read = install('armed-model', 'machine-a');
      storage.setState({ sessions: { ...storage.getState().sessions,
        s1: { ...storage.getState().sessions.s1!, active: false },
      } });
      const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'armed-model' };
      const projection = createProviderModelProjectionFixture({ agentTargetKey: selection.agentTargetKey,
        groups: [createProviderModelProjectionGroupFixture({ connectionId: selection.providerConnectionId, rows: [{
          ref: selection, descriptor: { id: selection.modelId, name: 'Armed model', modelOptions: [{
            ...effort, currentValue: 'max', options: [{ value: 'minimal', name: 'Minimal' }, { value: 'max', name: 'Max' }],
          }] }, sources: { manual: false, static: false, probe: true }, confidence: 'probe',
          compatibility: { result: { status: 'experimental', selectedProtocol: 'openai-responses',
            reasons: ['model_capability_toolRoundTrips_unknown'], confirmationScope: { kind: 'model', modelId: selection.modelId } },
            compatibilityFingerprint: 'compatibility:v1:a', confirmed: true },
          endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
        }] })] });
      daemonAnswer = () => projection;
      const initialMetadataVersion = read().metadataVersion;
      expect(await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId: 'reasoning_effort', valueId: 'high',
      }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(read().metadataVersion).toBe(initialMetadataVersion);
      const result = await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId: 'reasoning_effort', valueId: 'minimal',
      }, context());
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(readOverride(read)).toMatchObject({ overrides: { reasoning_effort: { value: 'minimal' } } });
      expect(outgoing).toHaveLength(2);
      expect(outgoing.every(request => request.method === `machine-a:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`
        && (request.params as { refreshPolicy?: string }).refreshPolicy === 'current_only')).toBe(true);
    });

    it.each(['declared', 'unknown', 'unavailable'] as const)('discovers native model options for a direct Action (%s)', async (catalog) => {
      const read = installSession('s1', {
        path: '/tmp/project', host: 'localhost', machineId: 'machine-a', flavor: 'codex',
        providerBindingV1: binding,
        modelSelectionIntentV1: { v: 1, updatedAt: 3, selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna',
        } },
      } as never, serverId, 1);
      const initialMetadataVersion = read().metadataVersion;
      daemonAnswer = () => ({ ok: true, result: {
        availableModels: catalog === 'unknown' ? [] : [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', modelOptions: [
          { id: 'service_tier', name: 'Speed', type: 'select', currentValue: 'default',
            options: [{ value: 'default', name: 'Standard' }, { value: 'fast', name: 'Fast' }] },
        ] }],
        supportsFreeform: false, source: catalog === 'unavailable' ? 'unavailable' : 'dynamic', runtimeDescriptorV1Accepted: true,
      } });
      const result = await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId: 'service_tier', valueId: 'fast',
      }, context());
      if (catalog === 'declared') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(readOverride(read)).toMatchObject({ overrides: { service_tier: { value: 'fast' } } });
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(read().metadataVersion).toBe(initialMetadataVersion);
      }
      expect(outgoing).toEqual([expect.objectContaining({
        method: `machine-a:${RPC_METHODS.CAPABILITIES_INVOKE}`,
        params: expect.objectContaining({ method: 'probeModels' }),
      })]);
    });

    it.each([
      { configId: 'reasoning_effort', valueId: 'adaptive', undeclaredValueId: 'high' },
      { configId: 'service_tier', valueId: 'fast', undeclaredValueId: 'unoffered' },
    ])('retains declared $configId=$valueId for a native model armed on a Provider route', async ({ configId, valueId, undeclaredValueId }) => {
      // Live 1103: the Provider runner's catalog lists only its Provider model, so the armed native one has no descriptor.
      const read = installSession('s1', {
        path: '/tmp/project', host: 'localhost', machineId: 'machine-a', flavor: 'codex',
        providerBindingV1: binding,
        modelSelectionIntentV1: { v: 1, updatedAt: 3, selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna',
        } },
        sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 2, currentModelId: 'provider-model',
          availableModels: [{ id: 'provider-model', name: 'Provider model', modelOptions: [effort] }] },
      } as never, serverId, 1);
      const initialMetadataVersion = read().metadataVersion;
      const session = storage.getState().sessions.s1!;
      const account = await captureLazyActionAccountContext(serverId);
      const discovery = buildSessionModelDiscoveryContext({
        target: resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })),
        agentId: 'codex', machineId: 'machine-a', serverId: account.serverId, directory: '/tmp/project', profileId: null,
        metadata: readSessionOwnerMetadataView(session), settings: account.readLiveSettings() ?? storage.getState().settings,
        accountScope: account.accountLifetime.scope,
      });
      account.dispose();
      const cacheKey = buildDynamicModelProbeCacheKey({
        machineId: discovery.selectedMachineId, targetKey: resolveBackendTargetKeyV2(discovery.backendTarget!),
        serverId: discovery.capabilityServerId, providerConnectionId: null, cwd: discovery.cwd,
        extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(discovery.probeContext),
      })!;
      writeDynamicModelProbeCacheSuccess(cacheKey, {
        availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', modelOptions: [
          { ...effort, options: [{ value: 'adaptive', name: 'Adaptive' }] },
          { id: 'service_tier', name: 'Speed', type: 'select', currentValue: 'default',
            options: [{ value: 'default', name: 'Standard' }, { value: 'fast', name: 'Fast' }] },
        ] }], supportsFreeform: false,
      });
      expect(await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId, valueId: undeclaredValueId,
      }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(outgoing, JSON.stringify(discovery)).toEqual([]);
      expect(read().metadataVersion).toBe(initialMetadataVersion);
      const result = await createDefaultActionExecutor().execute('session.config_option.set', {
        sessionId: 's1', configId, valueId,
      }, context());
      expect(result, JSON.stringify({ result, outgoing, discovery })).toMatchObject({ ok: true });
      expect(readOverride(read)).toMatchObject({ overrides: { [configId]: { value: valueId } } });
      // Choosing from a held catalog writes intent without another Machine probe.
      expect(outgoing).toEqual([]);
    });
  });

  it('rejects an unavailable Composer config-option choice without writing metadata', async () => {
    const read = installSession('s1', {
      path: '/tmp/project', host: 'localhost', flavor: 'opencode',
      sessionConfigOptionsV1: {
        v: 1, agentId: 'opencode', updatedAt: 1,
        configOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] }],
      },
    }, serverId, 1);
    const initialMetadataVersion = read().metadataVersion;
    expect(await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'ultra',
    }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataVersion).toBe(initialMetadataVersion);
  });

  it.each([false, true])('authorizes selected-model choices without bypassing global overrides (disabled=%s)', async (disabled) => {
    const reasoning = {
      id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium',
      options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
    };
    const read = installSession('s1', {
      path: '/tmp/project', host: 'localhost', flavor: 'opencode',
      modelSelectionIntentV1: { v: 1, updatedAt: 2, selection: {
        agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: null, modelId: 'selected',
      } },
      sessionModelsV1: {
        v: 1, agentId: 'opencode', updatedAt: 1, currentModelId: 'selected',
        availableModels: [{ id: 'selected', name: 'Selected', modelOptions: [reasoning] }],
      },
      ...(disabled ? { sessionConfigOptionsV1: {
        v: 1 as const, agentId: 'opencode', updatedAt: 1,
        configOptions: [reasoning, { id: 'automatic', name: 'Automatic', type: 'boolean', currentValue: 'true',
          overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'medium' } }],
      } } : {}),
    }, serverId, 1);
    const initialMetadataVersion = read().metadataVersion;
    expect(await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'unoffered',
    }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataVersion).toBe(initialMetadataVersion);
    const result = await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'high',
    }, context());
    if (disabled) {
      expect(result, JSON.stringify({ result, session: storage.getState().sessions.s1 })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(read().metadataVersion).toBe(initialMetadataVersion);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
      expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v }))
        .toMatchObject({ acpConfigOptionOverridesV1: { overrides: { reasoning_effort: { value: 'high' } } } });
    }
  });


  it.each(['ui', 'agent', 'mcp'] as const)('routes a confirmed connected-account mutation through its %s Action owner', async (surface) => {
    daemonAnswer = () => ({ ok: true, action: 'metadata_updated' });
    const input = {
      sessionId: 's1', agentId: 'claude', machineId: 'machine-a', serverId,
      bindings: { v: 2 as const, bindingsByServiceId: {} },
    };
    await installActionSettings({}, undefined, { 'session.connected_services_auth.set': ['agent', 'mcp'] });
    installSession('s1', { machineId: 'machine-a', flavor: 'claude' });
    const result = await createDefaultActionExecutor().execute(
      'session.connected_services_auth.set',
      input,
      { ...context(), surface, defaultSessionId: 's1',
        ...(surface === 'agent' ? { authority: 'account_automation' as const,
          actionCaller: { kind: 'session' as const, sessionId: 's1', starterDepth: 0, turnDepth: 0 } } : {}),
        presentUserConfirmation: { actionId: 'session.connected_services_auth.set' } },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, action: 'metadata_updated' } });
    expect(outgoing).toContainEqual(expect.objectContaining({
      method: `machine-a:${RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH}`,
      params: expect.objectContaining({ sessionId: 's1', agentId: 'claude', bindings: input.bindings }),
    }));
  });

  it.each(['ui', 'agent', 'mcp'] as const)('retains auth-switch continuity recovery through the %s Action and composer reader', async (surface) => {
    const { ConnectedServiceUxDiagnosticV1Schema } = await import('@happier-dev/protocol/connect/connectedServiceUxDiagnostics');
    const { readSessionConnectedServiceAuthSwitchActionResult } = await import('@/sync/ops/connectedServices/sessionAuthSwitch');
    // Exact public failure shape from the daemon switch owner's continuity refusal.
    const refusal = {
      ok: false as const,
      errorCode: 'continuity_unsupported' as const,
      serviceId: 'happier.agent.muse/muse-account',
      diagnostics: {
        failurePhase: 'continuity' as const,
        uxDiagnostic: ConnectedServiceUxDiagnosticV1Schema.parse({
          code: 'continuity_unsupported', failurePhase: 'continuity', source: 'manual_auth_switch',
          serviceId: 'happier.agent.muse/muse-account', retryable: false,
          suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account', 'open_connected_accounts'],
        }),
      },
    };
    daemonAnswer = () => refusal;
    const actionId = 'session.connected_services_auth.set';
    await installActionSettings({}, undefined, { [actionId]: ['agent', 'mcp'] });
    installSession('s1', { machineId: 'machine-a', flavor: 'muse' });
    const result = await createDefaultActionExecutor().execute(actionId, {
      sessionId: 's1', agentId: 'muse', machineId: 'machine-a', serverId,
      bindings: { v: 2, bindingsByServiceId: { 'happier.agent.muse/muse-account': { source: 'native' } } },
    }, { ...context(), surface, defaultSessionId: 's1',
      ...(surface === 'agent' ? { authority: 'account_automation' as const,
        actionCaller: { kind: 'session' as const, sessionId: 's1', starterDepth: 0, turnDepth: 0 } } : {}),
      presentUserConfirmation: { actionId } });
    expect(result).toMatchObject({ ok: false, errorCode: refusal.errorCode, details: refusal });
    expect(readSessionConnectedServiceAuthSwitchActionResult(result)).toEqual(refusal);
  });

  it.each([
    { runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
    { agentRuntimeDescriptorV1: { v: 1, agentId: 'opencode', provider: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
  ] as const)('resolves ACP modes and default from the canonical or supported deployed runtime carrier', async (descriptor) => {
    installSession('s1', { path: '/tmp/project', host: 'localhost',
      ...descriptor,
      acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']) });
    const result = await createDefaultActionExecutor().execute('action.options.resolve',
      { actionId: 'session.mode.set', fieldPath: 'modeId', sessionId: 's1' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
      expect.objectContaining({ value: 'default' }), expect.objectContaining({ value: 'build' }), expect.objectContaining({ value: 'plan' }),
    ]) } });
  });
});
