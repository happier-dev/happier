import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol';
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

  it('reports ready only after every required handler is acknowledged on the active socket', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
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
      encryptionMode: 'plain',
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
        encryptionMode: 'plain',
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

  it('passes a host-only active-turn context to a local handler', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;

    rpc.registerHandler('demo.active-turn', async (_params, context) => context?.localActionContext ?? null);

    await expect(rpc.invokeLocal('demo.active-turn', {}, {
      localActionContext: {
        surface: 'agent',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority,
      },
    })).resolves.toEqual({
      surface: 'agent',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority,
    });
  });
});

describe('RpcHandlerManager.handleRequest (plaintext)', () => {
  it('passes plaintext params through and returns plaintext results', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });

    rpc.registerHandler('demo.method', async (params: any) => {
      return { ok: true, echoed: params };
    });

    const res = await rpc.handleRequest({ method: 'sess_1:demo.method', params: { a: 1 } });
    expect(res).toEqual({ ok: true, echoed: { a: 1 } });
  });

  it('retains structured error details when a plaintext handler throws', async () => {
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger,
    });
    rpc.registerHandler('demo.failure', async () => {
      throw new Error('handler failed');
    });

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.failure',
      params: {},
    })).resolves.toEqual({ error: 'handler failed' });

    const errorLog = logger.mock.calls.find(
      ([message]) => message === '[RPC] [ERROR] Error handling request',
    );
    expect(errorLog).toBeDefined();

    const serializedLogData = JSON.stringify(errorLog![1]);
    expect(serializedLogData).toContain('"name":"Error"');
    expect(serializedLogData).toContain('"message":"handler failed"');
    expect(serializedLogData).toContain('"stack":"Error: handler failed');
  });

  it('returns a method-not-found error object when handler is missing', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });

    const res = await rpc.handleRequest({ method: 'sess_1:missing.method', params: {} });
    expect(res).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('passes a server-stamped permission actor to the transport handler but never fabricates one locally', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    const authorization = {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
      sessionId: 'sess_1',
      actor: {
        kind: 'accountUser' as const,
        accountId: 'account-owner',
        relationship: 'owner' as const,
      },
    };

    rpc.registerHandler('demo.permission', async (_params, context) => context?.authorization ?? null);

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.permission',
      params: {},
      authorization,
    })).resolves.toEqual(authorization);
    await expect(rpc.invokeLocal('demo.permission', {})).resolves.toBeNull();
  });
});

