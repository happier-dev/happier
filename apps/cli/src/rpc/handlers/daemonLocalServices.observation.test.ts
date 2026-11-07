import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
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

it('carries launcher scope demand through admitted RPC and retires it on cancellation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-launcher-rpc-demand-')));
    await mkdir(join(root, 'packages', 'child'), { recursive: true });
    const packageFile = join(root, 'package.json');
    await writeFile(packageFile, JSON.stringify({ name: 'rpc', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
    const machineId = 'machine_1';
    const runtime = createLocalServicesDaemonRuntime({ machineId, startLoop: false, inventoryEnabled: () => true,
        workspaceFacts: () => ({ facts: [{ path: root }], acceptedWorkspaceRefs: [{ id: 'workspace', serverId: 'home', machineId,
            rootPath: root, createdAtMs: 1 }], diagnostics: [] }),
        scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
    const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger() {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId, resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation_1',
            verifyMachineAdmission: async () => true,
        }) });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'custodian', machineId,
        localServicesInventory: runtime.inventoryRoutes, localServicesLauncher: runtime.launcherRoutes });
    const socket = Object.assign(new EventEmitter(), { connected: true }) as unknown as Socket;
    rpc.onSocketConnect(socket);
    const machineAdmission = { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId,
        installationId: 'installation_1', role: 'manage' as const, encryptionMode: 'plain' as const };
    const method = `${machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH}`;
    const observing = rpc.handleRequest({ method, machineAdmission, requestId: 'scoped-observation',
        params: { machineId, observationOnly: true, launcherScopes: [{ workspaceRoot: root }] } });
    let pending: Promise<unknown> | undefined;
    try {
        await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(1));
        await vi.waitFor(async () => expect((await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))
            .targets.flatMap(target => target.sourceClass?.kind === 'package_script' ? [target.sourceClass.scriptName] : [])).toEqual(['dev']));
        await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
        pending = rpc.handleRequest({ method, machineAdmission, params: { machineId,
            sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt } });
        await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(2));
        await writeFile(packageFile, JSON.stringify({ name: 'rpc', packageManager: 'npm@10', scripts: { preview: 'serve' } }));
        expect(await pending).toMatchObject({ protocolVersion: 1, changed: true });
        expect((await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' })).targets
            .flatMap(target => target.sourceClass?.kind === 'package_script' ? [target.sourceClass.scriptName] : []))
            .toEqual(['preview']);
    } finally {
        socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'scoped-observation' });
        await observing; await pending; await runtime.stop(); await rm(root, { recursive: true, force: true });
    }
    expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
});
