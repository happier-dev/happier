import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
} from '@happier-dev/agents';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
  AgentSessionRealtimeInspectResultV1Schema,
  PluginProjectionV2Schema, SessionCurrentProjectionRecordV1Schema,
  SessionMetadataTuplePatchV1Schema, SessionSpawnNewInputV2Schema,
  V2SessionListResponseSchema, MachineAccessGrantsListResponseV1Schema,
  SessionOrganizationSnapshotResponseSchema,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import { ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { ConnectedAccountCatalogRowReadResponseV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionRunnerRuntimeStatusFixture } from '@/dev/testkit/fixtures/sessionRunnerRuntimeFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { StorageState } from '@/sync/store/types';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
type WireSpawnFixtureInput = Omit<ReturnType<typeof SessionSpawnNewInputV2Schema.parse>, 'directory'> & {
  directory: string; machineId: string; serverId: string;
  backendTarget: { kind: 'backend'; backendId: string }; userAttemptId: string | undefined;
};
type MachineSpawnTrustedHiddenSystemSessionFn = (
  input: WireSpawnFixtureInput,
  marker: NonNullable<ReturnType<typeof SessionSpawnNewInputV2Schema.parse>['agentSessionStartupInstructionsV1']>,
) => ReturnType<typeof import('@/sync/ops/machines').machineSpawnTrustedHiddenSystemSession>;
// Mutable external fixtures cover retained/malformed rows; actual wire schemas and readers remain real.
type TestState = {
  authoringMemory?: { recentMachinePaths: { machineId: string; path: string }[] };
  settingsScope?: { serverId: string; accountId: string } | null;
  settings: any;
  machines: Record<string, any>;
  sessions: Record<string, any>;
  sessionListRowsByServerId?: Record<string, Record<string, any>>;
  ordinarySessionListMembershipByServerId?: Record<string, string[]>;
  sessionListIndexByServerId?: StorageState['sessionListIndexByServerId'];
  concurrentSessionListCacheByServerId?: Record<string, any>;
};
let state: TestState;
let homeId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const sessionRecords = new Map<string, ReturnType<typeof sessionWireRecord>>();
const projectionResponse = vi.fn<MachineContributionRegistryProjectionDescribeFn>();
const spawnResponse = vi.fn();
const trustedSpawnResponse = vi.fn<MachineSpawnTrustedHiddenSystemSessionFn>();
const spawnRequests = vi.fn();
const listResponse = vi.fn();
let sessionListWireOverride: ReturnType<typeof V2SessionListResponseSchema.parse> | null = null;
const metadataPatchResponse = vi.fn<(sessionId: string) => Promise<void>>();
const sessionDetailResponse = vi.fn();
let sessionOrganizationFailure: Error | null = null;
const sessionRpcResponse = vi.fn();
const operationResponse = vi.fn();
const resumeResponse = vi.fn();
const unarchiveResponse = vi.fn<(sessionId: string) => Promise<Response>>();
let runnerObservedAtMs = 2000;
let purposeBindings: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] };
let purposeCatalogUnavailable = false;
let purposeCatalogReads = 0;
const globalVoiceStartupInstructionsMarker = Object.freeze({
  v: 1 as const,
  id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
});

function sessionCreationCorrespondence(input: Pick<ReturnType<typeof SessionSpawnNewInputV2Schema.parse>,
  'agentTarget' | 'executionTarget' | 'directory' | 'creationKey'> &
  Partial<ReturnType<typeof SessionSpawnNewInputV2Schema.parse>>) {
  return SessionCreationCorrespondenceV1Schema.parse({
    v: 1,
    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'voice-test-daemon',
      creationKey: input.creationKey ?? 'direct-session' }),
    recipe: {
      execution: { machineId: input.executionTarget.machineId, directory: input.directory },
      organization: { folderId: null, tagIds: [] }, agentTarget: input.agentTarget,
      modelSelection: input.modelSelection ?? null, profileId: null, requestedPermissionMode: input.permissionMode ?? null, agentModeId: null,
      configuration: null, connectedServices: input.connectedServices ?? null, capabilitySelection: null,
      transcriptStorage: input.transcriptStorage ?? 'persisted', terminal: null,
      agentSessionStartupInstructionsMarkerV1: input.agentSessionStartupInstructionsV1
        ? { v: 1, id: input.agentSessionStartupInstructionsV1.id, revision: input.agentSessionStartupInstructionsV1.revision }
        : null,
      checkout: null,
    },
  });
}

function rejectNextMetadataCommitForSession(sessionId: string, error: Error): void {
  let shouldReject = true;
  metadataPatchResponse.mockImplementation(async targetSessionId => {
    if (targetSessionId === sessionId && shouldReject) {
      shouldReject = false;
      throw error;
    }
  });
}

// Voice's real creator always records its admitted permission; retained fixtures need that same proof.
const voiceFixtureMetadataDefaults = { path: '/voice', host: 'voice.test', flavor: 'codex', permissionMode: 'read-only' } as const;

