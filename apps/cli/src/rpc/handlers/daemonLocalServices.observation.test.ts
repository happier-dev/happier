import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { registerDaemonLocalServicesMachineRpcHandlers } from './daemonLocalServices';

it('retains admitted observation through registered inventory replies and releases it on transport cancellation', async () => {
    const machineId = 'machine_1';
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({ v: 1, machineId, generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] });
    const routes = createLocalServiceInventoryRoutes({ registry });
    const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger() {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId, resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation_1',
            // The Home admission response is the external authorization boundary.
            verifyMachineAdmission: async () => true,
        }) });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'custodian', machineId, localServicesInventory: routes });
    // Socket.IO is the transport boundary; cancellation goes through the real RPC manager.
    const socket = Object.assign(new EventEmitter(), { connected: true }) as unknown as Socket;
    rpc.onSocketConnect(socket);
    const method = `${machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH}`;
    const machineAdmission = { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId,
        installationId: 'installation_1', role: 'manage' as const, encryptionMode: 'plain' as const };
    const observing = rpc.handleRequest({ method, machineAdmission, requestId: 'inventory-observation',
        params: { machineId, observationOnly: true } });
    try {
        await vi.waitFor(() => expect(routes.watcherCount()).toBe(1));
        for (let index = 0; index < 8; index++) {
            const value = rpc.handleRequest({ method, machineAdmission, params: { machineId, sinceGeneratedAt: registry.getSnapshot().generatedAt } });
            await vi.waitFor(() => expect(routes.watcherCount()).toBe(2));
            registry.invalidate();
            expect(await value).toMatchObject({ protocolVersion: 1, changed: true });
            expect(routes.watcherCount()).toBe(1);
        }
    } finally {
        socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'inventory-observation' });
        await observing;
    }
    expect(routes.watcherCount()).toBe(0);
});
