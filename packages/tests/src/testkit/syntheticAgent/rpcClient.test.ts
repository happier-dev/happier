import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDataKeyRpcClient } from './rpcClient';
import { encryptDataKeyBase64 } from '../rpcCrypto';

describe('createDataKeyRpcClient', () => {
  it('forwards an explicit rpc timeout to the socket collector', async () => {
    const dataKey = new Uint8Array(32).fill(7);
    const rpcCalls: Array<{ method: string; params: string; timeoutMs?: number }> = [];
    const rpcCall = async <T = unknown>(method: string, params: string, timeoutMs?: number): Promise<T> => {
      rpcCalls.push({ method, params, timeoutMs });
      return {
        ok: true,
        result: encryptDataKeyBase64({ persisted: true }, dataKey),
      } as unknown as T;
    };

    const client = createDataKeyRpcClient({ rpcCall }, dataKey);
    await expect(client.call(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER, {
      linkedSessionId: 'sess_1',
      storageMode: 'persisted',
    }, 60_000)).resolves.toEqual({
      ok: true,
      result: { persisted: true },
    });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.method).toBe(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER);
    expect(rpcCalls[0]?.timeoutMs).toBe(60_000);
    expect(rpcCalls[0]?.params).toEqual(expect.any(String));
  });
});
