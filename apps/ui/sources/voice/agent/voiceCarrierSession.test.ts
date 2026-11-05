import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID, GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION } from '@happier-dev/agents';
import { SessionOrganizationSnapshotResponseSchema} from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionSpawnNewInputV2Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createServedHomeAccountToken, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Sparse fixture inputs are completed by canonical builders before publication.
let state: any = { sessions: {}, machines: {}, machineListByServerId: {}, authoringMemory: {}, settings: {} };
let homeId = '';
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let actionHttp: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | undefined;
const spawnSession = vi.fn();
const readSessions = vi.fn();
const readSession = vi.fn();
let daemonProjection: unknown = null;
const committedSessionRecords = new Map<string, ReturnType<typeof sessionWireRecord>>();
let sessionMetadataHttp = createSessionMetadataHttpBoundary(() => ({}));
const purposes = createConnectedPurposeCatalogHttpBoundary();
const voiceHomeDirectory = '/tmp/.happier/voice-agent';
const exactConnectedServices = { v: 2 as const, bindingsByServiceId: {
  'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'codex-work' },
} };
const globalVoiceStartupMarker = { v: 1 as const, id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID, revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION };
function enableCodexStartupInstructionsV1() {
  daemonProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {},
    agentsById: { codex: { id: 'codex', isBuiltIn: true, capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } } } },
  });
}
function createVoiceHomeCandidate(id: string, metadataOverrides: Record<string, unknown> = {}) {
  return { id, active: true, updatedAt: 10, metadata: {
    path: voiceHomeDirectory, host: 'm1', machineId: 'm1', homeDir: '/home/u',
    flavor: 'codex', connectedServices: exactConnectedServices, permissionMode: 'default',
    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
    voiceConversationScopeV1: { v: 1, kind: 'voice_home' }, voiceAgentStartupInstructionsV1: globalVoiceStartupMarker,
    ...metadataOverrides,
  } };
}
function createSplitVoiceHomeCandidate(id: string, overrides: Record<string, unknown> = {}) {
  const candidate = createVoiceHomeCandidate(id, overrides);
  const owner = createSessionOwnerMetadataV1({ metadata: candidate.metadata });
  if (!owner.ok) throw new Error(`Invalid Voice fixture owner fields: ${owner.unsupportedFields.join(',')}`);
  const shared = projectSessionSharedMetadataV1({ metadata: candidate.metadata });
  return { ...candidate, metadataLayoutVersion: 1, metadata: shared,
    ownerMetadataView: projectSessionOwnerCompatibilityViewV1({ sharedMetadata: shared, ownerMetadata: owner.ownerMetadata }) };
}
function installFreshVoiceHomeSpawn(sessionId = 'fresh_voice') {
  spawnSession.mockResolvedValue({ type: 'success', sessionId });
  readSessions.mockImplementation(async () => {
    state.sessions[sessionId] = { id: sessionId, active: true, updatedAt: 1,
      metadata: { path: voiceHomeDirectory, host: 'm1', machineId: 'm1', homeDir: '/home/u' } };
  });
}
function sessionWireRecord(session: ReturnType<typeof createSessionFixture>) {
  const owner = session.metadataLayoutVersion === 1 ? createSessionOwnerMetadataV1({ metadata: session.ownerMetadataView }) : null;
  if (owner && !owner.ok) throw new Error('Invalid split Session fixture owner metadata');
  return SessionCurrentProjectionRecordV1Schema.parse({
    id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
    active: session.active, activeAt: session.activeAt, archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: session.metadataLayoutVersion ?? 0,
    ...(owner?.ok ? { ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) } : {}),
    metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, agentState: null, agentStateVersion: session.agentStateVersion,
    pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
  });
}
function captureCarrierSessionRecords() {
  for (const [id, partial] of Object.entries(state.sessions)) {
    if (committedSessionRecords.has(id)) continue;
    const session = createSessionFixture({ active: true, ...partial as Parameters<typeof createSessionFixture>[0], id,
      serverId: account!.home.id, metadata: (partial as ReturnType<typeof createSessionFixture>).metadataLayoutVersion === 1
        ? (partial as ReturnType<typeof createSessionFixture>).metadata
        : { path: '/voice', host: 'voice.test', flavor: state.settings.lastUsedAgent,
          permissionMode: readLocalConversationVoiceSettings(settingsParse(state.settings).voice).agent.permissionIntent,
          ...(partial as ReturnType<typeof createSessionFixture>).metadata } });
    const record = sessionWireRecord(session);
    committedSessionRecords.set(id, record);
    sessionMetadataHttp.replaceSession(id, record);
  }
}
function publishCarrierFixture(observePresence = true) {
  const sessions = Object.fromEntries(Object.entries(state.sessions).map(([id, partial]) => {
    const session = createSessionFixture({ active: true, ...partial as Parameters<typeof createSessionFixture>[0], id,
      serverId: account!.home.id, metadata: (partial as ReturnType<typeof createSessionFixture>).metadataLayoutVersion === 1
        ? (partial as ReturnType<typeof createSessionFixture>).metadata
        : { path: '/voice', host: 'voice.test', flavor: state.settings.lastUsedAgent,
          permissionMode: readLocalConversationVoiceSettings(settingsParse(state.settings).voice).agent.permissionIntent,
          ...(partial as ReturnType<typeof createSessionFixture>).metadata } });
    return [id, session];
  }));
  const machines = Object.fromEntries(Object.entries(state.machines).map(([id, partial]) => [id,
    createMachineFixture({ storageMode: 'plain', access: createPlainMachineRowFixture({ id, accountId: 'voice-account' }).access,
      activeAt: (partial as ReturnType<typeof createMachineFixture>).active === false ? 0 : Date.now(), ...partial as Parameters<typeof createMachineFixture>[0], id })]));
  captureCarrierSessionRecords();
  storage.setState({ sessions: structuredClone(sessions), machines: structuredClone(machines),
    machineListByServerId: structuredClone({ [homeId]: Object.values(machines), ...state.machineListByServerId }),
    authoringMemory: structuredClone(state.authoringMemory), settings: settingsParse(state.settings) });
  // Authored current Machine fixtures include their presence observation; they
  // are not a cache retained from the previous Account transport's teardown.
  if (observePresence) captureMachinePresenceObservation({ serverId: account!.serverId, accountId: 'voice-account' })(Object.keys(machines));
}
async function respondToServerRequest(input: RequestInfo | URL, init?: RequestInit) {
  const purposeResponse = await purposes.handle(input, init);
  if (purposeResponse) return purposeResponse;
  const path = new URL(String(input)).pathname;
  if (path.startsWith('/v1/actions/')) {
    const response = await actionHttp?.handle(new URL(String(input)), init);
    if (response) return response;
  }
  if (path === '/health') return Response.json({});
  if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
  if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
  if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
  if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
  if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: state.settings }, version: 1 });
  if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } });
  if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
  if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
  if (path === '/v1/artifacts') return Response.json([]);
  if (path === '/v1/machines/managed/actions/list') return Response.json(ManagedListOutputV1Schema.parse({ machines: [] }));
  if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
    schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
  } }));
  const machineDetail = /^\/v1\/machines\/([^/]+)$/.exec(path);
  if (path === '/v1/machines' || path === '/v1/machines/read-batch' || machineDetail) {
    const machines = { ...Object.fromEntries((state.machineListByServerId[homeId] ?? []).map((machine: ReturnType<typeof createMachineFixture>) => [machine.id, machine])), ...state.machines };
    const rows = Object.entries(machines).map(([id, partial]) => ({ ...createPlainMachineRowFixture({ id, accountId: 'voice-account' }),
      ...partial as Parameters<typeof createMachineFixture>[0],
      installationId: actionHttp?.machine.installationId,
      installationPublicKey: actionHttp?.machine.installationPublicKey,
      activeAt: (partial as ReturnType<typeof createMachineFixture>).activeAt ?? ((partial as ReturnType<typeof createMachineFixture>).active === false ? 0 : Date.now()),
      metadata: (partial as ReturnType<typeof createMachineFixture>).metadata === null ? null : encodePlainMachineStoredContent({ ...createMachineFixture().metadata, ...(partial as ReturnType<typeof createMachineFixture>).metadata }),
    }));
    if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
      id => rows.find(machine => machine.id === id) ?? null);
    return Response.json(machineDetail ? { machine: rows.find(machine => machine.id === decodeURIComponent(machineDetail[1])) } : rows);
  }
  const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
  if (machineAccess) {
    const id = decodeURIComponent(machineAccess[1]);
    const access = createPlainMachineRowFixture({ id, accountId: 'voice-account' }).access;
    if (!access) throw new Error('Canonical Machine access missing');
    return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: id, custodian: access.custodian, access,
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }));
  }
  if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
  if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v1/sessions') {
    if (spawnSession.mock.calls.length) { await readSessions(); captureCarrierSessionRecords(); }
    return Response.json(createSessionListSourceFixture({ sessions: [...committedSessionRecords.values()], hasNext: false, nextCursor: null }));
  }
  const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    if (!committedSessionRecords.has(id)) { await readSession(id); captureCarrierSessionRecords(); }
    const current = committedSessionRecords.get(id);
    if (!current) return new Response('{}', { status: 404 });
    if (init?.method === 'PATCH') {
      const response = sessionMetadataHttp.handle(input, init);
      const detail = sessionMetadataHttp.handle(input);
      if (!response || !detail) throw new Error('Missing canonical Session metadata boundary');
      committedSessionRecords.set(id, SessionCurrentProjectionRecordV1Schema.parse((await detail.json()).session));
      return response;
    }
    return Response.json({ session: current });
  }
  return new Response('{}', { status: 404 });
}
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  // A scoped Socket may be pooled across Account restores. Keep its external
  // ACK boundary cold for its full lifetime, including restoreAllMocks teardown.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event === 'rpc-call') {
      const request = payload as { method: string; params: unknown };
      return { ok: true, result: await dispatchMachineRpc(request.method.slice(request.method.indexOf(':') + 1), request.params) };
    }
    if (event !== 'update-metadata') throw new Error(`Unexpected socket acknowledgement: ${event}`);
    const record = committedSessionRecords.get(payload.sid);
    if (!record) throw new Error('Metadata ACK requested for an unknown Session');
    const committed = SessionCurrentProjectionRecordV1Schema.parse({ ...record, metadata: payload.metadata, metadataVersion: payload.expectedVersion + 1 });
    committedSessionRecords.set(payload.sid, committed);
    sessionMetadataHttp.replaceSession(payload.sid, committed);
    return { result: 'success', version: committed.metadataVersion, metadata: committed.metadata };
  });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
