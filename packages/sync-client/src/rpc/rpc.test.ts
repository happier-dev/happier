import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { callSocketRpc, emitWithAckCancellable, type SocketRpcAckScope } from './callSocketRpc.js';
import { readRpcRequestDisposition } from './rpcDisposition.js';
import { socketRpcCodec, type SocketRpcContent } from './socketRpcCodec.js';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

function cipher(): SocketRpcContent {
  const key = randomBytes(32);
  return { mode: 'e2ee', cipher: {
    encryptRaw: async (value) => {
      const iv = randomBytes(12);
      const encryptor = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([encryptor.update(JSON.stringify(value)), encryptor.final()]);
      return Buffer.concat([iv, encryptor.getAuthTag(), sealed]).toString('base64');
    },
    decryptRaw: async (value) => {
      const bytes = Buffer.from(value, 'base64');
      const decryptor = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decryptor.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decryptor.update(bytes.subarray(28)), decryptor.final()]).toString());
    },
  } };
}

let server: Server;
let destroy: (() => Promise<void>) | undefined;
async function setup() {
  const http = createServer();
  server = new Server(http, { path: '/v1/updates/', pingInterval: 15_000, pingTimeout: 45_000 });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const socket = io(`http://127.0.0.1:${address.port}`, { path: '/v1/updates/', auth: { token: 't', clientType: 'session-scoped', sessionId: 's' }, forceNew: true, reconnection: false, autoConnect: false });
  destroy = async () => { socket.disconnect(); };
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  return socket;
}
afterEach(async () => {
  vi.useRealTimers();
  await destroy?.();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
it.each(['plain', 'e2ee'] as const)('correlates each ordinary %s issuance without opting into cancellation', async mode => {
  const socket = await setup();
  const content = mode === 'plain' ? { mode: 'plain' } as const : cipher();
  const packets: { traceId?: unknown; requestId?: unknown; timeoutMs?: unknown }[] = [];
  let cancellations = 0;
  server.sockets.sockets.forEach(remote => {
    remote.on('rpc-cancel', () => { cancellations += 1; });
    remote.on('rpc-call', async (packet, acknowledge) => {
      packets.push(packet);
      const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
      acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse(content, { echoed: decoded.params }, decoded.callId) });
    });
  });
  for (const secret of ['private-first', 'private-second']) {
    await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'read',
      params: { secret }, content, timeoutMs: null })).resolves.toEqual({ echoed: { secret } });
  }
  expect(packets).toHaveLength(2);
  const traceIds = packets.map(packet => packet.traceId);
  for (const traceId of traceIds) expect(traceId).toEqual(expect.stringMatching(/^rpc_[A-Za-z0-9_-]+$/));
  expect(new Set(traceIds).size).toBe(2);
  expect(JSON.stringify(traceIds)).not.toContain('private-');
  for (const packet of packets) {
    expect(packet).not.toHaveProperty('requestId');
    expect(packet.timeoutMs).toBeNull();
  }
  expect(cancellations).toBe(0);
});
it.each([undefined, null, 10_000])('settles an expired-heartbeat emit as notSent without retaining or replaying it (%s)', async timeoutMs => {
  const socket = await setup();
  const received: string[] = [];
  const listen = (remote: ServerSocket) => {
    remote.on('rpc-call', (payload: { requestId: string }, ack: (value: string) => void) => {
      received.push(payload.requestId);
      ack(payload.requestId);
    });
    remote.on('rpc-cancel', () => { received.push('cancel'); });
  };
  server.sockets.sockets.forEach(listen);
  server.on('connection', listen);
  await expect(emitWithAckCancellable({ socket, event: 'rpc-call', payload: { requestId: 'healthy' } })).resolves.toBe('healthy');
  const disconnected = new Promise<string>(resolve => socket.once('disconnect', resolve));
  const controller = new AbortController();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
  let failure: unknown;
  const pending = emitWithAckCancellable({ socket, event: 'rpc-call', payload: { requestId: 'expired' },
    requestId: 'expired', signal: controller.signal, timeoutMs,
  }).catch((error: unknown) => { failure = error; });
  clock.mockRestore();
  try {
    // One event-loop turn observes prompt settlement without imposing an RPC budget.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readRpcErrorCode(failure)).toBe(RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
    expect(readRpcRequestDisposition(failure)).toBe('notSent');
    expect(socket.sendBuffer).toEqual([]);
    expect(socket).toHaveProperty('acks', {});
    expect(await disconnected).toBe('ping timeout');
    controller.abort();
    await pending;
    expect(socket.sendBuffer).toEqual([]);
    expect(socket).toHaveProperty('acks', {});
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
    });
    await expect(emitWithAckCancellable({ socket, event: 'rpc-call', payload: { requestId: 'fresh' } })).resolves.toBe('fresh');
    expect(received).toEqual(['healthy', 'fresh']);
  } finally {
    controller.abort();
    await pending;
  }
});
it('fails closed against a relay without answering-client routing instead of delivering to an arbitrary app', async () => {
  const socket = await setup();
  let effects = 0;
  // A predecessor relay resolves only registered method names. It cannot
  // ignore a selector and run the incumbent unqualified handler by accident.
  server.sockets.sockets.forEach(remote => remote.once('rpc-call', (payload, ack) => {
    if (payload.method === `m:${RPC_METHODS.UI_ACTION_EXECUTE}`) {
      effects++;
      ack({ ok: true, result: 'wrong-device' });
    } else ack({ ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
  }));
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: RPC_METHODS.UI_ACTION_EXECUTE,
    params: {}, content: { mode: 'plain' }, answeringClient: { clientId: 'app-b', requireSingle: true } }))
    .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
  expect(effects).toBe(0);
});
it('classifies a disconnected Goal caller and allows a fresh call after reconnection without replaying the mutation', async () => {
  const socket = await setup();
  const requests: string[] = [];
  server.on('connection', remote => remote.on('rpc-call', (payload, ack) => {
    requests.push(payload.method);
    ack({ ok: true, result: { workState: null } });
  }));
  server.sockets.sockets.forEach(remote => remote.once('rpc-call', payload => {
    requests.push(payload.method);
    remote.disconnect(true);
  }));
  const error = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' },
    method: RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2, params: { sessionId: 's', objective: 'Keep going', resumeInactiveWithInitialGoal: true },
    content: { mode: 'plain' }, timeoutMs: null }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
  expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' },
    method: RPC_METHODS.DAEMON_SESSION_GOAL_GET, params: { sessionId: 's' },
    content: { mode: 'plain' }, timeoutMs: null })).resolves.toEqual({ workState: null });
  expect(requests).toEqual([`m:${RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2}`, `m:${RPC_METHODS.DAEMON_SESSION_GOAL_GET}`]);
});
it.each([
  { method: RPC_METHODS.MACHINES_VITALS_GET, targetKind: 'machine', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE },
  { method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, targetKind: 'session', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE },
  { method: RPC_METHODS.STOP_SESSION, targetKind: 'machine', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN },
  { method: 'plugin.unclassified.read', targetKind: 'machine', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN },
] as const)(
  'settles issued $method on disconnect before its deadline without replay', async ({ method, targetKind, errorCode }) => {
  const socket = await setup();
  const requests: string[] = [];
  let observeIssued!: () => void;
  const issued = new Promise<void>(resolve => { observeIssued = resolve; });
  server.sockets.sockets.forEach(remote => remote.on('rpc-call', packet => {
    requests.push(packet.requestId);
    observeIssued();
  }));
  let failure: unknown;
  const pending = callSocketRpc({ socket, target: { kind: targetKind, id: 'm' }, method,
    params: {}, content: { mode: 'plain' }, timeoutMs: 180_000, requestId: 'original-issued-call' })
    .catch((error: unknown) => { failure = error; });
  await issued;
  socket.disconnect();
  // An event-loop turn is the disconnect settlement barrier, not a shorter RPC timer.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(readRpcErrorCode(failure)).toBe(errorCode);
  // The transport must not rewrite an issued request into a pre-effect refusal.
  expect(readRpcRequestDisposition(failure)).toBe('outcomeUnknown');
  await pending;
  expect(requests).toEqual(['original-issued-call']);
  expect(socket).toHaveProperty('acks', {});
});
it('classifies a disconnect during request preparation before issuance and permits a fresh plugin read after reconnect', async () => {
  const socket = await setup();
  const content = cipher();
  if (content.mode !== 'e2ee') throw new Error('Expected encrypted transport');
  let prepared!: () => void;
  const preparing = new Promise<void>(resolve => { prepared = resolve; });
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  const delayedContent: SocketRpcContent = { mode: 'e2ee', cipher: {
    ...content.cipher,
    encryptRaw: async value => { prepared(); await preparation; return await content.cipher.encryptRaw(value); },
  } };
  let issued = false;
  const pending = callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'plugin.example.read',
    params: {}, content: delayedContent, onIssued: () => { issued = true; } })
    .catch((failure: unknown) => failure);
  await preparing;
  socket.disconnect();
  finishPreparation();
  const failure = await pending;
  expect(readRpcErrorCode(failure)).toBe(RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
  expect(readRpcRequestDisposition(failure)).toBe('notSent');
  expect(issued).toBe(false);

  const requests: string[] = [];
  server.on('connection', remote => remote.on('rpc-call', async (packet, ack) => {
    requests.push(packet.method);
    const request = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
    ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, { ready: true }, request.callId) });
  }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'plugin.example.read',
    params: {}, content })).resolves.toEqual({ ready: true });
  expect(requests).toEqual(['m:plugin.example.read']);
});
it.each([undefined, null, 180_000])('carries the caller deadline intent across real Socket.IO (%s)', async timeoutMs => {
  const socket = await setup();
  const received = new Promise<Record<string, unknown>>(resolve => server.sockets.sockets.forEach(remote => {
    remote.once('rpc-call', (payload, ack) => {
      resolve(payload);
      ack({ ok: true, result: { accepted: true } });
    });
  }));
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'read', params: {},
    content: { mode: 'plain' }, timeoutMs })).resolves.toEqual({ accepted: true });
  if (timeoutMs === undefined) expect(await received).not.toHaveProperty('timeoutMs');
  else expect(await received).toHaveProperty('timeoutMs', timeoutMs);
});
it('rejects malformed authored deadlines before submitting them over Socket.IO', async () => {
  const socket = await setup();
  let requests = 0;
  server.sockets.sockets.forEach(remote => remote.on('rpc-call', (_payload, ack) => {
    requests += 1;
    ack({ ok: true, result: { accepted: true } });
  }));
  for (const timeoutMs of [-1, Number.POSITIVE_INFINITY]) {
    await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'read', params: {},
      content: { mode: 'plain' }, timeoutMs })).rejects.toThrow();
  }
  expect(requests).toBe(0);
});
it('accepts a delayed real Socket.IO acknowledgement for a deadline beyond its native timer range', async () => {
  const socket = await setup();
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', (_payload, ack) => {
    setTimeout(() => ack({ ok: true, result: { status: 'success', sessionId: 'long-spawn' } }), 30);
  }));
  const result = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' },
    method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, params: { spawnNonce: 'long-spawn' },
    content: { mode: 'plain' }, timeoutMs: 30 * 24 * 60 * 60_000,
  }).catch((error: unknown) => error);
  expect(result).toEqual({ status: 'success', sessionId: 'long-spawn' });
});

