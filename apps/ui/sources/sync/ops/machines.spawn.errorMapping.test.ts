import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machineSpawnNewSession error mapping', () => {
  beforeEach(() => {
    machineRpcWithServerScopeMock.mockReset();
  });

  it('returns a descriptive error when daemon RPC method is not available', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE);
    expect(result.errorMessage.toLowerCase()).toContain('daemon');
    expect(result.errorMessage.toLowerCase()).toContain('rpc');
  });

  it('uses an extended RPC timeout for spawn session calls', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      serverId: 'server-b',
    });

    expect(result.type).toBe('success');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ timeoutMs: expect.any(Number) });
    expect(call.timeoutMs).toBeGreaterThanOrEqual(90_000);
  });

  it('maps socket ack timeouts to SESSION_WEBHOOK_TIMEOUT', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('operation has timed out'));

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT);
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage.length).toBeGreaterThan(0);
  });
});
