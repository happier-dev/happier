import axios from 'axios';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { configuration, reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import type { Session } from '@/api/types';
import { createSessionClientDurableMutationPersistenceContext, parseRuntimeSessionClientDurableMutation } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { ApiSessionClient, type ApiSessionClientOptions } from './sessionClient';
import { registerTranscriptSecret, TRANSCRIPT_SECRET_REDACTED } from './client/transport/transcriptSecretRedaction';
import { createSessionScopedSocketConnection } from './sockets';

// Substitute only the Home HTTP/Socket.IO boundaries. Request ownership, the
// tuple writer, encryption, durable journal and connection supervisor stay real.
vi.mock('axios');
const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

const ownerCredentials = { token: 'tok', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) } };
const serverUrl = 'https://socket-readiness.example.test';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

const currentFeatures = FeaturesResponseSchema.parse({
  features: { sharing: { pendingQueueV2: { enabled: true } } },
  capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } },
});

function createOwnerSession(options: Parameters<typeof createPlainSessionFixture>[0]) {
  const session = createPlainSessionFixture(options);
  const tuple = buildSessionMetadataEnvelopeFields({
    credentials: { token: 'tok', encryption: null }, accountEncryptionMode: 'plain',
    metadata: session.metadata, agentState: session.agentState, storedContentMode: 'plain',
  });
  return { ...session, metadataLayoutVersion: 1 as const,
    ownerMetadata: tuple.ownerMetadataValue, ownerMetadataEnvelope: tuple.ownerMetadata };
}

function createOwnerRow(session: ReturnType<typeof createOwnerSession>) {
  const tuple = buildSessionMetadataEnvelopeFields({
    credentials: { token: 'tok', encryption: null }, accountEncryptionMode: 'plain',
    metadata: session.metadata, agentState: session.agentState, storedContentMode: 'plain',
  });
  return createSessionRecordFixture({
    id: session.id, metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext,
    metadataVersion: session.metadataVersion, ownerMetadata: tuple.ownerMetadata,
    agentState: tuple.agentState, agentStateVersion: session.agentStateVersion, encryptionMode: 'plain', share: null,
  });
}

