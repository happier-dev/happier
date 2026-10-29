import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineTerminalList } from './machineTerminal';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine terminal ops (server-scoped routing)', () => {
    it('cancels a creation observer without releasing physical creation custody', async () => {
        const { awaitPendingMachineTerminalCreation, trackPendingMachineTerminalCreation } = await import('./machineTerminal');
        let finishCreation!: () => void;
        const creation = trackPendingMachineTerminalCreation('machine-wait', 'terminal-wait', () =>
            new Promise<void>(resolve => { finishCreation = resolve; }));
        const controller = new AbortController();
        let cancelled = false;
        const observation = awaitPendingMachineTerminalCreation('machine-wait', 'terminal-wait', { signal: controller.signal })
            .catch(() => { cancelled = true; });
        controller.abort();
        await vi.waitFor(() => expect(cancelled).toBe(true));
        let stillPending = true;
        const otherObservation = awaitPendingMachineTerminalCreation('machine-wait', 'terminal-wait').then(() => { stillPending = false; });
        await Promise.resolve();
        expect(stillPending).toBe(true);
        finishCreation();
        await Promise.all([creation, observation, otherObservation]);
        expect(stillPending).toBe(false);
    });

    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('lists attributed terminals on the selected Home and only degrades for an unavailable method', async () => {
        const response = { ok: true, terminals: [{ terminalId: 't1', terminalKey: 'shell', cwd: '/project', sessionId: 'other-session', ended: false, exit: null }] };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(response);
        await expect(machineTerminalList('machine-1', { serverId: 'server-a' })).resolves.toEqual(response);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', serverId: 'server-a', method: 'daemon.terminal.list', payload: {},
        }));
        machineRpcWithServerScopeMock.mockRejectedValueOnce({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        await expect(machineTerminalList('machine-1')).resolves.toBeNull();
        const denied = Object.assign(new Error('denied'), { rpcErrorCode: 'FORBIDDEN' });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(denied);
        await expect(machineTerminalList('machine-1')).rejects.toBe(denied);
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ...response, internal: 'secret' });
        await expect(machineTerminalList('machine-1')).rejects.toThrow('Unsupported response');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: false, errorCode: 'terminal_disabled', error: 'terminal_disabled' });
        await expect(machineTerminalList('machine-1')).resolves.toEqual({ ok: false, errorCode: 'terminal_disabled', error: 'terminal_disabled' });
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

    it('makes a 0.2 package-script rejection operation-specific without retrying or disabling shell and attach', async () => {
        const { machineTerminalEnsure, machineTerminalRestart } = await import('./machineTerminal');
        const rejected = { ok: false, errorCode: 'terminal_invalid_request', error: 'terminal_invalid_request' };
        for (const create of [machineTerminalEnsure, machineTerminalRestart]) {
            machineRpcWithServerScopeMock.mockResolvedValueOnce(rejected);
            await expect(create('machine-1', {
                terminalKey: 'script', launch: { kind: 'package_script', runTargetId: 'script:test' },
            })).resolves.toEqual({ ...rejected, error: 'cli_update_required' });
        }
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        for (const request of machineRpcWithServerScopeMock.mock.calls) {
            expect(request[0].payload).toEqual({
                terminalKey: 'script', launch: { kind: 'package_script', runTargetId: 'script:test' },
            });
        }
        const success = { ok: true, terminalId: 'shell', reused: false };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(success).mockResolvedValueOnce(success);
        await expect(machineTerminalEnsure('machine-1', { terminalKey: 'plain' })).resolves.toEqual(success);
        await expect(machineTerminalEnsure('machine-1', {
            terminalKey: 'attach', launch: { kind: 'session_attach', sessionId: 'session-1' },
        })).resolves.toEqual(success);
        // Current-daemon domain refusals are not mistaken for version skew.
        const denied = { ...rejected, error: 'project_workspace_changed' };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(denied);
        await expect(machineTerminalEnsure('machine-1', {
            terminalKey: 'script', launch: { kind: 'package_script', runTargetId: 'script:test' },
        })).resolves.toEqual(denied);
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

    it('routes terminal restart with a typed login through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, terminalId: 't2', reused: false });
        const { machineTerminalRestart } = await import('./machineTerminal');

        const res = await machineTerminalRestart(
            'machine-1',
            { terminalKey: 'provider-login:codex', cwd: '/tmp', cols: 100, rows: 30, launch: { kind: 'agent_login', agentId: 'codex' } },
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
                launch: { kind: 'agent_login', agentId: 'codex' },
            }),
        }));
    });
});
