import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import tweetnacl from 'tweetnacl';
import { decrypt, decodeBase64, encrypt, encodeBase64 } from '@/api/encryption';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { API_TOKEN_FULL_GRANT_V1, verifyExternalActionMachineRpcRequestV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { io } from 'socket.io-client';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

let nextRpcAck: any = null;
let nextSocket: FakeSocket | null = null;
let configureNextSocket: ((socket: FakeSocket) => void) | null = null;

class FakeSocket {
  public io = createSocketIoManagerStub();
  public connected = false;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  public emitted: Array<{ event: string; data: any }> = [];
  public onEmit: (() => void) | null = null;
  public connectError: Error | null = null;
  public disconnectAfterConnect = false;
  public rejectAcksOnDisconnect = true;
  public emitError: Error | null = null;
  public ackMode: 'sync' | 'never' = 'sync';
  public delayedAck: ((payload: unknown) => void) | null = null;
  public disconnectCalls = 0;
  public closeCalls = 0;
  private pendingAcks = new Set<(error: Error) => void>();

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((item) => item !== handler));
    return this;
  }

  removeListener(event: string, handler: (...args: any[]) => void) {
    return this.off(event, handler);
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.length ?? 0;
  }

  trigger(event: string, ...args: any[]) {
    if (event === 'disconnect') {
      this.connected = false;
      if (this.rejectAcksOnDisconnect) {
        for (const reject of this.pendingAcks) reject(new Error('RPC socket disconnected before acknowledgement'));
      }
      this.pendingAcks.clear();
    }
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  connect() {
    if (this.connectError) {
      for (const handler of this.handlers.get('connect_error') ?? []) {
        handler(this.connectError);
      }
      return this;
    }
    this.connected = true;
    for (const handler of this.handlers.get('connect') ?? []) {
      handler();
    }
    if (this.disconnectAfterConnect) {
      this.connected = false;
      this.trigger('disconnect', 'transport close');
    }
    return this;
  }

  emit(event: string, data: any, callback?: (payload: any) => void) {
    if (this.emitError) {
      throw this.emitError;
    }
    this.emitted.push({ event, data });
    this.onEmit?.();
    if (this.ackMode === 'never') {
      this.delayedAck = callback ?? null;
      return this;
    }
    if (typeof nextRpcAck === 'function') {
      void Promise.resolve(nextRpcAck(data)).then(callback);
    } else callback?.(nextRpcAck ?? { ok: true, result: { echoed: data.params } });
    return this;
  }

  // Socket.IO's promise acknowledgement rejects its pending callback on disconnect.
  emitWithAck(event: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pendingAcks.add(reject);
      try {
        this.emit(event, data, (value) => {
          this.pendingAcks.delete(reject);
          resolve(value);
        });
      } catch (error) {
        this.pendingAcks.delete(reject);
        reject(error);
      }
    });
  }

  disconnect() {
    this.connected = false;
    this.disconnectCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }

  removeAllListeners() {
    this.handlers.clear();
  }
}

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    nextSocket = new FakeSocket();
    configureNextSocket?.(nextSocket);
    return nextSocket;
  }),
}));

import { callSessionRpc, readSessionRpcRequestDisposition } from './sessionRpc';
import { startExecutionRunStream, waitForExecutionRun, watchExecutionRun } from '@/session/services/executionRuns';

