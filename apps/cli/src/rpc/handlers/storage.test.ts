import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema, MachineStoragePileResultV1Schema,
    MachineStorageWatchResultV1Schema, PileReviewV1Schema, PileApplyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { RpcHandlerMap, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from './storage';
import type { StorageServiceDeps } from '@/storage/storageService';
import { createDaemonMachineRpcRouteAttachmentCache } from '@/daemon/machineRpcRouteAttachments';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

const filesystemBoundary = vi.hoisted<{ beforeMkdir?: (path: string) => Promise<void>;
    beforeLstat?: (path: string) => void; beforeAccess?: (path: string) => void }>(() => ({}));
// Node's ESM namespace is immutable; replace only this OS boundary while retaining real filesystem operations.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: ((...args: Parameters<typeof actual.lstat>) => {
        filesystemBoundary.beforeLstat?.(String(args[0])); return actual.lstat(...args);
    }) as typeof actual.lstat, access: async (...args: Parameters<typeof actual.access>) => {
        filesystemBoundary.beforeAccess?.(String(args[0])); return actual.access(...args);
    }, mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
        await filesystemBoundary.beforeMkdir?.(String(path));
        return actual.mkdir(path, options);
    } };
});

const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
let lazyFixtureDirectory: string;
let disposeNative: (() => Promise<void>) | undefined;
let nativeFixtureDirectory: string;
beforeAll(async () => {
    // Load the actual source owner before the canonical publisher switches execPath to its staged native runtime.
    await import('@/storage/storageService');
    nativeFixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-rpc-')));
    disposeNative = await createProcessCustodyFixture();
});
afterAll(async () => {
    await disposeNative?.();
    if (nativeFixtureDirectory) await rm(nativeFixtureDirectory, { recursive: true, force: true });
});
function context(actorAccountId = 'owner', role: 'use' | 'manage' = 'manage'): RpcHandlerContext {
    return { signal: new AbortController().signal, machineAdmission: { ...identity, actorAccountId, role, encryptionMode: 'plain' },
        callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true };
}
function setup(input: Readonly<{
    target?: () => typeof identity;
    deps?: (target: typeof identity) => StorageServiceDeps | Promise<StorageServiceDeps>;
    readOwnSessionIds?: (accountId: string) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
}> = {}) {
    // The transport registrar is untyped; receiving handlers parse their real request schemas.
    const handlers: RpcHandlerMap = new Map();
    const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    let constructions = 0;
    const routes = createDaemonStorageRoutes({ target: input.target ?? (() => identity), deps: async target => {
        constructions += 1;
        return input.deps?.(target) ?? { resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: lazyFixtureDirectory, activeServerDir: join(lazyFixtureDirectory, 'server'),
            tempRoot: join(lazyFixtureDirectory, 'tmp') },
            readVolumes: () => [{ id: target.serverId, label: 'Fixture', mount: '/', totalBytes: 1000, availableBytes: 800 }] };
    }, readOwnSessionIds: input.readOwnSessionIds ?? (() => new Set()) });
    registerDaemonStorageRpcHandlers(rpc, routes);
    return { handlers, routes, constructions: () => constructions };
}
describe('lazy storage Machine RPC', () => {
    it('preserves settled Project cleanup details when a removal RPC rejoins its admitted operation', async () => {
        const { routes } = setup();
        const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner' });
        const input = { machineId: 'machine', items: [{ ref: {
            itemId: 'checkout', path: join(lazyFixtureDirectory, 'checkout'),
            identity: { dev: 'fixture', ino: '1', kind: 'directory' as const }, collectedAt: 1,
            collectedBy: { accountId: 'owner', kind: 'person' as const } }, expect: 'reviewed-checkout' }] };
        const details = { kind: 'finiteCommand' as const, phase: 'teardown' as const, step: 1, exitCode: 7, signal: null };
        const ingress = { ...context(), localActionContext: { actionRequestId: 'cleanup-retry' } };
        // Seed the real operation owner's settled result, then rejoin through the
        // receiving RPC. Storage, operation replay and failure projection stay real.
        expect(await operationRuntime.observeExecution({ actionId: 'machines.storage.deleteNow', input,
            actionRequestId: 'cleanup-retry', rpcContext: ingress, execute: async () => ({ ok: false,
                errorCode: 'project_setup_step_failed', error: 'Cleanup command failed', details }) }))
            .toMatchObject({ ok: false, details });
        const handlers: RpcHandlerMap = new Map();
        registerDaemonStorageRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } },
            { ...routes, observeActionExecution: operationRuntime.observeExecution });
        try {
            await expect(handlers.get(RPC_METHODS.DAEMON_STORAGE_DELETE_NOW)!(input, ingress))
                .rejects.toMatchObject({ rpcErrorCode: 'project_setup_step_failed', details });
        } finally { routes.dispose(); }
    });
    beforeAll(async () => { lazyFixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-lazy-'))); });
    afterAll(async () => { await rm(lazyFixtureDirectory, { recursive: true, force: true }); });
    it.skipIf(process.platform === 'win32').each(['EACCES', 'EPERM', 'EROFS'])('isolates the MACH-REPLAY-84 boot EFI EACCES and reports %s volumes on summary reads', async code => {
        const home = join(lazyFixtureDirectory, `boot-regression-${code}`); await mkdir(home);
        const locked = join(home, 'locked-volume'); await mkdir(locked);
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        const bootProbes: string[] = [];
        const accessProbes: string[] = [];
        filesystemBoundary.beforeLstat = path => {
            if (path.startsWith('/boot/efi/')) {
                bootProbes.push(path);
                throw Object.assign(new Error(`EACCES: permission denied, lstat '${path}'`), { code: 'EACCES', syscall: 'lstat', path });
            }
        };
        filesystemBoundary.beforeAccess = path => {
            accessProbes.push(path);
            if (path.startsWith(locked)) throw Object.assign(new Error('Volume unwritable'), { code });
        };
        const { handlers, routes } = setup({ deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
            machineId: 'machine', activityLog, catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(home, 'absent') },
            readVolumes: () => [{ id: 'main', label: 'Main', mount: home, totalBytes: 1000, availableBytes: 800 },
                { id: 'efi', label: 'EFI', mount: '/boot/efi', totalBytes: 500, availableBytes: 100 },
                { id: 'locked', label: 'Locked', mount: locked, totalBytes: 2000, availableBytes: 400 }] }) });
        try {
            const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
            await handlers.get(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH)!({ machineId: 'machine' }, context());
            const summary = HappierStorageSummaryV1Schema.parse(await read({ machineId: 'machine' }, context()));
            expect(summary.volumes).toEqual(expect.arrayContaining([
                expect.objectContaining({ volume: expect.objectContaining({ volumeId: 'main' }), cleanup: { kind: 'available' } }),
                expect.objectContaining({ volume: expect.objectContaining({ volumeId: 'efi' }), cleanup: { kind: 'unavailable', reason: 'system_partition' } }),
                expect.objectContaining({ volume: expect.objectContaining({ volumeId: 'locked' }), cleanup: { kind: 'unavailable', reason: code === 'EROFS' ? 'read_only' : 'permission_denied' } }),
            ]));
            expect(bootProbes).toEqual([]);
            const initialAccessProbes = accessProbes.length;
            await read({ machineId: 'machine' }, context());
            // A warm summary consumes the measured facts without probing mounts again.
            expect(accessProbes.length).toBe(initialAccessProbes);
            filesystemBoundary.beforeAccess = undefined;
            const refreshed = HappierStorageSummaryV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH)!({ machineId: 'machine' }, context()));
            expect(refreshed.volumes.find(volume => volume.volume.volumeId === 'locked')).toMatchObject({ cleanup: { kind: 'available' } });
        } finally {
            routes.dispose(); filesystemBoundary.beforeLstat = undefined; filesystemBoundary.beforeAccess = undefined;
        }
    });
    it('authorizes storage reads once per request with zero verification at watch return', async () => {
        const { routes } = setup();
        let current = true;
        let verifications = 0;
        const manager = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
            encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
                resolveInstallationId: () => identity.installationId,
                // Home admission is the network boundary; Storage owners and dispatch remain real.
                verifyMachineAdmission: async () => { verifications++; return current; },
            }) });
        registerDaemonStorageRpcHandlers(manager, routes);
        const request = (method: string, params = {}) => ({ method: `${identity.machineId}:${method}`,
            params: { machineId: identity.machineId, ...params }, callerAuthority: 'present_user' as const,
            machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: identity.machineId,
                installationId: identity.installationId, custodianAccountId: identity.custodianAccountId,
                actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' }) });
        try {
            for (const [method, params, expected] of [
                [RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {}, { categories: expect.any(Array) }],
                [RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'logs' }, { items: [] }],
                [RPC_METHODS.DAEMON_STORAGE_PILE_GET, {}, { items: [] }],
                [RPC_METHODS.DAEMON_STORAGE_WATCH, { sinceRevision: 0 }, { changed: true }],
            ] as const) {
                const before = verifications;
                expect(await manager.handleRequest(request(method, params))).toMatchObject(expected);
                expect(verifications - before).toBe(1);
            }
            current = false;
            const before = verifications;
            expect(await manager.handleRequest(request(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(verifications - before).toBe(1);
        } finally { routes.dispose(); }
    });
    it('reads storage through a caller-local Home label while keeping revoked grants and stale installations denied', async () => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        env.patch({ HAPPIER_HOME_DIR: lazyFixtureDirectory }); reloadConfiguration();
        try {
            const profile = await addServerProfile({ name: 'stack_resources__id_default', serverUrl: 'https://qa.example.test', webappUrl: 'https://qa.example.test' });
            const homeId = 'srv_resources_qa';
            await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
                v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl, revision: 1,
                endpoints: [{ kind: 'https', url: profile.serverUrl }],
            } });
            const { handlers, routes, constructions } = setup({ target: () => ({ ...identity, serverId: profile.id }),
                deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
                    catalog: { happyHomeDir: join(lazyFixtureDirectory, 'absent'), activeServerDir: join(lazyFixtureDirectory, 'absent', 'server'),
                    tempRoot: join(lazyFixtureDirectory, 'absent-temp') }, readVolumes: () => [] }) });
            const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
            const input = { machineId: identity.machineId, serverId: 'browser-home' };
            try {
                expect(await read(input, { ...context(), verifyMachineAdmissionCurrent: async () => false })).toMatchObject({ volumes: [] });
                await expect(read(input, { ...context(), machineAdmission: { ...context().machineAdmission!, installationId: 'old-install' } }))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
                // Bare registrar calls consume already-admitted context; real ingress revocation is covered above.
                expect(constructions()).toBe(1);
                expect(await read(input, context())).toMatchObject({ volumes: [], wholeDisk: { enabled: false } });
                expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ ...input, categoryId: 'logs' }, context()))
                    .toMatchObject({ items: [] });
                expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ ...input, categoryId: 'logs' }, context('recipient', 'manage')))
                    .toMatchObject({ items: [] });
                await expect(handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ ...input, categoryId: 'logs' }, context('recipient', 'use')))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            } finally { routes.dispose(); }
        } finally { env.restore(); reloadConfiguration(); }
    });
    it('mounts every storage operation without constructing the storage owner', () => {
        const { handlers, constructions } = setup();
        expect([...handlers.keys()]).toEqual([RPC_METHODS.DAEMON_STORAGE_PATH_CAPACITY_GET, RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
            RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, RPC_METHODS.DAEMON_STORAGE_WATCH,
            RPC_METHODS.DAEMON_STORAGE_PILE_GET, RPC_METHODS.DAEMON_STORAGE_PILE_SET, RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK,
            RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, RPC_METHODS.DAEMON_STORAGE_DOCKER_PRUNE,
            RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY,
            RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST,
            RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST, RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE,
            RPC_METHODS.DAEMON_STORAGE_SCAN_START, RPC_METHODS.DAEMON_STORAGE_SCAN_GET, RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL,
            RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP, RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE]);
        expect(constructions()).toBe(0);
    });
    it('returns a typed refusal for an invented ref without writing the pile', async () => {
        const { handlers, routes } = setup();
        try {
            await expect(handlers.get(RPC_METHODS.DAEMON_STORAGE_PILE_SET)!({ machineId: 'machine',
                add: [{ itemId: 'invented-id', path: join(lazyFixtureDirectory, 'not-a-served-item') }] }, context()))
                .rejects.toMatchObject({ rpcErrorCode: 'storage_item_not_collectable' });
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_PILE_GET)!({ machineId: 'machine' }, context()))
                .toMatchObject({ items: [], summary: { count: 0 } });
        } finally { routes.dispose(); }
    });
    it('refuses recipient disk scans and protection policy effects before constructing the owner', async () => {
        const { handlers, constructions, routes } = setup();
        try {
            for (const [method, payload] of [[RPC_METHODS.DAEMON_STORAGE_SCAN_START, { target: { volumeId: 'volume' } }],
                [RPC_METHODS.DAEMON_STORAGE_SCAN_GET, {}], [RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: 'scan' }],
                [RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP, { scanId: 'scan', path: '/private' }],
                [RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, { path: '/private' }], [RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE, { path: '/private' }]] as const) {
                await expect(handlers.get(method)!({ machineId: 'machine', ...payload }, context('recipient', 'use')))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            }
            expect(constructions()).toBe(0);
        } finally { routes.dispose(); }
    });
    it.each(['owner', 'manager'])('lets %s mutate protected folders through admitted RPC and the real Resources metadata CAS owner', async actor => {
        const { createMachineResourcesPolicyRuntime } = await import('@/daemon/resources/machineResourcesPolicy');
        const home = join(lazyFixtureDirectory, 'protected-rpc'); const path = join(home, 'personal');
        await mkdir(path, { recursive: true });
        let metadata: Record<string, unknown> = { neighboringPolicy: 'retained' }; let metadataVersion = 1;
        // The metadata transport is the system boundary; policy admission and CAS merging remain real.
        const policy = createMachineResourcesPolicyRuntime({ port: {
            read: async () => ({ status: 'ready', metadata, metadataVersion }),
            compareAndSwap: async request => {
                if (request.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
                metadata = request.metadata; metadataVersion++;
                return { status: 'applied', metadata, metadataVersion };
            },
        } });
        await policy.reload();
        const { handlers, routes } = setup({ deps: () => ({ catalog: { happyHomeDir: home, activeServerDir: join(home, 'server'), tempRoot: join(home, 'tmp') },
            readVolumes: () => [], homeDir: home, custodianAccountId: 'owner', machineId: 'machine', serverId: 'home', resourcesPolicy: policy,
        }) });
        try {
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD)!({ machineId: 'machine', path: '~/personal' }, context(actor)))
                .toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [{ path, addedAt: expect.any(Number) }] } } });
            expect(metadata.neighboringPolicy).toBe('retained');
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE)!({ machineId: 'machine', path: join(home, 'Documents') }, context(actor)))
                .toEqual({ status: 'unsupported', reason: 'built_in_protection' });
            expect(policy.read()).toMatchObject({ policy: { storage: { protectedFolders: [{ path }] } } });
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE)!({ machineId: 'machine', path }, context(actor)))
                .toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [] } } });
        } finally { routes.dispose(); policy.stop(); }
    });
    it('refuses missing or stale local admission and consumes dispatch admission for reads', async () => {
        const { handlers, constructions, routes } = setup();
        const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
        await expect(read({ machineId: 'machine' })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ machineId: 'other' }, context())).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(constructions()).toBe(0);
        expect(await read({ machineId: 'machine' }, { ...context(), verifyMachineAdmissionCurrent: async () => false }))
            .toMatchObject({ categories: expect.any(Array) });
        expect(constructions()).toBe(1);
        routes.dispose();
    });
    it('refuses locally cancelled cleanup before owner construction', async () => {
        const { handlers, constructions, routes } = setup();
        const cancelled = new AbortController();
        cancelled.abort();
        for (const [method, args] of [[RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true }], [RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, {}],
            [RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { batchId: 'batch' }]] as const) {
            await expect(handlers.get(method)!({ machineId: 'machine', ...args },
                { ...context(), signal: cancelled.signal }))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        expect(constructions()).toBe(0);
        routes.dispose();
    });
    it('exposes Machine categories to Manage and only shared capacity totals to Use', async () => {
        const { handlers, routes } = setup();
        try {
            await handlers.get(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH)!({ machineId: 'machine' }, context());
            const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
            for (const actor of ['owner', 'manager']) {
                expect(await read({ machineId: 'machine' }, context(actor))).toMatchObject({ categories: expect.arrayContaining([expect.objectContaining({ categoryId: 'ownData',
                    size: expect.any(Object), canGoBytes: 0, count: expect.any(Number), detailFacts: expect.any(Object) })]) });
            }
            expect(await read({ machineId: 'machine' }, context('recipient', 'use'))).toMatchObject({ categories: [], suggestionsTop: [],
                volumes: [{ volume: { volumeId: 'home' }, totalBytes: 1000, freeBytes: 800, happierBytes: expect.any(Number), pileBytes: 0, trashBytes: 0 }],
                pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 } });
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ machineId: 'machine', categoryId: 'sessionFolders' }, context('recipient', 'use')))
                .toMatchObject({ categoryId: 'sessionFolders', items: [] });
            for (const [method, input] of [[RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'ownData' }],
                [RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, {}]] as const) {
                await expect(handlers.get(method)!({ machineId: 'machine', ...input }, context('recipient', 'use')))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            }
        } finally { routes.dispose(); }
    });
    it('finishes admitted reads after lazy owner construction and requester-owned Session proof awaits', async () => {
        let valid = true;
        let release!: (deps: StorageServiceDeps) => void;
        let entered!: () => void;
        const enteredDeps = new Promise<void>(resolve => { entered = resolve; });
        const pendingDeps = new Promise<StorageServiceDeps>(resolve => { release = resolve; });
        const { handlers, routes } = setup({ deps: () => { entered(); return pendingDeps; } });
        const admitted = { ...context(), verifyMachineAdmissionCurrent: async () => valid };
        const pending = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ machineId: 'machine' }, admitted);
        await enteredDeps;
        valid = false;
        release({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: lazyFixtureDirectory, activeServerDir: join(lazyFixtureDirectory, 'server'), tempRoot: join(lazyFixtureDirectory, 'tmp') }, readVolumes: () => [] });
        expect(await pending).toMatchObject({ volumes: [] });
        routes.dispose();

        let releaseProof!: (ids: ReadonlySet<string>) => void;
        let proofEntered!: () => void;
        const enteredProof = new Promise<void>(resolve => { proofEntered = resolve; });
        const proof = new Promise<ReadonlySet<string>>(resolve => { releaseProof = resolve; });
        const next = setup({ readOwnSessionIds: () => { proofEntered(); return proof; } });
        valid = true;
        const ownRead = next.handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ machineId: 'machine', categoryId: 'sessionFolders' },
            { ...context('recipient', 'use'), verifyMachineAdmissionCurrent: async () => valid });
        await enteredProof;
        valid = false;
        releaseProof(new Set(['own-session']));
        expect(await ownRead).toMatchObject({ items: [] });
        expect(next.constructions()).toBe(1);
        next.routes.dispose();
    });
    it('uses the same cache for revision-edge watch and releases a cancelled request', async () => {
        const { handlers, routes } = setup();
        let verifications = 0;
        const watchContext = { ...context('recipient', 'use'), verifyMachineAdmissionCurrent: async () => { verifications += 1; return true; } };
        try {
            const service = await routes.getService(identity);
            const first = await service.summary();
            const changed = handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: first.revision }, watchContext);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(verifications).toBe(0);
            service.invalidate();
            expect(await changed).toMatchObject({ changed: true, summary: { categories: [], revision: expect.any(Number) } });
            expect(verifications).toBe(0);
            const controller = new AbortController();
            const latest = await service.summary();
            const cancelled = handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: latest.revision },
                { ...watchContext, signal: controller.signal });
            const rejected = expect(cancelled).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            await new Promise<void>(resolve => setImmediate(resolve));
            controller.abort();
            await rejected;
            expect(verifications).toBe(0);
            expect((await service.summary()).revision).toBe(latest.revision);
        } finally { routes.dispose(); }
    });
    it('retires the previous Home owner instead of carrying its cached facts into a replacement', async () => {
        let target = identity;
        const { handlers, routes } = setup({ target: () => target });
        try {
            const previous = await routes.getService(target);
            expect((await previous.refresh()).volumes[0]?.volume.volumeId).toBe('home');
            target = { ...identity, serverId: 'replacement-home' };
            await (await routes.getService(target)).refresh();
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ serverId: target.serverId, machineId: 'machine' }, context()))
                .toMatchObject({ volumes: [{ volume: { volumeId: 'replacement-home' } }] });
            await expect(previous.summary()).rejects.toMatchObject({ name: 'AbortError' });
        } finally { routes.dispose(); }
    });
    it('retires a constructed owner while its real scan-index filesystem initialization is still awaited', async () => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-retire-')));
        const { createStorageScanIndex } = await import('@/storage/scan/scanIndex');
        const { createStorageScanRunner } = await import('@/storage/scan/scanRunner');
        const activeServerDir = join(directory, 'server');
        const volume = { id: 'preserved-volume', mountPath: join(directory, 'volume'), usedBytes: 0 };
        await mkdir(volume.mountPath);
        await writeFile(join(volume.mountPath, 'retained'), 'retained scan bytes');
        const previous = createStorageScanIndex({ activeServerDir });
        const runner = createStorageScanRunner({ index: previous, readVolumes: () => [volume], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'processcustody', path: process.execPath } }) });
        await runner.initialize();
        const scan = await runner.start({ target: { volumeId: volume.id } });
        await runner.wait(scan.scanId);
        expect((await runner.get()).state?.status).toBe('complete');
        await runner.dispose();
        const retainedIndex = join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update('preserved-volume').digest('hex')}.sqlite`);
        const retainedBytes = await readFile(retainedIndex);
        let target = identity;
        const listeners = new Set<() => void>();
        let entered!: () => void; let release!: () => void;
        const blocked = new Promise<void>(resolve => { entered = resolve; });
        const resume = new Promise<void>(resolve => { release = resolve; });
        // Hold only the real OS adapter; the service, initializer, runner and index remain real.
        filesystemBoundary.beforeMkdir = async path => {
            if (path === join(directory, 'server', 'storage', 'scans')) { entered(); await resume; }
        };
        const { routes } = setup({ target: () => target, deps: async admittedTarget => ({
            catalog: { happyHomeDir: admittedTarget.serverId === identity.serverId ? directory : join(directory, 'replacement'),
                activeServerDir: admittedTarget.serverId === identity.serverId ? activeServerDir : join(directory, 'replacement', 'server'), tempRoot: join(directory, 'tmp') },
            readVolumes: () => [{ id: volume.id, mount: volume.mountPath, label: 'Fixture', totalBytes: 1000, availableBytes: 1000 }],
            // A loaded opt-in reaches real index initialization. Unknown policy
            // deliberately preserves retained indexes without opening them.
            resourcesPolicy: await createStoragePolicyFixture({ wholeDiskEnabled: admittedTarget.serverId === identity.serverId }),
            subscribeChanges: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        }) });
        const pending = routes.getService(identity);
        const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        try {
            await Promise.race([blocked, pending.then(() => { throw new Error('Initializer did not reach the held filesystem boundary'); })]);
            expect(listeners.size).toBe(1);
            target = { ...identity, serverId: 'replacement-home' };
            routes.reconcileTarget();
            expect(listeners.size).toBe(0);
            release(); await rejected;
            expect(await readFile(retainedIndex)).toEqual(retainedBytes);
            const replacement = await routes.getService(target);
            expect((await replacement.summary()).wholeDisk).toEqual({ enabled: false, scans: [] });
            expect(listeners.size).toBe(1);
            expect(await readFile(retainedIndex)).toEqual(retainedBytes);
        } finally {
            release(); routes.dispose(); filesystemBoundary.beforeMkdir = undefined;
            try { await rejected; } finally { await rm(directory, { recursive: true, force: true }); }
        }
    });
    it('keeps the canonical storage owner reachable after the Machine transport is reattached', async () => {
        const { routes } = setup();
        const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => null });
        const handlers: RpcHandlerMap = new Map();
        const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        // A replacement external Machine transport mounts the real receiving route registrar.
        const replacement = { registerStorageRoutes(next: typeof routes) { registerDaemonStorageRpcHandlers(rpc, next); } };
        try {
            cache.attachStorageRoutes(routes);
            cache.attachApiMachineForSessions(replacement as never);
            const first = await handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ machineId: 'machine' }, context());
            handlers.clear();
            cache.attachApiMachineForSessions(replacement as never);
            expect(await handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ machineId: 'machine' }, context())).toEqual(first);
        } finally { routes.dispose(); }
    });
    it('retires the previous Home cache at transport reattachment before another storage request arrives', async () => {
        let target = identity;
        const { routes } = setup({ target: () => target });
        const service = await routes.getService(identity);
        await service.summary();
        target = { ...identity, serverId: 'replacement-home' };
        const rpc: RpcHandlerRegistrar = { registerHandler() {} };
        registerDaemonStorageRpcHandlers(rpc, routes);
        await new Promise<void>(resolve => setImmediate(resolve));
        await expect(service.summary()).rejects.toMatchObject({ name: 'AbortError' });
        routes.dispose();
    });
    it('rejects unknown fields and malformed category, cursor and revision inputs before construction', async () => {
        const { handlers, constructions, routes } = setup();
        for (const [method, input, code, path] of [[RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, { unknown: true }, 'unrecognized_keys', []],
            [RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'not-a-category' }, 'invalid_value', ['categoryId']],
            [RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, { categoryId: 'not-a-category' }, 'invalid_value', ['categoryId']],
            [RPC_METHODS.DAEMON_STORAGE_WATCH, { sinceRevision: -1 }, 'too_small', ['sinceRevision']]] as const) {
            await expect(handlers.get(method)!({ machineId: 'machine', ...input }, context())).rejects.toMatchObject({ issues: [{ code, path }] });
        }
        expect(constructions()).toBe(0);
        routes.dispose();
    });
});

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('storage RPC with real private Session directories and native sizing', () => {
    let scratch: string;
    beforeAll(async () => {
        scratch = join(nativeFixtureDirectory, 'sessions'); await mkdir(scratch);
    });
    it('serves typed Storage replies without self-parsing while retaining real recipient and public-item projection', async () => {
        const home = join(scratch, 'typed-replies');
        const server = join(home, 'server');
        const directories = createManagedSessionDirectories({ activeServerDir: server });
        const own = await directories.materializeForFreshSpawn({ sessionCreationTag: 'typed-own' });
        const foreign = await directories.materializeForFreshSpawn({ sessionCreationTag: 'typed-foreign' });
        await directories.bind({ allocationId: own.allocationId, sessionId: 'own-session' });
        await directories.bind({ allocationId: foreign.allocationId, sessionId: 'foreign-session' });
        await writeFile(join(own.directory, 'attachment'), 'owned attachment');
        await writeFile(join(foreign.directory, 'attachment'), 'foreign attachment');
        const { routes } = setup({ deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: home, activeServerDir: server, managedSessionDirectories: directories,
                tempRoot: join(scratch, 'typed-no-temp'), readProjects: () => ({ status: 'ready', projects: [] }),
                readTrackedSessions: () => ['own-session', 'foreign-session'].map(sessionId => ({ sessionId,
                    cwd: scratch, running: false, stoppedAt: 0 })), readInUsePaths: () => ({ reliable: true, paths: [] }) },
            machineId: identity.machineId, serverId: identity.serverId, custodianAccountId: identity.custodianAccountId,
            homeDir: scratch, readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch,
                totalBytes: 1_000_000, availableBytes: 500_000 }] }),
            readOwnSessionIds: account => new Set(account === 'recipient' ? ['own-session'] : []),
        });
        const manager = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
            encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
                resolveInstallationId: () => identity.installationId,
                // Home verification is the transport boundary; all Storage logic and sizing remain real.
                verifyMachineAdmission: async () => true,
            }) });
        registerDaemonStorageRpcHandlers(manager, routes);
        const request = (method: string, params: object, actor = 'owner') => manager.handleRequest({
            method: `${identity.machineId}:${method}`, params: { machineId: identity.machineId, ...params },
            callerAuthority: 'present_user', machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({
                machineId: identity.machineId, installationId: identity.installationId,
                custodianAccountId: identity.custodianAccountId, actorAccountId: actor,
                role: actor === 'owner' ? 'manage' : 'use', encryptionMode: 'plain',
            }),
        });
        // Call-through instrumentation measures redundant full-reply walks without replacing internal logic.
        const parses = [HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema,
            MachineStoragePileResultV1Schema, MachineStorageWatchResultV1Schema].map(schema => vi.spyOn(schema, 'parse'));
        try {
            await request(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, {});
            const owner = await request(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {});
            expect(owner).toMatchObject({ categories: expect.arrayContaining([
                expect.objectContaining({ categoryId: 'sessionFolders', count: 2 }),
            ]) });
            const shared = await request(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {}, 'recipient');
            expect(shared).toMatchObject({ categories: [], suggestionsTop: [], wholeDisk: { scans: [] } });
            expect(shared).not.toHaveProperty('scanShortcuts');
            const category = await request(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'sessionFolders' }, 'recipient');
            expect(category).toMatchObject({ items: [expect.objectContaining({ path: own.directory,
                size: expect.objectContaining({ allocatedBytes: expect.any(Number) }) })] });
            expect(JSON.stringify(category)).not.toContain(foreign.directory);
            for (const field of ['sessionId', 'referenceOwnerData', 'ownVerdict', 'fingerprintRequired', 'categoryGroup']) {
                expect(JSON.stringify(category)).not.toContain(`"${field}"`);
            }
            expect(await request(RPC_METHODS.DAEMON_STORAGE_PILE_GET, {}, 'recipient')).toMatchObject({ items: [] });
            expect(await request(RPC_METHODS.DAEMON_STORAGE_WATCH, { sinceRevision: 0 }, 'recipient'))
                .toMatchObject({ changed: true, summary: shared });
            expect(parses.reduce((count, parse) => count + parse.mock.calls.length, 0)).toBe(0);
        } finally { for (const parse of parses) parse.mockRestore(); routes.dispose(); }
    });
    it.each(['cleanup', 'restore', 'empty'] as const)('serves only own pile and Trash receipts and finishes admitted %s after Home withdrawal', async operation => {
        const home = join(scratch, `recipient-trash-home-${operation}`);
        const server = join(home, 'server');
        const directories = createManagedSessionDirectories({ activeServerDir: server });
        const own = await directories.materializeForFreshSpawn({ sessionCreationTag: 'recipient-trash-own' });
        const foreign = await directories.materializeForFreshSpawn({ sessionCreationTag: 'recipient-trash-foreign' });
        await directories.bind({ allocationId: own.allocationId, sessionId: 'own-session' });
        await directories.bind({ allocationId: foreign.allocationId, sessionId: 'foreign-session' });
        await writeFile(join(own.directory, 'own.txt'), 'owned attachment');
        await writeFile(join(foreign.directory, 'foreign.txt'), 'private foreign attachment');
        const sampler = createMachineVitalsSampler({
            // No OS samples are needed for the real Activity receipt owner.
            readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }),
        });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
        let recipientSessionIds = new Set(['own-session']);
        let revokeDuringMutation = false;
        let authorityCurrent = true;
        let verifications = 0;
        const { handlers, routes } = setup({ deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: home, activeServerDir: server,
            managedSessionDirectories: directories, tempRoot: join(scratch, 'recipient-trash-no-temp'),
            readProjects: () => ({ status: 'ready', projects: [] }),
            readTrackedSessions: () => ['own-session', 'foreign-session'].map(sessionId => ({ sessionId, cwd: scratch, running: false, stoppedAt: 0 })),
            readInUsePaths: () => ({ reliable: true, paths: [] }) }, activityLog, machineId: 'machine', serverId: 'home',
            custodianAccountId: 'owner', homeDir: scratch,
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] }),
            readOwnSessionIds: account => {
                const admitted = account === 'recipient' ? recipientSessionIds : new Set(account === 'foreign' ? ['foreign-session'] : []);
                // Withdraw only Machine access. Session custody is a separate live boundary,
                // and its explicit withdrawal/foreign-entry controls below remain enforced.
                if (revokeDuringMutation) authorityCurrent = false;
                return admitted;
            },
        });
        const manager = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
            encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
                resolveInstallationId: () => identity.installationId,
                // Home admission and own-Session reads are genuine network boundaries.
                verifyMachineAdmission: async () => { verifications++; return authorityCurrent; },
            }) });
        registerDaemonStorageRpcHandlers(manager, routes);
        const transported = (method: string, input: object, account = 'recipient', role: 'use' | 'manage' = 'use') => manager.handleRequest({
            method: `${identity.machineId}:${method}`, params: { machineId: identity.machineId, ...input }, callerAuthority: 'present_user',
            machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: identity.machineId,
                installationId: identity.installationId, custodianAccountId: identity.custodianAccountId,
                actorAccountId: account, role, encryptionMode: 'plain' }),
        });
        const invoke = (method: string, input: object, account = 'recipient', role: 'use' | 'manage' = 'use') =>
            revokeDuringMutation && [RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE,
                RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY].some(effect => effect === method) ? transported(method, input, account, role)
                : handlers.get(method)!({ machineId: 'machine', ...input }, context(account, role));
        const listTrash = async (account = 'recipient', role: 'use' | 'manage' = 'use') =>
            MachineStorageCategoryListResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'trash' }, account, role));
        const move = async (account: string, emptyAfter = false) => {
            const folders = MachineStorageCategoryListResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
                { categoryId: 'sessionFolders' }, account));
            const pile = MachineStoragePileResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_PILE_SET,
                { add: folders.items.map(item => ({ itemId: item.itemId, path: item.path })) }, account));
            expect(pile.items).toHaveLength(1);
            expect(MachineStoragePileResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET, {}, account)).items).toEqual(pile.items);
            if (account === 'foreign') {
                expect(await invoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET, {})).toMatchObject({ items: [], summary: { count: 0 } });
            }
            const checked = PileReviewV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK,
                { refs: pile.items.map(({ itemId, path }) => ({ itemId, path })) }, account));
            if (emptyAfter) revokeDuringMutation = true;
            const answer = await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE,
                { items: checked.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })), emptyAfter }, account);
            expect(answer, JSON.stringify(answer)).toMatchObject({ mode: 'trash', outcomes: [{ itemId: pile.items[0]!.itemId, status: 'moved' }] });
            const result = PileApplyResultV1Schema.parse(answer);
            return result;
        };
        try {
            expect(await listTrash()).toMatchObject({ items: [], trashEntries: [] });
            for (const categoryId of ['caches', 'worktrees', 'logs', 'ownData']) {
                await expect(invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId }))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            }
            const foreignMoved = await move('foreign');
            expect(await listTrash()).toMatchObject({ items: [], trashEntries: [] });
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET, {})).toMatchObject({ items: [], summary: { count: 0 } });
            const ownMoved = await move('recipient');
            const visible = await listTrash();
            expect(visible.trashEntries).toEqual([expect.objectContaining({ batchId: ownMoved.batchId, originalPath: own.directory })]);
            expect(JSON.stringify(visible)).not.toContain(foreign.directory);
            expect(JSON.stringify(visible)).not.toContain(foreignMoved.batchId);
            expect(JSON.stringify(visible)).not.toContain('ownerData');
            expect((await listTrash('owner', 'manage')).trashEntries).toHaveLength(2);
            const foreignEntry = (await listTrash('foreign')).trashEntries![0]!;
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { entryIds: [foreignEntry.entryId] }))
                .toMatchObject({ outcomes: [{ entryId: foreignEntry.entryId, status: 'refused', reason: { code: 'unauthorized' } }] });
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, { entryIds: [foreignEntry.entryId] }))
                .toMatchObject({ outcomes: [{ entryId: foreignEntry.entryId, status: 'refused', reason: { code: 'unauthorized' } }] });
            recipientSessionIds = new Set();
            expect(await listTrash()).toMatchObject({ items: [], trashEntries: [] });
            for (const method of [RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY]) {
                expect(await invoke(method, { batchId: ownMoved.batchId }))
                    .toMatchObject({ outcomes: [{ status: 'refused', reason: { code: 'unauthorized' } }] });
            }
            recipientSessionIds = new Set(['own-session']);
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { batchId: ownMoved.batchId }))
                .toMatchObject({ outcomes: [{ status: 'restored', path: own.directory }] });
            expect(await readFile(join(own.directory, 'own.txt'), 'utf8')).toBe('owned attachment');
            const again = await move('recipient');
            const emptied = await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, { batchId: again.batchId });
            expect(emptied, JSON.stringify(emptied))
                .toMatchObject({ outcomes: [{ status: 'deleted' }] });
            expect(await listTrash()).toMatchObject({ items: [], trashEntries: [] });
            expect((await listTrash('foreign')).trashEntries).toEqual([expect.objectContaining({ batchId: foreignMoved.batchId })]);
            const finite = await directories.materializeForFreshSpawn({ sessionCreationTag: 'recipient-admitted-finite' });
            await directories.bind({ allocationId: finite.allocationId, sessionId: 'own-session' });
            await writeFile(join(finite.directory, 'finite.txt'), 'admitted cleanup');
            (await routes.getService(identity)).invalidate();
            const priorReceiptIds = new Set((await activityLog.list({ range: 'today' })).entries.map(row => row.id));
            if (operation === 'cleanup') {
                const admitted = await move('recipient', true);
                expect(admitted.inTrashBytes).toBe(0);
                expect(admitted.freedBytes).toBeGreaterThan(0);
                await expect(readFile(join(finite.directory, 'finite.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
            } else {
                const moved = await move('recipient');
                revokeDuringMutation = true;
                const result = await invoke(operation === 'restore' ? RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE : RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY,
                    { batchId: moved.batchId });
                expect(result, JSON.stringify(result)).toMatchObject({ outcomes: [{ status: operation === 'restore' ? 'restored' : 'deleted' }] });
                if (operation === 'restore') {
                    expect(await readFile(join(finite.directory, 'finite.txt'), 'utf8')).toBe('admitted cleanup');
                } else {
                    await expect(readFile(join(finite.directory, 'finite.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
                }
            }
            const settledReceipts = (await activityLog.list({ range: 'today' })).entries;
            const admittedMoves = settledReceipts.filter(row => row.kind === 'trash_moved' && !priorReceiptIds.has(row.id));
            expect(admittedMoves).toHaveLength(1);
            for (const movedReceipt of admittedMoves) {
                expect(movedReceipt).toMatchObject({ kind: 'trash_moved', outcome: 'done',
                    ...(operation === 'restore' ? { undoneAt: expect.any(Number) } : { inTrashBytes: 0 }) });
                if (operation !== 'restore') {
                    expect(settledReceipts.find(row => row.kind === 'trash_emptied' && row.ref === movedReceipt.id))
                        .toMatchObject({ kind: 'trash_emptied', outcome: 'done' });
                }
            }
            expect(authorityCurrent).toBe(false);
            expect(verifications).toBe(1);
            expect(await transported(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {})).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(verifications).toBe(2);
            expect((await listTrash('foreign')).trashEntries).toEqual([expect.objectContaining({ batchId: foreignMoved.batchId })]);
        } finally { routes.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });
    it('keeps admitted own-Session scope through the read and re-admits the next request without private identity fields', async () => {
        const home = join(scratch, 'home');
        const server = join(home, 'server');
        const directories = createManagedSessionDirectories({ activeServerDir: server });
        const own = await directories.materializeForFreshSpawn({ sessionCreationTag: 'own' });
        const foreign = await directories.materializeForFreshSpawn({ sessionCreationTag: 'foreign' });
        await directories.bind({ allocationId: own.allocationId, sessionId: 'own-session' });
        await directories.bind({ allocationId: foreign.allocationId, sessionId: 'foreign-session' });
        await mkdir(home, { recursive: true });
        await writeFile(join(own.directory, 'own.txt'), 'owned attachment');
        await writeFile(join(foreign.directory, 'foreign.txt'), 'private foreign attachment');
        let ownSessionIds = new Set(['own-session']);
        let revokeDuringLivenessRead = false;
        let ownScopeReads = 0;
        const { handlers, routes } = setup({ deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: home, activeServerDir: server,
            managedSessionDirectories: directories, tempRoot: join(scratch, 'absent-temp'), readInUsePaths: async () => {
                if (revokeDuringLivenessRead) ownSessionIds = new Set();
                return { reliable: true, paths: [] };
            } }, readVolumes: () => [] }),
            readOwnSessionIds: actor => { ownScopeReads++; return actor === 'recipient' ? ownSessionIds : new Set<string>(); } });
        try {
            const list = handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!;
            const output = await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context('recipient', 'use'));
            expect(MachineStorageCategoryListResultV1Schema.parse(output)).toEqual(output);
            expect(output).toMatchObject({ categoryId: 'sessionFolders', items: [{ path: own.directory, size: { atLeast: false } }] });
            expect(JSON.stringify(output)).not.toContain(foreign.directory);
            expect(JSON.stringify(output)).not.toContain('sessionId');
            expect(await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context('unproven', 'use'))).toMatchObject({ items: [] });
            expect(await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context()))
                .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ path: own.directory }), expect.objectContaining({ path: foreign.directory })]) });
            revokeDuringLivenessRead = true;
            (await routes.getService(identity)).invalidate();
            const before = ownScopeReads;
            const admitted = await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context('recipient', 'use'));
            expect(ownSessionIds.size).toBe(0);
            expect(admitted).toMatchObject({ items: [{ path: own.directory }] });
            expect(ownScopeReads - before).toBe(1);
            expect(JSON.stringify(admitted)).not.toContain(foreign.directory);
            const revoked = await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context('recipient', 'use'));
            expect(revoked).toMatchObject({ items: [] });
            expect(JSON.stringify(revoked)).not.toContain(own.directory);
        } finally { routes.dispose(); }
    });
});
