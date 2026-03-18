import { describe, expect, it } from 'vitest';
import { stringifySerializedJsonValue } from '@happier-dev/protocol';

import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
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

  it('unwraps serialized JSON envelopes from encrypted rpc results', async () => {
    const dataKey = new Uint8Array(32).fill(7);
    const socket = {
      rpcCall: async () => ({
        ok: true,
        result: encryptDataKeyBase64(
          stringifySerializedJsonValue({
            ok: true,
            candidates: [{ remoteSessionId: 'sess-direct-core' }],
            nextCursor: null,
          }),
          dataKey,
        ),
      }),
    };

    const client = createDataKeyRpcClient(socket as any, dataKey);
    const res = await client.call('machine:daemon.directSessions.candidates.list', { providerId: 'claude' });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        candidates: [{ remoteSessionId: 'sess-direct-core' }],
        nextCursor: null,
      },
    });
  });

  it('unwraps cli-style serialized JSON objects from encrypted rpc results', async () => {
    const dataKey = new Uint8Array(32).fill(9);
    const socket = {
      rpcCall: async () => ({
        ok: true,
        result: encryptDataKeyBase64(
          {
            __happierSerializedJsonValueV1: true,
            type: 'json',
            value: {
              ok: true,
              candidates: [{ remoteSessionId: 'sess-direct-core' }],
              nextCursor: null,
            },
          },
          dataKey,
        ),
      }),
    };

    const client = createDataKeyRpcClient(socket as any, dataKey);
    const res = await client.call('machine:daemon.directSessions.candidates.list', { providerId: 'claude' });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        candidates: [{ remoteSessionId: 'sess-direct-core' }],
        nextCursor: null,
      },
    });
  });
});