describe('execution-run caller authority at the Socket.IO boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    nextRpcAck = null;
    nextSocket = null;
  });

  it('keeps an automation stream call narrowed when using Account credentials', async () => {
    nextRpcAck = { ok: true, result: { streamId: 'voice-stream' } };
    const request = {
      token: 'account-token', sessionId: 'voice-session', mode: 'plain' as const, ctx: null,
      authorityCeiling: 'account_automation' as const,
      request: { runId: 'voice-run', message: 'Agent-authored turn' },
    };
    await expect(startExecutionRunStream(request)).resolves.toMatchObject({ ok: true, data: { streamId: 'voice-stream' } });
    expect(vi.mocked(io).mock.calls.at(-1)?.[1]?.auth).toMatchObject({
      token: 'account-token', authorityCeiling: 'account_automation',
    });
  });

  it.each([
    { scope: 'attached', authority: 'account_automation', surface: 'agent' },
    { scope: 'detached', authority: 'account_automation', surface: 'agent' },
    { scope: 'attached', authority: 'present_user', surface: 'cli' },
  ] as const)('preserves $authority from the real Action executor through $scope list RPC', async ({ scope, authority, surface }) => {
    const sessionId = 'c000000000000000000000000';
    // Only Home HTTP and Socket.IO are replaced; Session resolution, Action
    // options, CLI adapters, codecs and socket admission execute normally.
    const homeHttp = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home HTTP boundary'));
    if (scope === 'attached') {
      homeHttp.mockResolvedValueOnce({ status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } }).mockResolvedValueOnce({ status: 200, data: { session: {
        id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadata: '{}', metadataVersion: 0, dataEncryptionKey: null,
        agentState: null, agentStateVersion: 0,
      } } });
    } else {
      homeHttp.mockResolvedValue({ status: 200, data: { machine: {
        id: 'voice-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      } } });
    }
    nextRpcAck = (request: { method: string }) => ({ ok: true, result: request.method.includes('capabilities.detect')
      ? { results: { 'tool.executionRuns': { ok: true, data: { protocolVersion: 2, features: { detachedScope: true } } } } }
      : { runs: [] } });
    const credentials = { token: 'account-token', encryption: null };
    const executor = createActionExecutor(createCliActionDeps({
      token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
    }));
    const result = await executor.execute('execution.run.list', { sessionId: scope === 'attached' ? sessionId : null }, {
      surface, authority, defaultSessionId: sessionId,
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, executionRunTargetMachineId: 'voice-machine',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { runs: [] } });
    const socketAuth = vi.mocked(io).mock.calls.map((call) => call[1]?.auth);
    expect(socketAuth.length).toBeGreaterThan(0);
    expect(socketAuth.every((auth) => auth !== null && typeof auth === 'object'
      && (authority === 'account_automation'
        ? 'authorityCeiling' in auth && auth.authorityCeiling === 'account_automation'
        : !('authorityCeiling' in auth)))).toBe(true);
  });
});

describe('current-turn cancellation through the CLI Action owner', () => {
  const sessionId = 'c000000000000000000000000';
  const home = { serverId: 'cancel-home', serverHttpBaseUrl: 'https://cancel-home.test' };
  const credentials = { token: 'account-token', encryption: null };
  const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
  const session = { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    encryptionMode: 'plain', metadata: '{}', metadataVersion: 0, dataEncryptionKey: null,
    agentState: null, agentStateVersion: 0 };
  const harness = () => createCliActionExecutorHarness({ token: credentials.token, credentials,
    sessionId: 'construction-session', mode: 'plain', ctx: null, ...home });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    nextRpcAck = null;
    nextSocket = null;
    configureNextSocket = null;
  });

  it.each([
    { authority: 'account_automation', surface: 'agent' },
    { authority: 'present_user', surface: 'cli' },
  ] as const)('cancels only the selected turn while retaining $authority at the real socket boundary', async ({ authority, surface }) => {
    // Only Home HTTP and Socket.IO are replaced; resolution, admission and codecs stay real.
    const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home HTTP boundary'));
    http.mockResolvedValueOnce({ status: 200, data: currentness })
      .mockResolvedValueOnce({ status: 200, data: { session } });
    nextRpcAck = { ok: true, result: { cancelled: true } };
    const signal = new AbortController().signal;
    expect(await harness().executor.execute('session.turn.cancel', { sessionId }, {
      authority, surface, signal, ...(surface === 'agent' ? { defaultSessionId: sessionId } : {}),
    }))
      .toEqual({ ok: true, result: { cancelled: true } });
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      `${home.serverHttpBaseUrl}/v1/account/encryption/currentness`,
      `${home.serverHttpBaseUrl}/v2/sessions/${sessionId}`,
    ]);
    expect(http.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(http.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(nextSocket?.emitted.filter(call => call.event === 'rpc-call').map(call => call.data))
      .toEqual([expect.objectContaining({ method: `${sessionId}:abort`, params: { reason: expect.any(String) } })]);
    expect(vi.mocked(io).mock.calls.at(-1)?.[0]).toBe(home.serverHttpBaseUrl);
    expect(vi.mocked(io).mock.calls.at(-1)?.[1]?.auth).toMatchObject({ token: credentials.token,
      ...(authority === 'account_automation' ? { authorityCeiling: 'account_automation' } : {}) });
    if (authority === 'present_user') expect(vi.mocked(io).mock.calls.at(-1)?.[1]?.auth).not.toHaveProperty('authorityCeiling');
  });

  it('withdraws before RPC dispatch when cancellation occurs during Home resolution', async () => {
    const controller = new AbortController();
    const http = vi.spyOn(axios, 'get').mockImplementationOnce(async () => {
      controller.abort();
      return { status: 200, data: currentness };
    });
    expect(await harness().executor.execute('session.turn.cancel', { sessionId }, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId, signal: controller.signal,
    })).toMatchObject({ ok: false });
    expect(http.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(io).not.toHaveBeenCalled();
  });

  it('carries the admitted external cancellation proof to the exact abort payload', async () => {
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'session' as const, sessionId };
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      serverIdentityId: 'home', accountId: 'account', principalId: 'account',
      credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine',
      actionId: 'session.turn.cancel', requestId: 'cancel-request', requestEnvelopeDigest: 'A'.repeat(43),
      target, grant: API_TOKEN_FULL_GRANT_V1,
    } };
    const context: ActionExecutorContext = { authority: 'account_automation', surface: 'api',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization };
    const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home HTTP boundary'));
    http.mockResolvedValueOnce({ status: 200, data: currentness })
      .mockResolvedValueOnce({ status: 200, data: { session } });
    nextRpcAck = { ok: true, result: { cancelled: true } };
    const owner = createCliActionExecutorHarness({ token: credentials.token, credentials,
      sessionId: 'construction-session', mode: 'plain', ctx: null, ...home, serverIdentityId: 'home',
      externalActionMachineRequestPrivateKey: key.secretKey, externalActionMachineInstallationId: 'installation' });
    expect(await owner.deps.sessionTurnCancel?.({ sessionId, serverId: home.serverId, context }))
      .toEqual({ cancelled: true });
    const payload = nextSocket?.emitted.find(call => call.event === 'rpc-call')?.data;
    expect(payload).toMatchObject({ method: `${sessionId}:abort`, externalActionExecution: {
      authorization, target, effectActionId: 'session.turn.cancel',
    } });
    const signed = { authorizationToken: authorization.token, effectActionId: 'session.turn.cancel', target,
      installationId: 'installation', event: 'rpc-call', method: payload.method, requestId: payload.requestId,
      params: payload.params, publicKey: key.publicKey, signature: payload.externalActionExecution.machineSignature };
    expect(verifyExternalActionMachineRpcRequestV1(signed)).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...signed, params: { reason: 'tampered' } })).toBe(false);
    expect(http.mock.calls.every(([, config]) => config?.headers?.Authorization !== `Bearer ${credentials.token}`)).toBe(true);
  });

  it('refuses another Home and an unsigned external effect before reading or dispatching', async () => {
    const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home HTTP boundary'));
    const cancel = harness().deps.sessionTurnCancel;
    expect(cancel).toBeTypeOf('function');
    expect(await cancel!({ sessionId, serverId: 'other-home', context: { authority: 'account_automation' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    const target = { kind: 'session' as const, sessionId };
    expect(await cancel!({ sessionId, serverId: home.serverId, context: {
      authority: 'account_automation', surface: 'api', externalActionTarget: target,
      externalActionExecutionAuthorization: { v: 1, token: 'home-proof', binding: {
        serverIdentityId: 'home', accountId: 'account', principalId: 'account',
        credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine',
        actionId: 'session.turn.cancel', requestId: 'cancel-request', requestEnvelopeDigest: 'A'.repeat(43),
        target, grant: API_TOKEN_FULL_GRANT_V1,
      } },
    } })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(http).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
  });
});

describe('execution wait transport recovery', () => {
  const terminal = {
    ok: true, status: 'succeeded', result: { run: {
      runId: 'run-original', callId: 'run-call', sidechainId: 'run-sidechain', intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    } },
  };
  it.each(['needs_attention', 'change'] as const)('refuses a terminal-only reply to a %s request', async (condition) => {
    nextRpcAck = { ok: true, result: terminal };
    await expect(waitForExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: 'run-original', timeoutMs: null, condition,
    })).resolves.toMatchObject({ ok: false, code: 'execution_run_wait_result_invalid' });
    expect(nextSocket?.emitted.filter((call) => call.event === 'rpc-call').map((call) => call.data.method))
      .toEqual(['sess_1:execution.run.wait']);
  });
  it('streams passive snapshots, parks while quiet and resnapshots the same run after reconnect', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => { sockets.push(socket); socket.ackMode = 'never'; };
    const abort = new AbortController();
    const snapshots: unknown[] = [];
    const watching = watchExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: 'run-original', timeoutMs: null, signal: abort.signal, onSnapshot: (value) => { snapshots.push(value); },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const running = { run: { ...terminal.result.run, status: 'running', finishedAtMs: undefined } };
    sockets[0]?.delayedAck?.({ ok: true, result: { ok: true, status: 'running', disposition: 'snapshot', result: running } });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([running]);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.emitted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0]?.emitted).toHaveLength(2); // One parked change RPC, no periodic gets.
    sockets[0]?.trigger('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.emitted[0]?.data.params).toMatchObject({ runId: 'run-original', condition: 'change', after: running });
    sockets[1]?.delayedAck?.({ ok: true, result: { ok: true, status: 'succeeded', disposition: 'snapshot', result: terminal.result } });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([running, terminal.result]);
    abort.abort();
    expect(await watching).toMatchObject({ name: 'AbortError' });
    expect(sockets.flatMap((socket) => socket.emitted).filter((call) => call.event === 'rpc-call')
      .every((call) => call.data.method === 'sess_1:execution.run.wait')).toBe(true);
    expect(sockets.every((socket) => socket.listenerCount('disconnect') === 0)).toBe(true);
  });
  it('preserves snapshot output backpressure across reconnect', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => { sockets.push(socket); socket.ackMode = 'never'; };
    const abort = new AbortController();
    let releaseOutput = () => {};
    const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
    const snapshots: unknown[] = [];
    const watching = watchExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: 'run-original', timeoutMs: null, signal: abort.signal,
      onSnapshot: async (value) => { snapshots.push(value); await output; },
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.delayedAck?.({ ok: true, result: { ...terminal, disposition: 'snapshot' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toEqual([terminal.result]);
      sockets[0]?.trigger('disconnect', 'transport close');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(2);
      expect(sockets[1]?.emitted).toHaveLength(0);
      releaseOutput();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[1]?.emitted[0]?.data.params).toMatchObject({ after: terminal.result, condition: 'change' });
    } finally { releaseOutput(); abort.abort(); await watching; }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    nextRpcAck = null;
    nextSocket = null;
    configureNextSocket = null;
  });

  it.each(['before submission', 'after submission', 'before terminal acknowledgement'] as const)(
    'reattaches the original run after disconnect %s', async (phase) => {
      vi.useFakeTimers();
      const sockets: FakeSocket[] = [];
      configureNextSocket = (socket) => {
        sockets.push(socket);
        if (sockets.length === 1) {
          socket.rejectAcksOnDisconnect = false;
          socket.ackMode = 'never';
          socket.disconnectAfterConnect = phase === 'before submission';
          if (phase === 'before terminal acknowledgement') {
            socket.onEmit = () => socket.trigger('disconnect', 'transport close');
          }
        } else {
          nextRpcAck = { ok: true, result: terminal };
        }
      };
      const result = waitForExecutionRun({
        token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null, runId: 'run-original', timeoutMs: null,
      }).catch((error: unknown) => error);
      if (phase === 'after submission') {
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets[0]?.emitted.some((item) => item.event === 'rpc-call')).toBe(true);
        sockets[0]?.trigger('disconnect', 'transport close');
      }
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toEqual(terminal);
      const calls = sockets.flatMap((socket) => socket.emitted.filter((item) => item.event === 'rpc-call'));
      expect(calls.length).toBe(phase === 'before submission' ? 1 : 2);
      expect(calls.every((item) => item.data.method === 'sess_1:execution.run.wait'
        && item.data.params.runId === 'run-original')).toBe(true);
      expect(sockets.every((socket) => socket.listenerCount('disconnect') === 0)).toBe(true);
    },
  );

  it('detaches a cancelled waiter while a sibling waits on the same run', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => { sockets.push(socket); socket.ackMode = 'never'; };
    const cancelled = new AbortController();
    const first = waitForExecutionRun({
      token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null, runId: 'run-original', timeoutMs: null,
      signal: cancelled.signal,
    }).catch((error: unknown) => error);
    const second = waitForExecutionRun({
      token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null, runId: 'run-original', timeoutMs: null,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    cancelled.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(sockets[1]?.disconnectCalls).toBe(0);
    sockets[1]?.trigger('disconnect', 'transport close');
    configureNextSocket = (socket) => { sockets.push(socket); nextRpcAck = { ok: true, result: terminal }; };
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(second).resolves.toEqual(terminal);
    expect(sockets.flatMap((socket) => socket.emitted).some((item) => item.data?.method?.includes('start'))).toBe(false);
  });

  it('discards a late acknowledgement from the disconnected observation', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => {
      sockets.push(socket);
      if (sockets.length === 1) { socket.ackMode = 'never'; socket.rejectAcksOnDisconnect = false; }
      else nextRpcAck = { ok: true, result: terminal };
    };
    let settled = false;
    const result = waitForExecutionRun({
      token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null, runId: 'run-original', timeoutMs: null,
    }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.trigger('disconnect', 'transport close');
    sockets[0]?.delayedAck?.({ ok: true, result: {
      ...terminal, status: 'failed', result: { run: { ...terminal.result.run, status: 'failed' } },
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toEqual(terminal);
  });

  it('preserves the remaining observation budget and accepts terminal custody before the deadline', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => {
      sockets.push(socket);
      if (sockets.length === 1) { socket.ackMode = 'never'; socket.rejectAcksOnDisconnect = false; }
      else nextRpcAck = { ok: true, result: terminal };
    };
    const result = waitForExecutionRun({
      token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null, runId: 'run-original', timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[0]?.trigger('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(2_000);
    const calls = sockets.flatMap((socket) => socket.emitted.filter((item) => item.event === 'rpc-call'));
    await expect(result).resolves.toEqual(terminal);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.data.params.timeoutSeconds).toBeGreaterThan(0);
    expect(calls[1]?.data.params.timeoutSeconds).toBeLessThanOrEqual(3);
  });

  it.each(['before connection', 'after submission', 'during output backpressure'] as const)(
    'expires the finite observation %s without inventing Run state or replaying work', async (phase) => {
      vi.useFakeTimers();
      const sockets: FakeSocket[] = [];
      configureNextSocket = (socket) => {
        sockets.push(socket);
        socket.ackMode = 'never';
        socket.rejectAcksOnDisconnect = false;
        if (phase === 'before connection' || sockets.length > 1) socket.connectError = new Error('offline');
      };
      const abort = new AbortController();
      let releaseOutput = () => {};
      const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
      let settled = false;
      const snapshots: unknown[] = [];
      const observing = waitForExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
        runId: 'run-original', timeoutMs: 5_000, signal: abort.signal,
        ...(phase === 'during output backpressure' ? { onSnapshot: async (value: unknown) => { snapshots.push(value); await output; } } : {}),
      }).catch((error: unknown) => error).then((value) => { settled = true; return value; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        if (phase === 'during output backpressure') {
          sockets[0]?.delayedAck?.({ ok: true, result: { ...terminal, disposition: 'snapshot' } });
          await vi.advanceTimersByTimeAsync(0);
          expect(snapshots).toEqual([terminal.result]);
        }
        if (phase !== 'before connection') sockets[0]?.trigger('disconnect', 'transport close');
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        const timeout = await observing;
        expect(timeout).toMatchObject({ ok: false, code: 'observation_timeout' });
        expect(timeout).not.toHaveProperty('status');
        expect(timeout).not.toHaveProperty('result');
        // A late reconnect/ACK cannot revive this observer; only observation is ended.
        configureNextSocket = (socket) => { sockets.push(socket); nextRpcAck = { ok: true, result: terminal }; };
        releaseOutput();
        sockets[0]?.delayedAck?.({ ok: true, result: terminal });
        const socketCount = sockets.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sockets).toHaveLength(socketCount);
        expect(sockets.flatMap((socket) => socket.emitted).filter((call) => call.event === 'rpc-call')
          .every((call) => call.data.method === 'sess_1:execution.run.wait')).toBe(true);
        expect(sockets.every((socket) => socket.listenerCount('disconnect') === 0)).toBe(true);
      } finally { releaseOutput(); abort.abort(); await observing; }
    },
  );
  it('expires the same finite observation while its predecessor compatibility snapshot is unavailable', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => {
      sockets.push(socket);
      if (sockets.length === 1) nextRpcAck = { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
      else socket.ackMode = 'never';
    };
    const abort = new AbortController();
    const observing = waitForExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: 'run-original', timeoutMs: 5_000, signal: abort.signal,
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets.flatMap((socket) => socket.emitted).filter((call) => call.event === 'rpc-call')
        .map((call) => call.data.method)).toEqual(['sess_1:execution.run.wait', 'sess_1:execution.run.get']);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(observing).resolves.toMatchObject({ ok: false, code: 'observation_timeout' });
    } finally { abort.abort(); await observing; }
  });

  it('keeps a 30-day direct observation alive until its authored deadline and removes its timer', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    configureNextSocket = (socket) => { sockets.push(socket); socket.ackMode = 'never'; };
    const abort = new AbortController();
    const durationMs = 30 * 24 * 60 * 60 * 1_000;
    let settled = false;
    const observing = waitForExecutionRun({ token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: 'run-original', timeoutMs: durationMs, signal: abort.signal,
    }).catch((error: unknown) => error).then((value) => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(durationMs - 1);
      expect(settled).toBe(false);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.emitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(observing).resolves.toMatchObject({ ok: false, code: 'observation_timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { abort.abort(); await observing; }
  });
});

describe('callSessionRpc (plaintext sessions)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    nextRpcAck = null;
    nextSocket = null;
    configureNextSocket = null;
  });

  it.each([
    ['plain', 'session.model.set', 'session.model.transition'],
    ['e2ee', 'session.model.set', 'session.model.transition'],
    ['plain', 'session.permission.respond', 'session.permission.respond'],
    ['e2ee', 'session.user_action.answer', 'session.user_action.answer'],
  ] as const)('binds an external %s %s RPC to its exact payload and refuses missing proof', async (mode, effectActionId, method) => {
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'session' as const, sessionId: 'sess_1' };
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      serverIdentityId: 'home', accountId: 'account', principalId: 'account',
      credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine',
      actionId: effectActionId, requestId: 'outer-request', requestEnvelopeDigest: 'A'.repeat(43),
      target, grant: API_TOKEN_FULL_GRANT_V1,
    } };
    const context: ActionExecutorContext = { authority: 'account_automation', surface: 'api',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization };
    const content = mode === 'plain' ? { mode, ctx: null } : { mode, ctx: {
      encryptionKey: new Uint8Array(32).fill(4), encryptionVariant: 'legacy' as const,
    } };
    nextRpcAck = async (request: { method: string; params: unknown }) => {
      const key = new Uint8Array(32).fill(4);
      const rpcContent: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
        encryptRaw: async value => encodeBase64(encrypt(key, 'legacy', value)),
        decryptRaw: async value => decrypt(key, 'legacy', decodeBase64(value)),
      } };
      const decoded = await socketRpcCodec.decodeRequestParams(rpcContent, request.params, request.method);
      return { ok: true, result: await socketRpcCodec.encodeResponse(rpcContent, null, decoded.callId) };
    };
    const input = { token: 'daemon-token', sessionId: target.sessionId, method: `sess_1:${method}`,
      request: { v: 1, selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' } },
      ...content, externalAction: { context, effectActionId, installationId: 'installation', privateKey: key.secretKey },
    };
    await callSessionRpc(input);
    const payload = nextSocket?.emitted.find((item) => item.event === 'rpc-call')?.data;
    expect(payload.externalActionExecution).toMatchObject({ authorization, target, effectActionId });
    const signed = { authorizationToken: authorization.token, effectActionId, target,
      installationId: 'installation', event: 'rpc-call', method: payload.method, requestId: payload.requestId,
      params: payload.params, publicKey: key.publicKey, signature: payload.externalActionExecution.machineSignature };
    expect(verifyExternalActionMachineRpcRequestV1(signed)).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...signed, params: 'tampered' })).toBe(false);
    await expect(callSessionRpc({ ...input, externalAction: { ...input.externalAction,
      context: { authority: 'account_automation', surface: 'api' },
    } })).rejects.toThrow();
    expect(nextSocket?.emitted).toHaveLength(0);
  });

  it('uses a user-scoped caller socket for one-shot runtime RPC calls', async () => {
    const { io } = await import('socket.io-client');
    await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: null,
    });

    expect(io).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      auth: expect.objectContaining({ token: 't', clientType: 'user-scoped' }),
    }));
  });

  it('sends plaintext params and returns plaintext results when mode=plain', async () => {
    nextRpcAck = null;
    const req = { a: 1 };
    const res = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: req,
      ctx: null,
    });

    expect(res).toEqual({ echoed: req });
    expect(nextSocket?.emitted[0]?.data.requestId).toEqual(expect.any(String));
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
    expect(nextSocket?.listenerCount('connect')).toBe(0);
    expect(nextSocket?.listenerCount('connect_error')).toBe(0);
    expect(nextSocket?.listenerCount('disconnect')).toBe(0);
  });

  it('throws RpcError with rpcErrorCode when the RPC response includes errorCode', async () => {
    nextRpcAck = {
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };

    await expect(
      callSessionRpc({
        token: 't',
        sessionId: 'sess_1',
        mode: 'plain',
        method: 'sess_1:demo.method',
        request: { a: 1 },
        ctx: null,
      }),
    ).rejects.toSatisfy((error: unknown) => readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('carries the protocol Session write context to the relay', async () => {
    await callSessionRpc({
      token: 't', sessionId: 'sess_1', mode: 'plain', ctx: null,
      method: 'sess_1:session.user_action.answer', request: { id: 'question', approved: true },
    });
    expect(nextSocket?.emitted[0]?.data).toMatchObject({
      method: 'sess_1:session.user_action.answer',
      authorization: { kind: 'session.write', sessionId: 'sess_1' },
    });
  });

  it('cancels the exact issued request when the caller aborts', async () => {
    const abort = new AbortController();
    let issued = () => {};
    const emitted = new Promise<void>((resolve) => { issued = resolve; });
    configureNextSocket = (socket) => { socket.ackMode = 'never'; socket.onEmit = issued; };
    const pending = callSessionRpc({
      token: 't', sessionId: 'sess_1', mode: 'plain', ctx: null,
      method: 'sess_1:execution.run.wait', request: { runId: 'run_1' },
      timeoutMs: null, signal: abort.signal,
    });
    const rejected = pending.catch((error: unknown) => error);
    await emitted;
    const requestId = nextSocket?.emitted[0]?.data.requestId;
    abort.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(nextSocket?.emitted).toContainEqual({ event: 'rpc-cancel', data: { requestId } });
  });

  it('closes the socket when connection fails before the RPC emit', async () => {
    configureNextSocket = (socket) => {
      socket.connectError = new Error('connect failed');
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: null,
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'connect failed' });
    expect(readSessionRpcRequestDisposition(error)).toBe('notSent');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
    expect(nextSocket?.listenerCount('connect')).toBe(0);
    expect(nextSocket?.listenerCount('connect_error')).toBe(0);
  });

  it('closes the socket when emit throws synchronously', async () => {
    configureNextSocket = (socket) => {
      socket.emitError = new Error('emit failed');
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: null,
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'emit failed' });
    expect(readSessionRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('closes the socket when the RPC ack times out', async () => {
    vi.useFakeTimers();
    configureNextSocket = (socket) => {
      socket.ackMode = 'never';
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      timeoutMs: 10,
      ctx: null,
    });
    const errorPromise = promise.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(10);

    const error = await errorPromise;
    expect(error).toMatchObject({ message: 'RPC call timeout' });
    expect(readSessionRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('lets caller-lifecycle RPCs wait without a competing local ack timeout', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    configureNextSocket = (socket) => {
      socket.ackMode = 'never';
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: abort.signal,
      ctx: null,
    });
    const errorPromise = promise.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(nextSocket?.disconnectCalls).toBe(0);
    expect(nextSocket?.emitted[0]?.data).not.toHaveProperty('timeoutMs');

    abort.abort();
    const error = await errorPromise;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(readSessionRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('settles an emitted RPC as outcome-unknown when its socket disconnects before acknowledgement', async () => {
    let resolveEmitted = () => {};
    const emitted = new Promise<void>((resolve) => {
      resolveEmitted = resolve;
    });
    configureNextSocket = (socket) => {
      socket.ackMode = 'never';
      socket.onEmit = resolveEmitted;
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      ctx: null,
    });

    await emitted;
    nextSocket?.trigger('disconnect', 'transport close');
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readSessionRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('settles a connect-then-disconnect race before emission even with no acknowledgement timeout', async () => {
    const observationFallback = new AbortController();
    configureNextSocket = (socket) => {
      socket.ackMode = 'never';
      socket.disconnectAfterConnect = true;
    };

    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: observationFallback.signal,
      ctx: null,
    });
    expect(nextSocket?.emitted).toHaveLength(0);
    observationFallback.abort(new Error('test observation fallback'));

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readSessionRpcRequestDisposition(error)).toBe('notSent');
    expect(nextSocket?.emitted).toHaveLength(0);
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });
});
