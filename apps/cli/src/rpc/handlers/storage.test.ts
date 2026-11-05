import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { MachineStorageCategoryListResultV1Schema, MachineStoragePileResultV1Schema, PileReviewV1Schema, PileApplyResultV1Schema, MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';
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

const filesystemBoundary = vi.hoisted<{ beforeMkdir?: (path: string) => Promise<void> }>(() => ({}));
// Node's ESM namespace is immutable; replace only this OS boundary while retaining real filesystem operations.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
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
        callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true, verifyMachineAuthorityCurrent: async () => true };
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
    const routes = createDaemonStorageRoutes({ target: input.target ?? (() => identity), deps: target => {
        constructions += 1;
        return input.deps?.(target) ?? { catalog: { happyHomeDir: lazyFixtureDirectory, activeServerDir: join(lazyFixtureDirectory, 'server'),
            tempRoot: join(lazyFixtureDirectory, 'tmp') },
            readVolumes: () => [{ id: target.serverId, label: 'Fixture', mount: '/', totalBytes: 1000, availableBytes: 800 }] };
    }, readOwnSessionIds: input.readOwnSessionIds ?? (() => new Set()) });
    registerDaemonStorageRpcHandlers(rpc, routes);
    return { handlers, routes, constructions: () => constructions };
}
describe('lazy storage Machine RPC', () => {
    beforeAll(async () => { lazyFixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-lazy-'))); });
    afterAll(async () => { await rm(lazyFixtureDirectory, { recursive: true, force: true }); });
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
                deps: () => ({ catalog: { happyHomeDir: join(lazyFixtureDirectory, 'absent'), activeServerDir: join(lazyFixtureDirectory, 'absent', 'server'),
                    tempRoot: join(lazyFixtureDirectory, 'absent-temp') }, readVolumes: () => [] }) });
            const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
            const input = { machineId: identity.machineId, serverId: 'browser-home' };
            try {
                await expect(read(input, { ...context(), verifyMachineAdmissionCurrent: async () => false })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
                await expect(read(input, { ...context(), machineAdmission: { ...context().machineAdmission!, installationId: 'old-install' } }))
                    .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
                // Bare registrar calls omit the dispatcher's initial verification.
                // The handler verifies revocation before disclosing this owner's result.
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
        expect([...handlers.keys()]).toEqual([RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
            RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, RPC_METHODS.DAEMON_STORAGE_WATCH,
            RPC_METHODS.DAEMON_STORAGE_PILE_GET, RPC_METHODS.DAEMON_STORAGE_PILE_SET, RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK,
            RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY,
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
            readPolicy: () => { const snapshot = policy.read(); if (snapshot.status !== 'ready') throw new Error('Fixture policy unavailable'); return snapshot.policy.storage; },
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
    it('refuses missing or stale local admission before storage and revoked Home admission before disclosure', async () => {
        const { handlers, constructions, routes } = setup();
        const read = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!;
        await expect(read({ machineId: 'machine' })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ machineId: 'other' }, context())).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(constructions()).toBe(0);
        await expect(read({ machineId: 'machine' }, { ...context(), verifyMachineAdmissionCurrent: async () => false }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(constructions()).toBe(1);
        routes.dispose();
    });
    it('refuses revoked cleanup authority before effects or disclosure, including empty reads and all-entry emptying', async () => {
        const { handlers, constructions, routes } = setup();
        for (const [method, args] of [[RPC_METHODS.DAEMON_STORAGE_PILE_GET, {}], [RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true }],
            [RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK, { refs: [] }], [RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, {}],
            [RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { batchId: 'batch' }]] as const) {
            await expect(handlers.get(method)!({ machineId: 'machine', ...args },
                { ...context(), verifyMachineAdmissionCurrent: async () => false, verifyMachineAuthorityCurrent: async () => false }))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        expect(constructions()).toBe(1);
        routes.dispose();
    });
    it('exposes Machine categories to Manage and only shared capacity totals to Use', async () => {
        const { handlers, routes } = setup();
        try {
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
    it('revalidates after lazy owner construction and after requester-owned Session proof awaits', async () => {
        let valid = true;
        let release!: (deps: StorageServiceDeps) => void;
        let entered!: () => void;
        const enteredDeps = new Promise<void>(resolve => { entered = resolve; });
        const pendingDeps = new Promise<StorageServiceDeps>(resolve => { release = resolve; });
        const { handlers, routes } = setup({ deps: () => { entered(); return pendingDeps; } });
        const admitted = { ...context(), verifyMachineAdmissionCurrent: async () => valid };
        const pending = handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ machineId: 'machine' }, admitted);
        const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await enteredDeps;
        valid = false;
        release({ catalog: { happyHomeDir: lazyFixtureDirectory, activeServerDir: join(lazyFixtureDirectory, 'server'), tempRoot: join(lazyFixtureDirectory, 'tmp') }, readVolumes: () => [] });
        await rejected;
        routes.dispose();

        let releaseProof!: (ids: ReadonlySet<string>) => void;
        let proofEntered!: () => void;
        const enteredProof = new Promise<void>(resolve => { proofEntered = resolve; });
        const proof = new Promise<ReadonlySet<string>>(resolve => { releaseProof = resolve; });
        const next = setup({ readOwnSessionIds: () => { proofEntered(); return proof; } });
        valid = true;
        const ownRead = next.handlers.get(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)!({ machineId: 'machine', categoryId: 'sessionFolders' },
            { ...context('recipient', 'use'), verifyMachineAdmissionCurrent: async () => valid });
        const ownRejected = expect(ownRead).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await enteredProof;
        valid = false;
        releaseProof(new Set(['own-session']));
        await ownRejected;
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
            expect(verifications).toBe(1);
            const controller = new AbortController();
            const latest = await service.summary();
            const cancelled = handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: latest.revision },
                { ...watchContext, signal: controller.signal });
            const rejected = expect(cancelled).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            await new Promise<void>(resolve => setImmediate(resolve));
            controller.abort();
            await rejected;
            expect(verifications).toBe(1);
            expect((await service.summary()).revision).toBe(latest.revision);
        } finally { routes.dispose(); }
    });
    it('retires the previous Home owner instead of carrying its cached facts into a replacement', async () => {
        let target = identity;
        const { handlers, routes } = setup({ target: () => target });
        try {
            const previous = await routes.getService(target);
            expect((await previous.summary()).volumes[0]?.volume.volumeId).toBe('home');
            target = { ...identity, serverId: 'replacement-home' };
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
        const { routes } = setup({ target: () => target, deps: admittedTarget => ({
            catalog: { happyHomeDir: admittedTarget.serverId === identity.serverId ? directory : join(directory, 'replacement'),
                activeServerDir: admittedTarget.serverId === identity.serverId ? activeServerDir : join(directory, 'replacement', 'server'), tempRoot: join(directory, 'tmp') },
            readVolumes: () => [{ id: volume.id, mount: volume.mountPath, label: 'Fixture', totalBytes: 1000, availableBytes: 1000 }],
            // A loaded opt-in reaches real index initialization. Unknown policy
            // deliberately preserves retained indexes without opening them.
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: admittedTarget.serverId === identity.serverId }),
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
    it('serves a recipient own pile and Trash receipts through collect, restore and early empty without disclosing another Account', async () => {
        const home = join(scratch, 'recipient-trash-home');
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
        let revokeAfterMove = false;
        const { handlers, routes } = setup({ deps: () => ({ catalog: { happyHomeDir: home, activeServerDir: server,
            managedSessionDirectories: directories, tempRoot: join(scratch, 'recipient-trash-no-temp'),
            readProjects: () => ({ status: 'ready', projects: [] }),
            readTrackedSessions: () => ['own-session', 'foreign-session'].map(sessionId => ({ sessionId, cwd: scratch, running: false, stoppedAt: 0 })),
            readInUsePaths: () => ({ reliable: true, paths: [] }) }, activityLog, machineId: 'machine', serverId: 'home',
            custodianAccountId: 'owner', homeDir: scratch,
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] }),
            readOwnSessionIds: account => account === 'recipient' ? recipientSessionIds : new Set(account === 'foreign' ? ['foreign-session'] : []),
        });
        const invoke = (method: string, input: object, account = 'recipient', role: 'use' | 'manage' = 'use') =>
            handlers.get(method)!({ machineId: 'machine', ...input }, { ...context(account, role),
                verifyMachineAuthorityCurrent: async () => {
                    // Home authority stays current, but Session custody can end
                    // between the committed move and its requested early empty.
                    if (revokeAfterMove && account === 'recipient') {
                        try { await readFile(join(own.directory, 'own.txt')); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; recipientSessionIds = new Set(); }
                    }
                    return true;
                } });
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
            const result = PileApplyResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE,
                { items: checked.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })), emptyAfter }, account));
            expect(result.outcomes).toEqual([{ itemId: pile.items[0]!.itemId, status: 'moved',
                ...(revokeAfterMove ? { reason: { code: 'unauthorized' } } : {}) }]);
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
            recipientSessionIds = new Set(['own-session']);
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { batchId: ownMoved.batchId }))
                .toMatchObject({ outcomes: [{ status: 'restored', path: own.directory }] });
            expect(await readFile(join(own.directory, 'own.txt'), 'utf8')).toBe('owned attachment');
            revokeAfterMove = true;
            const held = await move('recipient', true);
            expect(held.inTrashBytes).toBeGreaterThan(0);
            expect(held.freedBytes).toBe(0);
            revokeAfterMove = false; recipientSessionIds = new Set(['own-session']);
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, { batchId: held.batchId }))
                .toMatchObject({ outcomes: [{ status: 'restored', path: own.directory }] });
            const again = await move('recipient');
            const emptied = await invoke(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, { batchId: again.batchId });
            expect(emptied, JSON.stringify(emptied))
                .toMatchObject({ outcomes: [{ status: 'deleted' }] });
            expect(await listTrash()).toMatchObject({ items: [], trashEntries: [] });
            expect((await listTrash('foreign')).trashEntries).toEqual([expect.objectContaining({ batchId: foreignMoved.batchId })]);
        } finally { routes.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });
    it('discloses only proven-own folders through the real registrar and drops private Session identity fields', async () => {
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
        const { handlers, routes } = setup({ deps: () => ({ catalog: { happyHomeDir: home, activeServerDir: server,
            managedSessionDirectories: directories, tempRoot: join(scratch, 'absent-temp'), readInUsePaths: async () => {
                if (revokeDuringLivenessRead) ownSessionIds = new Set();
                return { reliable: true, paths: [] };
            } }, readVolumes: () => [] }),
            readOwnSessionIds: actor => actor === 'recipient' ? ownSessionIds : new Set<string>() });
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
            const revoked = await list({ machineId: 'machine', categoryId: 'sessionFolders' }, context('recipient', 'use'));
            expect(ownSessionIds.size).toBe(0);
            expect(revoked).toMatchObject({ items: [] });
            expect(JSON.stringify(revoked)).not.toContain(own.directory);
        } finally { routes.dispose(); }
    });
});