function sessionWireRecord(session: ReturnType<typeof createSessionFixture>) {
  const metadata = session.metadata ? { ...voiceFixtureMetadataDefaults, ...session.metadata,
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}) } : null;
  const owner = session.metadataLayoutVersion === 1 ? createSessionOwnerMetadataV1({ metadata }) : null;
  if (owner && !owner.ok) throw new Error('Invalid split Session fixture owner metadata');
  return SessionCurrentProjectionRecordV1Schema.parse({
    id: session.id, seq: session.seq ?? 1, createdAt: session.createdAt ?? 1,
    updatedAt: session.updatedAt, active: session.active,
    activeAt: session.presence === 'online' ? Date.now() : session.activeAt ?? 1,
    archivedAt: session.archivedAt ?? null, encryptionMode: 'plain', metadataLayoutVersion: session.metadataLayoutVersion ?? 0,
    metadata: JSON.stringify(owner?.ok ? projectSessionSharedMetadataV1({ metadata }) : metadata),
    ...(owner?.ok ? { ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) } : {}),
    metadataVersion: session.metadataVersion ?? 1,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionFixture().access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null,
    agentState: null, agentStateVersion: session.agentStateVersion ?? 0,
    pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
  });
}
function commitFixtureSession(id: string) {
  if (sessionRecords.has(id)) return sessionRecords.get(id);
  const raw = state.sessions[id];
  const row = state.sessionListRowsByServerId?.[homeId]?.[id];
  const session = raw?.metadata ? raw : row?.metadata ? row : raw ?? row;
  if (!session) return undefined;
  const record = sessionWireRecord(createSessionFixture({ ...session, id, serverId: homeId }));
  sessionRecords.set(id, record);
  return record;
}
// Real Sync owns tuple parsing, retries and projection application; only Home HTTP is synthetic.
async function respondToServerRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  const path = new URL(String(input)).pathname;
  if (path === '/v2/sessions/read-batch') return null;
  const json = (body: unknown) => Response.json(body);
  if (path === managedMachineActionEndpointPathV1('machines.managed.list')) {
    return json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }));
  }
  if (path === '/health') return json({});
  if (path === '/v2/cursor') return json({ cursor: 0, changesFloor: 0 });
  if (path === '/v2/changes') return json({ changes: [], nextCursor: 0 });
  if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
  if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: state.settings }, version: 1 });
  if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
  if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
    purposeCatalogReads += 1;
    return purposeCatalogUnavailable ? new Response('{}', { status: 503 })
      : json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: purposeBindings } } }));
  }
  if (path === ACP_CATALOG_ROWS_ROUTE_V1) return json({ status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, definitions: [] } } });
  if (path === '/v1/account/authoring-memory') return json({ rows: [{ key: 'recentMachinePaths', revision: 1,
    content: { t: 'plain', v: state.authoringMemory?.recentMachinePaths ?? [] } }] });
  if (path.startsWith('/v1/account/authoring-memory/')) return json({ status: 'present', revision: 1,
    content: { t: 'plain', v: path.endsWith('/recentMachinePaths') ? state.authoringMemory?.recentMachinePaths ?? [] : null } });
  if (path === '/v1/account/project-rows/list') return json({ status: 'listed', rows: [], coverage: 'complete' });
  if (path === '/v1/artifacts') return json([]);
  if (path === '/v2/session-organization') {
    if (sessionOrganizationFailure && state.sessions['voice-home-session']) {
      return Response.json({ error: sessionOrganizationFailure.message }, { status: 422 });
    }
    return json(SessionOrganizationSnapshotResponseSchema.parse({
    snapshot: { schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [],
      tags: [], tagAssignments: [], orderEntries: [], labels: [] },
    }));
  }
  const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
  if (machineAccess) {
    const custodian = { accountId: 'account-1', displayName: 'Voice Account' };
    const access = { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' };
    return json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: decodeURIComponent(machineAccess[1]),
      custodian, access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] }));
  }
  if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path)) return json({ messages: [], hasMore: false });
  if (path === '/v2/sessions/metadata-upgrades') return json({ sessionIds: [] });
  const unarchive = /^\/v2\/sessions\/([^/]+)\/unarchive$/.exec(path);
  if (unarchive && init?.method === 'POST') return await unarchiveResponse(decodeURIComponent(unarchive[1]));
  if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v1/sessions') {
    if (path !== '/v2/sessions/active') {
      await listResponse();
      if (sessionListWireOverride) return json(V2SessionListResponseSchema.parse(sessionListWireOverride));
    }
    for (const id of Object.keys(state.sessions)) commitFixtureSession(id);
    for (const id of Object.keys(state.sessionListRowsByServerId?.[homeId] ?? {})) commitFixtureSession(id);
    const sessions = [...sessionRecords.values()].map(record => {
      const row = state.sessionListRowsByServerId?.[homeId]?.[record.id];
      return record.metadataLayoutVersion === 0 && row
        ? sessionWireRecord(createSessionFixture({ ...row, id: record.id, serverId: homeId }))
        : record;
    });
    return json(V2SessionListResponseSchema.parse({ sessions, hasNext: false, nextCursor: null }));
  }
  const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    if (init?.method !== 'PATCH') await sessionDetailResponse(id, { serverId: homeId });
    let current = commitFixtureSession(id);
    if (current?.metadataLayoutVersion === 0 && current.metadata === JSON.stringify(null) && state.sessions[id]?.metadata) {
      current = sessionWireRecord(createSessionFixture({ ...state.sessions[id], id, serverId: homeId }));
      sessionRecords.set(id, current);
    }
    if (!current) return new Response('{}', { status: 404 });
    if (init?.method === 'PATCH') {
      const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
      if (patch.mode !== 'owner_migration' && patch.mode !== 'owner') throw new Error('Expected owner tuple mutation');
      await metadataPatchResponse(id);
      const target = patch.mode === 'owner_migration' ? patch.target : patch;
      const committed = SessionCurrentProjectionRecordV1Schema.parse({
        ...current, metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
        metadataVersion: current.metadataVersion + 1, ownerMetadata: target.ownerMetadata,
        agentState: target.agentState.ciphertext, agentStateVersion: (current.agentStateVersion ?? 0) + 1,
      });
      sessionRecords.set(id, committed);
      return json({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: committed.metadataVersion }, agentState: { version: committed.agentStateVersion } });
    }
    return json({ session: current });
  }
  const machineDetail = /^\/v1\/machines\/([^/]+)$/.exec(path);
  if (path === '/v1/machines' || path === '/v1/machines/read-batch' || machineDetail) {
    const defaults = createMachineFixture().metadata!;
    const machines = Object.values(state.machines).map(machine => ({
    ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-1' }),
    ...machine, seq: machine.seq ?? 1, createdAt: 1, updatedAt: 1, activeAt: machine.activeAt ?? Date.now(),
    metadataVersion: machine.metadataVersion ?? 1, daemonStateVersion: 0,
    // Bootstrap can read before loadConversationSession normalizes the client
    // fixture. Publish the same complete Machine content at both times.
    metadata: machine.metadata ? encodePlainMachineStoredContent({
      host: defaults.host, platform: defaults.platform, happyCliVersion: defaults.happyCliVersion,
      homeDir: '', happyHomeDir: '', ...machine.metadata,
    }) : null,
    daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    }));
    if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
      id => machines.find(machine => machine.id === id) ?? null);
    return json(machineDetail ? { machine: machines.find(machine => machine.id === decodeURIComponent(machineDetail[1])) } : machines);
  }
  return new Response('{}', { status: 404 });
}
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  // Scoped pool sockets may survive restoreAllMocks; the cold transport owns these for its lifetime.
  socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event === 'rpc-call') {
      // The real Socket RPC owner encodes the target into the method prefix.
      const request = payload as { method: string; params: unknown };
      const separator = request.method.indexOf(':');
      const targetId = request.method.slice(0, separator);
      const method = request.method.slice(separator + 1);
      const result = method === 'session.agentRealtime.inspect'
        ? await sessionRpcResponse({ sessionId: targetId, serverId: homeId,
          method, payload: request.params })
        : await dispatchMachineRpc({ machineId: targetId, serverId: homeId, method, payload: request.params });
      return { ok: true, result };
    }
    if (event !== 'update-metadata') throw new Error(`Unexpected socket event: ${event}`);
    return { result: 'success', version: payload.expectedVersion + 1, metadata: payload.metadata };
  });
});
// Synthetic daemon responses sit below the real scoped transport, Action and catalogs.
async function dispatchMachineRpc(request: { method: string; payload: unknown; machineId: string; serverId?: string }) {
    if (request.method === 'actionOperation.get.v2') return await operationResponse(request.payload);
    if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
      // Directory existence is an OS boundary; all Session admission remains real.
      const input = SessionCreationTargetPreparationRequestV1Schema.parse(request.payload);
      if (input.directory.kind !== 'path') throw new Error('Expected a direct Voice carrier directory');
      return SessionCreationTargetPreparationResultV1Schema.parse({
        ok: true, directory: input.directory.path, directoryKind: 'path',
        directoryCreationRequired: false, checkout: null,
      });
    }
    if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
      const input = SessionResumeRequestV1Schema.parse(request.payload);
      return resumeResponse({ ...request, payload: input });
    }
    if (request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET) {
      const payload = request.payload as { sessionId: string };
      return createSessionRunnerRuntimeStatusFixture({ sessionId: payload.sessionId, machineId: request.machineId, wrapperPid: 122, observedAtMs: runnerObservedAtMs });
    }
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      const response = await projectionResponse(request.machineId, { serverId: request.serverId });
      return response.supported ? { protocolVersion: 1, projection: response.projection } : { error: 'RPC_METHOD_NOT_FOUND', errorCode: 'RPC_METHOD_NOT_FOUND' };
    }
    if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) throw new Error(`Unexpected machine RPC: ${request.method}`);
    const input = SessionSpawnNewInputV2Schema.parse(request.payload);
    spawnRequests(input);
    // A fixture view of transport fields keeps directory/currentness scenarios concise.
    // Agent identity comes from the real bundled catalog, never an alternate selection decision.
    const identity = input.agentTarget.identity;
    const backendId = resolveBundledAgentIdFromContributionIdentity(identity) ?? buildQualifiedPluginContributionKey(identity);
    const options = {
      ...input, machineId: input.executionTarget.machineId, serverId: input.executionTarget.serverId,
      directory: input.directory.kind === 'path' ? input.directory.path : '',
      backendTarget: { kind: 'backend' as const, backendId }, userAttemptId: input.creationKey,
    };
    const spawned = input.agentSessionStartupInstructionsV1
      ? await trustedSpawnResponse(options, input.agentSessionStartupInstructionsV1)
      : await spawnResponse(options);
    if (spawned.type !== 'success') return spawned;
    const created = state.sessions[spawned.sessionId];
    if (created?.metadata) {
      created.metadata.sessionCreationCorrespondenceV1 = sessionCreationCorrespondence(input);
      const owner = createSessionOwnerMetadataV1({ metadata: created.metadata });
      if (!owner.ok) throw new Error(`Synthetic daemon published invalid owner metadata: ${owner.unsupportedFields.join(',')}`);
    }
    return { ...spawned, disposition: spawned.disposition ?? 'created', executionTarget: input.executionTarget,
      organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
}
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
await loadSyncSingletonForTests();
afterAll(() => restoreActionExecutorModuleLoader());
afterEach(async () => {
  runnerObservedAtMs = 2000;
  operationResponse.mockReset();
  await connection?.dispose();
  vi.restoreAllMocks();
});
async function restoreAccount(account: Pick<Parameters<typeof restoreServerAccountForTest>[0], 'serverIdentityId' | 'credentials'> = {}) {
  unarchiveResponse.mockReset();
  unarchiveResponse.mockImplementation(async () => Response.json({ success: true, archivedAt: null }));
  purposeBindings = { v: 1, bindings: [] };
  purposeCatalogUnavailable = false;
  purposeCatalogReads = 0;
  sessionRecords.clear();
  sessionListWireOverride = null;
  sessionOrganizationFailure = null;
  connection = await restoreServerAccountForTest({
    ...account,
    serverUrl: 'https://voice-conversation.example.test', accountId: 'account-1',
    credentialScope: 'restored-home', activation: 'switch', request: createSessionReadBatchFetchBoundary(respondToServerRequest),
  });
  homeId = connection.home.id;
  state.settingsScope = { serverId: homeId, accountId: 'account-1' };
  // Finish the real bootstrap census before a case replaces its external
  // Machine rows. A refresh may otherwise join the older bootstrap census.
  const { sync } = await import('@/sync/sync');
  await sync.refreshMachines();
}
async function loadConversationSession() {
  const normalize = (id: string, session: Parameters<typeof createSessionFixture>[0]) =>
    createSessionFixture({ ...session, id, serverId: homeId,
      metadata: session?.metadata ? { ...voiceFixtureMetadataDefaults, ...session.metadata } : null });
  for (const [id, session] of Object.entries(state.sessions)) state.sessions[id] = normalize(id, session);
  for (const rows of Object.values(state.sessionListRowsByServerId ?? {})) {
    for (const [id, session] of Object.entries(rows)) rows[id] = normalize(id, session);
  }
  for (const machine of Object.values(state.machines)) {
    const defaults = createMachineFixture().metadata!;
    machine.metadata = machine.metadata ? { host: defaults.host, platform: defaults.platform,
      happyCliVersion: defaults.happyCliVersion, homeDir: '', happyHomeDir: '', ...machine.metadata } : null;
    // Tests replace external Machine content after Account bootstrap. Publish
    // its new revision so real selective hydration can observe that replacement.
    machine.metadataVersion = (machine.metadataVersion ?? 1) + 1;
    machine.activeAt = machine.active ? Date.now() : 0;
  }
  const { sync } = await import('@/sync/sync');
  await sync.refreshMachines();
  storage.setState({ ...structuredClone(state), authoringMemory: {
    ...storage.getState().authoringMemory, ...state.authoringMemory,
  }, settings: settingsParse(state.settings), profileScope: { serverId: homeId, accountId: 'account-1' } });
  return import('./voiceConversationSession');
}
const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
function enableCodexStartupInstructionsV1(): void {
  clearDaemonMergedProjectionCacheForTests();
  projectionResponse.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

/**
 * A novel external qualified Agent projected by the target machine, used by the
 * exact-target Voice selection corridors.
 */
function enableExternalVoiceAgentProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  projectionResponse.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      agentsById: {
        'acme-voice-agent': {
          id: 'acme-voice-agent',
          identity: {
            pluginId: 'acme.voice',
            localId: 'agent',
          },
          title: 'Acme Voice Agent',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

function enableCollidingQualifiedAgentProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  projectionResponse.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          identity: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
          },
          isBuiltIn: true,
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
        'acme.agent.codex/codex': {
          id: 'acme.agent.codex/codex',
          identity: {
            pluginId: 'acme.agent.codex',
            localId: 'codex',
          },
          channel: 'plugin',
          isBuiltIn: false,
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

function enableBundledCodexAgentOnlyProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  projectionResponse.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          identity: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
          },
          isBuiltIn: true,
        },
      },
      familiesById: {},
    }),
  });
}

