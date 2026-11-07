import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { HappierStorageSummaryV1Schema, MachineStorageScanGetResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from '@/rpc/handlers/storage';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createTrashStore, resolveTrashOsUserId } from '@/storage/trash/trashStore';
import { createStorageScanIndex } from '@/storage/scan/scanIndex';
import { startNativeDiskScan } from '@/storage/measure/nativeDiskMeasure';

afterEach(() => vi.restoreAllMocks());
describe('CLI storage Action transport', () => {
    it.each([['lstat', 'EACCES'], ['readdir', 'EPERM']] as const)('returns readable Storage totals and a typed incomplete category through the real Action after %s %s, then recovers', async (operation, code) => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-action-permission-')));
        const blockedVolume = join(directory, 'restricted-volume');
        const osUserId = await resolveTrashOsUserId();
        const blockedTrash = process.platform === 'win32'
            ? join(blockedVolume, '.happier-trash', osUserId) : join(blockedVolume, `.happier-trash-${osUserId}`);
        await mkdir(blockedTrash, { recursive: true, mode: 0o700 });
        const cache = join(directory, 'cache', 'readable');
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, 'payload.bin'), Buffer.alloc(16384, 7));
        const nativeLstat = filesystem.lstat;
        const nativeReaddir = filesystem.readdir;
        let blocked = true;
        let nativeCode: string = code;
        // Filesystem denial is injected at the genuine OS boundary so the test
        // remains valid under privileged runners; all Storage/Action logic is real.
        vi.spyOn(filesystem, 'lstat').mockImplementation((...args: Parameters<typeof nativeLstat>) => {
            if (operation === 'lstat' && blocked && String(args[0]).startsWith(blockedTrash)) {
                return Promise.reject(Object.assign(new Error('Permission denied reading volume Trash'), { code: nativeCode }));
            }
            return nativeLstat(...args);
        });
        vi.spyOn(filesystem, 'readdir').mockImplementation((...args: Parameters<typeof nativeReaddir>) => {
            if (operation === 'readdir' && blocked && String(args[0]) === blockedTrash) {
                return Promise.reject(Object.assign(new Error('Permission denied listing volume Trash'), { code: nativeCode }));
            }
            return nativeReaddir(...args);
        });
        const identity = { serverId: 'home', machineId: 'selected-machine', installationId: 'install', custodianAccountId: 'owner' };
        const policy = await createStoragePolicyFixture({ wholeDiskEnabled: true });
        const policySnapshot = policy.read();
        if (policySnapshot.status !== 'ready') throw new Error('Expected the fixture policy to be ready');
        // Both development policy ports read the same real metadata owner. This
        // fixture does not depend on the pending Storage policy-port migration.
        const readPolicy = () => policySnapshot.policy.storage;
        const catalog = { happyHomeDir: directory, activeServerDir: join(directory, 'server'), readPolicy };
        const activityLog = await createActivityLog({ activeServerDir: directory,
            resourceSummary: { reportAutomaticAction() { throw new Error('A Storage read must not report an automatic effect'); } } });
        const volumes = [{ id: 'home-volume', label: 'Home', mount: directory, totalBytes: 100, availableBytes: 50 },
            { id: 'restricted-volume', label: 'Restricted', mount: blockedVolume, totalBytes: 100, availableBytes: 50 }];
        const readableSource = join(directory, 'readable-trash-source');
        await mkdir(readableSource);
        await writeFile(join(readableSource, 'retained.bin'), Buffer.alloc(8192, 3));
        const trash = createTrashStore({ happyHomeDir: directory, osUserId, target: identity,
            readVolumes: () => volumes, activityLog, attributionFor: () => ({ kind: 'unknown' }),
            readEmptyAfterDays: () => null, classifyRestorePath: async () => null });
        const prepared = await trash.prepare({ path: readableSource, batchId: 'readable', title: 'Readable Trash',
            size: { allocatedBytes: 8192, freesBytes: 8192, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
            movedBy: { accountId: 'owner', kind: 'person' } });
        await prepared.commit();
        // Retain an actual native scan in the real index, as a later Action
        // reads it after a daemon restart. No scanner or index logic is mocked.
        const readableDisk = join(blockedVolume, 'readable-disk-sibling');
        await mkdir(readableDisk); await writeFile(join(readableDisk, 'bytes'), Buffer.alloc(8192));
        const seed = createStorageScanIndex({ activeServerDir: catalog.activeServerDir });
        const scanIds: string[] = [];
        try {
            await seed.initialize(volumes.map(volume => ({ id: volume.id, mountPath: volume.mount, usedBytes: 50 })), true);
            for (const [volumeId, root] of [['home-volume', cache], ['restricted-volume', readableDisk]] as const) {
                const scan = await seed.begin({ volumeId, root, target: { folderPath: root },
                    fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
                scanIds.push(scan.scanId);
                const native = startNativeDiskScan({ root }, { onRecord: record => seed.ingest(volumeId, record) });
                seed.finish(volumeId, await native.done);
            }
        } finally { seed.close(); }
        const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(),
            deps: () => ({ machineId: identity.machineId, activityLog, resourcesPolicy: policy, readPolicy,
                catalog,
                readVolumes: () => volumes }) });
        const rpc = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
            encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
                resolveInstallationId: () => identity.installationId, verifyMachineAdmission: async () => true,
            }) });
        registerDaemonStorageRpcHandlers(rpc, routes);
        const transport = await import('@/session/transport/rpc/machineRpc');
        let reply: unknown;
        vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async request => {
            reply = await rpc.handleRequest({ method: `${identity.machineId}:${request.method}`, params: request.request,
                callerAuthority: 'present_user', machineAdmission: { machineId: identity.machineId,
                    installationId: identity.installationId, custodianAccountId: identity.custodianAccountId, actorAccountId: 'owner',
                    role: 'manage', encryptionMode: 'plain' } });
            return reply;
        });
        const credentials = { token: 'token', encryption: null };
        const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global',
            serverId: identity.serverId, serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null }));
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: identity.serverId };
        const directoryWrites = vi.spyOn(filesystem, 'mkdir');
        try {
            // O-MACH 2026-11-06: unreadable roots leave readable totals available;
            // a category-only issue records why those totals are a lower bound.
            const result = await executor.execute('machines.storage.summary.get', { machineId: identity.machineId }, context);
            const issue = { categoryId: 'trash', reason: 'permission_denied', remedy: 'grant_admin_access_or_run_as_machine_owner' };
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { incomplete: [issue] } });
            expect(reply).toMatchObject({ incomplete: [issue] });
            if (!result.ok) throw new Error('Expected a partial Storage summary');
            const summary = HappierStorageSummaryV1Schema.parse(result.result);
            expect(summary.volumes).toHaveLength(2);
            expect(summary.volumes.find(volume => volume.volume.volumeId === 'home-volume')!.happierBytes).toBeGreaterThan(0);
            expect(summary.categories.find(category => category.categoryId === 'caches')!.size.allocatedBytes).toBeGreaterThan(0);
            expect(summary.categories.find(category => category.categoryId === 'trash')).toMatchObject({
                size: { atLeast: true }, detailFacts: { factsReported: false },
            });
            expect(summary.trash.count).toBe(1);
            expect(summary.trash.allocatedBytes).toBeGreaterThan(0);
            expect(JSON.stringify(Reflect.get(summary, 'incomplete'))).not.toContain(directory);
            expect(await executor.execute('machines.storage.category.list', { machineId: identity.machineId, categoryId: 'trash' }, context))
                .toMatchObject({ ok: true, result: { incomplete: [issue],
                    items: [expect.objectContaining({ itemId: prepared.entry.entryId })],
                    trashEntries: [expect.objectContaining({ entryId: prepared.entry.entryId })] } });
            expect(await executor.execute('machines.storage.category.list', { machineId: identity.machineId, categoryId: 'caches' }, context))
                .toMatchObject({ ok: true, result: { items: [expect.objectContaining({ path: cache })] } });
            expect(await executor.execute('machines.storage.worktrees.list', { machineId: identity.machineId }, context))
                .toMatchObject({ ok: true, result: { items: [] } });
            expect(await executor.execute('machines.storage.suggestions.list', { machineId: identity.machineId }, context))
                .toMatchObject({ ok: true, result: { incomplete: [issue], items: expect.any(Array) } });
            const unrelatedDisk = await executor.execute('machines.storage.scan.get', { machineId: identity.machineId, scanId: scanIds[0],
                view: { tab: 'insights', depth: 1 } }, context);
            expect(unrelatedDisk).toMatchObject({ ok: true });
            if (!unrelatedDisk.ok) throw new Error('Expected the unaffected volume scan');
            expect(MachineStorageScanGetResultV1Schema.parse(unrelatedDisk.result).incomplete).toBeUndefined();
            const disk = await executor.execute('machines.storage.scan.get', { machineId: identity.machineId, scanId: scanIds[1],
                view: { tab: 'insights', depth: 1 } }, context);
            expect(disk, JSON.stringify(disk)).toMatchObject({ ok: true, result: { incomplete: [issue],
                nodes: expect.any(Array), root: { size: { allocatedBytes: expect.any(Number) } },
                insights: { trashBytes: expect.any(Number), largestDistinct: expect.any(Array) } } });
            if (!disk.ok) throw new Error('Expected readable Disk insights');
            expect(MachineStorageScanGetResultV1Schema.parse(disk.result).root!.size.allocatedBytes).toBeGreaterThan(0);
            expect(directoryWrites.mock.calls.some(([path]) => String(path).startsWith(blockedVolume))).toBe(false);
            blocked = false;
            const recovered = await executor.execute('machines.storage.size.refresh', { machineId: identity.machineId }, context);
            expect(recovered).toMatchObject({ ok: true });
            if (!recovered.ok) throw new Error('Expected Storage recovery');
            expect(Reflect.get(recovered.result as object, 'incomplete')).toBeUndefined();
            const recoveredDisk = await executor.execute('machines.storage.scan.get', { machineId: identity.machineId, scanId: scanIds[1],
                view: { tab: 'insights', depth: 1 } }, context);
            expect(recoveredDisk).toMatchObject({ ok: true });
            if (!recoveredDisk.ok) throw new Error('Expected Disk recovery');
            expect(MachineStorageScanGetResultV1Schema.parse(recoveredDisk.result).incomplete).toBeUndefined();
            nativeCode = 'EIO'; blocked = true;
            expect(await executor.execute('machines.storage.size.refresh', { machineId: identity.machineId }, context))
                .toMatchObject({ ok: false });
        } finally { routes.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
    it('preserves opted-out and unavailable-policy refusals from the real Storage RPC producer', async () => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-action-refusals-')));
        const identity = { serverId: 'home', machineId: 'selected-machine', installationId: 'install', custodianAccountId: 'owner' };
        const policy = await createStoragePolicyFixture({ wholeDiskEnabled: false });
        const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(),
            deps: () => ({ resourcesPolicy: policy, catalog: { happyHomeDir: directory, activeServerDir: join(directory, 'server') },
                readVolumes: () => [] }) });
        const rpc = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
            encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
                resolveInstallationId: () => identity.installationId,
                // Home grant verification is the external boundary; local admission remains real.
                verifyMachineAdmission: async () => true,
            }) });
        registerDaemonStorageRpcHandlers(rpc, routes);
        const transport = await import('@/session/transport/rpc/machineRpc');
        let reply: unknown;
        // Replace only the network hop. Registration, Storage policy/service,
        // RPC exception serialization and the strict Action consumer stay real.
        vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async request => {
            reply = await rpc.handleRequest({ method: `${identity.machineId}:${request.method}`, params: request.request,
                callerAuthority: 'present_user', machineAdmission: { machineId: identity.machineId,
                    installationId: identity.installationId, custodianAccountId: identity.custodianAccountId, actorAccountId: 'owner',
                    role: 'manage', encryptionMode: 'plain' } });
            return reply;
        });
        const credentials = { token: 'token', encryption: null };
        const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global',
            serverId: identity.serverId, serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null }));
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: identity.serverId };
        const scanActions = [
            ['machines.storage.scan.start', { target: { folderPath: directory } }, 'storage_whole_disk_disabled'],
            ['machines.storage.scan.cancel', { scanId: 'missing-scan' }, 'storage_scan_unavailable'],
            ['machines.storage.scan.skip', { scanId: 'missing-scan', path: directory }, 'storage_scan_unavailable'],
        ] as const;
        try {
            for (const [actionId, input, errorCode] of scanActions) {
                const result = await executor.execute(actionId, { machineId: identity.machineId, ...input }, context);
                expect(result, actionId).toMatchObject({ ok: false, errorCode });
                expect(reply, actionId).toMatchObject({ error: expect.any(String), errorCode });
            }
            expect(await executor.execute('machines.storage.scan.get', { machineId: identity.machineId }, context))
                .toEqual({ ok: true, result: { state: null, nodes: [], coverage: [] } });
            await policy.setAvailability('unavailable');
            for (const [actionId, input] of [...scanActions.filter(([id]) => id !== 'machines.storage.scan.cancel'),
                ['machines.storage.scan.get', {}] as const]) {
                expect(await executor.execute(actionId, { machineId: identity.machineId, ...input }, context), actionId)
                    .toMatchObject({ ok: false, errorCode: 'policy_unavailable' });
                expect(reply, actionId).toMatchObject({ errorCode: 'policy_unavailable' });
            }
            // Cancellation remains available when policy cannot be read; a missing
            // scan still settles as a typed refusal rather than invalid Action output.
            expect(await executor.execute('machines.storage.scan.cancel', { machineId: identity.machineId, scanId: 'missing-scan' }, context))
                .toMatchObject({ ok: false, errorCode: 'storage_scan_unavailable' });
        } finally { routes.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
    it('retains an accepted cleanup acknowledgement after caller cancellation while retired reads remain closed', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const controller = new AbortController();
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        // Only the authenticated daemon transport is replaced, including its consumed acknowledgement.
        const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async () => { controller.abort(); return receipt; });
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null });
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.trash.move',
            input: { machineId: 'selected-machine', items: [{ ref, expect: 'checked', claimedVerdict: 'safe' }] }, context, signal: controller.signal }))
            .resolves.toEqual(receipt);
        const readController = new AbortController();
        rpc.mockImplementationOnce(async () => {
            readController.abort();
            return { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
                pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        });
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.summary.get',
            input: { machineId: 'selected-machine' }, context, signal: readController.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
    it('preserves a typed daemon rejection instead of misclassifying it as invalid Action output', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        // The daemon RPC error response is the actual transport boundary shape.
        vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue({ error: 'Storage item cannot be collected', errorCode: 'storage_item_not_collectable' });
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null }));
        expect(await executor.execute('machines.storage.pile.set', { machineId: 'selected-machine',
            add: [{ itemId: 'invented-id', path: '/scanned/file' }] }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
            .toMatchObject({ ok: false, errorCode: 'storage_item_not_collectable', error: 'Storage item cannot be collected' });
    });
    it('reads the selected machine through canonical Machine RPC and preserves target and cancellation', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const summary = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: 100, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } });
        // Network transport is the boundary; Action routing and input admission remain real.
        const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue(summary);
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null });
        const signal = new AbortController().signal;
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.summary.get', input: { machineId: 'selected-machine' },
            context: { surface: 'cli', authority: 'present_user', serverId: 'home' }, signal })).resolves.toEqual(summary);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'selected-machine', method: RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET,
            request: { machineId: 'selected-machine', serverId: 'home' }, signal }));
    });
    it('uses authenticated exact-machine ingress when a local target transport has no Machine admission', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const summary = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: 100, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } });
        // Exact-machine network ingress is the controlled boundary; the Action and local RPC handler remain real.
        const authenticatedRpc = vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue(summary);
        // Use the canonical untyped transport map; handlers retain their real schema admission.
        const handlers: RpcHandlerMap = new Map();
        const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        const routes = createDaemonStorageRoutes({ target: () => ({ serverId: 'home', machineId: 'selected-machine',
            installationId: 'install', custodianAccountId: 'owner' }), deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: '/missing-fixture', activeServerDir: '/missing-fixture/server' }, readVolumes: () => [] }),
            readOwnSessionIds: () => new Set() });
        registerDaemonStorageRpcHandlers(rpc, routes);
        try {
            const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
            const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
                serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null,
                machineActionDirectTargetTransport: { machineId: 'selected-machine', invoke: async (method, request) => handlers.get(method)!(request) } });
            expect(await createActionExecutor(deps).execute('machines.storage.summary.get', { machineId: 'selected-machine' },
                { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: summary });
            const scan = { state: null, nodes: [], coverage: [] };
            authenticatedRpc.mockResolvedValueOnce(scan);
            expect(await createActionExecutor(deps).execute('machines.storage.scan.get', { machineId: 'selected-machine' },
                { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: scan });
            expect(authenticatedRpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_SCAN_GET,
                machineId: 'selected-machine', request: { machineId: 'selected-machine', serverId: 'home' } }));
        } finally { routes.dispose(); }
    });
});
