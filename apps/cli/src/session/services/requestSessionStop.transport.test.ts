import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Console } from 'node:console';
import axios from 'axios';
import { encodeBase64, encrypt } from '@/api/encryption';
import { requestSessionStop } from './requestSessionStop';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const boundary = vi.hoisted(() => ({ socket: null as unknown, mode: 'timeout' }));
vi.mock('socket.io-client', () => ({ io: () => boundary.socket }));

describe('requestSessionStop machine transport', () => {
  const sessionId = 'cmuo0nwxt11bptmszygswp8g3';
  const secret = new Uint8Array(32).fill(1);
  const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret } };
  let calls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    // Only the network adapters are replaced; resolution, encryption, request disposition,
    // and Stop outcome classification all execute through their production owners.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/machines/owning-machine')) {
        return { status: 200, data: { machine: { id: 'owning-machine', dataEncryptionKey: null } } };
      }
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [] };
      return { status: 200, data: { session: {
        id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
        metadata: encodeBase64(encrypt(secret, 'legacy', { machineId: 'owning-machine' })),
        metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        machineId: 'owning-machine',
      } } };
    });
    const events = new EventEmitter();
    boundary.socket = {
      on: events.on.bind(events), off: events.off.bind(events),
      connect: () => boundary.mode === 'connect_error'
        ? events.emit('connect_error', new Error('Connection refused'))
        : events.emit('connect'),
      disconnect: () => undefined, close: () => undefined,
      emit: (event: string, _payload: unknown, callback?: (response: unknown) => void) => {
        calls.push(event);
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        if (boundary.mode === 'disconnect') events.emit('disconnect', 'transport close');
        if (boundary.mode === 'forbidden') callback?.({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
        if (boundary.mode === 'unavailable') callback?.({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        if (boundary.mode === 'slow_stop') setTimeout(() => callback?.({ ok: true,
          result: encodeBase64(encrypt(secret, 'legacy', { status: 'stopped' })),
        }), 22_410);
        // The finite relay forwarding deadline owns a request whose handler does not settle.
        if (boundary.mode === 'timeout') setTimeout(() => callback?.({ ok: false, error: 'RPC call timeout' }), 30_000);
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['timeout', 'disconnect'])('preserves ambiguous %s after emission even when session metadata is inactive', async (mode) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // Vitest buffers console.log; route it through the real Node console to observe
    // the stdout boundary without replacing the production logger.
    const nodeConsole = new Console(process.stdout, process.stderr);
    vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    boundary.mode = mode;
    const result = requestSessionStop({ credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(result).resolves.toEqual({
      ok: true, sessionId, stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('waits for a physical Stop acknowledgement beyond the generic machine RPC cutoff', async () => {
    boundary.mode = 'slow_stop';
    let settled = false;
    const result = requestSessionStop({ credentials, idOrPrefix: sessionId })
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false);
    expect(calls).not.toContain(SOCKET_RPC_EVENTS.CANCEL);
    await vi.advanceTimersByTimeAsync(2_410);
    await expect(result).resolves.toEqual({ ok: true, sessionId, stopped: true });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('retains a definitive authorization refusal', async () => {
    boundary.mode = 'forbidden';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_forbidden' },
    });
  });

  it('retains a definitive unavailable-target response', async () => {
    boundary.mode = 'unavailable';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
  });

  it('reports unavailable before emission without issuing Stop', async () => {
    boundary.mode = 'connect_error';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
    expect(calls).toEqual([]);
  });
});
