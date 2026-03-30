import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine terminal ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes daemon terminal ensure through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false });
        const { machineTerminalEnsure } = await import('./machineTerminal');

        const res = await machineTerminalEnsure(
            'machine-1',
            { terminalKey: 'k', cwd: '/tmp', cols: 80, rows: 24 },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, terminalId: 't1', reused: false });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
            payload: expect.objectContaining({ terminalKey: 'k', cwd: '/tmp', cols: 80, rows: 24 }),
        }));
    });

    it('routes daemon terminal stream reads through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, terminalId: 't1', events: [], nextCursor: 1, done: false });
        const { machineTerminalStreamRead } = await import('./machineTerminal');

        const res = await machineTerminalStreamRead(
            'machine-1',
            { terminalId: 't1', cursor: 0, maxBytes: 123, maxEvents: 10 },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, terminalId: 't1', events: [], nextCursor: 1, done: false });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
            payload: expect.objectContaining({ terminalId: 't1', cursor: 0, maxBytes: 123, maxEvents: 10 }),
        }));
    });

    it('routes terminal restart with an initial command through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, terminalId: 't2', reused: false });
        const { machineTerminalRestart } = await import('./machineTerminal');

        const res = await machineTerminalRestart(
            'machine-1',
            { terminalKey: 'provider-login:codex', cwd: '/tmp', cols: 100, rows: 30, initialCommand: 'codex login' },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, terminalId: 't2', reused: false });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_TERMINAL_RESTART,
            payload: expect.objectContaining({
                terminalKey: 'provider-login:codex',
                cwd: '/tmp',
                cols: 100,
                rows: 30,
                initialCommand: 'codex login',
            }),
        }));
    });
});
