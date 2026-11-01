import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import { logger } from '@/ui/logger';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { PublicRpcHandlerError, RpcError, isSocketRpcTargetFailureV1 } from '@happier-dev/protocol/rpcErrors';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Socket } from 'socket.io-client';

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createSocketEventBoundary() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
      return socket;
    }),
  };
  return {
    // Socket.IO is the system boundary under test; only its event surface is needed here.
    socket: socket as unknown as Socket,
    trigger(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

describe('RpcHandlerManager registration receipts', () => {
  it('surfaces registration errors from only the active socket epoch', () => {
    const onRegistrationError = vi.fn();
    const config = {
      scopePrefix: 'machine-1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey' as const,
      logger: () => {},
      onRegistrationError,
    };
    const rpc = new RpcHandlerManager(config);
    const first = createSocketEventBoundary();
    const second = createSocketEventBoundary();

    rpc.onSocketConnect(first.socket);
    first.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register',
      error: 'client-upgrade-required',
      requirement: { v: 1 },
    });

    rpc.onSocketConnect(second.socket);
    first.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register',
      error: 'stale-error',
    });
    second.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'unregister',
      error: 'not-a-registration-error',
    });

    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledWith({
      type: 'register',
      error: 'client-upgrade-required',
      requirement: { v: 1 },
    });
  });

  it('reports ready only after every required handler is acknowledged on the active socket', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    rpc.registerHandler('core.stop', async () => ({ ok: true }));
    rpc.registerHandler('optional.status', async () => ({ ok: true }));
    const boundary = createSocketEventBoundary();

    rpc.onSocketConnect(boundary.socket);
    const readiness = rpc.waitForRegisteredHandlers(
      ['core.spawn', 'core.stop'],
      { timeoutMs: 1_000 },
    );
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:optional.status' });
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });

    let settled = false;
    void readiness.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.stop' });
    await expect(readiness).resolves.toEqual({ status: 'ready' });
  });

  it('disconnects old waiters and ignores stale acknowledgements after reconnect', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    const first = createSocketEventBoundary();
    const second = createSocketEventBoundary();

    rpc.onSocketConnect(first.socket);
    const firstReadiness = rpc.waitForRegisteredHandlers(['core.spawn'], { timeoutMs: 1_000 });
    rpc.onSocketConnect(second.socket);
    const secondReadiness = rpc.waitForRegisteredHandlers(['core.spawn'], { timeoutMs: 1_000 });

    first.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    await expect(firstReadiness).resolves.toEqual({
      status: 'disconnected',
      missingMethods: ['core.spawn'],
    });

    let secondSettled = false;
    void secondReadiness.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    second.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    await expect(secondReadiness).resolves.toEqual({ status: 'ready' });
  });

  it('returns the exact missing handlers when the readiness deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const rpc = new RpcHandlerManager({
        scopePrefix: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        logger: () => {},
      });
      rpc.registerHandler('core.spawn', async () => ({ ok: true }));
      rpc.registerHandler('core.stop', async () => ({ ok: true }));
      const boundary = createSocketEventBoundary();
      rpc.onSocketConnect(boundary.socket);

      const readiness = rpc.waitForRegisteredHandlers(
        ['core.spawn', 'core.stop'],
        { timeoutMs: 50 },
      );
      boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
      await vi.advanceTimersByTimeAsync(50);

      await expect(readiness).resolves.toEqual({
        status: 'timeout',
        missingMethods: ['core.stop'],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RpcHandlerManager.invokeLocal', () => {
  it('invokes a registered handler without encryption', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: any) => {
      return { ok: true, echoed: params };
    });

    const res = await rpc.invokeLocal('demo.method', { a: 1 });
    expect(res).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('returns a method-not-found error shape when handler is missing', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    const res = await rpc.invokeLocal('missing.method', {});
    expect(res).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });
});

describe('RpcHandlerManager.handleRequest error responses', () => {
  it.each(['plain', 'e2ee'] as const)('preserves only the public typed error fields over %s transport', async (encryptionMode) => {
    const encryptionKey = new Uint8Array(32).fill(7);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1', encryptionKey, encryptionVariant: 'dataKey', encryptionMode, logger: () => {},
    });
    const request = { method: 'machine-1:handoff', params: encryptionMode === 'plain'
      ? {} : encodeBase64(encrypt(encryptionKey, 'dataKey', {})) };
    const readResponse = async () => {
      const response: unknown = await rpc.handleRequest(request);
      if (encryptionMode === 'plain') return response;
      expect(typeof response).toBe('string');
      return decrypt(encryptionKey, 'dataKey', decodeBase64(response as string));
    };
    rpc.registerHandler('handoff', async () => {
      throw Object.assign(new RpcError('Authentication is required', 'not_authenticated'), {
        privateCredential: 'must-not-cross-transport', cause: new Error('private cause'),
      });
    });
    expect(await readResponse()).toEqual({ error: 'Authentication is required', errorCode: 'not_authenticated' });

    rpc.registerHandler('handoff', async () => {
      throw Object.assign(new Error('Untyped handler failure'), { code: 'PRIVATE_OS_CODE' });
    });
    expect(await readResponse()).toEqual({ error: 'Untyped handler failure' });

    rpc.registerHandler('handoff', async () => { throw 'untyped non-Error failure'; });
    expect(await readResponse()).toEqual({ error: 'Unknown error' });
  });
});

