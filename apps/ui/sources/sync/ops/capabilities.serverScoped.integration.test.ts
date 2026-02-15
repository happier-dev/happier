import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('capabilities ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes describe requests with server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            capabilities: [],
            checklists: {},
        });
        const { machineCapabilitiesDescribe } = await import('./capabilities');

        const result = await machineCapabilitiesDescribe('machine-1', { serverId: 'server-a' });

        expect(result).toEqual({
            supported: true,
            response: {
                protocolVersion: 1,
                capabilities: [],
                checklists: {},
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
        }));
    });

    it('routes detect and invoke requests with server id', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                protocolVersion: 1,
                results: {},
            })
            .mockResolvedValueOnce({
                ok: true,
                result: { accepted: true },
            });

        const { machineCapabilitiesDetect, machineCapabilitiesInvoke } = await import('./capabilities');
        const invokeRequest = {
            id: 'tool.install',
            method: 'run',
            params: {},
        } as const;

        const detectResult = await machineCapabilitiesDetect(
            'machine-2',
            { checklistId: 'new_session' },
            { serverId: 'server-b', timeoutMs: 2500 },
        );
        const invokeResult = await machineCapabilitiesInvoke(
            'machine-2',
            invokeRequest,
            { serverId: 'server-b', timeoutMs: 30_000 },
        );

        expect(detectResult).toEqual({
            supported: true,
            response: {
                protocolVersion: 1,
                results: {},
            },
        });
        expect(invokeResult).toEqual({
            supported: true,
            response: {
                ok: true,
                result: { accepted: true },
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-b',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-b',
        }));
    });
});
