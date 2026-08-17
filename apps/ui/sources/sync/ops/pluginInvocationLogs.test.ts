import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const target = {
    serverId: 'server-profile-a',
    serverIdentityId: 'srv_plugin_logs',
    machineId: 'machine-2',
} as const;

function availableResponse() {
    return {
        version: 1 as const,
        kind: 'available' as const,
        records: [{
            version: 1 as const,
            kind: 'plugin_invocation_log' as const,
            level: 'info' as const,
            message: 'redacted message',
            context: {
                plugin: { id: 'example.plugin', version: '1.0.0' },
                contribution: { id: 'action.run', qualifiedId: 'example.plugin/action.run' },
                generation: 'generation-1',
                correlationId: 'correlation-1',
                surface: 'action',
            },
            occurredAtMs: 123,
            sequence: 4,
        }],
        cursor: 456,
        hasMore: false,
    };
}

describe('plugin invocation log machine read', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes the exact current machine through the shared RPC transport with host-stamped filtering', async () => {
        const controller = new AbortController();
        machineRpcWithServerScopeMock.mockResolvedValueOnce(availableResponse());
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: {
                pluginId: 'example.plugin',
                correlationId: 'correlation-1',
                cursor: 300,
                limit: 100,
            },
            signal: controller.signal,
        })).resolves.toEqual(availableResponse());

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledExactlyOnceWith({
            machineId: 'machine-2',
            serverId: 'server-profile-a',
            method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
            signal: controller.signal,
            payload: {
                version: 1,
                target: {
                    serverIdentityId: 'srv_plugin_logs',
                    machineId: 'machine-2',
                },
                query: {
                    pluginId: 'example.plugin',
                    correlationId: 'correlation-1',
                    cursor: 300,
                    limit: 100,
                },
            },
        });
    });

    it('does not reinterpret an unsupported daemon response as an empty log page', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'available', records: [] });
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: { pluginId: 'example.plugin' },
        })).rejects.toThrow('Plugin invocation log response was invalid');
    });

    it.each([
        RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
    ])('maps the typed daemon method-absence code %s to the strict reader-unavailable response', async (rpcErrorCode) => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(
            new Error('Plugin invocation logs RPC is absent'),
            { rpcErrorCode },
        ));
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: { pluginId: 'example.plugin' },
        })).resolves.toEqual({
            version: 1,
            kind: 'unavailable',
            code: 'plugin_log_reader_unavailable',
        });
    });

    it('preserves unrelated typed RPC failures instead of presenting them as reader unavailability', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(
            new Error('The caller is forbidden'),
            { rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN },
        ));
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: { pluginId: 'example.plugin' },
        })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    });

    it('preserves cancellation when a typed method-absence error races the UI lifetime', async () => {
        const controller = new AbortController();
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => {
            controller.abort();
            throw Object.assign(
                new Error('Plugin invocation logs RPC is absent'),
                { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND },
            );
        });
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: { pluginId: 'example.plugin' },
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not issue a read after the UI lifetime has already been cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const { readPluginInvocationLogsOnMachine } = await import('./pluginInvocationLogs');

        await expect(readPluginInvocationLogsOnMachine({
            target,
            query: { pluginId: 'example.plugin' },
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
