import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createStorageScanIndex } from '@/storage/scan/scanIndex';
import { logger } from '@/ui/logger';
import { DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from './storage';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';

const filesystemBoundary = vi.hoisted<{ beforeRead?: (path: string) => Promise<void> }>(() => ({}));
// Hold only the OS file read. Pile serialization, identity checks and writes stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
        await filesystemBoundary.beforeRead?.(String(args[0]));
        return actual.lstat(...args);
    } };
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Only Home admission and file logging are substituted. The dispatcher, routes,
// lazy service, scan lifecycle, runner and persisted index are the real owners.
async function fixture() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-currentness-')));
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    const index = createStorageScanIndex({ activeServerDir: home });
    await index.initialize([{ id: 'volume', mountPath: home, usedBytes: 0 }], true);
    const state = await index.begin({ volumeId: 'volume', root: home, target: { folderPath: home }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    index.finish('volume', 'cancelled'); index.close();
    const authority = { valid: true, calls: 0 };
    const policy = await createStoragePolicyFixture({ wholeDiskEnabled: true });
    const depsEntered = deferred(); const releaseDeps = deferred();
    let holdDeps = false;
    let failDeps = false;
    let constructions = 0;
    const routes = createDaemonStorageRoutes({ target: () => target, readOwnSessionIds: () => new Set(), deps: async () => {
        constructions += 1;
        depsEntered.resolve();
        if (holdDeps) await releaseDeps.promise;
        if (failDeps) throw new Error('Fixture storage initialization failed');
        return { catalog: { happyHomeDir: join(home, 'absent'), activeServerDir: home, tempRoot: join(home, 'tmp') },
            readVolumes: () => [{ id: 'volume', mount: home, label: 'Fixture', totalBytes: 1000, availableBytes: 900 }],
            resourcesPolicy: policy };
    } });
    const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => {
            authority.calls += 1;
            return authority.valid ? { ok: true } : { ok: false, error: 'denied', errorCode: 'RPC_FORBIDDEN' };
        } });
    registerDaemonStorageRpcHandlers(manager, routes);
    const call = (method: string, params: Record<string, unknown> = {}, requestId?: string) => manager.handleRequest({ method: `${target.machineId}:${method}`, requestId,
        params: { machineId: target.machineId, ...params }, callerAuthority: 'present_user',
        machineAdmission: { machineId: target.machineId, installationId: target.installationId,
            custodianAccountId: target.custodianAccountId, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' } });
    const pilePath = join(home, 'storage', 'piles', `${createHash('sha256').update('owner').digest('hex')}.json`);
    return { state, routes, authority, policy, call, pilePath, depsEntered, releaseDeps, holdDeps: () => { holdDeps = true; },
        failDeps: () => { failDeps = true; },
        constructions: () => constructions,
        async dispose() { releaseDeps.resolve(); routes.dispose(); policy.stop(); await rm(home, { recursive: true, force: true }); } };
}

afterEach(() => { filesystemBoundary.beforeRead = undefined; vi.restoreAllMocks(); });
describe('storage RPC verification boundaries', () => {
    it('preserves typed policy refusal through the real dispatcher and recovers when policy is ready', async () => {
        await import('@/storage/storageService');
        const disposeNative = await createProcessCustodyFixture();
        const f = await fixture();
        try {
            for (const availability of ['unavailable', 'locked'] as const) {
                await f.policy.setAvailability(availability);
                expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)).toMatchObject({ errorCode: 'policy_unavailable' });
            }
            await f.policy.setAvailability('ready');
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)).toMatchObject({ wholeDisk: { enabled: true } });
            expect(f.constructions()).toBe(1);
        } finally { await f.dispose(); await disposeNative(); }
    });
    it('locates a slow read boundary under the dispatcher request identity without tracing enabled', async () => {
        const f = await fixture(); f.holdDeps();
        const requestId = 'rpc_23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
        vi.stubEnv('HAPPIER_LOG_LEVEL', 'info');
        vi.stubEnv('DEBUG', '');
        const sink = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId }, requestId);
        try {
            await f.depsEntered.promise;
            expect(sink.mock.calls.filter(([message]) => message === '[storage-read]')).toEqual([]);
            now = DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS + 1; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ state: { scanId: f.state.scanId } });
            expect(sink).toHaveBeenCalledWith('[storage-read]', expect.objectContaining({
                stage: 'storage.rpc.service', requestId, status: 'settled', elapsedMs: now, outcome: 'completed',
            }));
            expect(sink).toHaveBeenCalledWith('[storage-read]', expect.objectContaining({
                stage: 'storage.rpc.service', requestId, status: 'started', elapsedMs: 0,
            }));
            expect(debug.mock.calls.filter(([message]) => message === '[storage-read]')).toEqual([]);
            expect(f.authority.calls).toBe(1);
        } finally {
            f.releaseDeps.resolve(); await pending; clock.mockRestore(); vi.unstubAllEnvs(); await f.dispose();
        }
    });
    it('keeps the dispatcher denial ahead of lazy storage construction', async () => {
        const f = await fixture(); f.authority.valid = false;
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(1);
            expect(f.constructions()).toBe(0);
        } finally { await f.dispose(); }
    });
    it('settles scan cancellation with only dispatcher admission', async () => {
        const f = await fixture();
        let atEntry = 0;
        vi.spyOn(logger, 'infoFile').mockImplementation(message => {
            if (message === '[storage-scan] cancel-entry') atEntry = f.authority.calls;
        });
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId })).toMatchObject({ status: 'cancelled' });
            expect(atEntry).toBe(1);
            expect(f.authority.calls).toBe(1);
        } finally { await f.dispose(); }
    });
    it('finishes admitted cancellation after Home withdrawal during lazy service initialization and denies the next request', async () => {
        const f = await fixture(); f.holdDeps();
        const entries: string[] = [];
        vi.spyOn(logger, 'infoFile').mockImplementation(message => { entries.push(message); });
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ status: 'cancelled' });
            expect(entries).toContain('[storage-scan] cancel-entry');
            expect(f.authority.calls).toBe(1);
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('returns settled cancellation after Home withdrawal at runner entry and denies the next request', async () => {
        const f = await fixture(); let reachedRunner = false;
        vi.spyOn(logger, 'infoFile').mockImplementation(message => {
            if (message === '[storage-scan] cancel-entry') { reachedRunner = true; f.authority.valid = false; }
        });
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId })).toMatchObject({ status: 'cancelled' });
            expect(reachedRunner).toBe(true);
            expect(f.authority.calls).toBe(1);
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('admits a passive scan read once at dispatch', async () => {
        const f = await fixture();
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ state: { scanId: f.state.scanId } });
            expect(f.authority.calls).toBe(1);
        } finally { await f.dispose(); }
    });
    it('finishes an admitted read after Home withdrawal during lazy initialization and denies the next request', async () => {
        const f = await fixture(); f.holdDeps();
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ state: { scanId: f.state.scanId } });
            expect(f.authority.calls).toBe(1);
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('retains the admitted initialization error after Home withdrawal and denies the next request', async () => {
        const f = await fixture(); f.holdDeps(); f.failDeps();
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ error: 'Fixture storage initialization failed' });
            expect(f.authority.calls).toBe(1);
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('admits each pile read and mutation once at dispatch', async () => {
        const f = await fixture();
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_PILE_GET)).toMatchObject({ items: [] });
            expect(f.authority.calls).toBe(1);
            f.authority.calls = 0;
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true })).toMatchObject({ items: [] });
            expect(f.authority.calls).toBe(1);
        } finally { await f.dispose(); }
    });
    it('finishes an admitted no-op pile mutation after Home withdrawal during the store read and denies the next request', async () => {
        const f = await fixture(); const entered = deferred(); const release = deferred();
        filesystemBoundary.beforeRead = async path => { if (path === f.pilePath) { entered.resolve(); await release.promise; } };
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true });
            await entered.promise;
            f.authority.valid = false; release.resolve();
            expect(await pending).toMatchObject({ items: [], summary: { count: 0 } });
            expect(f.authority.calls).toBe(1);
            filesystemBoundary.beforeRead = undefined;
            await expect(readFile(f.pilePath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_PILE_GET)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { release.resolve(); await f.dispose(); }
    });
});
