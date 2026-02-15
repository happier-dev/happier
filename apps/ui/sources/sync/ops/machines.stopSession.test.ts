import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine stop session ops server-scoped routing', () => {
  beforeEach(() => {
    machineRpcWithServerScopeMock.mockReset();
  });

  it('routes stop-session through server-scoped machine rpc', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ message: 'Session stopped' });
    const { machineStopSession } = await import('./machines');

    const result = await machineStopSession('machine-1', 'session-1', { serverId: 'server-a' });

    expect(result).toEqual({ ok: true });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-a',
      method: 'stop-session',
      payload: { sessionId: 'session-1' },
    }));
  });
});

