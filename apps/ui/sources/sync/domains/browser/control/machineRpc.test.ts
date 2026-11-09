import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

import {
    createBrowserDaemonControlCommandSender,
    dispatchBrowserDaemonControlCommandViaMachineRpc,
    listBrowserDaemonViewsViaMachineRpc,
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

    it.each(['throw', 'result'] as const)('keeps temporary routing loss retryable for commands and discovery (%s)', async carrier => {
        if (carrier === 'throw') machineRpcWithServerScopeMock.mockRejectedValue(new RpcError('Discovery failed', 'RPC_METHOD_NOT_AVAILABLE'));
        else machineRpcWithServerScopeMock.mockResolvedValue({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        const scope = { machineId: MACHINE_ID, serverId: SERVER_ID };
        expect(await dispatchBrowserDaemonControlCommandViaMachineRpc({ ...scope, command: RELOAD_COMMAND }))
            .toEqual({ ok: false, reason: 'request_failed' });
        expect(await listBrowserDaemonViewsViaMachineRpc({ ...scope, browserSessionId: RELOAD_COMMAND.browserSessionId }))
            .toEqual({ ok: false, reason: 'request_failed' });
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

    it.each(['result', 'throw'] as const)('keeps the managed-browser prerequisite from a typed %s', async (kind) => {
        if (kind === 'result') machineRpcWithServerScopeMock.mockResolvedValue({ error: 'Browser prerequisite', errorCode: 'managed_package_missing' });
        else machineRpcWithServerScopeMock.mockRejectedValue(new RpcError('Browser prerequisite', 'managed_package_missing'));
        const scope = { machineId: MACHINE_ID, serverId: SERVER_ID };
        expect(await dispatchBrowserDaemonControlCommandViaMachineRpc({ ...scope, command: RELOAD_COMMAND }))
            .toEqual({ ok: false, reason: 'managed_package_missing' });
        expect(await listBrowserDaemonViewsViaMachineRpc({ ...scope, browserSessionId: RELOAD_COMMAND.browserSessionId }))
            .toEqual({ ok: false, reason: 'managed_package_missing' });
    });
});

describe('createBrowserDaemonControlCommandSender', () => {
    it.each([
        [{ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' }, 'unavailable'],
        [{ protocolVersion: 1, result: { bogus: true } }, 'invalid_response'],
    ] as const)('returns the terminal transport outcome to the caller instead of swallowing it', async (response, reason) => {
        machineRpcWithServerScopeMock.mockResolvedValue(response);
        const send = createBrowserDaemonControlCommandSender({ machineId: MACHINE_ID, serverId: SERVER_ID });
        expect(await send(RELOAD_COMMAND)).toEqual({ ok: false, reason });
    });

    it('returns unknown delivery after the connection fails', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new Error('socket down'));
        const send = createBrowserDaemonControlCommandSender({ machineId: MACHINE_ID, serverId: SERVER_ID });
        expect(await send(RELOAD_COMMAND)).toEqual({ ok: false, reason: 'request_failed' });
    });

    it('feeds authoritative response events to the surface event sink', async () => {
        const event = { kind: 'navigationCommitted', eventId: 'redirect', browserSessionId: 'browser_session_1', viewId: 'view_1', occurredAt: 1, currentUrl: 'https://redirect.test/', navigationGeneration: 4 };
        const response = dispatchedResponse();
        machineRpcWithServerScopeMock.mockResolvedValue({ ...response, result: { ...response.result, events: [event] } });
        const onEvents = vi.fn();
        const send = createBrowserDaemonControlCommandSender({ machineId: MACHINE_ID, serverId: SERVER_ID });
        send(RELOAD_COMMAND, onEvents);
        await vi.waitFor(() => expect(onEvents).toHaveBeenCalledWith([event]));
    });
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