describe('RpcHandlerManager.handleRequest (plaintext)', () => {
  it('passes plaintext params through and returns plaintext results', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: any) => {
      return { ok: true, echoed: params };
    });

    const res = await rpc.handleRequest({ method: 'sess_1:demo.method', params: { a: 1 } });
    expect(res).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('returns a method-not-found error object when handler is missing', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    const res = await rpc.handleRequest({ method: 'sess_1:missing.method', params: {} });
    expect(res).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('aborts the exact active handler when the relay cancels its transport request', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });
    let observedSignal: AbortSignal | null = null;
    rpc.registerHandler('demo.wait', async (...args: unknown[]) => {
      observedSignal = (args[2] as { signal?: AbortSignal } | undefined)?.signal ?? null;
      if (!observedSignal) return { error: 'missing transport cancellation signal' };
      return await new Promise<never>((_resolve, reject) => {
        observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), { once: true });
      });
    });
    const boundary = createSocketEventBoundary();
    rpc.onSocketConnect(boundary.socket);

    const response = rpc.handleRequest({
      method: 'sess_1:demo.wait',
      params: {},
      requestId: 'target-request-1',
    });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());

    boundary.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'target-request-1' });

    await expect(response).resolves.toEqual({ error: 'RPC request cancelled by caller' });
    expect(rpc.getInFlightRequestCount()).toBe(0);
  });
});

describe('RpcHandlerManager.handleRequest (encrypted)', () => {
  it('projects public handler refusals through the safe encrypted failure envelope', async () => {
    const encryptionKey = new Uint8Array(32).fill(5);
    const privateMessage = 'Private structured answer details';
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1', encryptionKey, encryptionVariant: 'dataKey', logger: () => {},
    });
    rpc.registerHandler('question-answer', async () => {
      throw new PublicRpcHandlerError('STRUCTURED_QUESTION_INVALID', privateMessage);
    });

    const response = await rpc.handleRequest({
      method: 'machine-1:question-answer',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', {})),
    });
    const failure = decrypt(encryptionKey, 'dataKey', decodeBase64(response));

    expect(isSocketRpcTargetFailureV1(failure)).toBe(true);
    expect(failure).toMatchObject({ type: 'socket-rpc-target-failure-v1', errorCode: 'STRUCTURED_QUESTION_INVALID' });
    expect(JSON.stringify(failure)).not.toContain(privateMessage);
  });

  it.each(['legacy', 'dataKey'] as const)('records a %s key mismatch without logging key material or running the handler', async (encryptionVariant) => {
    const encryptionKey = new Uint8Array(32).fill(3);
    const callerKey = new Uint8Array(32).fill(7);
    const params = { privateValue: 'must-not-be-logged' };
    const encryptedParams = encodeBase64(encrypt(callerKey, encryptionVariant, params));
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    try {
      const rpc = new RpcHandlerManager({
        scopePrefix: 'machine-1',
        encryptionKey,
        encryptionVariant,
        logger: () => {},
      });
      let handlerRan = false;
      rpc.registerHandler('demo.method', async () => {
        handlerRan = true;
        return { ok: true };
      });

      const response = await rpc.handleRequest({ method: 'machine-1:demo.method', params: encryptedParams });

      expect(handlerRan).toBe(false);
      expect(decrypt(encryptionKey, encryptionVariant, decodeBase64(response))).toEqual({ error: 'Invalid RPC params' });
      expect(infoFile).toHaveBeenCalledWith(expect.any(String), {
        reason: 'rpc_params_decryption_failed',
        method: 'demo.method',
        encryptionVariant,
      });
      const logged = JSON.stringify(infoFile.mock.calls);
      expect(logged).not.toContain('machine-1');
      expect(logged).not.toContain(params.privateValue);
      expect(logged).not.toContain(encryptedParams);
      expect(logged).not.toContain(encodeBase64(encryptionKey));
      expect(logged).not.toContain(encodeBase64(callerKey));
    } finally {
      infoFile.mockRestore();
    }
  });

  it('keeps the encrypted result opaque while exposing requested transport acknowledgement metadata', async () => {
    const encryptionKey = new Uint8Array(32).fill(3);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
      projectTransportAcknowledgement: ({ method, result }) => (
        method === 'machine-1:stop-session'
        && typeof result === 'object'
        && result !== null
        && (result as { status?: unknown }).status === 'stopped'
          ? { kind: 'session.stop' as const, status: 'stopped' as const }
          : null
      ),
    });

    rpc.registerHandler('stop-session', async () => ({ status: 'stopped' }));

    const res = await rpc.handleRequest({
      method: 'machine-1:stop-session',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { sessionId: 'sess_1' })),
      transportResponseEnvelopeVersion: 1,
    });

    expect(res).toEqual({
      v: 1,
      result: expect.any(String),
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    });
    expect(
      decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64((res as { result: string }).result),
      ),
    ).toEqual({ status: 'stopped' });
  });

  it('rejects encrypted requests when the authorization hook rejects the decrypted params', async () => {
    const encryptionKey = new Uint8Array(32).fill(5);
    const authorizeRequest = vi.fn(() => ({
      ok: false as const,
      error: 'Forbidden',
      errorCode: 'RPC_FORBIDDEN',
    }));
    const handler = vi.fn(async () => ({ ok: true }));
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
      authorizeRequest,
    } as any);

    rpc.registerHandler('daemon.sessionRunner.restart', handler);

    const res = await rpc.handleRequest({
      method: 'machine-1:daemon.sessionRunner.restart',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { sessionId: 's2' })),
      authorization: { kind: 'session.write', sessionId: 's1' },
      transportResponseEnvelopeVersion: 1,
    } as any);

    expect(authorizeRequest).toHaveBeenCalledWith({
      method: 'machine-1:daemon.sessionRunner.restart',
      params: { sessionId: 's2' },
      authorization: { kind: 'session.write', sessionId: 's1' },
      transportResponseEnvelopeVersion: 1,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(res).toEqual({
      v: 1,
      result: expect.any(String),
    });
    expect(
      decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64((res as { result: string }).result),
      ),
    ).toEqual({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
  });

  it('passes encrypted undefined params through to the handler', async () => {
    const encryptionKey = new Uint8Array(32).fill(7);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: unknown) => {
      return { ok: true, sawUndefined: params === undefined };
    });

    const res = await rpc.handleRequest({
      method: 'sess_1:demo.method',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', undefined)),
    });

    expect(typeof res).toBe('string');
    expect(
      decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64(res as string),
      ),
    ).toEqual({ ok: true, sawUndefined: true });
  });

  it('preserves undefined handler results through encrypted responses', async () => {
    const encryptionKey = new Uint8Array(32).fill(9);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });

    rpc.registerHandler('demo.undefined', async () => undefined);

    const res = await rpc.handleRequest({
      method: 'sess_1:demo.undefined',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { ok: true })),
    });

    expect(typeof res).toBe('string');
    expect(
      decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64(res as string),
      ),
    ).toBeUndefined();
  });
});

