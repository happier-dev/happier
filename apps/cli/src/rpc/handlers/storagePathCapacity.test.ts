import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { RpcHandlerMap, RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from './storage';

it('serves exact-path capacity through admitted Storage RPC, including zero and native unavailable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'storage-capacity-rpc-')));
    const selected = join(root, 'archive');
    await mkdir(selected);
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
    let available: number | undefined = 3;
    const probes: string[] = [];
    const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(),
        deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(), catalog: { happyHomeDir: root, activeServerDir: root },
            readVolumes: () => [{ id: 'archive', label: 'Archive', mount: selected, totalBytes: 10000, availableBytes: 9999 }],
            nowMs: () => 1234,
            readFilesystemCapacity: async path => {
                probes.push(path);
                if (available === undefined) throw Object.assign(new Error('unsupported filesystem'), { code: 'ENOTSUP' });
                return { bavail: available, bsize: 4096 };
            } }) });
    const handlers: RpcHandlerMap = new Map();
    const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerDaemonStorageRpcHandlers(rpc, routes);
    const context: RpcHandlerContext = { signal: new AbortController().signal,
        callerAuthority: 'present_user', machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' } };
    try {
        const read = handlers.get('daemon.storage.path.capacity.get');
        expect(read).toBeTypeOf('function');
        if (!read) throw new Error('Storage capacity RPC missing');
        const request = { machineId: identity.machineId, serverId: identity.serverId, path: selected };
        await expect(read({ ...request, machineId: 'other' }, context))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read(request, { ...context, machineAdmission: { ...context.machineAdmission!, role: 'use' } }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read(request, { ...context, machineAdmission: { ...context.machineAdmission!, installationId: 'other' } }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(probes).toEqual([]);
        expect(await read(request, context)).toEqual({ status: 'known', path: selected, freeBytes: 12288, observedAt: 1234,
            volume: { volumeId: 'archive', mountPath: selected, label: 'Archive' } });
        available = 0;
        expect(await read(request, context)).toMatchObject({ status: 'known', freeBytes: 0 });
        available = undefined;
        expect(await read(request, context)).toEqual({ status: 'unknown', path: selected, reason: 'ENOTSUP' });
        expect(probes).toEqual([selected, selected, selected]);
    } finally { routes.dispose(); await rm(root, { recursive: true, force: true }); }
});
