import { describe, expect, it } from 'vitest';

import { callEncryptedMachineRpc, type MemoryRpcSchema } from './memoryRpc';

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
});
