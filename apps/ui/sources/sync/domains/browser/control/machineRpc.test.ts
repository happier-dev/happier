import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

import {
    createBrowserDaemonControlCommandSender,
    dispatchBrowserDaemonControlCommandViaMachineRpc,
} from './machineRpc';

const MACHINE_ID = 'machine_1';
const SERVER_ID = 'server_1';

const RELOAD_COMMAND = {
    kind: 'reload',
    commandId: 'command_reload',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
} satisfies BrowserCommandV1;

function dispatchedResponse() {
    return {
        protocolVersion: 1,
        result: {
            v: 1,
            commandId: 'command_reload',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
            events: [],
        },
    };
}

describe('dispatchBrowserDaemonControlCommandViaMachineRpc', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes the command over the daemon browser control machine RPC and returns the dispatch result', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue(dispatchedResponse());

        const result = await dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            command: RELOAD_COMMAND,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            method: RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
            payload: { machineId: MACHINE_ID, command: RELOAD_COMMAND },
        }));
        expect(result).toEqual({
            ok: true,
            result: {
                v: 1,
                commandId: 'command_reload',
                status: 'dispatched',
                adapterKind: 'chromiumSidecar',
                events: [],
            },
        });
    });

    it('maps a method-not-found transport result to unavailable', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            error: 'Method not found',
            errorCode: 'RPC_METHOD_NOT_FOUND',
        });

        const result = await dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            command: RELOAD_COMMAND,
        });

        expect(result).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('maps a malformed response to invalid_response', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ protocolVersion: 1, result: { bogus: true } });

        const result = await dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            command: RELOAD_COMMAND,
        });

        expect(result).toEqual({ ok: false, reason: 'invalid_response' });
    });

    it('maps a transport throw to request_failed', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new Error('socket down'));

        const result = await dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            command: RELOAD_COMMAND,
        });

        expect(result).toEqual({ ok: false, reason: 'request_failed' });
    });
});

describe('createBrowserDaemonControlCommandSender', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('fires the command transport and forwards the result to the observability sink', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue(dispatchedResponse());
        const onResult = vi.fn();
        const send = createBrowserDaemonControlCommandSender({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            onResult,
        });

        send(RELOAD_COMMAND);
        await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

        expect(onResult).toHaveBeenCalledWith({
            ok: true,
            result: expect.objectContaining({ status: 'dispatched' }),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
        }));
    });
});
