import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const boundary = vi.hoisted(() => ({ get: vi.fn(), spawn: vi.fn(), resolve: vi.fn(), io: vi.fn() }));
// HTTP, local daemon control, and Socket.IO are the actual process/network boundaries.
vi.mock('axios', () => ({ default: { get: boundary.get } }));
vi.mock('socket.io-client', () => ({ io: boundary.io }));
vi.mock('@/daemon/controlClient', async (original) => ({
  ...await original<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession: boundary.spawn,
  resolveDaemonSpawnSessionByNonce: boundary.resolve,
}));

import { createSpawnedSession } from './createSpawnedSession';

const key = new Uint8Array(32).fill(7);
const credentials: Credentials = { token: 'account-token', encryption: { type: 'legacy', secret: key } };
const session = {
  id: 'remote-session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
  encryptionMode: 'plain', metadata: JSON.stringify({ path: '/remote-only/repo', host: 'remote', machineId: 'remote' }),
  metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
};

describe('createSpawnedSession exact remote routing', () => {
  let calls: Array<{ method: string; request: unknown }>;
  let answer: (method: string, request: unknown) => unknown;
  let disconnectNextSpawn: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    disconnectNextSpawn = false;
    boundary.spawn.mockResolvedValue({ success: true, sessionId: 'local-session' });
    boundary.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/machines/remote')) {
        return { status: 200, data: { machine: { id: 'remote', dataEncryptionKey: null } } };
      }
      if (url.endsWith('/v1/machines')) {
        return { status: 200, data: [{ id: 'remote', replacedByMachineId: 'local' }] };
      }
      return { status: 200, data: { session } };
    });
    answer = () => ({ type: 'success', sessionId: session.id });
    boundary.io.mockImplementation(() => {
      const events = new EventEmitter();
      return {
        on: events.on.bind(events), off: events.off.bind(events),
        connect: () => events.emit('connect'), disconnect: vi.fn(), close: vi.fn(),
        emit: (event: string, payload: { method: string; params: string }, ack: (value: unknown) => void) => {
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
    expect(boundary.get.mock.calls.every(([url]) => String(url).endsWith('/v1/machines/remote'))).toBe(true);
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
