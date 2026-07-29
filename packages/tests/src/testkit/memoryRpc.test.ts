import { describe, expect, it } from 'vitest';

import { callEncryptedMachineRpc, type MemoryRpcSchema } from './memoryRpc';
import { encryptLegacyBase64 } from './messageCrypto';

const passthroughSchema: MemoryRpcSchema<unknown> = {
  safeParse: (input: unknown) => ({ success: true, data: input }),
};

describe('callEncryptedMachineRpc', () => {
  it('fails fast when the machine RPC returns an explicit error envelope', async () => {
    let calls = 0;

    await expect(
      callEncryptedMachineRpc({
        ui: {
          rpcCall: async () => {
            calls += 1;
            return {
              ok: false,
              errorCode: 'memory_index_unavailable',
              error: 'index is disabled',
            };
          },
        },
        machineId: 'machine-1',
        method: 'memory.search',
        req: {},
        secret: new Uint8Array(32),
        schema: passthroughSchema,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/memory_index_unavailable.*index is disabled|index is disabled.*memory_index_unavailable/);

    expect(calls).toBe(1);
  });

  it('fails fast when the encrypted machine handler result contains an explicit error', async () => {
    const secret = new Uint8Array(32);
    let calls = 0;

    await expect(
      callEncryptedMachineRpc({
        ui: {
          rpcCall: async () => {
            calls += 1;
            return {
              ok: true,
              result: encryptLegacyBase64({
                errorCode: 'projection_unavailable',
                error: 'projection failed',
              }, secret),
            };
          },
        },
        machineId: 'machine-1',
        method: 'daemon.extensions.contributionRegistryProjection.describe',
        req: {},
        secret,
        schema: {
          safeParse: () => ({ success: false }),
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/projection_unavailable.*projection failed|projection failed.*projection_unavailable/);

    expect(calls).toBe(1);
  });

  it('reports the last schema error when the decrypted response never satisfies the response schema', async () => {
    const secret = new Uint8Array(32);

    await expect(
      callEncryptedMachineRpc({
        ui: {
          rpcCall: async () => ({
            ok: true,
            result: encryptLegacyBase64({ unexpected: 'shape' }, secret),
          }),
        },
        machineId: 'machine-1',
        method: 'memory.search',
        req: {},
        secret,
        schema: {
          safeParse: () => ({ success: false, error: new Error('invalid test shape') }),
        },
        timeoutMs: 25,
      }),
    ).rejects.toThrow(
      'last schema error: invalid test shape; invalid response shape: object keys=[unexpected] protocolVersion=absent projection=absent',
    );
  });
});
