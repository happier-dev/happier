import { describe, expect, it, vi } from 'vitest';

import { callMachineRpcWhenRegistered } from './machineRpcReadiness';

describe('callMachineRpcWhenRegistered', () => {
  it('retries only the exact method-unavailable envelope', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
      .mockResolvedValueOnce({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
      .mockResolvedValueOnce({ ok: true, result: 'ready' });

    await expect(callMachineRpcWhenRegistered({
      call,
      timeoutMs: 2_000,
      context: 'test RPC registration',
    })).resolves.toEqual({ ok: true, result: 'ready' });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('returns a routed failure without retrying it', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, errorCode: 'RPC_FORBIDDEN' });

    await expect(callMachineRpcWhenRegistered({
      call,
      timeoutMs: 500,
      context: 'test RPC registration',
    })).resolves.toEqual({ ok: false, errorCode: 'RPC_FORBIDDEN' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret a thrown error message as method unavailability', async () => {
    const call = vi.fn().mockRejectedValue(new Error('RPC_METHOD_NOT_AVAILABLE transport failure'));

    await expect(callMachineRpcWhenRegistered({
      call,
      timeoutMs: 500,
      context: 'test RPC registration',
    })).rejects.toThrow('RPC_METHOD_NOT_AVAILABLE transport failure');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
