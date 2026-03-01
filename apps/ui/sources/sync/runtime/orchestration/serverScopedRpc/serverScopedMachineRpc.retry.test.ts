import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    machineRPC: (...args: unknown[]) => machineRpcSpy(...args),
  },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

describe('machineRpcWithServerScope (retry)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    machineRpcSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries once when rpc method is not available (active scope)', async () => {
    machineRpcSpy
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }))
      .mockResolvedValueOnce({ ok: true });

    const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');

    const p = machineRpcWithServerScope({
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 1 },
    });

    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(machineRpcSpy).toHaveBeenCalledTimes(2);
  });
});