describe('RpcHandlerManager.handleRequest (encrypted)', () => {
  it('passes the reserved Session server-start envelope through raw only for its stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(29);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = {
      kind: 'session.serverStart.serverOrigin',
    } as const;
    const rawEnvelope = {
      v: 1,
      kind: 'session.serverStart.dispatch',
      target: { accountId: 'account-1', machineId: 'machine-1', machineInstallationId: 'installation-1' },
      start: {
        automationId: 'automation-1',
        runId: 'run-1',
        origin: 'event',
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        requestEnvelope: { t: 'plain', v: { opaque: true } },
      },
    };
    const rawResult = { type: 'error', code: 'target_unavailable', retryable: true };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler('daemon.sessions.serverStart.dispatch', handler);

    await expect(rpc.handleRequest({
      method: 'machine-1:daemon.sessions.serverStart.dispatch',
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual(rawResult);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes the reserved external Action envelope through raw only for its stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(31);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = { kind: 'action.api.serverOrigin' } as const;
    const rawEnvelope = {
      actionId: 'session.get',
      envelope: { v: 1, target: { kind: 'machine', machineId: 'machine-1' }, input: {} },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    const rawResult = {
      v: 1,
      actionId: 'session.get',
      execution: { ok: false, errorCode: 'target_not_local', error: 'target_not_local' },
    };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler('daemon.actions.external.dispatch', handler);

    await expect(rpc.handleRequest({
      method: 'machine-1:daemon.actions.external.dispatch',
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0])).resolves.toEqual(rawResult);

    const missingOrigin = await rpc.handleRequest({
      method: 'machine-1:daemon.actions.external.dispatch',
      params: rawEnvelope,
    } as Parameters<typeof rpc.handleRequest>[0]);
    expect(typeof missingOrigin).toBe('string');
    expect(decrypt(
      encryptionKey,
      'dataKey',
      decodeBase64(missingOrigin as string),
    )).toEqual({
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes the reserved Automation reply-handoff envelope through raw only for the stamped server origin', async () => {
    const encryptionKey = new Uint8Array(32).fill(17);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const serverOrigin = {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
    } as const;
    const rawEnvelope = {
      v: 1,
      kind: 'automation.replyHandoff.dispatch',
      handoffId: 'handoff-1',
    };
    const rawResult = { kind: 'settled', settlement: { kind: 'accepted' } };
    const handler = vi.fn(async (params: unknown, context) => {
      expect(params).toEqual(rawEnvelope);
      expect(context?.authorization).toEqual(serverOrigin);
      return rawResult;
    });
    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, handler);

    const response = await rpc.handleRequest({
      method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
      params: rawEnvelope,
      authorization: serverOrigin,
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(response).toEqual(rawResult);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails closed before the reserved handler when the server-origin stamp is absent or malformed', async () => {
    const encryptionKey = new Uint8Array(32).fill(19);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const handler = vi.fn(async () => ({ kind: 'settled' }));
    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, handler);

    for (const authorization of [
      undefined,
      {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
        forged: true,
      },
    ]) {
      const response = await rpc.handleRequest({
        method: `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
        params: { v: 1, kind: 'automation.replyHandoff.dispatch' },
        ...(authorization ? { authorization } : {}),
      } as Parameters<typeof rpc.handleRequest>[0]);

      expect(typeof response).toBe('string');
      expect(decrypt(
        encryptionKey,
        'dataKey',
        decodeBase64(response as string),
      )).toEqual({
        error: RPC_ERROR_MESSAGES.FORBIDDEN,
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
      });
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps every other encrypted RPC encrypted even when it carries the Automation origin marker', async () => {
    const encryptionKey = new Uint8Array(32).fill(23);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    const handler = vi.fn(async () => ({ ok: true }));
    rpc.registerHandler('demo.other', handler);

    const response = await rpc.handleRequest({
      method: 'machine-1:demo.other',
      params: { raw: true },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
      },
    } as Parameters<typeof rpc.handleRequest>[0]);

    expect(handler).not.toHaveBeenCalled();
    expect(typeof response).toBe('string');
    expect(decrypt(
      encryptionKey,
      'dataKey',
      decodeBase64(response as string),
    )).toEqual({ error: 'Invalid RPC params' });
  });

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
  it('exposes only safe method timing while the actual handler is executing', async () => {
    const authorizationStarted = createDeferredVoid();
    const handlerStarted = createDeferredVoid();
    let nowMs = 1_000;

    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-secret-scope',
      encryptionMode: 'plain',
      logger: () => {},
      nowMs: () => nowMs,
      authorizeRequest: async () => {
        await authorizationStarted.promise;
        return { ok: true };
      },
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
    expect(rpc.getActiveHandlerExecutions()).toEqual([]);

    authorizationStarted.resolve();
    await vi.waitFor(() => expect(rpc.getActiveHandlerExecutions()).toHaveLength(1));
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

  it('tracks local handler execution without changing the caller signal', async () => {
    const handlerStarted = createDeferredVoid();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let nowMs = 5_000;
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-secret-scope',
      encryptionMode: 'plain',
      logger: () => {},
      nowMs: () => nowMs,
    });
    rpc.registerHandler('workspace.favicon.resolve', async (_params, context) => {
      observedSignal = context?.signal;
      await handlerStarted.promise;
      return null;
    });

    const requestPromise = rpc.invokeLocal('workspace.favicon.resolve', {}, {
      signal: controller.signal,
    });
    await Promise.resolve();
    nowMs = 5_400;

    expect(observedSignal).toBe(controller.signal);
    expect(rpc.getActiveHandlerExecutions()).toEqual([
      { method: 'workspace.favicon.resolve', activeForMs: 400 },
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

describe('RpcHandlerManager request lifetime', () => {
  it('aborts only the exact request correlated by a server-relayed cancellation', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
      encryptionMode: 'plain', logger: () => {},
    });
    const boundary = createSocketEventBoundary();
    let handlerStarts = 0;
    let secondSettled = false;
    rpc.registerHandler('demo.abort', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      handlerStarts += 1;
      await new Promise<void>((resolve) => context?.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { aborted: context?.signal.aborted === true };
    }) as Parameters<typeof rpc.registerHandler>[1]);
    rpc.onSocketConnect(boundary.socket);

    const first = rpc.handleRequest({
      method: 'sess_1:demo.abort', params: {}, requestId: 'relay-request-a',
    } as Parameters<typeof rpc.handleRequest>[0]);
    const second = rpc.handleRequest({
      method: 'sess_1:demo.abort', params: {}, requestId: 'relay-request-b',
    } as Parameters<typeof rpc.handleRequest>[0]).finally(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(handlerStarts).toBe(2));

    // This is emitted only by the authenticated server relay; the target owns
    // the mapping from its stamped request id to the active AbortController.
    boundary.trigger('rpc-cancel', { requestId: 'relay-request-a' });

    const firstSettled = await Promise.race([
      first.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(firstSettled).toEqual({ status: 'resolved', value: { aborted: true } });
    expect(secondSettled).toBe(false);

    boundary.trigger('rpc-cancel', { requestId: 'relay-request-b' });
    const secondSettledResult = await Promise.race([
      second.then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(secondSettledResult).toEqual({ status: 'resolved', value: { aborted: true } });
  });

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
