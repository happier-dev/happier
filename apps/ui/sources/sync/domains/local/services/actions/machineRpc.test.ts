import type {
    LocalServiceActionAuditEventV1,
    LocalServiceActionResultV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

const request = {
    requestId: 'request_1',
    target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
    action: 'copy_url' as const,
    force: false,
};

const auditEvent = {
    v: 1 as const,
    eventId: 'request_1:0:succeeded',
    requestId: 'request_1',
    machineId: 'machine_1',
    action: 'copy_url' as const,
    result: 'succeeded' as const,
    recordedAt: 1_000,
} satisfies LocalServiceActionAuditEventV1;

const result = {
    v: 1 as const,
    requestId: 'request_1',
    action: 'copy_url' as const,
    status: 'succeeded' as const,
    auditEvents: [auditEvent],
} satisfies LocalServiceActionResultV1;

function actionResponse(overrides: Partial<LocalServiceActionResultV1>) {
    return {
        protocolVersion: 1 as const,
        result: { ...result, ...overrides },
    };
}

describe('local service actions machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('executes daemon-owned local service actions through machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, result });
        const { executeLocalServiceActionViaMachineRpc } = await import('./machineRpc');

        await expect(executeLocalServiceActionViaMachineRpc({
            request,
            serverId: 'server_1',
        })).resolves.toEqual({ ok: true, result });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            payload: request,
        });
    });

    it('fails closed for unavailable and invalid daemon action responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                result: { ...result, status: 'denied', reasonCode: undefined },
            });
        const { executeLocalServiceActionViaMachineRpc } = await import('./machineRpc');

        await expect(executeLocalServiceActionViaMachineRpc({
            request,
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(executeLocalServiceActionViaMachineRpc({
            request,
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });

    it('fails closed when daemon action responses do not match the requested action target', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce(actionResponse({ requestId: 'request_2' }))
            .mockResolvedValueOnce(actionResponse({ action: 'open_preview' }))
            .mockResolvedValueOnce(actionResponse({ auditEvents: [] }))
            .mockResolvedValueOnce(actionResponse({
                auditEvents: [{ ...result.auditEvents[0], requestId: 'request_2' }],
            }))
            .mockResolvedValueOnce(actionResponse({
                auditEvents: [{ ...result.auditEvents[0], action: 'open_preview' }],
            }))
            .mockResolvedValueOnce(actionResponse({
                auditEvents: [{ ...result.auditEvents[0], machineId: 'machine_2' }],
            }));
        const { executeLocalServiceActionViaMachineRpc } = await import('./machineRpc');

        for (let index = 0; index < 6; index += 1) {
            await expect(executeLocalServiceActionViaMachineRpc({
                request,
            })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
        }
    });
});
