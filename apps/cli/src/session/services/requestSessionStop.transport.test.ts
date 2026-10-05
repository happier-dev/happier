import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Console } from 'node:console';
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { requestSessionStop } from './requestSessionStop';
import { cleanupForkChildBestEffort } from '@/session/actions/lifecycle/fork/forkChildSessionRecovery';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const boundary = vi.hoisted(() => ({ socket: null as unknown, mode: 'timeout' }));
vi.mock('socket.io-client', () => ({ io: () => boundary.socket }));

describe('requestSessionStop machine transport', () => {
  const sessionId = 'cmuo0nwxt11bptmszygswp8g3';
  const secret = new Uint8Array(32).fill(1);
  const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret } };
  const content: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async (value) => encodeBase64(encrypt(secret, 'legacy', value)),
    decryptRaw: async (value) => decrypt(secret, 'legacy', decodeBase64(value)),
  } };
  let calls: string[];
  let events: EventEmitter;
  let forwardedTimeout: unknown;
  let active = false;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    active = false;
    forwardedTimeout = undefined;
    // Only the network adapters are replaced; resolution, encryption, request disposition,
    // and Stop outcome classification all execute through their production owners.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).includes('/v1/machines/')) return { status: 200, data: { machine: { id: 'owning-machine' } } };
      return { status: 200, data: { session: {
        id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active, activeAt: 0,
        metadata: encodeBase64(encrypt(secret, 'legacy', { machineId: 'owning-machine' })),
        metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        machineId: 'owning-machine',
      } } };
    });
    events = new EventEmitter();
    const pendingAcks = new Set<(error: Error) => void>();
    events.on('disconnect', () => {
      for (const reject of pendingAcks) reject(new Error('socket has been disconnected'));
      pendingAcks.clear();
    });
    const emit = async (event: string, payload: unknown, callback?: (response: unknown) => void) => {
      calls.push(event);
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      forwardedTimeout = (payload as { timeoutMs?: unknown }).timeoutMs;
      const request = payload as { method: string; params: unknown };
      const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
      const stopped = { ok: true, result: await socketRpcCodec.encodeResponse(content, { status: 'stopped' }, decoded.callId) };
      if (boundary.mode === 'slow_stop') setTimeout(() => callback?.(stopped), 22_410);
      // Mirror the relay's existing finite forwarding deadline, not a caller-owned timer.
      if (boundary.mode === 'timeout') setTimeout(() => callback?.({ ok: false, error: 'RPC call timeout' }), 30_000);
      if (boundary.mode === 'stopped') callback?.(stopped);
      if (boundary.mode === 'disconnect') events.emit('disconnect', 'transport close');
      if (boundary.mode === 'forbidden') callback?.({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
      if (boundary.mode === 'unavailable') callback?.({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    };
    boundary.socket = {
      io: { timeout: () => {}, on: () => {}, off: () => {} },
      on: events.on.bind(events), off: events.off.bind(events),
      connect: () => boundary.mode === 'connect_error'
        ? events.emit('connect_error', new Error('Connection refused'))
        : events.emit('connect'),
      disconnect: () => undefined, close: () => undefined,
      emit,
      // Socket.IO promise acknowledgements reject on disconnect even without an ack timer.
      emitWithAck: (event: string, payload: unknown) => new Promise((resolve, reject) => {
        pendingAcks.add(reject);
        void emit(event, payload, (response) => { pendingAcks.delete(reject); resolve(response); }).catch(reject);
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits for inactive evidence without quiet rereads and catches it on reconnect', async () => {
    boundary.mode = 'stopped';
    active = true;
    const result = requestSessionStop({ credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.mocked(axios.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(reads);
    active = false;
    events.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toMatchObject({ ok: true, sessionId, stopped: true });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
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

  it.each(['public', 'fork_cleanup'])('accepts a bounded %s Stop acknowledgement after the generic caller cutoff', async (entrypoint) => {
    boundary.mode = 'slow_stop';
    let settled = false;
    let fallbackUsed = false;
    const operation = entrypoint === 'public'
      ? requestSessionStop({ credentials, idOrPrefix: sessionId })
      : cleanupForkChildBestEffort({ credentials, sessionId, fallbackStopSession: async () => {
        fallbackUsed = true;
        return true;
      } });
    const result = operation.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false);
    expect(calls).not.toContain(SOCKET_RPC_EVENTS.CANCEL);
    expect(forwardedTimeout).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_410);
    if (entrypoint === 'public') await expect(result).resolves.toMatchObject({ ok: true, sessionId, stopped: true });
    else await expect(result).resolves.toBeUndefined();
    expect(fallbackUsed).toBe(false);
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('retains a definitive authorization refusal', async () => {
    boundary.mode = 'forbidden';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
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
