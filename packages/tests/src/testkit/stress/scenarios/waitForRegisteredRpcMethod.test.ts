import { describe, expect, it, vi } from 'vitest';

import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';

describe('waitForRegisteredRpcMethod', () => {
  it('retries through RPC_METHOD_NOT_AVAILABLE until the registered listener becomes routable', async () => {
    const rpcCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
      .mockResolvedValueOnce({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
      .mockResolvedValueOnce({
        ok: true,
        result: JSON.stringify({ ok: true, machineId: 'machine-1' }),
      });

    await expect(
      waitForRegisteredRpcMethod({
        ui: { rpcCall },
        method: 'session-1:stress.rpc.0',
        expectedMachineId: 'machine-1',
        timeoutMs: 2_000,
      }),
    ).resolves.toBeUndefined();

    expect(rpcCall).toHaveBeenCalledTimes(3);
  });

  it('fails when the ready method resolves to the wrong listener', async () => {
    const rpcCall = vi.fn().mockResolvedValue({
      ok: true,
      result: JSON.stringify({ ok: true, machineId: 'machine-2' }),
    });

    await expect(
      waitForRegisteredRpcMethod({
        ui: { rpcCall },
        method: 'session-1:stress.rpc.0',
        expectedMachineId: 'machine-1',
        timeoutMs: 500,
      }),
    ).rejects.toThrow('wrong listener');
  });
});
