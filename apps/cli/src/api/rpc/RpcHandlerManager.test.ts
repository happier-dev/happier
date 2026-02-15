import { describe, expect, it } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

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