describe('ensureVoiceConversationSessionForVoiceHome', () => {
  beforeEach(async () => {
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {}, primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
    clearDaemonMergedProjectionCacheForTests();
    spawnResponse.mockReset();
    trustedSpawnResponse.mockReset();
    spawnRequests.mockReset();
    listResponse.mockReset();
    metadataPatchResponse.mockReset();
    sessionDetailResponse.mockReset();
    sessionRpcResponse.mockReset();
    resumeResponse.mockReset();
    resumeResponse.mockImplementation(async ({ payload }) => ({ type: 'success', sessionId: payload.sessionId }));
    projectionResponse.mockReset();
    projectionResponse.mockResolvedValue({ supported: false, reason: 'not-supported' });

    state = {
      settingsScope: { serverId: homeId, accountId: 'account-1' },
      authoringMemory: {
        recentMachinePaths: [{ machineId: 'machine-1', path: '/Users/test/.happier/voice-agent' }],
      },
      settings: {
        lastUsedAgent: 'codex',
        voice: {
          executionMachine: { mode: 'auto', machineId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              agent: {
                agentSource: 'session',
                voiceHomeSubdirName: 'voice-agent',
                rootSessionPolicy: 'keep_warm',
                maxWarmRoots: 1,
              },
            } },
          },
        },
      },
      machines: {
        'machine-1': {
          id: 'machine-1',
          active: true,
          metadata: {
            happyHomeDir: '/Users/test/.happier',
          },
        },
      },
      sessions: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    };

    spawnResponse.mockImplementation(async (params: any) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    trustedSpawnResponse.mockImplementation(async (params) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    metadataPatchResponse.mockResolvedValue(undefined);
    await restoreAccount();
    listResponse.mockClear();
    sessionDetailResponse.mockClear();
  });

  it('R41 gives changed fixed-Agent authentication distinct carriers while keeping unchanged retries stable', async () => {
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = 'codex';
    const createdByKey = new Map<string, string>();
    spawnResponse.mockImplementation(async input => {
      const key = input.userAttemptId!;
      const id = createdByKey.get(key) ?? `fixed-carrier-${createdByKey.size + 1}`;
      createdByKey.set(key, id);
      state.sessions[id] = { id, active: true, updatedAt: createdByKey.size,
        metadata: { machineId: input.machineId, path: input.directory, flavor: 'codex',
          connectedServices: input.connectedServices }, permissionMode: input.permissionMode };
      return { type: 'success', sessionId: id };
    });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const first = await ensureVoiceConversationSessionForVoiceHome();
    const firstRequest = spawnRequests.mock.calls.at(-1)![0];
    expect(firstRequest.connectedServices).toEqual({ v: 2, bindingsByServiceId: {} });
    // One demanded admission reads the one purpose row; no per-service catalog census.
    expect(purposeCatalogReads).toBe(1);
    purposeBindings = { v: 1, bindings: [{ purpose: {
      consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary',
    }, target: { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'codex-pool' } }] };
    // A new fixed choice must not silently adopt the still-live old carrier.
    const second = await ensureVoiceConversationSessionForVoiceHome();
    const secondRequest = spawnRequests.mock.calls.at(-1)![0];
    expect(second).not.toBe(first);
    expect(secondRequest.creationKey).not.toBe(firstRequest.creationKey);
    expect(secondRequest.connectedServices?.bindingsByServiceId['happier.agent.codex/openai-codex'])
      .toMatchObject({ source: 'connected', selection: 'group', groupId: 'codex-pool' });
    state.sessions[second].active = false;
    storage.setState({ sessions: { ...storage.getState().sessions,
      [second]: { ...storage.getState().sessions[second]!, active: false } } });
    expect(await ensureVoiceConversationSessionForVoiceHome()).toBe(second);
    expect(spawnRequests.mock.calls.at(-1)![0].creationKey).toBe(secondRequest.creationKey);
    expect(sessionRecords.has(first)).toBe(true);
    expect(sessionRecords.has(second)).toBe(true);
  });

  it('R41 refuses an unavailable fixed-Agent purpose catalog before carrier creation', async () => {
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = 'codex';
    purposeCatalogUnavailable = true;
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'connected_account_purpose_catalog_unavailable',
    });
    expect(spawnRequests).not.toHaveBeenCalled();
  });

  it('R43 creates a new carrier after deletion instead of replaying the old creation Action', async () => {
    let created = 0;
    spawnResponse.mockImplementation(async input => {
      const id = `r43-deleted-carrier-${++created}`;
      state.sessions[id] = { id, active: true, updatedAt: created, metadata: {
        machineId: input.machineId, path: input.directory, flavor: 'codex',
      } };
      return { type: 'success', sessionId: id };
    });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const first = await ensureVoiceConversationSessionForVoiceHome();
    const firstKey = spawnRequests.mock.calls.at(-1)![0].creationKey;
    storage.getState().deleteSession(first, homeId);
    delete state.sessions[first];
    sessionRecords.delete(first);

    const second = await ensureVoiceConversationSessionForVoiceHome();
    expect(second).not.toBe(first);
    expect(spawnRequests.mock.calls.at(-1)![0].creationKey).toBe(firstKey);
    expect(storage.getState().sessions[first]).toBeUndefined();
    expect(storage.getState().sessions[second]).toBeDefined();
  });

  it.each(['account-1', 'other-account'])('keeps Voice preparation bound to %s while the canonical creation operation settles without a socket update', async accountId => {
    const spawn = spawnResponse.getMockImplementation()!;
    spawnResponse.mockImplementationOnce(async input => {
      await spawn(input);
      return { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
        operation: { serverId: homeId, machineId: 'machine-1', operationId: 'voice-pending' } };
    });
    const reading = createDeferred<void>();
    const terminal = createDeferred<void>();
    operationResponse.mockImplementation(async payload => {
      expect(payload).toEqual({ operationId: 'voice-pending', waitForTerminal: true });
      reading.resolve();
      await terminal.promise;
      return { kind: 'found', operation: { version: 1, operationId: 'voice-pending', revision: 3,
        actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId, machineId: 'machine-1' },
        title: 'Create session', requestId: 'transport-request', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
        result: { type: 'success', disposition: 'created', sessionId: 'voice-home-session',
          executionTarget: { serverId: homeId, machineId: 'machine-1' },
          organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } } };
    });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const preparing = ensureVoiceConversationSessionForVoiceHome();
    try {
      await Promise.race([reading.promise, preparing.then(() => { throw new Error('Voice preparation skipped operation settlement'); })]);
      terminal.resolve();
      if (accountId === 'account-1') await expect(preparing).resolves.toBe('voice-home-session');
      else await expect(preparing).rejects.toMatchObject({ code: 'action_operation_result_unavailable' });
      expect(spawnRequests).toHaveBeenCalledTimes(1);
    } finally {
      terminal.resolve();
      await preparing.catch(() => undefined);
    }
  });

  it('uses the bundled backend when the daemon projects its exact Agent identity without backend entries', async () => {
    enableBundledCodexAgentOnlyProjection();
    const { resolveQualifiedAgentBackendTargetForMachine } = await loadConversationSession();

    await expect(resolveQualifiedAgentBackendTargetForMachine({
      machineId: 'machine-1',
      agent: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
    })).resolves.toEqual({
      kind: 'backend',
      backendId: 'codex',
    });
  });

  it('uses the qualified routing id when an external Agent has no legacy backend alias', async () => {
    projectionResponse.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme-voice-agent': {
            id: 'acme-voice-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
          },
        },
        familiesById: {},
      }),
    });
    const { resolveQualifiedAgentBackendTargetForMachine } = await loadConversationSession();

    await expect(resolveQualifiedAgentBackendTargetForMachine({
      machineId: 'machine-1',
      agent: { pluginId: 'acme.voice', localId: 'agent' },
    })).resolves.toEqual({
      kind: 'backend',
      backendId: 'acme.voice/agent',
    });
  });

  it('admits a direct session only through the exact qualified Agent routing identity when local ids collide', async () => {
    enableCollidingQualifiedAgentProjection();
    state.sessions['installed-codex-direct'] = {
      id: 'installed-codex-direct',
      serverId: homeId,
      active: true,
      updatedAt: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/workspace',
        runtimeDescriptorV1: { v: 1, agentId: 'acme.agent.codex/codex', agent: {} },
        sessionCreationCorrespondenceV1: sessionCreationCorrespondence({
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent.codex', localId: 'codex' } },
          executionTarget: { serverId: homeId, machineId: 'machine-1' },
          directory: { kind: 'path', path: '/Users/test/workspace' },
        }),
      },
    };
    sessionRpcResponse.mockResolvedValue({
      ok: true,
      status: 'available',
      transport: 'webrtc',
    });

    await loadConversationSession();
    const hostLease = createBundledConversationRuntimeHostLease();

    try {
      const resolveBinding = hostLease.host.resolveAgentRealtimeVoiceConversationBinding;
      if (!resolveBinding) throw new Error('Agent realtime binding resolver is unavailable');
      await expect(resolveBinding({
        provider: {
          pluginId: 'acme.voice.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'acme.agent.codex',
          localId: 'codex',
        },
        controlSessionId: 'installed-codex-direct',
        requestedTargetSessionAddress: { serverId: homeId, sessionId: 'installed-codex-direct' },
        settings: state.settings,
      })).resolves.toEqual({
        conversationSessionAddress: { serverId: homeId, sessionId: 'installed-codex-direct' },
        transcriptMode: 'native_session',
        targetSessionAddress: { serverId: homeId, sessionId: 'installed-codex-direct' },
      });
      expect(sessionRpcResponse).toHaveBeenCalledWith({
        sessionId: 'installed-codex-direct',
        serverId: homeId,
        method: 'session.agentRealtime.inspect',
        payload: {
          v: 1,
          provider: {
            pluginId: 'acme.voice.codex',
            localId: 'realtime-codex',
          },
        },
      });
    } finally {
      hostLease.revoke();
    }
  });

  it('spawns a global hidden session with the exact qualified Agent backend when local ids collide', async () => {
    enableCollidingQualifiedAgentProjection();
    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'acme-codex-work',
        },
      },
    };
    trustedSpawnResponse.mockImplementation(async (params) => {
      state.sessions['installed-codex-global'] = {
        id: 'installed-codex-global',
        serverId: homeId,
        active: true,
        updatedAt: 1,
        permissionMode: params.permissionMode,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
          runtimeDescriptorV1: { v: 1, agentId: 'acme.agent.codex/codex', agent: {} },
          connectedServices: params.connectedServices,
        },
      };
      return { type: 'success', sessionId: 'installed-codex-global' };
    });
    sessionRpcResponse.mockResolvedValue({
      ok: true,
      status: 'available',
      transport: 'webrtc',
    });

    await loadConversationSession();
    const hostLease = createBundledConversationRuntimeHostLease();

    try {
      const resolveBinding = hostLease.host.resolveAgentRealtimeVoiceConversationBinding;
      if (!resolveBinding) throw new Error('Agent realtime binding resolver is unavailable');
      const bindingInput = {
        provider: {
          pluginId: 'acme.voice.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'acme.agent.codex',
          localId: 'codex',
        },
        controlSessionId: hostLease.host.globalVoiceSessionId,
        requestedTargetSessionAddress: null,
        settings: state.settings,
        connectedServices,
      };
      await expect(resolveBinding(bindingInput)).resolves.toEqual({
        conversationSessionAddress: {
          serverId: homeId,
          sessionId: 'installed-codex-global',
        },
        transcriptMode: 'native_session',
        targetSessionAddress: null,
      });
      expect(trustedSpawnResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          backendTarget: {
            kind: 'backend',
            backendId: 'acme.agent.codex/codex',
          },
          connectedServices,
        }),
        expect.anything(),
      );
      expect(sessionRpcResponse).toHaveBeenLastCalledWith({
        sessionId: 'installed-codex-global', serverId: homeId,
        method: 'session.agentRealtime.inspect',
        payload: { v: 1, provider: bindingInput.provider },
      });
      sessionRpcResponse.mockResolvedValueOnce(AgentSessionRealtimeInspectResultV1Schema.parse({
        ok: false, status: 'unavailable', code: 'runtime_stale', message: 'Runtime stale', reason: 'update_required',
      }));
      await expect(resolveBinding(bindingInput)).rejects.toMatchObject({ code: 'update_required' });
    } finally {
      hostLease.revoke();
    }
  });

  it('spawns on the preferred machine when auto mode has no active voice target session', async () => {
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      permissionMode: 'read-only',
      serverId: homeId,
    }));
  });

  it('refuses an Account replacement during spawn without publishing sticky auto-target memory', async () => {
    const spawned = createDeferred<{ type: 'success'; sessionId: string }>();
    const spawnEntered = createDeferred<void>();
    spawnResponse.mockImplementation(async () => {
      spawnEntered.resolve();
      return await spawned.promise;
    });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    const pending = ensureVoiceConversationSessionForVoiceHome();
    await spawnEntered.promise;
    expect(spawnResponse).toHaveBeenCalledOnce();
    storage.setState({ settingsScope: { serverId: 'server-2', accountId: 'account-2' } });
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 1,
      metadata: { machineId: 'machine-1', path: '/Users/test/.happier/voice-agent' },
    };
    spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });

    await expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    expect(useVoiceTargetStore.getState().autoTargetMachineByScope).toEqual({});
    expect(storage.getState().settings.voice.executionMachine).toMatchObject({ mode: 'auto', machineId: null });
  });

  it('spawns the configured external Agent through its exact projected backend target', async () => {
    enableExternalVoiceAgentProjection();
    state.settings.voice.providers.local_conversation.config.agent = {
      agentSource: 'agent',
      agentId: 'acme-voice-agent',
      agentTargetKey: 'agent:acme.voice/agent',
      agentIdentity: { pluginId: 'acme.voice', localId: 'agent' },
    };
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      backendTarget: { kind: 'backend', backendId: 'acme.voice/agent' },
    }));
  });

  it('fails the voice-home spawn closed when the configured external Agent is no longer projected', async () => {
    // No machine projection carries the configured Agent: its exact selection
    // is stale/unsupported on this machine, so no spawn may silently fall back
    // to a different Agent.
    state.settings.voice.providers.local_conversation.config.agent = {
      agentSource: 'agent',
      agentId: 'acme-voice-agent',
      agentTargetKey: 'agent:acme.voice/agent',
      agentIdentity: { pluginId: 'acme.voice', localId: 'agent' },
    };
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('coalesces concurrent voice-home ensures while the spawn is pending', async () => {
    const spawned = createDeferred<{ type: 'success'; sessionId: string }>();
    const spawnEntered = createDeferred<void>();
    spawnResponse.mockImplementation((params: any) => {
      spawnEntered.resolve();
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return spawned.promise;
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const first = ensureVoiceConversationSessionForVoiceHome();
    const second = ensureVoiceConversationSessionForVoiceHome();

    await spawnEntered.promise;
    expect(spawnResponse).toHaveBeenCalledTimes(1);

    spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'voice-home-session',
      'voice-home-session',
    ]);
  });

  it('releases one cancelled Voice Home reader while another reader completes the shared spawn', async () => {
    const spawned = createDeferred<{ type: 'success'; sessionId: string }>();
    const spawnEntered = createDeferred<void>();
    spawnResponse.mockImplementation((params: WireSpawnFixtureInput) => {
      spawnEntered.resolve();
      state.sessions['voice-home-session'] = { id: 'voice-home-session', active: true, updatedAt: 1,
        metadata: { machineId: params.machineId, path: params.directory } };
      return spawned.promise;
    });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const caller = new AbortController();
    let outcome = 'pending';
    const first = ensureVoiceConversationSessionForVoiceHome(null, caller.signal)
      .then(() => { outcome = 'resolved'; }, () => { outcome = 'cancelled'; });
    const second = ensureVoiceConversationSessionForVoiceHome();
    await spawnEntered.promise;
    expect(spawnResponse).toHaveBeenCalledTimes(1);
    caller.abort();
    try {
      await first;
      expect(outcome).toBe('cancelled');
      spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });
      await expect(second).resolves.toBe('voice-home-session');
      await first;
      expect(spawnResponse).toHaveBeenCalledTimes(1);
    } finally {
      spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });
      await Promise.allSettled([first, second]);
    }
  });

  it('releases a failed voice-home ensure so a later call can retry', async () => {
    const failedSpawn = createDeferred<{
      type: 'error';
      code: 'spawn_failed';
      retryable: true;
    }>();
    const spawnEntered = createDeferred<void>();
    spawnResponse.mockImplementationOnce(() => {
      spawnEntered.resolve();
      return failedSpawn.promise;
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const first = ensureVoiceConversationSessionForVoiceHome();
    const second = ensureVoiceConversationSessionForVoiceHome();

    await spawnEntered.promise;
    expect(spawnResponse).toHaveBeenCalledTimes(1);

    failedSpawn.resolve({
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
    });

    await expect(Promise.all([first, second])).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(spawnResponse).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('keeps the connected account diagnostic through carrier creation (retryable=%s)', async retryable => {
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    await connection.dispose();
    await restoreAccount({ serverIdentityId: 'srv_voice_connected_account',
      credentials: { token: createAccountTokenForTests('account-1', { currentAccount: true }) } });
    const { ConnectedServiceUxDiagnosticV1Schema } = await import('@happier-dev/protocol/connect/connectedServiceUxDiagnostics');
    const uxDiagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
      code: retryable ? 'connected_service_credential_refresh_unavailable' : 'connected_service_credential_reconnect_required',
      failurePhase: 'materialization', source: 'spawn_resume', serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'voice-profile', retryable,
      suggestedActions: retryable ? ['retry', 'open_connected_accounts'] : ['reconnect_profile', 'open_connected_accounts'],
    });
    spawnResponse.mockResolvedValueOnce({ type: 'error', code: 'spawn_failed', retryable,
      launchError: { kind: 'launch_error', code: uxDiagnostic.code, message: 'PRIVATE_PROVIDER_BODY', uxDiagnostic } });
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const rejection = await ensureVoiceConversationSessionForVoiceHome().then(() => null, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: uxDiagnostic.code, message: uxDiagnostic.code, uxDiagnostic });
    expect(JSON.stringify(rejection)).not.toContain('PRIVATE_PROVIDER_BODY');
  });

  it('does not expose private raw spawn diagnostics across the canonical Action boundary', async () => {
    const errorDetail = {
      kind: 'connected_service_ux_diagnostic' as const,
      uxDiagnostic: {
        code: 'connected_service_credential_refresh_unavailable' as const,
        failurePhase: 'materialization' as const,
        source: 'spawn_resume' as const,
        serviceId: 'openai-codex',
        agentId: 'codex',
        profileId: 'voice-profile',
        retryable: true,
        suggestedActions: ['retry', 'open_connected_accounts'] as const,
        diagnostics: {
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'network_error',
        },
      },
    };
    spawnResponse.mockRejectedValueOnce(Object.assign(new Error('private connected-service credential refresh transport detail'), { errorDetail }));

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    const rejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ code: 'action_failed', message: 'action_failed' });
    expect(rejection).not.toHaveProperty('errorDetail');
    expect(JSON.stringify(rejection)).not.toContain('private connected-service credential refresh transport detail');
  });

  it('uses the canonical absolute directory identity for voice-home reuse', async () => {
    state.machines['machine-1'].metadata = {
      homeDir: '/Users/test',
    };
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-1',
      path: '~/repo',
    }];
    state.sessions['absolute-voice-home-session'] = {
      id: 'absolute-voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/repo',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('absolute-voice-home-session');
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('uses the canonical absolute directory identity in the voice-home digest while preserving the raw spawn directory', async () => {
    state.machines['machine-1'].metadata = {
      homeDir: '/Users/test',
    };
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-1',
      path: '~/repo',
    }];

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      directory: '~/repo',
      userAttemptId: buildVoiceSpawnUserAttemptId({
        surface: 'voice_home',
        serverId: homeId,
        machineId: 'machine-1',
        directory: '/Users/test/repo',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: { v: 2, bindingsByServiceId: {} },
        permissionMode: 'read-only',
        requirements: null,
      }),
    }));
  });

  it('preserves the typed metadata failure with only a sanitized compensation identity when retirement also fails', async () => {
    const metadataFailure = new Error('private provider startup payload');
    const retirementFailure = new Error('private provider retirement payload');
    let failedPatchCount = 0;
    metadataPatchResponse.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'voice-home-session' && failedPatchCount < 2) {
        const failure = failedPatchCount === 0 ? metadataFailure : retirementFailure;
        failedPatchCount += 1;
        throw failure;
      }
    });

    const {
      ensureVoiceConversationSessionForVoiceHome,
      VoiceConversationSessionMetadataCommitError,
    } = await loadConversationSession();

    const failedEnsure = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failedEnsure).toBeInstanceOf(VoiceConversationSessionMetadataCommitError);
    expect(failedEnsure).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      compensationFailureCode: 'VOICE_CONVERSATION_RETIREMENT_FAILED',
    });
    // The real HTTP adapter converts the synthetic transport rejection to a Sync error.
    expect(failedEnsure).toHaveProperty('cause', expect.any(Error));
    expect(Object.getOwnPropertyDescriptor(failedEnsure, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(failedEnsure)).not.toContain(metadataFailure.message);
    expect(JSON.stringify(failedEnsure)).not.toContain(retirementFailure.message);
  });

  it('distinguishes a session refresh failure from a metadata write rejection behind the typed commit error', async () => {
    const refreshFailure = new Error('private session refresh transport detail');
    sessionOrganizationFailure = refreshFailure;

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    const refreshRejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    sessionOrganizationFailure = null;
    const metadataFailure = new Error('private metadata write response');
    rejectNextMetadataCommitForSession('voice-home-session', metadataFailure);
    const writeRejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    expect(refreshRejection).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      reason: 'session_refresh_failed',
    });
    expect(refreshRejection).toHaveProperty('cause', expect.any(Error));
    expect(writeRejection).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      reason: 'metadata_write_rejected',
    });
    expect(writeRejection).toHaveProperty('cause', expect.any(Error));
    expect((refreshRejection as { reason?: unknown }).reason)
      .not.toBe((writeRejection as { reason?: unknown }).reason);
    const serializedRejections = `${JSON.stringify(refreshRejection)}${JSON.stringify(writeRejection)}`;
    expect(serializedRejections).not.toContain(refreshFailure.message);
    expect(serializedRejections).not.toContain(metadataFailure.message);
  });

  it('finalizes a fresh global carrier by exact address when it is absent from the ordinary Session list', async () => {
    spawnResponse.mockImplementation(async (params: WireSpawnFixtureInput) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session', active: true, updatedAt: 1, metadataLayoutVersion: 1,
        metadata: { machineId: params.machineId, path: params.directory },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    sessionListWireOverride = { sessions: [], hasNext: false, nextCursor: null };
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    const result = await ensureVoiceConversationSessionForVoiceHome().catch((error: unknown) => error);
    expect(spawnResponse).toHaveBeenCalled();
    expect(result).toBe('voice-home-session');

    const carrier = storage.getState().sessions['voice-home-session'];
    expect(carrier?.serverId).toBe(homeId);
    expect(readSessionOwnerMetadataView(carrier!)).toMatchObject({
      machineId: 'machine-1',
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
    });
    expect(sessionDetailResponse).toHaveBeenCalledWith('voice-home-session', { serverId: homeId });
  });

  it('reports a stalled session-metadata wait as its own typed commit reason', async () => {
    spawnResponse.mockImplementation(async () => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: null,
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    // Keep real scoped transport timers live while exercising the persistence owner's wait boundary.
    const pending = ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );
    await expect(pending).resolves.toMatchObject({
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        sessionId: 'voice-home-session',
        reason: 'session_metadata_wait_timed_out',
    });
  });

  it('lets a raw online machine record reach the authoritative spawn operation without UI-only readiness projection', async () => {
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: homeId,
    }));
  });

  it('preserves the typed launch refusal without exposing its diagnostic message', async () => {
    spawnResponse.mockResolvedValue({
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
      launchError: {
        kind: 'launch_error',
        code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        message: 'private credential transport detail',
      },
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      message: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    });
  });

  it('surfaces the authoritative spawn operation failure for a raw online machine record', async () => {
    spawnResponse.mockResolvedValue({
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'spawn_failed',
      message: 'spawn_failed',
    });
    expect(spawnResponse).toHaveBeenCalledTimes(1);
  });

  it('routes recent voice-home spawn targets through active machine replacements', async () => {
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-old',
      path: '/Users/test/.happier/voice-agent',
    }];
    state.machines = {
      'machine-old': {
        id: 'machine-old',
        active: false,
        replacedByMachineId: 'machine-new',
        replacedAt: 123,
        metadata: {},
      },
      'machine-new': {
        id: 'machine-new',
        active: true,
        metadata: {},
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-new',
      directory: '/Users/test/.happier/voice-agent',
      serverId: homeId,
    }));
  });

  it('trims the configured agent id before choosing the spawned voice-home agent', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = ' codex ';

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
      },
    }));
  });

  it('spawns the voice home on an externally installed configured Agent', async () => {
    enableExternalVoiceAgentProjection();
    state.settings.lastUsedAgent = 'claude';
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = 'acme-voice-agent';

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.voice', localId: 'agent' },
        },
      }),
    );
    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.voice/agent',
      },
    }));
  });

  it('does not treat the legacy customAcp voice-home fallback as permission to select a plugin backend from merged projection truth', async () => {
    state.settings.lastUsedAgent = 'customAcp';
    projectionResponse.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme.review.provider': {
            id: 'acme.review.provider',
            title: 'Acme Review Provider',
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
            settingsBackendId: 'acme.review.backend',
          },
        },
      }),
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(projectionResponse).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      serverId: homeId,
    }));
    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
      },
    }));
  });

  it('keeps a stale configured Agent selection for repair without silently launching a bundled Agent', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    spawnResponse.mockResolvedValue({ type: 'error', code: 'incompatible_target', retryable: false });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({ code: 'incompatible_target' });
    expect(spawnRequests).toHaveBeenCalledWith(expect.objectContaining({
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
        definitionId: 'stale-review-bot' },
    }));
    expect(storage.getState().settings.lastUsedBackendTarget).toMatchObject({
      kind: 'agent', definitionId: 'stale-review-bot',
    });
  });

  it('uses the fixed machine target when the target mode is padded', async () => {
    state.machines['machine-2'] = {
      id: 'machine-2',
      active: true,
      metadata: {
        happyHomeDir: '/Users/fixed/.happier/',
      },
    };
    state.settings.voice.executionMachine = {
      mode: ' fixed ',
      machineId: ' machine-2 ',
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-2',
      directory: '/Users/fixed/.happier/voice-agent',
      serverId: homeId,
    }));
  });

  it('reuses visible lookup metadata while waiting for a freshly spawned voice home session to hydrate', async () => {
    spawnResponse.mockImplementation(async () => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: null,
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    const publishVisibleSession = async () => {
      state.sessionListRowsByServerId = {
        ...(state.sessionListRowsByServerId ?? {}),
        [homeId]: {
          ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
          'voice-home-session': {
            id: 'voice-home-session',
            active: true,
            updatedAt: 1,
            presence: 'online',
            metadata: {
              machineId: 'machine-1',
              path: '/Users/test/.happier/voice-agent',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'voice_home',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
        },
      };
      state.ordinarySessionListMembershipByServerId = {
        ...(state.ordinarySessionListMembershipByServerId ?? {}),
        [homeId]: ['voice-home-session'],
      };
      state.sessionListIndexByServerId = {
        ...(state.sessionListIndexByServerId ?? {}),
        [homeId]: [
          { type: 'session', sessionId: 'voice-home-session', serverId: homeId, serverName: 'Server 1' },
        ],
      };
      // The server now has this hydrated row. Both census and exact batch
      // reads expose it, replacing the earlier metadata-null spawn record.
      sessionRecords.delete('voice-home-session');
    };
    listResponse.mockImplementation(publishVisibleSession);
    sessionDetailResponse.mockImplementation(publishVisibleSession);

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    const pending = ensureVoiceConversationSessionForVoiceHome();

    await expect(pending).resolves.toBe('voice-home-session');
    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: homeId,
    }));
  });

  it('fails closed instead of roaming when the sticky auto target has no voice-home directory', async () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(state.settingsScope!, 'stale-machine');
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: true,
      metadata: {},
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_TARGET_MISSING',
    });
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('fails closed instead of roaming when the sticky auto target is inactive', async () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(state.settingsScope!, 'stale-machine');
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: false,
      metadata: {
        happyHomeDir: '/Users/stale/.happier',
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    });
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('keeps host-global auto selection independent from the focused session after handoff', async () => {
    state.machines['machine-target'] = {
      id: 'machine-target',
      active: true,
      metadata: {
        happyHomeDir: '/Users/target/.happier',
        host: 'target.local',
      },
    };
    state.machines['machine-stale'] = {
      id: 'machine-stale',
      active: false,
      replacedByMachineId: 'machine-target',
      replacedAt: 123,
      metadata: {
        host: 'source.local',
      },
    };
    state.sessions['focus-session'] = {
      id: 'focus-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };

    useVoiceTargetStore.setState({ primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'focus-session' }, lastFocusedSessionAddress: null });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: homeId,
    }));
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
        voiceAgentRunV1: {
          v: 1, runId: 'run-retired', backendId: 'codex', resumeHandle: null,
          updatedAtMs: 1, transcriptContractVersion: 2,
        },
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
      ...(state.sessionListRowsByServerId ?? {}),
      [homeId]: {
        ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
        'voice-home-session': {
          id: 'voice-home-session',
          active: true,
          updatedAt: 10,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      [homeId]: ['voice-home-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      [homeId]: [
        { type: 'session', sessionId: 'voice-home-session', serverId: homeId, serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('reuses the newest exact-compatible voice-home session instead of a newer incompatible candidate', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['newer-incompatible'] = {
      id: 'newer-incompatible',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    state.sessions['older-compatible'] = {
      id: 'older-compatible',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const isReusableSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'older-compatible');

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.voice.openai/openai': {
            source: 'connected',
            selection: 'profile',
            profileId: 'realtime-work',
          },
        },
      },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('older-compatible');

    expect(isReusableSession).toHaveBeenCalledTimes(2);
    expect(isReusableSession.mock.calls.map(([candidate]) => candidate.sessionId)).toEqual([
      'newer-incompatible',
      'older-compatible',
    ]);
    expect(spawnResponse).not.toHaveBeenCalled();
    expect(trustedSpawnResponse).not.toHaveBeenCalled();
  });

  it('creates a fresh matching session when V1 create is supported but cold-resume effectiveness is unproven', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['unproven-cold-resume'] = {
      id: 'unproven-cold-resume',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(trustedSpawnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('R43 refuses a rejoined Agent-realtime carrier when cold-resume instruction delivery is unproven', async () => {
    enableCodexStartupInstructionsV1();
    const create = trustedSpawnResponse.getMockImplementation()!;
    trustedSpawnResponse.mockImplementation(async (...args) => ({ ...await create(...args), disposition: 'rejoined' }));
    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession: async () => true,
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED' });
    expect(resumeResponse).not.toHaveBeenCalled();
  });

  it('spawns an exact voice-home session instead of reusing a stale-account candidate', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['wrong-account'] = {
      id: 'wrong-account',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-old',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'safe-yolo',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.voice.openai/openai': {
            source: 'connected',
            selection: 'profile',
            profileId: 'realtime-work',
          },
        },
      },
      permissionIntent: 'safe-yolo',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(trustedSpawnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        permissionMode: 'safe-yolo',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('rejects hidden candidates with the wrong backend target or permission intent before facet inspection', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['wrong-backend'] = {
      id: 'wrong-backend',
      active: true,
      updatedAt: 30,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'claude',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    state.sessions['wrong-permission'] = {
      id: 'wrong-permission',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'yolo',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(trustedSpawnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('spawns instead of reusing a candidate whose declaration-gated realtime facet is unavailable', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['facet-unavailable'] = {
      id: 'facet-unavailable',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        flavor: 'codex',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const inspectRealtimeFacet = vi.fn(async (
      _sessionId: string,
    ): Promise<{ status: 'available' | 'unavailable' }> => ({ status: 'unavailable' }));
    const isReusableSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      (await inspectRealtimeFacet(sessionId)).status === 'available');

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(inspectRealtimeFacet).toHaveBeenCalledWith('facet-unavailable');
    expect(trustedSpawnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('migrates a matching released voice_carrier home session in place instead of spawning a replacement', async () => {
    state.sessions['legacy-voice-home-session'] = {
      id: 'legacy-voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
      },
    };

    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await loadConversationSession();
    const {
      listVoiceConversationSystemSessions,
    } = await import('./voiceConversationSystemSessionLookup');
    expect(listVoiceConversationSystemSessions(state)).toEqual([
      expect.objectContaining({
        sessionId: 'legacy-voice-home-session',
        legacySystemKey: true,
        reusable: true,
      }),
    ]);

    const pending = ensureVoiceConversationSessionForVoiceHome();

    await expect(pending).resolves.toBe('legacy-voice-home-session');
    expect(spawnResponse).not.toHaveBeenCalled();
    expect(readSessionOwnerMetadataView(storage.getState().sessions['legacy-voice-home-session']!)).toMatchObject({
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
    });
  });

  it('retires a legacy voice home session when visible lookup metadata matches the target but raw metadata is stale', async () => {
    useVoiceTargetStore.setState({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
    state.sessions['legacy-session'] = {
      id: 'legacy-session',
      active: false,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
      },
    };
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 11,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
      ...(state.sessionListRowsByServerId ?? {}),
      [homeId]: {
        ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
        'legacy-session': {
          id: 'legacy-session',
          active: false,
          updatedAt: 10,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-1',
              remoteSessionId: 'remote-legacy',
              source: {
                kind: 'codexHome',
                home: 'user',
              },
            },
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
        'voice-home-session': {
          id: 'voice-home-session',
          active: true,
          updatedAt: 11,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      [homeId]: ['legacy-session', 'voice-home-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      [homeId]: [
        { type: 'session', sessionId: 'legacy-session', serverId: homeId, serverName: 'Server 1' },
        { type: 'session', sessionId: 'voice-home-session', serverId: homeId, serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(metadataPatchResponse.mock.calls.some(([sessionId]) => sessionId === 'legacy-session')).toBe(true);
    expect(readSessionOwnerMetadataView(storage.getState().sessions['legacy-session']!)).not.toHaveProperty('voiceAgentRunV1');
    expect(readSessionOwnerMetadataView(storage.getState().sessions['legacy-session']!)).toMatchObject({
      machineId: 'machine-stale',
      path: '/Users/test/.happier/voice-agent-old',
      systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
    });
  });

  it('does not recover a timed-out voice home spawn by scanning unrelated late sessions', async () => {
    spawnResponse.mockResolvedValue({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    listResponse.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-session': {
            id: 'late-session',
            active: true,
            updatedAt: 2,
            metadata: null,
          },
        },
      };
    });
    sessionDetailResponse.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'late-session') return;
      const nextRowsByServerId = {
        ...(state.sessionListRowsByServerId ?? {}),
        [homeId]: {
          ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
          'late-session': {
            id: 'late-session',
            active: true,
            updatedAt: 2,
            presence: 'online',
            metadata: {
              machineId: 'machine-1',
              path: '/Users/test/.happier/voice-agent',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'voice_home',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
        },
      };
      const nextIndexByServerId = {
        ...(state.sessionListIndexByServerId ?? {}),
        [homeId]: [
          { type: 'session' as const, sessionId: 'late-session', serverId: homeId, serverName: 'Server 1' },
        ],
      };
      state = {
        ...state,
        sessionListRowsByServerId: nextRowsByServerId,
        ordinarySessionListMembershipByServerId: {
          ...(state.ordinarySessionListMembershipByServerId ?? {}),
          [homeId]: ['late-session'],
        },
        sessionListIndexByServerId: nextIndexByServerId,
      };
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_SPAWN_PENDING',
    });
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_SPAWN_PENDING',
    });
    expect(spawnResponse.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(spawnResponse.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(spawnRequests.mock.calls[0]?.[0].creationKey).toBe(spawnRequests.mock.calls[1]?.[0].creationKey);
    expect(spawnRequests).toHaveBeenCalledTimes(2);
    expect(sessionDetailResponse).not.toHaveBeenCalled();
  });
});

describe('ensureVoiceConversationSessionForSessionRoot', () => {
  beforeEach(async () => {
    clearDaemonMergedProjectionCacheForTests();
    spawnResponse.mockReset();
    trustedSpawnResponse.mockReset();
    spawnRequests.mockReset();
    listResponse.mockReset();
    metadataPatchResponse.mockReset();
    sessionDetailResponse.mockReset();
    resumeResponse.mockReset();
    resumeResponse.mockImplementation(async ({ payload }) => ({ type: 'success', sessionId: payload.sessionId }));
    projectionResponse.mockReset();
    projectionResponse.mockResolvedValue({ supported: false, reason: 'not-supported' });

    state = {
      settings: {
        lastUsedAgent: 'codex',
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
      },
      machines: {
        'machine-stale': {
          id: 'machine-stale',
          active: false,
          replacedByMachineId: 'machine-target',
          replacedAt: 123,
          metadata: {
            host: 'source.local',
          },
        },
        'machine-target': {
          id: 'machine-target',
          active: true,
          metadata: {
            happyHomeDir: '/Users/target/.happier',
            host: 'target.local',
          },
        },
      },
      sessions: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    };

    spawnResponse.mockImplementation(async (params: any) => {
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-root-session' };
    });

    metadataPatchResponse.mockResolvedValue(undefined);
    await restoreAccount();
    listResponse.mockClear();
    sessionDetailResponse.mockClear();
  });

  it('inherits the coding root Agent, model and connected account instead of Account defaults', async () => {
    state.settings.voice.providers.local_conversation.config.agent.chatModelSource = 'session';
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'claude-root-account' },
    } };
    state.sessions['root-session'] = { id: 'root-session', active: true, updatedAt: 5, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local',
      flavor: 'claude', modelOverrideV1: { v: 1, modelId: 'pending-unapplied-model', updatedAt: 20 }, connectedServices,
      sessionAppliedModelV1: { v: 1, provider: 'claude', modelId: 'last-accepted-model', updatedAt: 10,
        selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'last-accepted-model' } },
      sessionModelsV1: { v: 1, agentId: 'claude', updatedAt: 30, currentModelId: 'claude-haiku-4-5',
        availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku' }],
        activeSelectionV1: { v: 1, source: 'runtime_apply',
          selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
          runner: { pid: 123, processStartTimeMs: 1000 },
        },
      },
    } };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
    })).resolves.toBe('voice-root-session');
    expect(spawnRequests).toHaveBeenCalledWith(expect.objectContaining({
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      modelSelection: expect.objectContaining({ ref: expect.objectContaining({ modelId: 'claude-haiku-4-5', providerConnectionId: null }) }),
      connectedServices,
    }));
  });

  it('reuses the creation key for unchanged root model selections observed at different times', async () => {
    state.settings.voice.providers.local_conversation.config.agent.chatModelSource = 'session';
    state.sessions['root-session'] = { id: 'root-session', active: true, updatedAt: 5, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local', flavor: 'claude',
      connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'root-account' },
      } },
      sessionModelsV1: { v: 1, agentId: 'claude', updatedAt: 30, currentModelId: 'claude-haiku-4-5',
        availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku' }],
        activeSelectionV1: { v: 1, source: 'runtime_apply',
          selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
          runner: { pid: 123, processStartTimeMs: 1000 },
        },
      },
    } };
    spawnResponse.mockResolvedValue({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    for (const observedAtMs of [2000, 3000]) {
      runnerObservedAtMs = observedAtMs;
      await expect(ensureVoiceConversationSessionForSessionRoot({
        sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
      })).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_SPAWN_PENDING' });
    }
    const first = spawnRequests.mock.calls[0]?.[0];
    const retry = spawnRequests.mock.calls[1]?.[0];
    expect(first.modelSelection.updatedAt).toBe(2000);
    expect(retry.modelSelection.updatedAt).toBe(3000);
    expect(retry.modelSelection.ref).toEqual(first.modelSelection.ref);
    expect(retry.creationKey).toBe(first.creationKey);
  });

  it.each(['Agent', 'connected account', 'permission'])('refuses to reuse a scoped carrier with another %s', async mismatch => {
    const rootBinding = { v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'root-account' },
    } };
    state.sessions['root-session'] = { id: 'root-session', active: true, updatedAt: 5, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local', flavor: 'claude',
      connectedServices: rootBinding,
    } };
    state.sessions['wrong-agent-carrier'] = { id: 'wrong-agent-carrier', active: false, updatedAt: 10, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local',
      flavor: mismatch === 'Agent' ? 'codex' : 'claude',
      connectedServices: mismatch !== 'connected account' ? rootBinding : { v: 2, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'another-account' },
      } },
      voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 'root-session' },
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      permissionMode: mismatch === 'permission' ? 'yolo' : 'read-only',
    } };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
    })).resolves.toBe('voice-root-session');
    expect(spawnRequests).toHaveBeenCalledWith(expect.objectContaining({
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    }));
  });

  it('keeps a root external Agent contribution qualified through carrier creation', async () => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.voice', localId: 'assistant' } };
    state.sessions['root-session'] = { id: 'root-session', active: true, updatedAt: 5, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local',
      runtimeDescriptorV1: { v: 1, agentId: 'acme.voice/assistant', agent: {} },
      sessionCreationCorrespondenceV1: sessionCreationCorrespondence({ agentTarget,
        executionTarget: { serverId: homeId, machineId: 'machine-target' },
        directory: { kind: 'path', path: '/Users/test/workspace/rebound' },
      }),
    } };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
    })).resolves.toBe('voice-root-session');
    expect(spawnRequests).toHaveBeenCalledWith(expect.objectContaining({ agentTarget }));
  });

  it('fails closed when a coding root does not declare an Agent', async () => {
    state.sessions['root-session'] = { id: 'root-session', active: true, updatedAt: 5, metadata: {
      machineId: 'machine-target', path: '/Users/test/workspace/rebound', host: 'target.local', flavor: 'unknown-agent',
    } };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    expect(spawnRequests).not.toHaveBeenCalled();
  });

  it('refuses a root Session from an unmounted Home instead of spawning against the same id here', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: 'server-2', sessionId: 'root-session' },
    })).rejects.toThrow('voice_conversation_session_home_not_mounted');
    expect(spawnResponse).not.toHaveBeenCalled();
    expect(spawnRequests).not.toHaveBeenCalled();
  });

  it('spawns on the reachable target machine when the root session metadata machine id is stale after handoff', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 'root-session' } })).resolves.toBe('voice-root-session');

    expect(spawnResponse).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-target',
      directory: '/Users/test/workspace/rebound',
      serverId: homeId,
    }));
    expect(spawnRequests).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { machineId: 'machine-target', serverId: homeId },
    }));
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.sessions['voice-root-session'] = {
      id: 'voice-root-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/old',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
        ...(state.sessionListRowsByServerId ?? {}),
        [homeId]: {
          ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
          'voice-root-session': {
            id: 'voice-root-session',
            active: true,
            updatedAt: 10,
            presence: 'online',
            metadata: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'session_root',
                sessionRootId: 'root-session',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      [homeId]: ['voice-root-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      [homeId]: [
        { type: 'session', sessionId: 'voice-root-session', serverId: homeId, serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 'root-session' } })).resolves.toBe('voice-root-session');
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('keeps hydration and lookup on the root Home when focus moves to another Home mid-refresh', async () => {
    // Both Homes hold the SAME candidate session id. The other Home has a hydrated,
    // non-hidden row for it, so a lookup that re-reads focus after the await would skip
    // hydration and resolve the wrong Session; the root Home's row is still unhydrated.
    const visibilityCalls: Array<{ sessionId: string; serverId: string | null }> = [];
    sessionDetailResponse.mockImplementation(async (sessionId: string, options?: any) => {
      visibilityCalls.push({ sessionId, serverId: options?.serverId ?? null });
      if (sessionId === 'root-session') {
        state.sessions['root-session'] = {
          id: 'root-session',
          active: false,
          updatedAt: 5,
          metadata: {
            machineId: 'machine-target',
            path: '/Users/test/workspace/rebound',
            homeDir: '/Users/test',
            host: 'target.local',
          },
        };
        return;
      }
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadata: {
          machineId: 'machine-target',
          path: '/Users/test/workspace/rebound',
          voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 'root-session' },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
    });
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    // Retire the real Account bootstrap list before installing the user's focus
    // change. Otherwise bootstrap can switch Home before this Start is admitted.
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });
    listResponse.mockImplementation(async () => {
      // The user switches Home while the authoritative list is still loading.
      const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
      const otherHome = await upsertAndActivateServer({ serverUrl: 'https://voice-other.example.test', name: 'Other Home' });
      state.sessionListRowsByServerId ??= {};
      state.sessionListRowsByServerId[homeId] ??= {};
      state.sessionListRowsByServerId[homeId]['voice-root-session'] = {
        id: 'voice-root-session', active: false, updatedAt: 10, metadataVersion: 1, metadata: null,
      } as any;
      state.sessionListRowsByServerId[otherHome.id] ??= {};
      state.sessionListRowsByServerId[otherHome.id]['voice-root-session'] = {
        id: 'voice-root-session', active: true, updatedAt: 99, metadataVersion: 1,
        metadata: { path: '/other/home/project' },
      } as any;
      state.ordinarySessionListMembershipByServerId ??= {};
      state.ordinarySessionListMembershipByServerId[homeId] = ['voice-root-session'];
      return { sessionIds: ['voice-root-session'], nextCursor: null, hasNext: false, source: 'v2' };
    });

    // Reuse/spawn is the incumbent case's contract; this one owns the Home binding, so it only
    // requires the attempt to settle.
    let settlementFailureName: string | null = null;
    await ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: homeId, sessionId: 'root-session' },
    }).catch((error: unknown) => {
      settlementFailureName = error instanceof Error
        ? `${error.name}:${/^voice_[a-z_]+$/.test(error.message) ? error.message : 'non_voice_failure'}`
        : 'unknown';
    });

    // The candidate is still hydrated, and against the root Home rather than the newly focused
    // one: reading focus after the await would have consulted the other Home's hydrated row
    // and skipped this candidate entirely.
    expect(visibilityCalls, `settlement failure: ${settlementFailureName}`).toContainEqual({ sessionId: 'voice-root-session', serverId: homeId });
    expect(visibilityCalls.every((call) => call.serverId === homeId)).toBe(true);
  });

  it('awaits authoritative session-list hydration before reusing a matching inactive hidden session', async () => {
    const sessionListHydration = createDeferred<void>();
    const rootRead = createDeferred<void>();
    const carrierRead = createDeferred<void>();
    const listRead = createDeferred<void>();
    sessionDetailResponse.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'root-session') {
        rootRead.resolve();
        state.sessions['root-session'] = {
          id: 'root-session',
          active: false,
          updatedAt: 5,
          metadata: {
            machineId: 'machine-target',
            path: '/Users/test/workspace/rebound',
            homeDir: '/Users/test',
            host: 'target.local',
          },
        };
        return;
      }
      if (sessionId === 'unrelated-hidden-session') {
        throw new Error('unrelated hidden hydration failed');
      }
      expect(sessionId).toBe('voice-root-session');
      carrierRead.resolve();
      await sessionListHydration.promise;
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadata: {
          machineId: 'machine-target',
          path: '/Users/test/workspace/rebound',
          voiceConversationScopeV1: {
            v: 1,
            kind: 'session_root',
            sessionRootId: 'root-session',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
    });
    listResponse.mockImplementation(async () => {
      listRead.resolve();
      state.sessionListRowsByServerId ??= {};
      state.sessionListRowsByServerId[homeId] ??= {};
      state.sessionListRowsByServerId[homeId]['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadataVersion: 1,
        metadata: null,
      } as any;
      state.sessionListRowsByServerId[homeId]['unrelated-hidden-session'] = {
        id: 'unrelated-hidden-session',
        active: false,
        updatedAt: 9,
        metadataVersion: 1,
        metadata: { hiddenSystemSession: true },
      } as any;
      state.ordinarySessionListMembershipByServerId ??= {};
      state.ordinarySessionListMembershipByServerId[homeId] = [
        'voice-root-session',
        'unrelated-hidden-session',
      ];
      return {
        sessionIds: ['voice-root-session', 'unrelated-hidden-session'],
        nextCursor: null,
        hasNext: false,
        source: 'v2',
      };
    });

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    const ensured = ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 'root-session' } });
    // Observe failure immediately, and release external hydration even when an assertion fails.
    let ensureSettled = false;
    void ensured.then(
      () => { ensureSettled = true; },
      () => { ensureSettled = true; },
    );

    try {
      await Promise.all([rootRead.promise, listRead.promise, carrierRead.promise]);
      expect(sessionDetailResponse).toHaveBeenCalledWith('root-session', { serverId: homeId });
      expect(listResponse).toHaveBeenCalledWith();
      expect(sessionDetailResponse).toHaveBeenCalledWith('voice-root-session', { serverId: homeId });
      expect(ensureSettled).toBe(false);
      expect(spawnResponse).not.toHaveBeenCalled();

      sessionListHydration.resolve();

      await expect(ensured).resolves.toBe('voice-root-session');
      expect(spawnResponse).not.toHaveBeenCalled();
    } finally {
      sessionListHydration.resolve();
      await ensured.catch(() => undefined);
    }
  });

  it.each(['coding root', 'synced carrier'])('resumes the inactive exact carrier before returning its endpoint from %s', async entry => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };
    state.sessions['voice-root-session'] = {
      id: 'voice-root-session',
      active: false,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'session_root',
          sessionRootId: 'root-session',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessions['newer-unrelated-voice-session'] = {
      id: 'newer-unrelated-voice-session',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/other',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    const admitted = createDeferred<void>();
    const resumeEntered = createDeferred<void>();
    const order: string[] = [];
    resumeResponse.mockImplementation(async () => {
      order.push('resume');
      resumeEntered.resolve();
      await admitted.promise;
      return { type: 'success', sessionId: 'voice-root-session' };
    });
    const ensured = ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: {
      serverId: homeId, sessionId: entry === 'coding root' ? 'root-session' : 'voice-root-session',
    } }).then(id => { order.push('endpoint'); return id; });
    try {
      await resumeEntered.promise;
      expect(order.length).toBeGreaterThan(0);
      expect(order).toEqual(['resume']);
      expect(resumeResponse).toHaveBeenCalledWith(expect.objectContaining({
        serverId: homeId, machineId: 'machine-target', payload: expect.objectContaining({
          type: 'resume-session', sessionId: 'voice-root-session', directory: '/Users/test/workspace/rebound',
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          executionAuthorization: { provenance: 'user_request', requestId: expect.any(String) },
        }),
      }));
      admitted.resolve();
      await expect(ensured).resolves.toBe('voice-root-session');
      expect(order).toEqual(['resume', 'endpoint']);
      expect(spawnResponse).not.toHaveBeenCalled();
    } finally {
      admitted.resolve();
      await ensured.catch(() => undefined);
    }
  });

  it('refuses failed exact archive restoration without resuming or selecting a replacement', async () => {
    state.sessions['archived-explicit-carrier'] = {
      id: 'archived-explicit-carrier', active: false, archivedAt: 1234, updatedAt: 10,
      metadata: { machineId: 'machine-target', path: '/Users/test/workspace/rebound',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    unarchiveResponse.mockImplementation(async () => new Response('private restoration detail', { status: 503 }));

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: {
      serverId: homeId, sessionId: 'archived-explicit-carrier',
    } })).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_UNARCHIVE_FAILED', message: 'voice_conversation_unarchive_failed' });

    expect(unarchiveResponse).toHaveBeenCalledWith('archived-explicit-carrier');
    expect(resumeResponse).not.toHaveBeenCalled();
    expect(spawnResponse).not.toHaveBeenCalled();
    expect(storage.getState().sessions['archived-explicit-carrier']?.archivedAt).toBe(1234);
  });

  it('refuses an unavailable retained carrier without exposing its endpoint or spawning a replacement', async () => {
    state.sessions['voice-offline'] = {
      id: 'voice-offline', active: false, updatedAt: 10,
      metadata: { machineId: 'machine-target', path: '/Users/test/workspace/rebound',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    resumeResponse.mockResolvedValue({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'private runtime detail' });
    const error = await ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: {
      serverId: homeId, sessionId: 'voice-offline',
    } }).then(() => null, (error: unknown) => error);
    expect(error).toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, message: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
    // Diagnostics retain the launch owner's original failure privately; public
    // recovery and ordinary serialization must keep the sanitized refusal.
    expect(error).toMatchObject({ cause: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'private runtime detail' } });
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(error)).not.toContain('private runtime detail');
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    expect(classifyVoiceMachineError(error)).toMatchObject({ kind: 'provider_error', reason: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['held_by_person', 'session_unavailable', 'none'],
    ['agent_signed_out', 'authentication_required', 'connect_agent'],
  ] as const)('preserves the retained carrier launch refusal %s through Voice recovery', async (code, kind, recoveryAction) => {
    state.sessions['voice-refused'] = {
      id: 'voice-refused', active: false, updatedAt: 10,
      metadata: { machineId: 'machine-target', path: '/Users/test/workspace/rebound',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    };
    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();
    resumeResponse.mockResolvedValue({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'private launch diagnostic', errorDetail: { kind: 'launch_error', code, message: 'private launch diagnostic' } });
    const error = await ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: {
      serverId: homeId, sessionId: 'voice-refused',
    } }).then(() => null, (error: unknown) => error);
    expect(error).toMatchObject({ code, message: code });
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    expect(classifyVoiceMachineError(error)).toMatchObject({ kind, reason: code, recoveryAction, presentation: 'error' });
    expect(resumeResponse).toHaveBeenCalledTimes(1);
    expect(spawnResponse).not.toHaveBeenCalled();
  });

  it('does not recover a timed-out session-root voice spawn by scanning unrelated late sessions', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };
    spawnResponse.mockResolvedValue({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    listResponse.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-root-session': {
            id: 'late-root-session',
            active: true,
            updatedAt: 20,
            metadata: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          },
        },
      };
    });

    const { ensureVoiceConversationSessionForSessionRoot } = await loadConversationSession();

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 'root-session' } })).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_SPAWN_PENDING',
    });
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: homeId, sessionId: 'root-session' } })).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_SPAWN_PENDING',
    });
    expect(spawnResponse.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(spawnResponse.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(spawnRequests.mock.calls[0]?.[0].creationKey).toBe(spawnRequests.mock.calls[1]?.[0].creationKey);
    expect(spawnRequests).toHaveBeenCalledTimes(2);
    expect(sessionDetailResponse).not.toHaveBeenCalled();
  });
});
