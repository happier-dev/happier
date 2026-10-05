import { describe, expect, it, vi } from 'vitest';
import { machineReadSessionLogTail } from './machines';

// Socket transport is the boundary; the machine operation and its routing remain real.
const machineRPC = vi.hoisted(() => vi.fn());
vi.mock('../api/session/apiSocket', () => ({ apiSocket: { machineRPC } }));

describe('machineReadSessionLogTail', () => {
    it('reads an explicit log path through the machine diagnostics method', async () => {
        const response = { success: true, path: '/happier/logs/session.log', tail: 'last line', truncated: true };
        machineRPC.mockResolvedValueOnce(response);

        await expect(machineReadSessionLogTail('machine-1', {
            path: response.path, maxBytes: 32_000,
        }, { timeoutMs: 5_000 })).resolves.toEqual(response);
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'daemon.session.log.tail', {
            path: response.path, maxBytes: 32_000,
        }, { timeoutMs: 5_000 });
    });

    it('preserves a transport failure as a failed diagnostic read', async () => {
        machineRPC.mockRejectedValueOnce(new Error('Machine offline'));
        await expect(machineReadSessionLogTail('machine-1', { path: '/happier/logs/session.log' }))
            .resolves.toEqual({ success: false, error: 'Machine offline' });
    });
});
