import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machineSpawnNewSession error mapping', () => {
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
});