async function dispatchMachineRpc(method: string, payload: unknown) {
  if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
    return createExistingSessionDirectoryPreflightResult(payload);
  }
  if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
    const input = SessionResumeRequestV1Schema.parse(payload);
    return { type: 'success', sessionId: input.sessionId };
  }
  if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
    return daemonProjection ? { protocolVersion: 1, projection: daemonProjection } : { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
  }
  if (method !== RPC_METHODS.SESSION_SPAWN_NEW) throw new Error(`Unexpected machine RPC: ${method}`);
  const input = SessionSpawnNewInputV2Schema.parse(payload);
  const spawned = await spawnSession(input);
  if (spawned.type !== 'success') return SessionSpawnNewResultV1Schema.parse(spawned);
  return SessionSpawnNewResultV1Schema.parse({ ...spawned, disposition: 'created', executionTarget: input.executionTarget,
    organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
}
await loadSyncSingletonForTests();
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreActionExecutorModuleLoader);
describe('voiceConversationSession', () => {
  afterEach(async () => { await account?.dispose(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    vi.useRealTimers();
    spawnSession.mockReset(); readSessions.mockReset(); readSession.mockReset();
    committedSessionRecords.clear(); sessionMetadataHttp = createSessionMetadataHttpBoundary(() => ({}));
    daemonProjection = null; clearDaemonMergedProjectionCacheForTests();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {}, scope: 'global', primaryActionSessionAddress: null, voiceLiveContextSessionAddresses: [], lastFocusedSessionAddress: null });
    state = { settings: {} };
    actionHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://voice-carrier.example.test',
      serverIdentityId: 'srv_voice-carrier-home', accountId: 'voice-account', machineId: 'm1', actionId: 'session.spawn_new',
      tokenEpoch: 0, execute: async input => projectSessionSpawnNewActionResultV1(
        SessionSpawnNewResultV1Schema.parse(await dispatchMachineRpc(RPC_METHODS.SESSION_SPAWN_NEW, input))) });
    account = await restoreServerAccountForTest({ serverUrl: 'https://voice-carrier.example.test',
      serverIdentityId: 'srv_voice-carrier-home', accountId: 'voice-account',
      credentials: { token: createServedHomeAccountToken('voice-account', true) },
      credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(respondToServerRequest) });
    homeId = account.serverId;
    state = { sessions: {}, machines: {}, machineListByServerId: {}, authoringMemory: {}, settings: {} };
    storage.setState({ sessionListIndexByServerId: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
    state.machines = {
      m1: {
        id: 'm1',
        active: true,
        metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/.happier', homeDir: '/home/u' },
      },
    };
    state.machineListByServerId = {};
    state.authoringMemory = { recentMachinePaths: [{ machineId: 'm1', path: '/tmp/repo' }] };
    state.settings = {
      lastUsedAgent: 'claude',
      voice: {
        executionMachine: { mode: 'auto', machineId: null },
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            agent: {
              agentSource: 'session',
              voiceHomeSubdirName: 'voice-agent',
            },
          } },
        },
      },
    };
  });

  it.each([false, true])('ensureVoiceConversationSessionId spawns and marks a hidden conversation after retained Machine recovery (%s)', async recovered => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    if (recovered) state.machines.m1.active = false;
    publishCarrierFixture();
    if (recovered) {
      const retainedMachine = storage.getState().machines.m1!;
      state.machines.m1.active = true;
      publishMachineActivity(retainedMachine, { active: true, activeAt: Date.now() }, []);
    }
    const outcome = await ensureVoiceConversationSessionId().then(sessionId => ({ sessionId }), async error => {
      const { getBugReportUserActionTrail } = await import('@/utils/system/bugReportActionTrail');
      return { failure: error instanceof Error ? error.message : 'unknown', spawnCalls: spawnSession.mock.calls.length,
        trail: getBugReportUserActionTrail().filter(item => item.action.startsWith('session.spawn_new.')) };
    });
    expect(outcome).toEqual({ sessionId: 'sys_voice' });
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: { serverId: homeId, machineId: 'm1' },
        directory: { kind: 'path', path: '/tmp/.happier/voice-agent' },
        agentTarget: expect.objectContaining({ identity: expect.objectContaining({ localId: 'claude' }) }),
        transcriptStorage: 'persisted',
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0])
      .not.toHaveProperty('agentSessionStartupInstructionsV1');

    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'sys_voice')?.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
  });

  it('retains the directory-preflight Machine content refusal for the Voice presenter', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');
    // A readable projection without mode/access cannot authorize an RPC payload.
    state.machines.m1.storageMode = undefined;
    state.machines.m1.access = undefined;
    publishCarrierFixture();
    const failure = await ensureVoiceConversationSessionId().then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MACHINE_ENCRYPTION_UNAVAILABLE', message: 'MACHINE_ENCRYPTION_UNAVAILABLE',
    });
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    const { resolveVoiceMachineErrorTranslationKey } = await import('@/voice/runtime/machine/voiceMachineErrorCopy');
    const presented = classifyVoiceMachineError(failure, { kind: 'provider_error' });
    expect(presented).toMatchObject({ kind: 'execution_machine_unavailable', reason: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
    expect(resolveVoiceMachineErrorTranslationKey(presented.kind, presented.reason))
      .toBe('voice.readiness.execution_machine_missing');
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('sends global startup instructions only when the old/new daemon projection declares V1', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions.old_voice = {
      id: 'old_voice',
      active: true,
      updatedAt: 10,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'default',
        systemSessionV1: {
          v: 1,
          key: 'voice_conversation',
          hidden: true,
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        voiceAgentStartupInstructionsV1: {
          v: 1,
          id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
          revision: 0,
        },
      },
    };
    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: {
          path: '/tmp/.happier/voice-agent',
          host: 'm1',
          machineId: 'm1',
          homeDir: '/home/u',
        },
      };
    });

    publishCarrierFixture();
    await ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: false,
    }, undefined, { kind: 'new', creationKey: 'startup-instructions-new' });


    const spawnInput = spawnSession.mock.calls[0]?.[0];
    expect(spawnSession.mock.calls[0]?.[0]).toHaveProperty('agentSessionStartupInstructionsV1');
    expect(spawnInput.agentSessionStartupInstructionsV1).toMatchObject({
      v: 1,
      id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
      revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
    });
    expect(spawnInput.agentSessionStartupInstructionsV1.instructions)
      .toContain("Happier's global Voice agent");
    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'sys_voice')?.voiceAgentStartupInstructionsV1)
      .toEqual({
        v: 1,
        id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
        revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
      });
    expect(JSON.stringify(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'sys_voice')))
      .not.toContain('Global Voice agent');
  });

  it('continues an explicitly selected native voice-home Session with effective startup instructions', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions.exact_voice = createSplitVoiceHomeCandidate('exact_voice');
    installFreshVoiceHomeSpawn();

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
    }, undefined, { kind: 'continue', conversationSessionAddress: { serverId: homeId, sessionId: 'exact_voice' } })).resolves.toBe('exact_voice');

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('continues the selected Windows voice-home Session and leaves unrelated conversations untouched', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.machines.m1.metadata = {
      ...state.machines.m1.metadata,
      platform: 'win32',
      happyHomeDir: 'C:\\Users\\Alice\\.happier\\',
      homeDir: String.raw`C:\Users\Alice`,
    };
    state.sessions = {
      exact_voice: createVoiceHomeCandidate('exact_voice', {
        path: 'c:/users/alice/.happier/voice-agent/',
      }),
      sibling_voice: {
        ...createVoiceHomeCandidate('sibling_voice', {
          path: 'c:/users/alice/.happier/voice-agent2',
        }),
        updatedAt: 100,
      },
      legacy_equivalent: {
        id: 'legacy_equivalent',
        active: true,
        updatedAt: 200,
        metadata: {
          path: 'C:/USERS/ALICE/.HAPPIER/voice-agent',
          machineId: 'm1',
          directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'm1',
            remoteSessionId: 'remote-legacy',
            source: { kind: 'codexHome', home: 'user' },
          },
          systemSessionV1: {
            v: 1,
            key: 'voice_conversation',
            hidden: true,
          },
        },
      },
    };
    installFreshVoiceHomeSpawn();

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
    }, undefined, { kind: 'continue', conversationSessionAddress: { serverId: homeId, sessionId: 'exact_voice' } })).resolves.toBe('exact_voice');

    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'legacy_equivalent')?.systemSessionV1).toMatchObject({
      v: 1,
      key: 'voice_conversation',
      hidden: true,
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps a Windows voice-home spawn directory operational', async () => {
    const {
      ensureVoiceConversationSessionId,
    } = await import('@/voice/persistence/voiceConversationSession');
    const operationalDirectory = String.raw`C:\Users\Alice\.happier\voice-agent`;
    state.machines.m1.metadata = {
      ...state.machines.m1.metadata,
      platform: 'win32',
      happyHomeDir: 'C:\\Users\\Alice\\.happier\\',
      homeDir: String.raw`C:\Users\Alice`,
    };
    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'windows_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.windows_voice = {
        id: 'windows_voice',
        active: true,
        updatedAt: 1,
        metadata: {
          path: operationalDirectory,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('windows_voice');

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: { kind: 'path', path: operationalDirectory },
    }));
  });

  it('starts an explicitly new conversation without selecting an existing same-recipe conversation', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions.exact_voice = createVoiceHomeCandidate('exact_voice');
    installFreshVoiceHomeSpawn();

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
    }, undefined, { kind: 'new', creationKey: 'person-selected-new' })).resolves.toBe('fresh_voice');

    expect(spawnSession.mock.calls[0]?.[0]).toHaveProperty('agentSessionStartupInstructionsV1');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: homeId, machineId: 'm1' },
      directory: { kind: 'path', path: voiceHomeDirectory },
      agentTarget: expect.objectContaining({ identity: expect.objectContaining({ localId: 'codex' }) }),
      connectedServices: exactConnectedServices,
      permissionMode: 'default',
    }));
  });

  it('refuses an explicitly selected native conversation whose required execution identity differs', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions = {
      wrong_backend: createVoiceHomeCandidate('wrong_backend', {
        flavor: 'claude',
      }),
      wrong_profile: createVoiceHomeCandidate('wrong_profile', {
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-personal',
            },
          },
        },
      }),
      wrong_group: createVoiceHomeCandidate('wrong_group', {
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'secondary',
              profileId: 'codex-work',
            },
          },
        },
      }),
      wrong_permission: createVoiceHomeCandidate('wrong_permission', {
        permissionMode: 'read-only',
      }),
      wrong_startup_id: createVoiceHomeCandidate('wrong_startup_id', {
        voiceAgentStartupInstructionsV1: {
          ...globalVoiceStartupMarker,
          id: 'happier.other_voice_agent',
        },
      }),
      wrong_startup_revision: createVoiceHomeCandidate('wrong_startup_revision', {
        voiceAgentStartupInstructionsV1: {
          ...globalVoiceStartupMarker,
          revision: 0,
        },
      }),
    };
    state.sessions.wrong_split_agent = createSplitVoiceHomeCandidate('wrong_split_agent', { flavor: 'claude' });
    state.sessions.missing_split_agent = createSplitVoiceHomeCandidate('missing_split_agent', { flavor: undefined });

    publishCarrierFixture();
    for (const sessionId of Object.keys(state.sessions)) {
      await expect(ensureVoiceConversationSessionForVoiceHome({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: exactConnectedServices,
        permissionIntent: 'default',
        coldResumeStartupInstructionsEffective: true,
      }, undefined, { kind: 'continue', conversationSessionAddress: { serverId: homeId, sessionId } }))
        .rejects.toMatchObject({ code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED' });
    }

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('fails closed before sending startup text when an old daemon projects no V1 capability', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    daemonProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { codex: { id: 'codex', isBuiltIn: true } }, familiesById: {} });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: false,
    })).rejects.toMatchObject({
      code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('waits briefly for a late-hydrated global spawn target before failing', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.authoringMemory.recentMachinePaths = [];
    state.sessions = {};

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    setTimeout(() => {
      state.authoringMemory.recentMachinePaths = [{ machineId: 'm1', path: '/tmp/repo' }];
    }, 25);

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: { serverId: homeId, machineId: 'm1' },
        directory: { kind: 'path', path: '/tmp/.happier/voice-agent' },
      }),
    );
  });

  it('fails closed instead of roaming when the fixed machine target is inactive', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_stale: { id: 'm_stale', active: false, metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/stale', homeDir: '/home/u' } },
      m_active: { id: 'm_active', active: true, metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/active', homeDir: '/home/u' } },
    };
    state.settings.voice.executionMachine = { mode: 'fixed', machineId: 'm_stale' };
    state.authoringMemory.recentMachinePaths = [{ machineId: 'm_active', path: '/tmp/repo-active' }];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo-active', host: 'active', machineId: 'm_active', homeDir: '/home/u' },
      };
    });

      publishCarrierFixture();
      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when fixed-machine metadata is not hydrated instead of trusting a recent path', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {};
    state.settings.voice.executionMachine = { mode: 'fixed', machineId: 'm_fixed' };
    state.authoringMemory.recentMachinePaths = [
      { machineId: 'm_fixed', path: '/tmp/fixed-repo' },
      { machineId: 'm_other', path: '/tmp/other-repo' },
    ];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/fixed-repo', host: 'fixed', machineId: 'm_fixed', homeDir: '/home/u' },
      };
    });

      publishCarrierFixture();
      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale inactive recent-machine candidates and falls back to an active machine for voice home', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_stale: {
        id: 'm_stale',
        active: false,
        metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/stale', homeDir: '/home/u' },
      },
      m_active: {
        id: 'm_active',
        active: true,
        metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/active', homeDir: '/home/u' },
      },
    };
    state.authoringMemory.recentMachinePaths = [{ machineId: 'm_stale', path: '/tmp/stale-repo' }];
    state.sessions = {
      stale_session: {
        id: 'stale_session',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/stale-repo', host: 'stale', machineId: 'm_stale', homeDir: '/home/u' },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 2,
        metadata: { path: '/tmp/active/voice-agent', host: 'active', machineId: 'm_active', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: { serverId: homeId, machineId: 'm_active' },
        directory: { kind: 'path', path: '/tmp/active/voice-agent' },
        transcriptStorage: 'persisted',
      }),
    );
  });

  it('prefers the sticky auto-selected voice machine over a newer recent machine path', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_recent: {
        id: 'm_recent',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'recent', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/recent', homeDir: '/home/u' },
      },
      m_sticky: {
        id: 'm_sticky',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'sticky', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/sticky', homeDir: '/home/u' },
      },
    };
    state.authoringMemory.recentMachinePaths = [{ machineId: 'm_recent', path: '/tmp/recent-repo' }];
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().rememberAutoTargetMachine(storage.getState().settingsScope!, 'm_sticky');

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/sticky/voice-agent', host: 'sticky', machineId: 'm_sticky', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: { serverId: homeId, machineId: 'm_sticky' },
        directory: { kind: 'path', path: '/tmp/sticky/voice-agent' },
      }),
    );
  });

  it('fails closed instead of roaming when a sticky auto-selected voice machine is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

      state.machines = {
        m_sticky: {
          id: 'm_sticky',
          active: false,
          activeAt: 0,
          metadata: { host: 'sticky', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/sticky', homeDir: '/home/u' },
        },
        m_other: {
          id: 'm_other',
          active: true,
          activeAt: Date.now(),
          metadata: { host: 'other', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/other', homeDir: '/home/u' },
        },
      };
      const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
      useVoiceTargetStore.getState().rememberAutoTargetMachine(storage.getState().settingsScope!, 'm_sticky');
      state.authoringMemory.recentMachinePaths = [{ machineId: 'm_other', path: '/tmp/other-repo' }];

      spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
      readSessions.mockImplementation(async () => {
        state.sessions.sys_voice = {
          id: 'sys_voice',
          updatedAt: 1,
          active: true,
          metadata: { path: '/tmp/other/voice-agent', host: 'other', machineId: 'm_other', homeDir: '/home/u' },
        };
      });

      publishCarrierFixture();
      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves the voice-home spawn target from the active server machine list when the machine record map is empty', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {};
    state.machineListByServerId = {
      [homeId]: [
        {
          id: 'm_server',
          active: true,
          activeAt: Date.now(),
          metadata: {
            host: 'server-machine',
            platform: 'darwin',
            happyCliVersion: '1',
            happyHomeDir: '/tmp/server-happy',
            homeDir: '/home/u',
          },
        },
      ],
    };
    state.authoringMemory.recentMachinePaths = [];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/server-happy/voice-agent', host: 'server-machine', machineId: 'm_server', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: { serverId: homeId, machineId: 'm_server' },
        directory: { kind: 'path', path: '/tmp/server-happy/voice-agent' },
      }),
    );
  });

  it('ensureVoiceConversationSessionForSessionRoot spawns a hidden voice conversation session in the session project root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo = {
        id: 'sys_voice_repo',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } })).resolves.toBe('sys_voice_repo');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: homeId, machineId: 'm1' },
      directory: { kind: 'path', path: '/tmp/repo' },
      transcriptStorage: 'persisted',
    }));
    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'sys_voice_repo')?.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'sys_voice_repo')?.voiceConversationScopeV1).toMatchObject({
      v: 1,
      kind: 'session_root',
      sessionRootId: 's_user',
    });
  });

  it('continues the explicitly selected session-root conversation across Windows separator spellings', async () => {
    const {
      ensureVoiceConversationSessionForSessionRoot,
    } = await import('@/voice/persistence/voiceConversationSession');
    state.sessions = {
      s_user: {
        id: 's_user',
        active: true,
        updatedAt: 1,
        metadata: {
          path: String.raw`C:\Workspace\Repo`,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      },
      exact_session_root_voice: {
        id: 'exact_session_root_voice',
        active: true,
        updatedAt: 10,
        metadata: {
          path: 'c:/workspace/repo/',
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
          systemSessionV1: {
            v: 1,
            key: 'voice_conversation',
            hidden: true,
          },
          voiceConversationScopeV1: {
            v: 1,
            kind: 'session_root',
            sessionRootId: 's_user',
          },
        },
      },
    };

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 's_user' },
      conversationSelection: { kind: 'continue', conversationSessionAddress: { serverId: homeId, sessionId: 'exact_session_root_voice' } },
    })).resolves.toBe('exact_session_root_voice');

    expect(readSessions).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps a Windows session-root spawn directory operational', async () => {
    const {
      ensureVoiceConversationSessionForSessionRoot,
    } = await import('@/voice/persistence/voiceConversationSession');
    const operationalDirectory = String.raw`C:\Workspace\Repo`;
    state.sessions.s_user = {
      id: 's_user',
      active: true,
      updatedAt: 1,
      metadata: {
        path: operationalDirectory,
        host: 'm1',
        machineId: 'm1',
        homeDir: String.raw`C:\Users\Alice`,
      },
    };
    spawnSession.mockResolvedValue({
      type: 'success',
      sessionId: 'windows_session_root_voice',
    });
    readSessions.mockImplementation(async () => {
      state.sessions.windows_session_root_voice = {
        id: 'windows_session_root_voice',
        active: true,
        updatedAt: 2,
        metadata: {
          path: operationalDirectory,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 's_user' },
    })).resolves.toBe('windows_session_root_voice');

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: { kind: 'path', path: operationalDirectory },
    }));
  });

  it('does not claim an unverified same-directory session after an ambiguous spawn timeout', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      active: true,
      activeAt: 1,
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    state.sessions.unverified_same_directory = {
      id: 'unverified_same_directory', active: true, updatedAt: 2,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } })).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_SPAWN_PENDING',
    });

    expect(spawnSession).toHaveBeenCalledOnce();
    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'unverified_same_directory')?.systemSessionV1).toBeUndefined();
  });

  it('reuses an active hidden voice session only for the same session root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user_a = {
      id: 's_user_a',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.s_user_b = {
      id: 's_user_b',
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.sys_voice_repo_a = {
      id: 'sys_voice_repo_a',
      active: true,
      activeAt: 100,
      updatedAt: 100,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's_user_a' },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo_b' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo_b = {
        id: 'sys_voice_repo_b',
        active: true,
        activeAt: 101,
        updatedAt: 101,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user_b' } })).resolves.toBe('sys_voice_repo_b');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('continues the explicitly selected active conversation for the same session root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.sys_voice_repo = {
      id: 'sys_voice_repo',
      active: true,
      activeAt: 100,
      updatedAt: 100,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's_user' },
      },
    };

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' },
      conversationSelection: { kind: 'continue', conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice_repo' } },
    })).resolves.toBe('sys_voice_repo');
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('surfaces the canonical Action failure when creating a hidden voice conversation session for a target root fails', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } })).rejects.toMatchObject({
      message: 'spawn_failed',
      code: 'spawn_failed',
    });
  });

  it('reports unavailable encryption material for an online locked target machine', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');
    state.sessions.s_user = {
      id: 's_user', active: true, presence: 'online', updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.machines.m1 = createMachineFixture({ id: 'm1', active: true, activeAt: Date.now(),
      availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
    });
    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } }))
      .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_KEY_UNAVAILABLE' });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not spawn when the root machine has no reachable target', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');
    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      presence: 'online',
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.machines.m1 = {
      id: 'm1',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      active: false,
      activeAt: Date.now() - 5 * 60_000,
      revokedAt: null,
      metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/.happier', homeDir: '/home/u' },
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } }))
      .rejects.toThrow('voice_conversation_session_target_missing');

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('continues the last inactive Voice conversation instead of replacing its identity', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.stale_voice = {
      id: 'stale_voice',
      active: false,
      activeAt: 10,
      updatedAt: 999,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_fresh' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_fresh = {
        id: 'sys_voice_fresh',
        active: true,
        activeAt: 1000,
        updatedAt: 1000,
        metadata: { path: '/tmp/.happier/voice-agent', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('stale_voice');
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('hydrates a missing target session before spawning a hidden voice conversation session for its root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    readSession.mockImplementation(async (sessionId: string) => {
      // Neighboring background hydration is a normal 404 at the HTTP boundary,
      // not a transport exception that declares the entire Home unreachable.
      if (sessionId !== 's_remote') return;
      state.sessions.s_remote = {
        id: 's_remote',
        updatedAt: 1,
        metadata: { path: '/tmp/remote-repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_remote' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_remote = {
        id: 'sys_voice_remote',
        updatedAt: 1,
        metadata: { path: '/tmp/remote-repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_remote' } })).resolves.toBe('sys_voice_remote');
    expect(readSession).toHaveBeenCalledWith('s_remote');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: homeId, machineId: 'm1' },
      directory: { kind: 'path', path: '/tmp/remote-repo' },
      transcriptStorage: 'persisted',
    }));
  });

  it('does not reuse an inactive hidden voice session for a target root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.stale_voice_repo = {
      id: 'stale_voice_repo',
      active: false,
      activeAt: 10,
      updatedAt: 999,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo_fresh' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo_fresh = {
        id: 'sys_voice_repo_fresh',
        active: true,
        activeAt: 1000,
        updatedAt: 1000,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 's_user' } })).resolves.toBe('sys_voice_repo_fresh');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('starts a persisted conversation without retiring an unselected direct-linked legacy conversation', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.legacy_direct = {
      id: 'legacy_direct',
      updatedAt: 20,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        machineId: 'm1',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'm1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_fresh' });
    readSessions.mockImplementation(async () => {
      state.sessions.sys_voice_fresh = {
        id: 'sys_voice_fresh',
        updatedAt: 21,
        metadata: { path: '/tmp/.happier/voice-agent', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    publishCarrierFixture();
    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice_fresh');

    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), 'legacy_direct')?.systemSessionV1).toMatchObject({
      v: 1,
      key: 'voice_conversation',
      hidden: true,
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: homeId, machineId: 'm1' },
      directory: { kind: 'path', path: '/tmp/.happier/voice-agent' },
      transcriptStorage: 'persisted',
    }));
  });

});