it('keeps a long acknowledgement deadline through timer chunks and cancels only its issued occurrence', async () => {
  vi.useFakeTimers();
  // The transport does not deliver an ACK; the real host cancellation/deadline logic owns settlement.
  const cancelled: unknown[] = [];
  const socket = {
    connected: true,
    emit: (event: string, payload: unknown) => { if (event === 'rpc-cancel') cancelled.push(payload); },
    emitWithAck: () => new Promise<unknown>(() => {}),
  };
  const timeoutMs = 30 * 24 * 60 * 60_000;
  let settled = false;
  const wait = emitWithAckCancellable({ socket, event: 'rpc-call', payload: {}, timeoutMs })
    .catch((error: unknown) => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(timeoutMs - 2_147_483_647);
  expect(await wait).toMatchObject({ message: 'operation has timed out' });
  expect(readRpcRequestDisposition(await wait)).toBe('outcomeUnknown');

  const controller = new AbortController();
  const stopped = emitWithAckCancellable({ socket, event: 'rpc-call', payload: {}, timeoutMs,
    signal: controller.signal, requestId: 'rpc-long-cancel',
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  controller.abort();
  expect(await stopped).toMatchObject({ name: 'AbortError', code: 'SOCKET_RPC_ABORTED' });
  expect(cancelled).toEqual([{ requestId: 'rpc-long-cancel' }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves the raw callback acknowledgement convention when a long deadline bypasses the native scope', async () => {
  const response = { status: 'success', sessionId: 'callback-spawn' };
  // Socket.IO uses (error, value) in its timeout scope, but (value) on the raw socket.
  const socket = {
    emit: (_event: string, _payload: unknown, ack: (value: unknown) => void) => ack(response),
    timeout: () => ({
      emit: (_event: string, _payload: unknown, ack: (error: unknown, value: unknown) => void) => ack(null, response),
    }),
  };
  await expect(emitWithAckCancellable({ socket, event: 'rpc-call', payload: {}, timeoutMs: 30 * 24 * 60 * 60_000 }))
    .resolves.toEqual(response);
});
it('issues prefixed RPC with session-write authority and decodes the ack', async () => {
  const socket = await setup();
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', (payload, ack) => {
    expect(payload).toMatchObject({ method: 's:abort', params: { reason: 'test' }, authorization: { kind: 'session.write', sessionId: 's' } });
    ack({ ok: true, result: { stopped: true } });
  }));
  expect(await callSocketRpc({ socket, target: { kind: 'session', id: 's' }, method: 'abort', params: { reason: 'test' }, content: { mode: 'plain' } })).toEqual({ stopped: true });
});
it('records an acknowledgement before delayed result decoding completes', async () => {
  const socket = await setup();
  server.sockets.sockets.forEach(remote => remote.on('rpc-call', (_payload, ack) => {
    ack({ ok: true, result: 'encrypted-result' });
  }));
  let received = false;
  let decoding = false;
  let release!: () => void;
  const decoded = new Promise<void>(resolve => { release = resolve; });
  const content: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async () => 'encrypted-request',
    decryptRaw: async () => { decoding = true; await decoded;
      return { v: 2, k: 'res', c: '00'.repeat(16), r: { accepted: true } }; },
  } };
  const pending = callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'read',
    params: {}, content, randomBytes: length => new Uint8Array(length), onResponse: () => { received = true; } });
  try {
    await vi.waitFor(() => expect(decoding).toBe(true));
    expect(received).toBe(true);
  } finally { release(); }
  await expect(pending).resolves.toEqual({ accepted: true });
});
it.each(['session.notes.set', 'session.user_action.answer', 'session.needs_you.raise'])(
  'preserves explicit Session Action authorization for %s rather than projecting it to a human write', async (method) => {
  const socket = await setup();
  const authorization = { kind: 'session.action' as const, sessionId: 's', origin: {
    v: 1 as const, caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 4 },
    callerPermissionMode: 'read-only' as const, sourceTurnId: 'turn-original', requestId: 'action-original', workspaceWrites: 'deny' as const,
  } };
  const received = new Promise<unknown>((resolve) => server.sockets.sockets.forEach((remote) => remote.once('rpc-call', (payload, ack) => {
    resolve(payload.authorization);
    ack({ ok: true, result: { updated: true } });
  })));
  await callSocketRpc({ socket, target: { kind: 'session', id: 's' }, method,
    params: { sessionId: 's', notes: 'private' }, content: { mode: 'plain' },
    authorization,
  });
  expect(await received).toEqual(authorization);
});
it('fails a mismatched Session Action origin before issue and never retries a rejected Home arm', async () => {
  const socket = await setup();
  const authorization = { kind: 'session.action' as const, sessionId: 'other', origin: {
    v: 1 as const, caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 4 },
    callerPermissionMode: null, sourceTurnId: 'turn-original', requestId: 'action-original',
  } };
  const requests: unknown[] = [];
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', (payload, ack) => {
    requests.push(payload.authorization);
    ack({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
  }));
  const call = (origin: typeof authorization) => callSocketRpc({ socket, target: { kind: 'session' as const, id: 's' },
    method: 'session.notes.set', params: { sessionId: 's', notes: 'private' }, content: { mode: 'plain' }, authorization: origin,
  });
  const mismatch = await call(authorization).catch((error: unknown) => error);
  expect(readRpcRequestDisposition(mismatch)).toBe('notSent');
  expect(requests).toEqual([]);
  const rejected = await call({ ...authorization, sessionId: 's' }).catch((error: unknown) => error);
  expect(rejected).toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
  expect(readRpcRequestDisposition(rejected)).toBe('notSent');
  expect(requests).toEqual([{ ...authorization, sessionId: 's' }]);
});
it.each(['spawn', RPC_METHODS.MACHINES_VITALS_GET])('preserves an explicitly uncertain relay acknowledgement for %s as outcomeUnknown', async method => {
  const socket = await setup();
  server.sockets.sockets.forEach(remote => remote.once('rpc-call', (_payload, ack) => {
    // A relay's error prose is not a local native disconnect observation.
    ack({ ok: false, error: 'socket has been disconnected', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
  }));
  const error = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method,
    params: {}, content: { mode: 'plain' } }).catch((error: unknown) => error);
  expect(readRpcErrorCode(error)).toBe(RPC_ERROR_CODES.OUTCOME_UNKNOWN);
  expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
});
it('distinguishes an unsealed pre-execution refusal from response decryption failure', async () => {
  const socket = await setup();
  const responses = [
    { error: 'Request binding unavailable', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
    'invalid-encrypted-response',
  ];
  server.sockets.sockets.forEach(remote => remote.on('rpc-call', (_payload, ack) => {
    ack({ ok: true, result: responses.shift() });
  }));
  const content = cipher();
  const invoke = () => callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'spawn', params: {}, content })
    .catch((error: unknown) => error);
  const refusal = await invoke();
  const undecodable = await invoke();
  expect(refusal).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  expect(undecodable).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
  expect(readRpcRequestDisposition(refusal)).toBe('notSent');
  expect(readRpcRequestDisposition(undecodable)).toBe('outcomeUnknown');
});
it.each(['reply', 'disconnect'] as const)('retains an issued native ACK after local cancellation until %s', async outcome => {
  const socket = await setup();
  let acknowledge!: (value: unknown) => void;
  let observeIssued!: () => void;
  const issued = new Promise<void>(resolve => { observeIssued = resolve; });
  server.sockets.sockets.forEach(remote => remote.on('rpc-call', (_payload, ack) => {
    acknowledge = ack;
    observeIssued();
  }));
  let uses = 0;
  // This lease is the resource boundary; the real native socket still owns its
  // timeout scope, buffering, cancellation packet and acknowledgement promise.
  const lease = {
    get connected() { return socket.connected; },
    timeout: socket.timeout.bind(socket),
    emit: socket.emit.bind(socket),
    retain: () => {
      uses += 1;
      return () => { uses -= 1; };
    },
  };
  const controller = new AbortController();
  const pending = emitWithAckCancellable({ socket: lease, event: 'rpc-call', payload: {},
    requestId: 'retained-ack', signal: controller.signal, timeoutMs: null }).catch((error: unknown) => error);
  await issued;
  expect(uses).toBe(1);
  controller.abort();
  const failure = await pending;
  expect(failure).toMatchObject({ code: 'SOCKET_RPC_ABORTED' });
  expect(readRpcRequestDisposition(failure)).toBe('outcomeUnknown');
  expect(uses).toBe(1);
  if (outcome === 'reply') acknowledge({ ok: true });
  else socket.disconnect();
  await vi.waitFor(() => { expect(uses).toBe(0); });
});
it('cancels an issued call and marks the unresolved outcome', async () => {
  const socket = await setup();
  const controller = new AbortController();
  const cancelled = new Promise<{ requestId: string }>((resolve) => server.sockets.sockets.forEach((remote) => {
    remote.once('rpc-call', (payload) => {
      remote.once('rpc-cancel', (cancel) => { expect(cancel.requestId).toBe(payload.requestId); resolve(cancel); });
      controller.abort();
    });
  }));
  const outcome = callSocketRpc({ socket, target: { kind: 'session', id: 's' }, method: 'abort', params: {}, content: { mode: 'plain' }, signal: controller.signal });
  const error = await outcome.catch((error: unknown) => error);
  expect(error).toMatchObject({ name: 'AbortError', code: 'SOCKET_RPC_ABORTED' });
  expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
  expect((await cancelled).requestId).toMatch(/^rpc_/);
});
it.each([null, 10_000])('retains the issued acknowledgement after opt-in cancellation (%s)', async timeoutMs => {
  const socket = await setup();
  const controller = new AbortController();
  const partial = { ok: true, results: [{ path: 'a.txt', status: 'replaced', edits: [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }] }], cancelled: ['b.txt'] };
  const cancelled = new Promise<void>(resolve => server.sockets.sockets.forEach(remote => remote.once('rpc-call', (payload, ack) => {
    expect(payload.waitForResultOnCancel).toBe(true);
    remote.once('rpc-cancel', cancel => {
      expect(cancel.requestId).toBe(payload.requestId);
      ack({ ok: true, result: partial });
      resolve();
    });
    controller.abort();
  })));
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY,
    params: {}, content: { mode: 'plain' }, signal: controller.signal, timeoutMs, waitForResultOnCancel: true }))
    .resolves.toEqual(partial);
  await cancelled;
});
it.each(['deadline', 'disconnect'] as const)('retains the original %s after cooperative cancellation', async failure => {
  const socket = await setup();
  const controller = new AbortController();
  server.sockets.sockets.forEach(remote => remote.once('rpc-call', payload => {
    remote.once('rpc-cancel', cancel => {
      expect(cancel.requestId).toBe(payload.requestId);
      if (failure === 'disconnect') remote.disconnect(true);
    });
    controller.abort();
  }));
  const error = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'replace',
    params: {}, content: { mode: 'plain' }, signal: controller.signal, timeoutMs: failure === 'deadline' ? 100 : null,
    waitForResultOnCancel: true }).catch((error: unknown) => error);
  expect(error).toMatchObject(failure === 'deadline' ? { message: 'operation has timed out' } : { rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
  expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
});
it('does not issue an opted-in call when already aborted', async () => {
  const controller = new AbortController(); controller.abort();
  const events: string[] = [];
  const socket = { emit: (event: string) => { events.push(event); }, emitWithAck: async () => { events.push('rpc-call'); return {}; } };
  const error = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'replace',
    params: {}, content: { mode: 'plain' }, signal: controller.signal, waitForResultOnCancel: true }).catch((error: unknown) => error);
  expect(error).toMatchObject({ name: 'AbortError' });
  expect(readRpcRequestDisposition(error)).toBe('notSent');
  expect(events).toEqual([]);
});
it('rejects before issue as notSent and exposes ack timeout after issue', async () => {
  const socket = await setup();
  const controller = new AbortController();
  controller.abort();
  const before = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'test', params: {}, content: { mode: 'plain' }, signal: controller.signal }).catch((error: unknown) => error);
  expect(readRpcRequestDisposition(before)).toBe('notSent');
  const timeout = await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'test', params: {}, content: { mode: 'plain' }, timeoutMs: 20 }).catch((error: unknown) => error);
  expect(timeout).toMatchObject({ message: 'operation has timed out' });
  expect(readRpcRequestDisposition(timeout)).toBe('outcomeUnknown');
});
it('roundtrips encrypted caller and responder codecs over the relay', async () => {
  const socket = await setup();
  const content = cipher();
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', async (payload, ack) => {
    expect(typeof payload.params).toBe('string');
    const request = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
    expect(request.callId).toMatch(/^[0-9a-f]{32}$/);
    expect(request.callId).not.toBe(payload.requestId);
    ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, { request: request.params }, request.callId) });
  }));
  expect(await callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'echo', params: { text: 'secret' }, content,
    requestId: 'relay-transport-id' })).toEqual({ request: { text: 'secret' } });
});
it('rejects a response from another call even with an authentic encrypted result', async () => {
  const socket = await setup();
  const content = cipher();
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', async (_payload, ack) => {
    ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, { deleted: true }, 'abcdef0123456789abcdef0123456789') });
  }));
  await expect(callSocketRpc({ socket, target: { kind: 'machine', id: 'm' }, method: 'statFile', params: { path: 'keep.txt' }, content }))
    .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
});
it('keeps attachment routing visible while sealing attachment input and output', async () => {
  const socket = await setup();
  const content = cipher();
  const transferRouting = { method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, t: 'session_attachment_upload_v1' as const, sessionId: 's' };
  server.sockets.sockets.forEach((remote) => remote.on('rpc-call', async (payload, ack) => {
    expect(payload.transferRouting).toEqual(transferRouting);
    expect(typeof payload.params).toBe('string');
    expect(JSON.stringify(payload)).not.toContain('private-file.txt');
    const request = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
    ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, { request: request.params }, request.callId) });
  }));
  expect(await callSocketRpc({ socket, target: { kind: 'session', id: 's' },
    method: transferRouting.method, transferRouting,
    params: { t: transferRouting.t, sessionId: 's', fileName: 'private-file.txt' }, content,
  })).toEqual({ request: { t: transferRouting.t, sessionId: 's', fileName: 'private-file.txt' } });
});
it('prepares the acknowledgement scope before signaling issuance and retains its receiver', async () => {
  const trace: string[] = [];
  // A Socket.IO-compatible network boundary whose methods require their receiver.
  class SocketBoundary {
    connected = true;
    emit(_event: string, _payload: unknown, ack: (value: unknown) => void) { trace.push('emit'); ack({ ok: true }); }
    timeout(): SocketRpcAckScope { trace.push('prepare'); return this; }
    emitWithAck(event: string, payload: unknown): Promise<unknown> {
      return new Promise((resolve) => this.emit(event, payload, resolve));
    }
  }
  expect(await emitWithAckCancellable({ socket: new SocketBoundary(), event: 'rpc-call', payload: {}, timeoutMs: 100,
    onIssued: () => { trace.push('issued'); },
  })).toEqual({ ok: true });
  expect(trace).toEqual(['prepare', 'issued', 'emit']);
});
it('does not signal issuance or send cancellation when acknowledgement preparation fails', async () => {
  const trace: string[] = [];
  const controller = new AbortController();
  const preparationError = new Error('Acknowledgement scope unavailable');
  // Failure belongs to the Socket.IO boundary, before any RPC is emitted.
  const socket = {
    connected: true,
    emit: (event: string) => { trace.push(event); },
    timeout: (): SocketRpcAckScope => { trace.push('prepare'); throw preparationError; },
  };
  const error = await emitWithAckCancellable({ socket, event: 'rpc-call', payload: {}, timeoutMs: 100,
    signal: controller.signal, requestId: 'rpc_preparation', onIssued: () => { trace.push('issued'); },
  }).catch((failure: unknown) => failure);
  controller.abort();
  expect(error).toBe(preparationError);
  expect(readRpcRequestDisposition(error)).toBe('notSent');
  expect(trace).toEqual(['prepare']);
});
it('preserves an authenticated undefined response and outer relay errors', async () => {
  const content = cipher();
  const callId = '0123456789abcdef0123456789abcdef';
  const result = await socketRpcCodec.encodeResponse(content, undefined, callId);
  expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId)).toBeUndefined();
  await expect(socketRpcCodec.decodeResult(content, { ok: false, error: 'denied', errorCode: 'FORBIDDEN' }, callId)).rejects.toMatchObject({ rpcErrorCode: 'FORBIDDEN' });
});
it('preserves authenticated serialized undefined request params', async () => {
  const content = cipher();
  const binding = { method: 'machine:echo', callId: '0123456789abcdef0123456789abcdef' };
  const result = await socketRpcCodec.encodeParams(content, undefined, binding);
  expect(await socketRpcCodec.decodeRequestParams(content, result, binding.method)).toEqual({ params: undefined, callId: binding.callId });
});
