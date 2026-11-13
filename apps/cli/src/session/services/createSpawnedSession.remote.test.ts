import { DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { AccountMachineInventoryRow } from '@/api/machine/fetchAccountMachines';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), io: vi.fn() }));
// HTTP, local daemon control, and Socket.IO are the actual process/network boundaries.
vi.mock('socket.io-client', () => ({ io: boundary.io }));
vi.mock('@/daemon/controlClient', async (original) => ({
  ...await original<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession: boundary.spawn,
  resolveDaemonSpawnSessionByNonce: boundary.resolve,
}));

import { createSpawnedSession } from './createSpawnedSession';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

const key = new Uint8Array(32).fill(7);
const credentials: Credentials = { token: 'account-token', encryption: { type: 'legacy', secret: key } };
const session = createSessionRecordFixture({
  id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
  encryptionMode: 'plain', metadata: JSON.stringify({ path: '/remote-only/repo', host: 'remote', machineId: 'remote' }),
  metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
});
const machine = { id: 'remote', replacedByMachineId: 'local', dataEncryptionKey: null } satisfies AccountMachineInventoryRow;

describe('createSpawnedSession exact remote routing', () => {
  let calls: Array<{ method: string; request: unknown }>;
  let answer: (method: string, request: unknown) => unknown;
  let disconnectNextSpawn: boolean;
  let relay: FastifyInstance;
  let restoreHttp: () => void;
  let httpPaths: string[];
  let persistedMetadata: Record<string, unknown>;
  beforeEach(async () => {
    vi.clearAllMocks();
    resetServerFeaturesClientForTests();
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe('/v1/features');
      return Response.json({ features: {}, capabilities: {} });
    }));
    calls = [];
    disconnectNextSpawn = false;
    boundary.spawn.mockResolvedValue({ success: true, sessionId: 'local-session' });
    httpPaths = [];
    persistedMetadata = JSON.parse(session.metadata!);
    relay = Fastify();
    relay.addHook('onRequest', async (request) => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
      httpPaths.push(new URL(request.url, 'http://relay.test').pathname);
    });
    relay.get('/v1/machines/remote', async () => ({ machine }));
    relay.get('/v1/machines', async () => [machine]);
    relay.get('/v1/account/settings', async () => ({ settings: null, settingsVersion: 0 }));
    relay.post<{ Body: { metadata: string; encryptionMode?: 'plain' | 'e2ee' } }>('/v1/sessions', async (request) => {
      const mode = request.body.encryptionMode ?? 'e2ee';
      const decoded: unknown = mode === 'plain' ? JSON.parse(request.body.metadata) : decrypt(key, 'legacy', decodeBase64(request.body.metadata, 'base64'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid metadata at HTTP fixture boundary');
      persistedMetadata = decoded as Record<string, unknown>;
      return { created: true, session: { ...session, metadata: request.body.metadata, encryptionMode: mode } };
    });
    relay.patch<{ Body: { metadata: { ciphertext: string } } }>('/v2/sessions/:sessionId', async (request) => {
      persistedMetadata = JSON.parse(request.body.metadata.ciphertext);
      return { success: true, metadata: { version: 2 } };
    });
    relay.get<{ Params: { sessionId: string } }>('/v2/sessions/:sessionId', async (request) => ({
      session: { ...session, id: request.params.sessionId, metadata: JSON.stringify(persistedMetadata) },
    }));
    await relay.ready();
    restoreHttp = installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin });
    answer = () => ({ type: 'success', sessionId: session.id });
    boundary.io.mockImplementation(() => {
      const events = new EventEmitter();
      return {
        on: events.on.bind(events), off: events.off.bind(events),
        connect: () => events.emit('connect'), disconnect: vi.fn(), close: vi.fn(),
        emit: (event: string, payload: { method: string; params: string; metadata?: string }, ack: (value: unknown) => void) => {
          if (event === 'update-metadata' && typeof payload.metadata === 'string') {
            persistedMetadata = JSON.parse(payload.metadata);
            ack({ result: 'success', version: 2, metadata: payload.metadata });
            return;
          }
          if (event !== SOCKET_RPC_EVENTS.CALL) return;
          const request = decrypt(key, 'legacy', decodeBase64(payload.params, 'base64'));
          calls.push({ method: payload.method, request });
          if (disconnectNextSpawn) {
            disconnectNextSpawn = false;
            events.emit('disconnect');
            return;
          }
          const result = answer(payload.method, request);
          ack(result === null
            ? { ok: false, error: 'Machine method unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
            : { ok: true, result: encodeBase64(encrypt(key, 'legacy', result)) });
        },
      };
    });
  });

  afterEach(async () => {
    resetServerFeaturesClientForTests();
    vi.unstubAllGlobals();
    restoreHttp?.();
    await relay?.close();
  });

  it.each(['session_agent', 'cli'] as const)('persists only the trusted creating session from the %s action without using transcript ancestry', async (surface) => {
    const deps = createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'actual-planner',
      mode: 'plain', ctx: { encryptionKey: key, encryptionVariant: 'legacy' },
      rawSession: { metadata: { path: '/remote-only/repo', host: 'remote', machineId: 'remote', flavor: 'opencode' } },
      getCallerPermissionMode: () => 'read-only',
    });
    const result = await deps.sessionSpawnNew({ surface, agentId: 'opencode', machineId: 'remote', directory: '/remote-only/repo' });
    expect(result).toMatchObject({ type: 'success', sessionId: session.id });
    expect(persistedMetadata.sessionOriginV1).toEqual(surface === 'session_agent' ? { v: 1, kind: 'agent', creatorSessionId: 'actual-planner' } : undefined);
    expect(persistedMetadata).not.toHaveProperty('forkV1');
  });

  it('refuses an explicit role when the target daemon lacks the role-aware spawn method without falling back', async () => {
    answer = (method) => method === `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_ROLE_V1}`
      ? null
      : { type: 'success', sessionId: session.id };
    const deps = createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'actual-planner',
      mode: 'plain', ctx: { encryptionKey: key, encryptionVariant: 'legacy' },
      rawSession: { metadata: { path: '/remote-only/repo', host: 'remote', machineId: 'remote', flavor: 'opencode' } },
      getCallerPermissionMode: () => 'read-only',
    });

    await expect(deps.sessionSpawnNew({
      surface: 'session_agent', agentId: 'opencode', machineId: 'remote',
      directory: '/remote-only/repo', role: 'worker',
    })).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(calls.map((call) => call.method)).toEqual([`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_ROLE_V1}`]);
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(persistedMetadata).not.toHaveProperty('sessionOriginV1');
    expect(persistedMetadata).not.toHaveProperty('sessionRoleV1');
  });

  it.each([['worker', { v: 1, role: 'worker' }], [undefined, undefined]] as const)('forwards only an explicit session-agent role (%s) to the creating daemon', async (role, expected) => {
    const deps = createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'actual-planner',
      mode: 'plain', ctx: { encryptionKey: key, encryptionVariant: 'legacy' },
      rawSession: { metadata: { path: '/remote-only/repo', host: 'remote', machineId: 'remote', flavor: 'opencode',
        sessionRoleV1: { v: 1, role: 'planner' } } },
      getCallerPermissionMode: () => 'read-only',
    });
    const result = await deps.sessionSpawnNew({ surface: 'session_agent', agentId: 'opencode', machineId: 'remote',
      directory: '/remote-only/repo', ...(role ? { role } : {}) });
    expect(result).toMatchObject({ type: 'success', sessionId: session.id });
    const expectedMethod = role
      ? `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_ROLE_V1}`
      : `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`;
    const spawn = calls.find((call) => call.method === expectedMethod);
    const forwarded = (spawn?.request as Record<string, unknown> | undefined)?.sessionRoleV1;
    if (expected) {
      expect(forwarded).toMatchObject({ ...expected, instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.worker });
      expect(typeof (forwarded as { assignmentId?: unknown }).assignmentId).toBe('string');
      expect(persistedMetadata.sessionOriginV1).toEqual({
        v: 1, kind: 'agent', creatorSessionId: 'actual-planner',
      });
    } else {
      expect(forwarded).toBeUndefined();
    }
    // The creator's own role is never inherited.
    expect(persistedMetadata.sessionRoleV1).toBeUndefined();
  });

  it('does not send an explicit role through the legacy local control endpoint when no machine identity is available', async () => {
    await expect(createSpawnedSession({
      credentials,
      directory: '/local/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      sessionRoleV1: {
        v: 1, role: 'worker', instructions: 'Implement this bounded task.',
        assignmentId: 'assignment-local', assignedAt: 1,
      },
    })).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('seeds an explicit role into replay-seeded initial metadata', async () => {
    await createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' }, sessionRoleV1: {
        v: 1, role: 'reviewer', instructions: 'Review this bounded task.',
        assignmentId: 'assignment-replay', assignedAt: 2,
      },
      replaySeededCreation: { tag: 'replay-role', agentId: 'opencode', sourceRecipe: { sourceSessionId: 'transcript-source', cutoffSeqInclusive: 0 },
        metadata: {
          forkV1: { v: 1, parentSessionId: 'transcript-source', parentCutoffSeqInclusive: 0, createdAtMs: 1, strategy: 'replay' },
          replaySeedV1: { v: 1, sourceSessionId: 'transcript-source', sourceCutoffSeqInclusive: 0, createdAtMs: 1, seedText: '' },
        },
      },
    });
    expect(persistedMetadata.sessionRoleV1).toEqual({
      v: 1, role: 'reviewer', instructions: 'Review this bounded task.',
      assignmentId: 'assignment-replay', assignedAt: 2,
    });
  });

  it('preserves provenance on an ordinary rejoin and persists it separately from replay ancestry', async () => {
    const origin = { v: 1 as const, kind: 'agent' as const, creatorSessionId: 'actual-planner' };
    persistedMetadata.sessionOriginV1 = origin;
    await createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' }, title: 'Later title',
      sessionOriginV1: { ...origin, creatorSessionId: 'later-caller' },
    });
    expect(persistedMetadata.sessionOriginV1).toEqual(origin);
    await createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' }, sessionOriginV1: origin,
      replaySeededCreation: { tag: 'replay-fixture', agentId: 'opencode', sourceRecipe: { sourceSessionId: 'transcript-source', cutoffSeqInclusive: 0 },
        metadata: {
          forkV1: { v: 1, parentSessionId: 'transcript-source', parentCutoffSeqInclusive: 0, createdAtMs: 1, strategy: 'replay' },
          replaySeedV1: { v: 1, sourceSessionId: 'transcript-source', sourceCutoffSeqInclusive: 0, createdAtMs: 1, seedText: '' },
        },
      },
    });
    expect(persistedMetadata.sessionOriginV1).toEqual(origin);
    expect(persistedMetadata.forkV1).toMatchObject({ parentSessionId: 'transcript-source' });
  });

  it.each([false, true])('spawns on remote and resolves its nonce without local execution (legacy=%s)', async (legacy) => {
    let resolutions = 0;
    answer = (method) => {
      if (method === `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}` && legacy) return null;
      if (method.endsWith(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE)) {
        return ++resolutions === 1 ? { status: 'pending' } : { status: 'success', sessionId: session.id };
      }
      return { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'remote-attempt' };
    };
    const result = await createSpawnedSession({
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      spawnNonce: 'remote-attempt', permissionMode: 'safe-yolo',
    });
    expect(result).toMatchObject({ sessionId: 'remote-session', session: { host: 'remote', path: '/remote-only/repo' } });
    expect(calls.map((call) => call.method)).toEqual([
      `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`,
      ...(legacy ? [`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION}`] : []),
      `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`,
      `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`,
    ]);
    expect(calls[0]?.request).toMatchObject({ directory: '/remote-only/repo', machineId: 'remote', permissionMode: 'safe-yolo', spawnNonce: 'remote-attempt' });
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(boundary.resolve).not.toHaveBeenCalled();
  });

  it('fails unavailable explicit targets without executing locally or following a replacement', async () => {
    answer = () => null;
    await expect(createSpawnedSession({
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    })).rejects.toMatchObject({ code: 'DAEMON_RPC_UNAVAILABLE' });
    expect(calls.every((call) => call.method.startsWith('remote:'))).toBe(true);
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(new Set(httpPaths)).toEqual(new Set(['/v1/machines/remote']));
  });

  it('accepts a synchronous typed remote response without resolving a nonce', async () => {
    const result = await createSpawnedSession({
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    });
    expect(result.sessionId).toBe(session.id);
    expect(calls.map((call) => call.method)).toEqual([`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`]);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('preserves remote directory approval rather than executing locally', async () => {
    answer = () => ({ type: 'requestToApproveDirectoryCreation', directory: '/remote-only/new' });
    await expect(createSpawnedSession({
      credentials, machineId: 'remote', directory: '/remote-only/new',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    })).rejects.toMatchObject({ code: 'conflict', details: { directory: '/remote-only/new' } });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('preserves the selected daemon rejection and its recovery details', async () => {
    const errorDetail = { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' };
    answer = () => ({
      type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'Selected target refused the launch', errorDetail,
    });
    await expect(createSpawnedSession({
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    })).rejects.toMatchObject({
      code: 'SPAWN_VALIDATION_FAILED', message: 'Selected target refused the launch',
      details: { errorDetail },
    });
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual([`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`]);
  });

  it('keeps implicit local creation on the local control transport', async () => {
    const result = await createSpawnedSession({
      credentials, directory: '/local/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    });
    expect(result.sessionId).toBe('local-session');
    expect(calls).toEqual([]);
    expect(boundary.spawn).toHaveBeenCalledOnce();
  });

  it('retains caller nonce custody after a lost acknowledgement and recovers on the same target', async () => {
    disconnectNextSpawn = true;
    const attempt = {
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'opencode' as const },
      spawnNonce: 'remote-attempt',
    };
    await expect(createSpawnedSession(attempt)).rejects.toMatchObject({ details: { spawnNonce: 'remote-attempt' } });
    answer = () => ({ status: 'success', sessionId: session.id });
    expect((await createSpawnedSession({ ...attempt, resumeOnly: true })).sessionId).toBe(session.id);
    expect(calls.map((call) => call.method)).toEqual([
      `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`,
      `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`,
    ]);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('rejects a blank explicit target rather than choosing the local daemon', async () => {
    await expect(createSpawnedSession({
      credentials, machineId: ' ', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('retains nonce custody when the relay reports forwarding failure without an error code', async () => {
    const createSocket = boundary.io.getMockImplementation()!;
    boundary.io.mockImplementationOnce(() => {
      const socket = createSocket();
      return {
        ...socket,
        emit: (event: string, payload: { method: string; params: string }, ack: (value: unknown) => void) => {
          socket.emit(event, payload, () => ack({ ok: false, error: 'operation has timed out' }));
        },
      };
    });
    const attempt = {
      credentials, machineId: 'remote', directory: '/remote-only/repo',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'opencode' as const },
      spawnNonce: 'remote-forwarding-failure',
    };
    await expect(createSpawnedSession(attempt)).rejects.toMatchObject({
      details: { spawnNonce: attempt.spawnNonce },
    });
    answer = () => ({ status: 'success', sessionId: session.id });
    expect((await createSpawnedSession({ ...attempt, resumeOnly: true })).sessionId).toBe(session.id);
    expect(calls.map((call) => call.method)).toEqual([
      `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`,
      `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`,
    ]);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
});
