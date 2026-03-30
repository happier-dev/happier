import { beforeEach, describe, expect, it, vi } from 'vitest';


const machineRpcWithServerScopeMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (args: unknown) => machineRpcWithServerScopeMock(args),
}));

describe('machineRipgrep', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes ripgrep via server-scoped machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            stdout: 'src/a.ts\n',
            stderr: '',
            exitCode: 0,
        });

        const { machineRipgrep } = await import('./machineRipgrep');

        const res = await machineRipgrep('m1', ['--files'], '/repo', { serverId: 'server-a' });
        expect(res.success).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            method: 'ripgrep',
            payload: { args: ['--files'], cwd: '/repo' },
            serverId: 'server-a',
            timeoutMs: undefined,
        });
    });

    it('fails closed on RPC error', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('boom'));
        const { machineRipgrep } = await import('./machineRipgrep');

        const res = await machineRipgrep('m1', ['--files'], '/repo');
        expect(res.success).toBe(false);
        expect(res.error).toContain('boom');
    });

    it('fails closed on an unexpected RPC response shape', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            stdout: 123,
        });

        const { machineRipgrep } = await import('./machineRipgrep');

        const res = await machineRipgrep('m1', ['--files']);
        expect(res.success).toBe(false);
        expect(res.error).toContain('Unsupported');
    });
});
