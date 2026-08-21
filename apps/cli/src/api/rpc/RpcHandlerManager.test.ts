import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
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
    first.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'stale-error' });
    second.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'unregister', error: 'not-a-registration-error' });

    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledWith({
      type: 'register',
      error: 'client-upgrade-required',
      requirement: { v: 1 },
    });
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
});

describe('RpcHandlerManager.handleRequest (encrypted)', () => {
  it('wraps an encrypted result with only the requested projected transport acknowledgement', async () => {
    const encryptionKey = new Uint8Array(32).fill(13);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
      projectTransportAcknowledgement: ({ method, result }) => (
        method === 'machine_1:demo.stop'
        && result
        && typeof result === 'object'
        && (result as { status?: unknown }).status === 'stopped'
          ? { kind: 'session.stop', status: 'stopped' }
          : null
      ),
    } as ConstructorParameters<typeof RpcHandlerManager>[0]);
    rpc.registerHandler('demo.stop', async () => ({ status: 'stopped' }));

    const response = await rpc.handleRequest({
      method: 'machine_1:demo.stop',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { sessionId: 'sess_1' })),
      transportResponseEnvelopeVersion: 1,
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(response).toMatchObject({
      v: 1,
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
      },
    });
    const encryptedResult = (response as { result: unknown }).result;
    expect(typeof encryptedResult).toBe('string');
    expect(
      decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64(encryptedResult as string),
      ),
    ).toEqual({ status: 'stopped' });
  });

  it('rejects encrypted requests when the authorization hook rejects', async () => {
    const encryptionKey = new Uint8Array(32).fill(11);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      authorizeRequest: async ({ method, params, authorization, transportResponseEnvelopeVersion }) => {
        expect(method).toBe('machine_1:demo.secure');
        expect(params).toEqual({ sessionId: 'sess_1' });
        expect(authorization).toEqual({ kind: 'session.write', sessionId: 'sess_1' });
        expect(transportResponseEnvelopeVersion).toBe(1);
        return {
          ok: false,
          error: RPC_ERROR_MESSAGES.FORBIDDEN,
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
        };
      },
      logger: () => {},
    });
    let handlerCalled = false;
    rpc.registerHandler('demo.secure', async () => {
      handlerCalled = true;
      return { ok: true };
    });

    const res = await rpc.handleRequest({
      method: 'machine_1:demo.secure',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { sessionId: 'sess_1' })),
      authorization: { kind: 'session.write', sessionId: 'sess_1' },
      transportResponseEnvelopeVersion: 1,
    });

    expect(handlerCalled).toBe(false);
    expect(res).toMatchObject({ v: 1 });
    const encryptedResult = (res as { result: unknown }).result;
    expect(typeof encryptedResult).toBe('string');
    expect(decrypt(
      encryptionKey,
      'dataKey',
      decodeBase64(encryptedResult as string),
    )).toEqual({
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
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

describe('RpcHandlerManager request lifetime', () => {
  it('aborts the central handler signal when the target transport disconnects', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    rpc.registerHandler('demo.abort', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      if (!context) return { aborted: false };
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context.signal.aborted };
    }) as Parameters<typeof rpc.registerHandler>[1]);

    const pending = rpc.handleRequest({ method: 'sess_1:demo.abort', params: {} });
    await Promise.resolve();
    rpc.onSocketDisconnect();

    await expect(pending).resolves.toEqual({ aborted: true });
  });

  it('aborts the central handler signal at the forwarded request timeout', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    rpc.registerHandler('demo.timeout', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      if (!context) return { aborted: false };
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context.signal.aborted };
    }) as Parameters<typeof rpc.registerHandler>[1]);

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.timeout', params: {}, timeoutMs: 5,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual({ aborted: true });
  });
});

describe('RpcHandlerManager owned handler replacement', () => {
  it('replaces one owner atomically while preserving unrelated handlers', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.replaceOwnedHandlers('machine-surface', () => {
      rpc.registerHandler('owned.keep', async () => 'old');
      rpc.registerHandler('owned.stale', async () => 'stale');
    });
    rpc.registerHandler('external.keep', async () => 'external');

    const emit = vi.fn();
    (rpc as any).socket = { emit };
    rpc.replaceOwnedHandlers('machine-surface', () => {
      expect(rpc.hasHandler('owned.keep')).toBe(false);
      rpc.registerHandler('owned.keep', async () => 'new');
    });

    await expect(rpc.invokeLocal('owned.keep', {})).resolves.toBe('new');
    await expect(rpc.invokeLocal('owned.stale', {})).resolves.toMatchObject({
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    });
    await expect(rpc.invokeLocal('external.keep', {})).resolves.toBe('external');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTER, {
      method: 'machine_1:owned.stale',
    });
  });
});
