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

    it('routes byte-stream reads through server-scoped machine rpc and preserves invalid UTF-8 bytes', async () => {
        const bytes = Uint8Array.from([0, 255, 195, 40, 27]);
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            terminalId: 't1',
            frames: [{
                t: 'bytes',
                terminalId: 't1',
                seq: 1,
                byteOffset: 0,
                byteLength: bytes.byteLength,
                encoding: 'base64',
                data: 'AP/DKBs=',
            }],
            nextByteOffset: bytes.byteLength,
            availableByteOffset: bytes.byteLength,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        const {
            decodeMachineTerminalBytesFrame,
            machineTerminalStreamReadBytes,
        } = await import('./machineTerminal');

        expect(typeof machineTerminalStreamReadBytes).toBe('function');

        const res = await machineTerminalStreamReadBytes(
            'machine-1',
            { terminalId: 't1', byteOffset: 0, maxBytes: 123, maxFrames: 10 },
            { serverId: 'server-a' },
        );

        expect(res.ok).toBe(true);
        if (!res.ok) {
            throw new Error('expected byte stream read to succeed');
        }
        const firstFrame = res.frames[0];
        expect(firstFrame).toBeDefined();
        expect(firstFrame?.t).toBe('bytes');
        if (!firstFrame || firstFrame.t !== 'bytes') {
            throw new Error('expected first terminal stream frame to be a bytes frame');
        }
        expect(Array.from(decodeMachineTerminalBytesFrame(firstFrame))).toEqual(Array.from(bytes));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
            payload: expect.objectContaining({ terminalId: 't1', byteOffset: 0, maxBytes: 123, maxFrames: 10 }),
        }));
    });

    it('routes byte-stream acknowledgements and typed input through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true });
        const {
            machineTerminalStreamAcknowledge,
            machineTerminalStreamSendInput,
        } = await import('./machineTerminal');

        await expect(machineTerminalStreamAcknowledge(
            'machine-1',
            { terminalId: 't1', ackedByteOffset: 4096, rendererId: 'xterm-web', surfaceEpoch: 2, creditBytes: 8192 },
            { serverId: 'server-a' },
        )).resolves.toEqual({ ok: true });
        await expect(machineTerminalStreamSendInput(
            'machine-1',
            { terminalId: 't1', event: { t: 'paste', text: 'hello', bracketed: true } },
            { serverId: 'server-a' },
        )).resolves.toEqual({ ok: true });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
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