describe('RpcHandlerManager in-flight request tracking', () => {
  it('exposes only safe method timing for active handler executions', async () => {
    const handlerStarted = createDeferredVoid();
    let nowMs = 1_000;

    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-secret-scope',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
      nowMs: () => nowMs,
    });

    rpc.registerHandler('scm.status.snapshot', async () => {
      await handlerStarted.promise;
      return { secretPayload: 'must-not-appear-in-diagnostics' };
    });

    const requestPromise = rpc.handleRequest({
      method: 'machine-secret-scope:scm.status.snapshot',
      params: { secretInput: 'must-not-appear-in-diagnostics' },
    });
    await Promise.resolve();
    nowMs = 2_250;

    expect(rpc.getActiveHandlerExecutions()).toEqual([
      {
        method: 'scm.status.snapshot',
        activeForMs: 1_250,
      },
    ]);

    handlerStarted.resolve();
    await requestPromise;
    expect(rpc.getActiveHandlerExecutions()).toEqual([]);
  });

  it('waits for an active request to settle before reporting idle', async () => {
    const handlerStarted = createDeferredVoid();

    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.slow', async () => {
      await handlerStarted.promise;
      return { ok: true };
    });

    const requestPromise = rpc.handleRequest({ method: 'sess_1:demo.slow', params: {} });
    await Promise.resolve();

    let idleResolved = false;
    const idlePromise = rpc.waitForIdle().then(() => {
      idleResolved = true;
    });

    await Promise.resolve();
    expect(idleResolved).toBe(false);

    handlerStarted.resolve();
    await requestPromise;
    await idlePromise;

    expect(idleResolved).toBe(true);
  });

  it('waits for an active local invocation to settle before reporting idle', async () => {
    const handlerStarted = createDeferredVoid();

    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.slowLocal', async () => {
      await handlerStarted.promise;
      return { ok: true };
    });

    const requestPromise = rpc.invokeLocal('demo.slowLocal', {});
    await Promise.resolve();

    let idleResolved = false;
    const idlePromise = rpc.waitForIdle().then(() => {
      idleResolved = true;
    });

    await Promise.resolve();
    expect(idleResolved).toBe(false);

    handlerStarted.resolve();
    await requestPromise;
    await idlePromise;

    expect(idleResolved).toBe(true);
  });
});
