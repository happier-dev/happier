import { describe, expect, it } from 'vitest';

import { createDataKeyRpcClient } from '../../src/testkit/syntheticAgent/rpcClient';

describe('testkit: synthetic agent rpc client', () => {
  it('fails closed when rpc success payload has non-string encrypted result', async () => {
    const socket = {
      rpcCall: async () => ({ ok: true, result: 123 }),
    };

    const client = createDataKeyRpcClient(socket as any, new Uint8Array(32));
    const res = await client.call('session:permission', { approved: true });

    expect(res).toEqual({ ok: false, error: 'invalid-rpc-result', errorCode: undefined });
  });
});