describe('ApiSessionClient exact request settlement recovery', () => {
  const clients: ApiSessionClient[] = [];
  const connectGates: ReturnType<typeof createDeferred>[] = [];

  it.each(['direct', 'deferred', 'deferred-attach-retry'] as const)('republishes an offline request through the %s Session tuple owner after reconnect', async adapter => {
    const session = createOwnerSession({ id: 'offline-request-publication' });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    const socket = createSocket({ disconnectReason: 'transport close' });
    const connect = createDeferred();
    const client = createClient(session, [socket], {}, connect);
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: session.id, limits: { maxEntries: 10, maxBytes: 10_000 } });
    const store = new AgentStateRequestStore({ session: adapter === 'direct' ? client : deferred, logPrefix: '[OfflinePublication]' });
    if (adapter === 'deferred') await deferred.attach(client);
    client.bindAgentStateRequestStore(store);
    const publication = { requestId: 'offline', toolName: 'Bash', toolInput: { command: 'pwd' }, createdAt: 10, turnId: 'turn-offline' };
    const failed = vi.spyOn(logger, 'infoFile');
    try {
      expect(socket.connected).toBe(false);
      vi.mocked(axios.patch).mockRejectedValue(new Error('Home unavailable'));
      store.publishRequest(publication);
      if (adapter === 'deferred-attach-retry') {
        await expect(deferred.attach(client, {
          beforeBufferedDrain: async () => { throw new Error('authority preparation rejected'); },
        })).rejects.toThrow('authority preparation rejected');
        expect(JSON.parse(row.agentState ?? '{}').requests?.offline).toBeUndefined();
        await deferred.attach(client);
      }
      await vi.waitFor(() => expect(axios.patch).toHaveBeenCalled());
      await client.updateAgentState(state => state).catch(() => undefined);
      expect(JSON.parse(row.agentState ?? '{}').requests?.offline).toBeUndefined();
      vi.mocked(axios.patch).mockImplementation(commit);
      connect.resolve();
      await vi.waitFor(() => expect(JSON.parse(row.agentState ?? '{}').requests?.offline).toMatchObject({
        tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 10, turnId: 'turn-offline',
      }));
      expect(failed).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operation: 'publish_request' }));
    } finally { store.dispose(); failed.mockRestore(); }
  });

  it.each(['retained', 'unsubscribe', 'cancel'] as const)('preserves the %s connection listener lifetime after attach rollback', async retirement => {
    const session = createOwnerSession({ id: 'retired-deferred-listener' });
    const row = createOwnerRow(session);
    serveSession(row);
    const socket = createSocket({ disconnectReason: 'transport close' });
    const connect = createDeferred();
    const client = createClient(session, [socket], {}, connect);
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: session.id, limits: { maxEntries: 10, maxBytes: 10_000 } });
    const listener = vi.fn<(state: Readonly<{ phase: string }>) => void>();
    const connectionState = vi.fn();
    const unsubscribeControl = client.subscribeToSessionConnectionState(connectionState);
    const unsubscribe = deferred.subscribeToSessionConnectionState(listener);
    await expect(deferred.attach(client, {
      beforeBufferedDrain: async () => { throw new Error('authority preparation rejected'); },
    })).rejects.toThrow('authority preparation rejected');
    if (retirement === 'unsubscribe') unsubscribe();
    else if (retirement === 'cancel') deferred.cancel();
    await deferred.attach(client);
    listener.mockClear();
    connect.resolve();
    await vi.waitFor(() => expect(connectionState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'online' })));
    unsubscribeControl();
    if (retirement === 'retained') {
      expect(listener.mock.calls.filter(([state]) => state.phase === 'online')).toHaveLength(1);
    } else {
      expect(listener).not.toHaveBeenCalled();
    }
    unsubscribe();
  });

  it.each(['AgentState', 'metadata'] as const)('overlaps %s currentness and Session reads without committing before both are admitted', async operation => {
    const session = createOwnerSession({ id: 'withdrawal-read-overlap' });
    const row = createOwnerRow(session);
    serveSession(row);
    const homeRead = vi.mocked(axios.get).getMockImplementation()!;
    const currentnessStarted = createDeferred();
    const releaseCurrentness = createDeferred();
    let sessionReads = 0;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        currentnessStarted.resolve();
        await releaseCurrentness.promise;
      }
      if (path === `/v2/sessions/${session.id}`) sessionReads += 1;
      return homeRead(url, options);
    });
    const connect = createDeferred();
    const client = createClient(session, [createSocket()], { initialRegisteredSessionStateFieldMutations: [] }, connect);
    const readValue = () => operation === 'AgentState'
      ? client.getAgentStateSnapshot()?.controlledByUser
      : client.getMetadataSnapshot()?.path === '/updated';
    const mutation = operation === 'AgentState'
      ? client.updateAgentState(state => ({ ...state, controlledByUser: true }))
      : client.updateMetadata(metadata => ({ ...metadata, path: '/updated' }));
    try {
      await currentnessStarted.promise;
      // HTTP is held, not internal tuple/currentness logic. An independent
      // Session read must progress while Account-mode admission is pending.
      await vi.waitFor(() => expect(sessionReads).toBe(1));
      expect(axios.patch).not.toHaveBeenCalled();
      expect(readValue()).not.toBe(true);
    } finally {
      releaseCurrentness.resolve();
      await mutation;
    }
    expect(readValue()).toBe(true);
  });

  it('retires an unacknowledged publication through the existing cancellation journal when its ACK was lost', async () => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-unacknowledged-request-')));
    reloadConfiguration();
    const session = createOwnerSession({ id: 'lost-request-publication-ack' });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    let saved = false;
    vi.mocked(axios.patch).mockImplementation(async (url, body, options) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (!saved && patch.mode === 'owner' && patch.agentState && patch.agentState.ciphertext !== null
        && JSON.parse(patch.agentState.ciphertext).requests?.lost) {
        saved = true;
        await commit(url, body, options);
      }
      throw new Error('Home response lost');
    });
    const connect = createDeferred();
    const client = createClient(session, [createSocket()], {}, connect);
    const store = new AgentStateRequestStore({ session: client, logPrefix: '[LostPublicationAck]' });
    const owner = { kind: 'plugin' as const, pluginId: 'lost-ack-owner' };
    client.bindAgentStateRequestStore(store);
    const failed = vi.spyOn(logger, 'infoFile');
    try {
      store.publishRequest({ requestId: 'lost', toolName: 'Bash', toolInput: { command: 'pwd' }, createdAt: 10, owner });
      await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operation: 'publish_request' })));
      expect(JSON.parse(row.agentState ?? '{}').requests?.lost).toBeDefined();
      expect(client.getAgentStateSnapshot()?.requests?.lost).toBeUndefined();
      await store.cancelRequestsByOwner({ owner, observedRetirement: true, reason: 'Plugin retired', requestIds: [] }).catch(() => undefined);
      vi.mocked(axios.patch).mockImplementation(commit);
      connect.resolve();
      await vi.waitFor(() => expect(JSON.parse(row.agentState ?? '{}').completedRequests?.lost).toMatchObject({ status: 'canceled' }));
      expect(JSON.parse(row.agentState ?? '{}').requests?.lost).toBeUndefined();
    } finally { vi.mocked(axios.patch).mockImplementation(commit); connect.resolve(); store.dispose(); failed.mockRestore(); }
  });

  function createSocket(options: Parameters<typeof createApiSessionSocketStub>[0] = {}) {
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1', committedFenceMs: 1_000 });
    const transcript = createSessionTranscriptHomeStub();
    return createApiSessionSocketStub({ ...options, emitWithAck: (event, payload, socket) =>
      activity.answer(event, payload) ?? transcript.answer(event, payload)
      ?? options.emitWithAck?.(event, payload, socket) ?? { result: 'success' } });
  }

  function createClient(session: Session, sockets: readonly ApiSessionSocketStub[], options: Partial<ApiSessionClientOptions> = {}, gate?: ReturnType<typeof createDeferred>, token = 'tok') {
    let nextSocket = 0;
    mockIo.mockImplementation(() => sockets[Math.min(nextSocket++, sockets.length - 1)]);
    const client = new ApiSessionClient(token, session, {
      localMachineId: 'machine-1',
      metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
        sessionId: session.id, agentRuntimeApplicability: 'supported',
      })],
      transport: { serverId: 'socket-readiness-home', serverUrl,
        createSessionSocketTransport: ({ sessionId, machineId }) => {
          const { socket, transport } = createSessionScopedSocketConnection({ token, serverUrl, sessionId, machineId });
          return { socket, transport: gate ? { ...transport,
            connect: async () => { await gate.promise; await transport.connect(); },
          } : transport };
        },
      },
      ...options,
    });
    clients.push(client);
    if (gate) connectGates.push(gate);
    return client;
  }

  function serveSession(row: ReturnType<typeof createSessionRecordFixture>, currentness = createAccountEncryptionCurrentnessFixture()) {
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === `/v2/sessions/${row.id}`) return { status: 200, data: { session: row } };
      return { status: 404, data: {} };
    });
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner') throw new Error('Expected existing layout-1 owner tuple patch');
      const target = patch;
      row.metadataLayoutVersion = 1;
      row.metadata = target.sharedMetadata.ciphertext;
      row.ownerMetadata = target.ownerMetadata;
      row.metadataVersion += 1;
      if (target.agentState) {
        row.agentState = target.agentState.ciphertext;
        row.agentStateVersion = (row.agentStateVersion ?? 0) + 1;
      }
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({
        success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion },
        agentState: { version: row.agentStateVersion },
      }) };
    });
  }

  beforeEach(() => {
    vi.mocked(axios.get).mockReset().mockImplementation(async url => ({
      status: new URL(String(url)).pathname === '/v1/auth/ping' ? 200 : 404, data: {},
    }));
    vi.mocked(axios.patch).mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(currentFeatures), { status: 200,
      headers: { 'content-type': 'application/json' } })));
  });

  afterEach(async () => {
    for (const gate of connectGates.splice(0)) gate.resolve();
    await Promise.all(clients.splice(0).map(client => client.close()));
    vi.unstubAllGlobals();
  });

  it.each(['reconnect', 'close'] as const)('settles an already-applied native choice through the bound Session store on %s', async (edge) => {
    const request = { tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 10, kind: 'user_action' };
    const background = { tool: 'Bash', arguments: { command: 'background' }, createdAt: 20 };
    const session = createOwnerSession({ id: 'applied-native-choice-reconnect',
      agentState: { requests: { native: request, background }, completedRequests: {} } });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    const socket = createSocket({ disconnectReason: 'transport close' });
    const client = createClient(session, [socket]);
    const store = new AgentStateRequestStore({ session: client, logPrefix: '[AppliedNativeChoice]' });
    client.bindAgentStateRequestStore(store);
    const coordinator = createPermissionRequestCoordinator<{ decision: string; answers: Record<string, string> }>({ store });
    const pending = coordinator.requestDecision({ requestId: 'native', toolName: request.tool, toolInput: request.arguments });
    void pending.catch(() => undefined);
    const context = coordinator.getResponseContext('native')!;
    const apply = vi.fn(async () => undefined);
    const result = { decision: 'approved', answers: { choice: 'Continue' } };
    vi.mocked(axios.patch).mockRejectedValue(new Error('native completion transport unavailable'));
    await expect(coordinator.completeResponse({ context, acknowledgeDecisionApplication: apply,
      completion: { result, completedRequest: { status: 'approved', decision: 'approved',
        extraCompletedFields: { answers: result.answers } } } })).rejects.toThrow('native completion transport unavailable');
    expect(client.getAgentStateSnapshot()?.requests?.native).toBeDefined();
    const replacement = new AgentStateRequestStore({ session: client, logPrefix: '[Replacement]' });
    client.bindAgentStateRequestStore(replacement);
    store.dispose();
    vi.mocked(axios.patch).mockImplementation(commit);
    if (edge === 'close') {
      await client.close();
      clients.splice(clients.indexOf(client), 1);
      await expect(pending).rejects.toThrow('Applied request retired');
      expect(apply).toHaveBeenCalledTimes(1);
      expect(JSON.parse(row.agentState ?? '{}').requests.native).toBeDefined();
      return;
    }
    socket.disconnect();
    socket.connect();
    await expect(pending).resolves.toEqual(result);
    expect(apply).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(row.agentState ?? '{}');
    expect(saved.requests).not.toHaveProperty('native');
    expect(saved.requests.background).toEqual(background);
    expect(saved.completedRequests.native).toMatchObject({ status: 'approved', answers: result.answers });
    expect(coordinator.getResponseContext('native')).toBeNull();
  });

  it.each(['last-waiter', 'plugin'] as const)('recovers a privately journaled %s cancellation on keyless plain restart without replacing newer requests', async cancellation => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-request-settlement-')));
    reloadConfiguration();
    const request = { tool: 'Bash', arguments: { command: 'private-settlement-command' }, createdAt: 10, owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } };
    const claimedNeighbor = { ...request, createdAt: 11, owner: { kind: 'plugin' as const, pluginId: 'plugin-b' },
      permissionResponseClaimV1: { version: 1, origin: 'automaticPolicy' } };
    const session = createOwnerSession({ id: 'request-settlement-restart', agentState: { requests: { foreground: request, neighbor: claimedNeighbor } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    vi.mocked(axios.patch).mockRejectedValue(new Error('Home temporarily unavailable'));
    const client = createClient(session, [createSocket()]);
    try {
      const store = new AgentStateRequestStore({ session: client, logPrefix: '[RequestSettlementTest]' });
      const coordinator = createPermissionRequestCoordinator({ store });
      let completion: Promise<unknown>;
      if (cancellation === 'last-waiter') {
        const controller = new AbortController();
        completion = coordinator.requestDecision({ requestId: 'foreground', toolName: request.tool,
          toolInput: request.arguments, owner: request.owner }, { signal: controller.signal });
        controller.abort();
      } else {
        completion = coordinator.cancelByPlugin('plugin-a', 'plugin retired');
      }
      await expect(completion).rejects.toThrow('awaiting acknowledged delivery');
      const persistence = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
        parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
      });
      const journal = await readFile(persistence.paths.queuePath, 'utf8');
      expect(journal).toContain('agent_state_request_settlement');
      expect(journal).not.toContain('private-settlement-command');
      await client.close();
      clients.splice(clients.indexOf(client), 1);
      const background = { ...request, createdAt: 20, arguments: { command: 'background remains' } };
      const newerState = { requests: { foreground: request, neighbor: claimedNeighbor, background }, resumed: true };
      row.agentState = JSON.stringify(newerState);
      row.agentStateVersion = 1;
      vi.mocked(axios.patch).mockImplementation(commit);
      const restarted = createClient({ ...session, agentState: newerState, agentStateVersion: 1 }, [createSocket()]);
      await expect.poll(async () => {
        await restarted.flushDurableMutationDelivery();
        return JSON.parse(row.agentState ?? '{}');
      }).toMatchObject({ requests: { background, neighbor: claimedNeighbor }, resumed: true,
        completedRequests: { foreground: { status: 'canceled', decision: 'abort' } } });
      expect(JSON.parse(row.agentState ?? '{}').requests).not.toHaveProperty('foreground');
      await restarted.close();
      clients.splice(clients.indexOf(restarted), 1);
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);


  it.each(['approval', 'current-policy', 'response-target'] as const)('does not retain a failed %s choice as deferred permission authority', async mode => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-direct-permission-ack-')));
    reloadConfiguration();
    const request = { tool: 'Bash', arguments: {}, createdAt: 10,
      ...(mode === 'response-target' ? { responseTarget: { kind: 'external-response' } } : {}) };
    const session = createOwnerSession({ id: `direct-permission-${mode}`, agentState: { requests: { foreground: request } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    vi.mocked(axios.patch).mockRejectedValue(new Error('Home unavailable before decision ACK'));
    const client = createClient(session, [createSocket()]);
    try {
      const store = new AgentStateRequestStore({ session: client, logPrefix: '[DirectDecisionAck]' });
      await expect(store.completeRequest({ requestId: 'foreground',
        status: mode === 'approval' ? 'approved' : 'canceled',
        ...(mode === 'current-policy' ? { isCurrent: () => true } : {}) })).rejects.toThrow('Home unavailable before decision ACK');
      const persistence = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
        parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
      });
      const journal = await readFile(persistence.paths.queuePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(journal).not.toContain('agent_state_request_settlement');
      await client.close();
      clients.splice(clients.indexOf(client), 1);
      vi.mocked(axios.patch).mockImplementation(commit);
      const restarted = createClient(session, [createSocket()]);
      await restarted.flushDurableMutationDelivery();
      expect(JSON.parse(row.agentState ?? '{}').requests.foreground).toEqual(request);
      expect(JSON.parse(row.agentState ?? '{}').completedRequests?.foreground).toBeUndefined();
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);




  it('does not retire a same-id replacement when an older local waiter aborts', async () => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-replacement-retirement-')));
    reloadConfiguration();
    const request = { tool: 'Bash', arguments: { command: 'old' }, createdAt: 10 };
    const session = createOwnerSession({ id: 'replacement-retirement', agentState: { requests: { same: request } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const client = createClient(session, [createSocket()]);
    try {
      const store = new AgentStateRequestStore({ session: client, logPrefix: '[ReplacementRetirement]' });
      const coordinator = createPermissionRequestCoordinator({ store });
      const controller = new AbortController();
      const pending = coordinator.requestDecision({ requestId: 'same', toolName: request.tool,
        toolInput: request.arguments }, { signal: controller.signal });
      void pending.catch(() => undefined);
      const replacement = { ...request, createdAt: 11, arguments: { command: 'new' } };
      await client.updateAgentState(state => ({ ...state, requests: { same: replacement } }));
      controller.abort();
      await expect(pending).rejects.toThrow();
      await client.flushDurableMutationDelivery();
      expect(JSON.parse(row.agentState ?? '{}').requests.same).toEqual(replacement);
      expect(JSON.parse(row.agentState ?? '{}').completedRequests?.same).toBeUndefined();
      const persistence = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
        parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
      });
      const journal = await readFile(persistence.paths.queuePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(journal).not.toContain('agent_state_request_settlement');
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);

  it('keeps pre-effect reset failure pending without a later phantom cancellation', async () => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-reset-ack-')));
    reloadConfiguration();
    const request = { tool: 'Bash', arguments: {}, createdAt: 10 };
    const session = createOwnerSession({ id: 'pre-effect-reset', agentState: { requests: { foreground: request } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const commit = vi.mocked(axios.patch).getMockImplementation()!;
    vi.mocked(axios.patch).mockRejectedValue(new Error('Home unavailable before reset ACK'));
    const client = createClient(session, [createSocket()]);
    try {
      const store = new AgentStateRequestStore({ session: client, logPrefix: '[ResetAck]' });
      const coordinator = createPermissionRequestCoordinator({ store });
      const pending = coordinator.requestDecision({ requestId: 'foreground', toolName: request.tool, toolInput: request.arguments });
      void pending.catch(() => undefined);
      await expect(coordinator.reset()).rejects.toThrow('Home unavailable before reset ACK');
      const persistence = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
        parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
      });
      const journal = await readFile(persistence.paths.queuePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(journal).not.toContain('agent_state_request_settlement');
      vi.mocked(axios.patch).mockImplementation(commit);
      await client.flushDurableMutationDelivery();
      expect(JSON.parse(row.agentState ?? '{}').requests.foreground).toEqual(request);
      expect(coordinator.getResponseContext('foreground')).not.toBeNull();
      await coordinator.cancelAll('test teardown');
      await expect(pending).rejects.toThrow();
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);

  it('commits a permission request carrying a live registered secret to Agent state only in redacted form', async () => {
    // Fake host-minted secret: an Agent that read it may echo it into a tool call it asks to approve.
    const secret = 'fake-live-hook-secret-0123456789abcdef';
    const unregister = registerTranscriptSecret(secret);
    const session = createOwnerSession({ id: 'redacted-permission-request', agentState: {} });
    const row = createOwnerRow(session);
    serveSession(row);
    const client = createClient(session, [createSocket()]);
    const store = new AgentStateRequestStore({ session: client, logPrefix: '[RedactedPermission]' });
    client.bindAgentStateRequestStore(store);
    const coordinator = createPermissionRequestCoordinator<{ decision: string }>({ store });
    try {
      const toolInput = { command: `curl -H 'x-happier-hook-secret: ${secret}' http://127.0.0.1/hook` };
      const pending = coordinator.requestDecision({ requestId: 'leaky', toolName: 'Bash', toolInput });
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(JSON.parse(row.agentState ?? '{}').requests?.leaky).toBeDefined());
      expect(row.agentState).not.toContain(secret);
      expect(JSON.parse(row.agentState ?? '{}').requests.leaky.arguments).toEqual({
        command: `curl -H 'x-happier-hook-secret: ${TRANSCRIPT_SECRET_REDACTED}' http://127.0.0.1/hook`,
      });
      const context = coordinator.getResponseContext('leaky');
      expect(context).not.toBeNull();
      await expect(coordinator.completeResponse({ context: context!, acknowledgeDecisionApplication: async () => undefined,
        completion: { result: { decision: 'approved' }, completedRequest: { status: 'approved', decision: 'approved' } },
      })).resolves.toBe(true);
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      const saved = JSON.parse(row.agentState ?? '{}');
      expect(saved.requests).not.toHaveProperty('leaky');
      expect(saved.completedRequests.leaky).toMatchObject({ status: 'approved' });
      expect(row.agentState).not.toContain(secret);
    } finally { store.dispose(); unregister(); }
  });

  it.each(['observed-abort', 'native-decision'] as const)('settles actual deferred permission composition after queued publication (%s)', async mode => {
    const session = createOwnerSession({ id: `deferred-permission-${mode}`, agentState: {} });
    const row = createOwnerRow(session);
    serveSession(row);
    const client = createClient(session, [createSocket()]);
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'pending-permission',
      limits: { maxEntries: 10, maxBytes: 10_000 } });
    const store = new AgentStateRequestStore({ session: deferred, logPrefix: '[DeferredPermissionComposition]' });
    const coordinator = createPermissionRequestCoordinator<{ decision: string }>({ store });
    const controller = new AbortController();
    const pending = coordinator.requestDecision({ requestId: 'foreground', toolName: 'Bash',
      toolInput: { command: 'deferred work' } }, { signal: controller.signal });
    void pending.catch(() => undefined);
    if (mode === 'observed-abort') controller.abort();
    await deferred.attach(client);
    if (mode === 'observed-abort') {
      await expect(pending).rejects.toThrow();
      expect(JSON.parse(row.agentState ?? '{}')).toMatchObject({ completedRequests: { foreground: { status: 'canceled' } } });
    } else {
      const context = coordinator.getResponseContext('foreground');
      expect(context).not.toBeNull();
      const applyNativeAnswer = vi.fn(async () => undefined);
      await expect(coordinator.completeResponse({ context: context!, acknowledgeDecisionApplication: applyNativeAnswer,
        completion: { result: { decision: 'approved' }, completedRequest: { status: 'approved', decision: 'approved' } },
      })).resolves.toBe(true);
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(applyNativeAnswer).toHaveBeenCalledTimes(1);
    }
    expect(JSON.parse(row.agentState ?? '{}').requests).not.toHaveProperty('foreground');
  });

  it('quarantines authenticated invalid settlement intent without blocking the next exact retirement', async () => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-invalid-settlement-')));
    reloadConfiguration();
    const request = { tool: 'Bash', arguments: { command: 'valid private work' }, createdAt: 10 };
    const session = createOwnerSession({ id: 'invalid-settlement', agentState: { requests: { foreground: request } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const persistence = createSessionClientDurableMutationPersistenceContext({
      activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
      parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
    });
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const invalidContent = { t: 'device_local_v1', c: storage.sealJson({ purpose: 'agent_state_request_settlement',
      value: { v: 2, privateValue: 'invalid private work' } }) };
    const validContent = { t: 'device_local_v1', c: storage.sealJson({ purpose: 'agent_state_request_settlement',
      value: { v: 1, entries: [{ requestId: 'foreground', removeRequest: true,
        completed: { ...request, completedAt: 20, status: 'canceled' } }] } }) };
    const queued = (mutationId: string, content: typeof invalidContent) => ({
      kind: 'agent_state_request_settlement', mutationId, createdAt: 20, attempts: 0, nextAttemptAt: 0,
      payload: { v: 1, source: 'agent_state_request_settlement', sessionId: session.id, mutationId, content },
    });
    const invalidMutation = queued('invalid-settlement', invalidContent);
    await mkdir(dirname(persistence.paths.queuePath), { recursive: true });
    await writeFile(persistence.paths.queuePath, JSON.stringify({ v: 1,
      mutations: [invalidMutation, queued('valid-settlement', validContent)] }));
    const client = createClient(session, [createSocket()]);
    try {
      await expect.poll(async () => {
        await client.flushDurableMutationDelivery();
        return JSON.parse(row.agentState ?? '{}');
      }).toMatchObject({ completedRequests: { foreground: { status: 'canceled' } } });
      expect(JSON.parse(row.agentState ?? '{}').requests).not.toHaveProperty('foreground');
      const deadLetters = JSON.parse(await readFile(persistence.paths.deadLetterPath, 'utf8'));
      expect(deadLetters.entries).toContainEqual(expect.objectContaining({
        reason: 'invalid_agent_state_request_settlement', queuedMutation: expect.objectContaining({ payload: invalidMutation.payload }),
      }));
      expect(JSON.stringify(deadLetters)).not.toContain('invalid private work');
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);

  // Ciphertexts produced by the actual 0.2 encrypt owner at ef2000e8d157643da689b1fbfd5ef9a7b55340bd.
  // They are persisted journal ingress, not ciphertext produced by this reader.
  it.each(['legacy', 'dataKey'] as const)('replays predecessor %s settlement with retained bound-owner material', async variant => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-predecessor-settlement-')));
    reloadConfiguration();
    const ciphertexts = {"legacy":"PVundZ+EN1NAPaDEC2Cyrhw/3cNhYO63qaVlh6XU9kerX2ZQ4qyOLy4gwsphZDld/tRvjAgfxPrj/d0nE7Wrw97U0Nx15XQ/owAdHiKY/b3V6ikynnCek8A1TIXxHQXm8GMvF0KFMBIJXjcN5UCyS+AVNlILgoaGm1SXaz7G0OrFYbVYmLghjy4iFpZBnbZhWQxNhIJi6lDVVUFdqb8ZmzMRvySBA4OmttBbZ68te1bNTV2aZ6v+ZS/UeUlNgu0xhvvgnLzpu9JpB9HIQhzFc3nBnxLsT+pq3JYbivpSvaYq3QpmLrT7fm7/E4R+QJmeXR0dZMkYwQsJzxI8X5sqivI4Lmulkm4HuAeTcqSMFT2wPF1x3SlCiiU2O2kf18TtPFzcL/YvGNEUC7ObAXi4WguKFYVv9AgwwPsqBP97/Q==","dataKey":"AENl3ov7jyQNweXAEPumFzsKDa+4BB+BeHeCLsOi4u+LWKGphWqGVZShRKup2QJl0yQF7ABSt0PXUIgtUzhvOmYs9q3Ahf3hz9tmYXK1FUfJoUTAytKFioBHUKAn1snmsfv/+/PYQ/Zq2pDvzLPTbZdtYm7Y3PDjP3p2+qBKsbiyv0GrYJhnN+TnpQbIDr1xZY72FQMlw+b4firmNoO0KF/gDZkeax2WbpRP3G54H5877eQoqU0AisPVDIhF4MW+9uhgWSHpi4WDXmAgdxDrQkSJWwtvuOxiHSq1aH2IqLuJSb4h8gTG1zPte4/M2QCXuHI7iXOqdXB2DNhlob42ym400fa83v+GJQy/KG2E29xlE2MiEaE7r4LUoNmdlM9lCAruWaREez4VPwVhIJNn5snmvHs="};
    const request = { tool: 'Bash', arguments: { command: 'predecessor private work' }, createdAt: 10 };
    const background = { ...request, createdAt: 30 };
    const session = createOwnerSession({ id: `predecessor-settlement-${variant}`,
      agentState: { requests: { foreground: request, background } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const persistence = createSessionClientDurableMutationPersistenceContext({
      activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
      parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
    });
    await mkdir(dirname(persistence.paths.queuePath), { recursive: true });
    const mutationId = 'source-settlement';
    await writeFile(persistence.paths.queuePath, JSON.stringify({ v: 1, mutations: [{
      kind: 'agent_state_request_settlement', mutationId, createdAt: 20, attempts: 0, nextAttemptAt: 0,
      payload: { v: 1, source: 'agent_state_request_settlement', sessionId: session.id, mutationId,
        content: { t: 'encrypted', c: ciphertexts[variant] } },
    }] }));
    const encryption = variant === 'legacy' ? ownerCredentials.encryption
      : { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(2), machineKey: new Uint8Array(32).fill(4) };
    const wrongEncryption = variant === 'legacy'
      ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) }
      : { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(2), machineKey: new Uint8Array(32).fill(9) };
    const wrongKeyClient = createClient(session, [createSocket()], { metadataAuthority: { kind: 'owner',
      credentials: { token: 'tok', encryption: wrongEncryption } } });
    await wrongKeyClient.flushDurableMutationDelivery();
    const retained = JSON.parse(await readFile(persistence.paths.queuePath, 'utf8'));
    expect(retained.mutations).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ content: { t: 'encrypted', c: ciphertexts[variant] } }),
    }));
    await expect(readFile(persistence.paths.deadLetterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(row.agentState ?? '{}').requests.foreground).toEqual(request);
    await wrongKeyClient.close();
    clients.splice(clients.indexOf(wrongKeyClient), 1);
    const client = createClient(session, [createSocket()], { metadataAuthority: { kind: 'owner',
      credentials: { token: 'tok', encryption } } });
    try {
      await expect.poll(async () => {
        await client.flushDurableMutationDelivery();
        return JSON.parse(row.agentState ?? '{}');
      }).toMatchObject({ requests: { background }, completedRequests: { foreground: { status: 'canceled' } } });
      expect(JSON.parse(row.agentState ?? '{}').requests).not.toHaveProperty('foreground');
    } finally {
      await Promise.all(clients.splice(0).map(active => active.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);

  it('retains predecessor installation ciphertext until its original scoped identity can replay it', async () => {
    vi.stubEnv('HAPPIER_HOME_DIR', await mkdtemp(join(tmpdir(), 'happier-predecessor-installation-')));
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'predecessor-keyless-home');
    reloadConfiguration();
    // Produced by the actual 0.2 sealAgentStateRequestSettlement owner at
    // 8c7f5dba37fb759d8a15c6653442725bdd1acf21 with the synthetic identity/scope below.
    const content = { t: 'installation_encrypted_v1', c: 'AKwA5SIeuTbBXVtBhh9I+MMj/Erd6lhgVYeBHnI7lPC5USFY9WfcNMmTzHspTw1eM+fUs7u2H+472ycR5VRZZZBBhJCjMooZ/9qqzPTOotoDdI5VaYNuC5tS3vpW2eT3YM1QOiKRFIQ3UBNiF4FTpOzgFr1Q/bsnRICLhpsj98DVYZs2uEmXIyKHlZqIttuYB4nn9XuXHpX0Y/07l20MLxVOUAw931W66oOkR3vLzpOKT1XV2df7zMUGzvetLh8SP2hwGip652Yk+MjQQTw+SFKjk4y9ijw9v2Pmq/Ie0AxTWwhLQL/yJJy9vW3OWbkmQf+kS4SdOpkCTd3qdvmUpgk/YpGBPb8WzpNuFbldYjCY8EZ0MnSP30lcvVFHDoLNtGNzNxFEhkV4bn/R+0s=' } as const;
    const identity = { version: 1, installationId: 'predecessor-installation', createdAt: 1,
      publicKey: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
      privateKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwfqSmxj4pxSCr71UHsTLsX5lUd2rr6-e5JCHuppFEbSLA' };
    const token = (account: string, revision = 1) => `header.${Buffer.from(JSON.stringify({ sub: account, revision })).toString('base64url')}.sig`;
    const request = { tool: 'Bash', arguments: { command: 'predecessor installation private work' }, createdAt: 10 };
    const background = { ...request, createdAt: 30 };
    const session = createOwnerSession({ id: 'predecessor-installation-settlement',
      agentState: { requests: { foreground: request, background } } });
    const row = createOwnerRow(session);
    serveSession(row);
    const persistence = createSessionClientDurableMutationPersistenceContext({
      activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId: session.id,
      parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
    });
    await mkdir(dirname(persistence.paths.queuePath), { recursive: true });
    const mutationId = 'source-installation-settlement';
    await writeFile(persistence.paths.queuePath, JSON.stringify({ v: 1, mutations: [{
      kind: 'agent_state_request_settlement', mutationId, createdAt: 20, attempts: 0, nextAttemptAt: 0,
      payload: { v: 1, source: 'agent_state_request_settlement', sessionId: session.id, mutationId, content },
    }] }));
    const assertRetained = async () => {
      const retained = JSON.parse(await readFile(persistence.paths.queuePath, 'utf8'));
      expect(retained.mutations).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ content }) }));
      await expect(readFile(persistence.paths.deadLetterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(row.agentState ?? '{}').requests.foreground).toEqual(request);
    };
    const closeClient = async (client: ApiSessionClient) => {
      await client.close();
      clients.splice(clients.indexOf(client), 1);
    };
    try {
      const missingIdentity = createClient(session, [createSocket()], {}, undefined, token('predecessor-account'));
      await missingIdentity.flushDurableMutationDelivery();
      await assertRetained();
      await expect(readFile(configuration.installationIdentityFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await closeClient(missingIdentity);
      readOrCreateInstallationIdentitySync();
      const replacedIdentity = createClient(session, [createSocket()], {}, undefined, token('predecessor-account'));
      await replacedIdentity.flushDurableMutationDelivery();
      await assertRetained();
      await closeClient(replacedIdentity);
      await writeFile(configuration.installationIdentityFile, JSON.stringify(identity), { mode: 0o600 });
      const wrongAccount = createClient(session, [createSocket()], {}, undefined, token('different-account'));
      await wrongAccount.flushDurableMutationDelivery();
      await assertRetained();
      await closeClient(wrongAccount);
      const recovered = createClient(session, [createSocket()], {}, undefined, token('predecessor-account', 2));
      // A live client retains the profile of its journal when the active Home changes.
      vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'another-profile');
      reloadConfiguration();
      await expect.poll(async () => {
        await recovered.flushDurableMutationDelivery();
        return JSON.parse(row.agentState ?? '{}');
      }).toMatchObject({ requests: { background }, completedRequests: { foreground: { status: 'canceled' } } });
      expect(JSON.parse(row.agentState ?? '{}').requests).not.toHaveProperty('foreground');
    } finally {
      await Promise.all(clients.splice(0).map(client => client.close()));
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  }, 60_000);

});
