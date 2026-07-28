import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import { PUBLIC_RPC_HANDLER_ERROR_CODES, PublicRpcHandlerError } from '@happier-dev/protocol/rpcErrors';

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it('returns an allowlisted public failure without the private handler message', async () => {
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger,
    });
    rpc.registerHandler('permission', async () => {
      throw new PublicRpcHandlerError(
        PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER,
        'private question and answer',
      );
    });

    const res = await rpc.handleRequest({ method: 'sess_1:permission', params: {} });
    expect(res).toEqual({
      type: 'socket-rpc-target-failure-v1',
      errorCode: 'STRUCTURED_QUESTION_RECEIVER_NOT_OWNER',
      error: 'This answer could not be handled safely. Update or reconnect Happier, then try again.',
    });
    expect(JSON.stringify(res)).not.toContain('private question');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private question');
  });
});

describe('RpcHandlerManager.handleRequest (encrypted)', () => {
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

  it('returns the public target-failure envelope outside encryption', async () => {
    const encryptionKey = new Uint8Array(32).fill(4);
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger,
    });
    rpc.registerHandler('session.structuredQuestion.respond.v1', async () => {
      throw new PublicRpcHandlerError(
        PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
        'private payload',
      );
    });

    const res = await rpc.handleRequest({
      method: 'sess_1:session.structuredQuestion.respond.v1',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', {})),
    });
    expect(res).toEqual(expect.objectContaining({
      type: 'socket-rpc-target-failure-v1',
      errorCode: 'STRUCTURED_QUESTION_INVALID',
    }));
    expect(JSON.stringify(res)).not.toContain('private payload');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private payload');
  });

  it('keeps explicit public-handler errors encrypted for unrelated RPC methods', async () => {
    const encryptionKey = new Uint8Array(32).fill(6);
    const rpc = new RpcHandlerManager({
      scopePrefix: 'sess_1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    rpc.registerHandler('demo.unrelated', async () => {
      throw new PublicRpcHandlerError(
        PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
        'private unrelated failure',
      );
    });

    const res = await rpc.handleRequest({
      method: 'sess_1:demo.unrelated',
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', {})),
    });

    expect(typeof res).toBe('string');
    expect(decrypt(encryptionKey, 'dataKey', decodeBase64(res as string))).toEqual({
      error: 'private unrelated failure',
    });
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
});
