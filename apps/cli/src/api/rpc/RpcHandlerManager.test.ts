import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import {
  RPC_ERROR_CODES,
  RPC_METHODS,
  SESSION_RPC_METHODS,
  RPC_ERROR_MESSAGES,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import type { Socket } from 'socket.io-client';
import type { RpcHandlerContext } from './types';
import { computeExternalActionSocketRpcRequestDigestV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

const bindingCallId = '0123456789abcdef0123456789abcdef';
function rpcContent(key: Uint8Array): SocketRpcContent {
  return { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
    decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
  } };
}
function sealRpcRequest(key: Uint8Array, method: string, value: unknown) {
  return socketRpcCodec.encodeParams(rpcContent(key), value, { method, callId: bindingCallId });
}
async function openRpcResponse(key: Uint8Array, value: unknown) {
  // Pre-admission refusals have no authenticated call id and cannot claim success.
  if (typeof value !== 'string') return value;
  return socketRpcCodec.decodeResult(rpcContent(key), { ok: true, result: value }, bindingCallId);
}

it('preserves a Home-stamped Session Action origin and rejects malformed or user-labelled origins', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {} });
  rpc.registerHandler('session.notes.set', (_input: unknown, context?: RpcHandlerContext) => ({
    authority: context?.callerAuthority, origin: context?.sessionActionOrigin,
  }));
  const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 3 },
    callerPermissionMode: 'default' as const, sourceTurnId: 'original-turn', requestId: 'original-request' };
  const request = { method: 'child:session.notes.set', params: { sessionId: 'child', notes: 'Notes' },
    callerAuthority: 'account_automation' as const, sessionActionOrigin: origin };
  expect(await rpc.handleRequest(request)).toEqual({ authority: 'account_automation', origin });
  for (const refused of [
    { ...request, callerAuthority: 'present_user' as const },
    { ...request, sessionActionOrigin: { ...origin, caller: { ...origin.caller, turnDepth: -1 } } },
    { ...request, method: 'child:session.message.send' },
  ]) expect(await rpc.handleRequest(refused)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  const malformed = { ...request, sessionActionOrigin: { ...origin, caller: { kind: 'session' as const, sessionId: 'lead' } } };
  // @ts-expect-error The transport boundary must reject a Session origin without host-stamped depths.
  expect(await rpc.handleRequest(malformed)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('binds the Home-issued input proof to the exact opaque RPC before opening it', async () => {
  const encryptionKey = new Uint8Array(32).fill(17);
  const rpc = new RpcHandlerManager({ scopePrefix: 'session-a', localMachineId: 'machine-a',
    encryptionKey, encryptionVariant: 'dataKey', logger: () => {} });
  const effect = vi.fn(async (_input: unknown, context?: RpcHandlerContext) => ({
    proof: context?.callerInputAuthorization, constraints: context?.callerInputConstraints,
  }));
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, effect);
  const target = { kind: 'session' as const, sessionId: 'session-a' };
  const request = { method: `session-a:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
    requestId: 'rpc-input-1', params: await sealRpcRequest(encryptionKey, `session-a:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, { text: 'hello' }) };
  // The authenticated Home transport is the boundary here; downstream HTTP validates its signed token.
  const proof: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-issued-token', binding: {
    accountId: 'account-a', principalId: 'principal-a', credentialId: 'credential-a',
    serverIdentityId: 'server-a', machineId: 'machine-a', actionId: 'session.message.send',
    requestId: request.requestId, target,
    grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['read-only'] },
    requestEnvelopeDigest: computeExternalActionSocketRpcRequestDigestV1({ ...request, target }),
  } };
  const admitted = { ...request, callerInputAuthorization: proof,
    callerInputConstraints: { models: null, permissionModes: null } };
  expect(await openRpcResponse(encryptionKey, await rpc.handleRequest(admitted))).toEqual({
    proof, constraints: { models: null, permissionModes: ['read-only'] },
  });
  for (const refused of [
    { ...admitted, params: 'not-valid-ciphertext' },
    { ...admitted, requestId: 'rpc-input-2' },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, target: { kind: 'session' as const, sessionId: 'session-b' } } } },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, machineId: 'machine-b' } } },
    { ...admitted, callerInputAuthorization: { ...proof, binding: { ...proof.binding, actionId: 'session.goal.set' } } },
  ]) {
    expect(await openRpcResponse(encryptionKey, await rpc.handleRequest(refused)))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
  expect(effect).toHaveBeenCalledOnce();
});

it('rechecks Session transfer routing against the hosted namespace and decrypted init', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'session-a', encryptionMode: 'plain', logger: () => {} });
  const effect = vi.fn(async () => ({ success: true }));
  rpc.registerHandler(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, effect);
  const transferRouting = { method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, t: 'session_attachment_upload_v1' as const, sessionId: 'session-a' };
  const request = { method: `session-a:${transferRouting.method}`, transferRouting,
    params: { t: transferRouting.t, sessionId: 'session-a', fileName: 'notes.txt' } };
  expect(await rpc.handleRequest(request)).toEqual({ success: true });
  for (const refused of [
    { ...request, transferRouting: { ...transferRouting, sessionId: 'session-b' } },
    { ...request, params: { ...request.params, sessionId: 'session-b' } },
    { ...request, params: { ...request.params, t: 'session_file_upload_v1' } },
  ]) {
    expect(await rpc.handleRequest(refused)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
  expect(effect).toHaveBeenCalledOnce();
});

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createSocketEventBoundary(clientType?: 'machine-scoped' | 'session-scoped') {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    auth: { clientType },
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
    emit: socket.emit,
    trigger(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

describe('RpcHandlerManager registration receipts', () => {
  it.each(['machine-scoped', 'session-scoped'] as const)(
    'publishes only handlers owned by the %s socket across connect, late registration and replay',
    async (clientType) => {
      const rpc = new RpcHandlerManager({ scopePrefix: 'owner-1', encryptionMode: 'plain', logger: () => {} });
      const sessionMethods = [
        RPC_METHODS.SESSION_AGENT_TRANSITION,
        RPC_METHODS.SESSION_FORK,
        'execution.run.start',
        'execution.run.brokerAuthority.resolve.v1',
        'session.permission.respond',
        'session.user_action.answer',
        RPC_METHODS.TRANSCRIPT_PAGE,
        'session.unlisted',
        'managedServer.endpoint.unlisted',
        'abort',
      ];
      const machineMethods = [
        RPC_METHODS.BASH,
        RPC_METHODS.STOP_SESSION,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      ];
      const handler = async () => ({ ok: true });
      for (const method of [...machineMethods, ...sessionMethods.slice(0, -1)]) {
        rpc.registerHandler(method, handler);
      }
      const boundary = createSocketEventBoundary(clientType);
      const publishedMethods = () => boundary.emit.mock.calls
        .filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)
        .map(([, payload]) => payload.method);
      const allowedMethods = clientType === 'machine-scoped'
        ? machineMethods : [...machineMethods, ...sessionMethods];
      const expected = allowedMethods.map((method) => `owner-1:${method}`).sort();

      rpc.onSocketConnect(boundary.socket);
      // Late registration takes a different publication path from initial connect.
      rpc.registerHandler('abort', handler);
      expect(publishedMethods().sort()).toEqual(expected);
      boundary.emit.mockClear();
      expect([...rpc.replayUnacknowledgedHandlerRegistrations()].sort()).toEqual([...allowedMethods].sort());
      expect(publishedMethods().sort()).toEqual(expected);
      boundary.emit.mockClear();
      rpc.onSocketDisconnect();
      rpc.onSocketConnect(boundary.socket);
      expect(publishedMethods().sort()).toEqual(expected);

      // Daemon Actions still consume local handlers, even when they cannot be published.
      expect(await rpc.invokeLocal('execution.run.start', {})).toEqual({ ok: true });
      expect(await rpc.invokeLocal(RPC_METHODS.SESSION_SPAWN_NEW, {})).toEqual({ ok: true });
    },
  );

  it('logs one safe correlated rejection after repeated reconnects and retries only recoverable registrations', () => {
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger });
    rpc.registerHandler('session.unlisted', () => null);
    rpc.registerHandler('daemon.connectedAccounts.control.command', () => null);
    const boundary = createSocketEventBoundary();
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      rpc.onSocketConnect(boundary.socket);
      rpc.onSocketDisconnect();
    }
    rpc.onSocketConnect(boundary.socket);
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register', method: 'machine-1:session.unlisted',
      error: 'RPC method not available', retryable: false, secret: 'must-not-log',
    });
    expect(logger.mock.calls).toEqual([['[RPC] [ERROR] Handler registration rejected', {
      method: 'machine-1:session.unlisted', error: 'RPC method not available', retryable: false,
    }]]);
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register', method: 'machine-1:daemon.connectedAccounts.control.command',
      error: 'Machine unavailable', retryable: true,
    });
    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual(['daemon.connectedAccounts.control.command']);
    rpc.onSocketDisconnect();
    boundary.emit.mockClear();
    rpc.onSocketConnect(boundary.socket);
    expect(boundary.emit.mock.calls.map(([, payload]) => payload.method)).toEqual([
      'machine-1:session.unlisted', 'machine-1:daemon.connectedAccounts.control.command',
    ]);
    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual([
      'session.unlisted', 'daemon.connectedAccounts.control.command',
    ]);
    boundary.emit.mockClear();
    rpc.registerHandler('session.unlisted', () => null);
    expect(boundary.emit.mock.calls).toEqual([[SOCKET_RPC_EVENTS.REGISTER, { method: 'machine-1:session.unlisted' }]]);
    // An older relay has no retry classification; an uncorrelated refusal
    // cannot turn a legitimate registration into a permanent denial.
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Forbidden' });
    boundary.trigger(SOCKET_RPC_EVENTS.ERROR, { type: 'register', method: 'other:session.unlisted', retryable: false, error: 'secret response' });
    expect(JSON.stringify(logger.mock.calls)).not.toContain('secret response');
    rpc.onSocketDisconnect();
    boundary.emit.mockClear();
    rpc.onSocketConnect(boundary.socket);
    expect(boundary.emit.mock.calls.map(([, payload]) => payload.method)).toEqual([
      'machine-1:session.unlisted', 'machine-1:daemon.connectedAccounts.control.command',
    ]);
  });

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

  it('replays every current unacknowledged handler when no subset is supplied', () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('core.spawn', async () => ({ ok: true }));
    rpc.registerHandler('optional.status', async () => ({ ok: true }));
    const boundary = createSocketEventBoundary();

    rpc.onSocketConnect(boundary.socket);
    boundary.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: 'machine-1:core.spawn' });
    boundary.emit.mockClear();

    expect(rpc.replayUnacknowledgedHandlerRegistrations()).toEqual(['optional.status']);
    expect(boundary.emit).toHaveBeenCalledTimes(1);
    expect(boundary.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:optional.status',
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

  it('projects only explicit protocol RPC error codes into the plaintext response', async () => {
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    rpc.registerHandler('demo.typedFailure', async () => {
      throw new RpcError('workspace root is unsafe', 'workspace_root_unsafe');
    });
    rpc.registerHandler('demo.filesystemFailure', async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(rpc.handleRequest({
      method: 'sess_1:demo.typedFailure',
      params: {},
    })).resolves.toEqual({
      error: 'workspace root is unsafe',
      errorCode: 'workspace_root_unsafe',
    });
    await expect(rpc.handleRequest({
      method: 'sess_1:demo.filesystemFailure',
      params: {},
    })).resolves.toEqual({ error: 'permission denied' });
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
  it('projects only validated server input constraints and refuses malformed constraints before dispatch', async () => {
    const encryptionKey = new Uint8Array(32).fill(26);
    const rpc = new RpcHandlerManager({ scopePrefix: 'sess_1', encryptionKey, encryptionVariant: 'dataKey', logger: () => {} });
    let executed = false;
    rpc.registerHandler('demo.constraints', async (_params, context) => {
      executed = true;
      return { constraints: context && 'callerInputConstraints' in context ? context.callerInputConstraints : null };
    });
    const params = await sealRpcRequest(encryptionKey, 'sess_1:demo.constraints', { callerInputConstraints: { models: null, permissionModes: null } });
    const decode = (result: unknown) => openRpcResponse(encryptionKey, result);
    const constraints = { models: null, permissionModes: ['read-only'] } as const;
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params,
      callerInputConstraints: { ...constraints, permissionModes: [...constraints.permissionModes] },
    }))).toEqual({ constraints });
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params }))).toEqual({ constraints: null });
    executed = false;
    expect(await decode(await rpc.handleRequest({ method: 'sess_1:demo.constraints', params,
      callerInputConstraints: { models: null, permissionModes: ['invalid'] },
    } as unknown as Parameters<typeof rpc.handleRequest>[0]))).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(executed).toBe(false);
  });

  it('uses only the server authority stamp and defaults unstamped requests to automation', async () => {
    const encryptionKey = new Uint8Array(32).fill(27);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1', encryptionKey, encryptionVariant: 'dataKey', logger: () => {},
    });
    rpc.registerHandler('demo.authority', async (_params, context) => ({ authority: context?.callerAuthority }));
    const params = await sealRpcRequest(encryptionKey, 'sess_1:demo.authority', { callerAuthority: 'present_user' });
    for (const callerAuthority of [undefined, 'account_automation', 'present_user'] as const) {
      const result = await rpc.handleRequest({ method: 'sess_1:demo.authority', params,
        ...(callerAuthority ? { callerAuthority } : {}),
      });
      expect(await openRpcResponse(encryptionKey, result as string)).toEqual({
        authority: callerAuthority ?? 'account_automation',
      });
    }
  });

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
        attempt: 3,
        claimedByMachineId: 'machine-source',
        cause: { kind: 'manual', invokedAt: 1 },
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
    expect(missingOrigin).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await openRpcResponse(encryptionKey, missingOrigin as string)).toEqual({
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

      expect(response).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await openRpcResponse(encryptionKey, response as string)).toEqual({
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
    expect(response).toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
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
      params: await sealRpcRequest(encryptionKey, 'machine_1:demo.stop', { sessionId: 'sess_1' }),
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
      await openRpcResponse(encryptionKey, encryptedResult as string),
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
      params: await sealRpcRequest(encryptionKey, 'machine_1:demo.secure', { sessionId: 'sess_1' }),
      authorization: { kind: 'session.write', sessionId: 'sess_1' },
      transportResponseEnvelopeVersion: 1,
    });

    expect(handlerCalled).toBe(false);
    expect(res).toMatchObject({ v: 1 });
    const encryptedResult = (res as { result: unknown }).result;
    expect(typeof encryptedResult).toBe('string');
    expect(await openRpcResponse(encryptionKey, encryptedResult as string)).toEqual({
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
      params: await sealRpcRequest(encryptionKey, 'sess_1:demo.method', undefined),
    });

    expect(typeof res).toBe('string');
    expect(
      await openRpcResponse(encryptionKey, res as string),
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
      params: await sealRpcRequest(encryptionKey, 'sess_1:demo.undefined', { ok: true }),
    });

    expect(typeof res).toBe('string');
    expect(
      await openRpcResponse(encryptionKey, res as string),
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
    let handlerStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    rpc.registerHandler('demo.abort', (async (_request: unknown, context?: { signal: AbortSignal }) => {
      if (!context) return { aborted: false };
      const aborted = new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      handlerStarted();
      await aborted;
      return { aborted: context.signal.aborted };
    }) as Parameters<typeof rpc.registerHandler>[1]);

    const pending = rpc.handleRequest({ method: 'sess_1:demo.abort', params: {} });
    await started;
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
