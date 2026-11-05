import { execFile } from 'node:child_process';
import * as childProcess from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { createStorageService, type StorageOperationActor, type StorageService, type StorageServiceDeps } from './storageService';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from '@/rpc/handlers/storage';
import { readProcessCensus } from '@/processes/census/processCensus';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerMap, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createHappierTempDir, getHappierTempRoot, getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createDaemonStorageVitalsBindings } from '@/daemon/resources/createDaemonStorageVitalsBindings';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { watcherCount } from '@/daemon/lifecycle/parkWatch';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { MachineStoragePolicyV1Schema, STORAGE_CHART_MAX_DRAWABLE_NODES,
    DiskScanStateV1Schema, type DiskScanStateV1, HappierStorageSummaryV1Schema, MachineStorageScanGetResultV1Schema, MachineStoragePileResultV1Schema,
    MachineStorageTrashMoveInputV1Schema, MachineStorageDeleteNowInputV1Schema, PileReviewV1Schema, PileApplyResultV1Schema,
    MachineStorageCategoryListResultV1Schema, TrashEntryV1Schema, TrashRestoreResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createStorageScanIndex } from './scan/scanIndex';
import { createGitScmBackendRuntimeRegistration } from '../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { createStorageWorktreeOperations } from './worktrees/storageWorktreeOperations';
import { createDaemonEventLoopStallMonitor } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTrashStore, resolveTrashOsUserId } from './trash/trashStore';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { startNativeDiskScan, measureNativeDisk } from './measure/nativeDiskMeasure';

// Pass through the real OS boundaries while observing summary enumeration and helper work.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

const execute = promisify(execFile);
// Native-helper fixtures replace process.execPath to exercise packaged lookup.
// Child fixture processes still run the actual test host executable.
const testHostExecutable = process.execPath;
let disposeNative: (() => Promise<void>) | undefined;
let scratch: string;

/** The mounted watch surface has one outstanding read; native record notifications are coalesced. */
async function waitForStorageScan(service: StorageService, scanId: string, actor: StorageOperationActor): Promise<void> {
    await new Promise<void>((done, reject) => {
        let reading = false; let changed = true; let settled = false;
        const off = service.subscribe(() => { changed = true; void check(); });
        async function check() {
            if (reading || settled) return;
            reading = true;
            try {
                do {
                    changed = false;
                    const current = await service.scanGet({ machineId: 'machine', scanId }, { actor });
                    if (current.state?.status === 'complete') { settled = true; off(); done(); }
                    else if (current.state?.status === 'failed' || current.state?.status === 'interrupted' || current.state?.status === 'cancelled') {
                        settled = true; off(); reject(new Error(`Fixture scan did not complete: ${JSON.stringify(current.state)}`));
                    }
                } while (changed && !settled);
            } catch (error) { settled = true; off(); reject(error); }
            finally { reading = false; }
        }
        void check();
    });
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('storage service with the actual native helper', () => {
    beforeAll(async () => {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-service-')));
        disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../..') });
    });
    afterAll(async () => {
        await disposeNative?.();
        if (scratch) await rm(scratch, { recursive: true, force: true });
    });

    it.skipIf(process.getuid?.() === 0).each([false, true])('serves readable scan results while a mode-000 folder remains incomplete (known project: %s)', async knownProject => {
        const home = join(scratch, `permission-home-${knownProject}`);
        const root = join(scratch, `permission-scan-${knownProject}`);
        const denied = join(root, 'permission-denied');
        const readable = join(root, 'readable');
        await Promise.all([home, denied, readable].map(path => mkdir(path, { recursive: true })));
        await writeFile(join(readable, 'bytes'), Buffer.alloc(8192, 1));
        await chmod(denied, 0);
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner',
            assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ homeDir: scratch, scmRegistry: createScmBackendRegistry([]),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'permission-no-temp'),
                readProjects: () => ({ status: 'ready', projects: knownProject ? [{ repositoryRoot: denied }] : [] }),
                readInUsePaths: () => ({ reliable: true, paths: [] }) },
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
            readVolumes: () => [{ id: 'permission', label: 'Permission', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const state = await service.scanStart({ machineId: 'machine', target: { folderPath: root } }, { actor });
            await waitForStorageScan(service, state.scanId, actor);
            for (const sort of [undefined, { by: 'size' as const, direction: 'desc' as const }]) {
                const result = MachineStorageScanGetResultV1Schema.parse(await service.scanGet({ machineId: 'machine', scanId: state.scanId,
                    view: { tab: 'folders', depth: 1, ...(sort ? { sort } : {}) } }, { actor }));
                expect(result.state?.unreadable.counts.permission).toBe(1);
                expect(result.root?.size.atLeast).toBe(true);
                expect(result.nodes.find(node => node.nodeId === denied)).toMatchObject({ size: { atLeast: true }, flags: { atLeast: true } });
                expect(result.nodes.find(node => node.nodeId === readable)?.size.allocatedBytes).toBeGreaterThan(0);
            }
        } finally { service.dispose(); await chmod(denied, 0o700); }
    });

    it('preserves temp ownership through Undo and forecasts only exclusive bytes through pile and Trash', async () => {
        const root = join(scratch, 'temp-undo'); const home = join(root, 'home'); const tempRoot = join(root, 'tmp');
        await mkdir(home, { recursive: true });
        const source = createHappierTempDir({ root: tempRoot, purpose: 'undo-fixture' });
        const marker = getHappierTempDirOwnerPath(source);
        // A reused PID with a different start identity is a canonical gone-owner fixture.
        await writeFile(marker, JSON.stringify({ v: 1, purpose: 'undo-fixture', pid: process.pid, processInstanceFingerprint: 'former-instance' }));
        const ownerBytes = await readFile(marker, 'utf8');
        const sample = join(source, 'sample'); const outside = join(root, 'outside-link');
        await writeFile(sample, Buffer.alloc(16_384, 7)); await link(sample, outside);
        const identity = await lstat(sample);
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(home, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary });
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner',
            assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        let availableBytes = 500_000; let volumeChanged = () => {};
        const open = () => createStorageService({ homeDir: scratch, machineId: 'machine', activityLog,
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot,
                readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) },
            readVolumes: () => [{ id: 'main', label: 'Main', mount: root, totalBytes: 1_000_000, availableBytes }],
            subscribeVolumeChanges(listener) { volumeChanged = listener; return () => {}; } });
        const measurements = () => vi.mocked(childProcess.spawn).mock.calls.filter(([, args]) => args?.[0] === 'disk-measure').length;
        let service = open();
        const check = async () => {
            const item = (await service.categoryList('temporary')).items.find(item => item.path === source)!;
            expect(item.verdict).toBe('safe');
            expect((await service.suggestionsList({ machineId: 'machine' }, { actor })).items.some(item => item.path === source)).toBe(true);
            const pile = await service.pileSet({ machineId: 'machine', add: [{ itemId: item.itemId, path: source }] }, { actor });
            return service.itemsCheck(pile.items, { actor });
        };
        try {
            const review = await check(); const size = review.items[0]!.size;
            expect(size.sharedBytes).toBeGreaterThan(0); expect(size.freesBytes).toBeLessThan(size.allocatedBytes);
            const before = HappierStorageSummaryV1Schema.parse(await service.summary({ actor }));
            expect(before.volumes[0]).toMatchObject({ pileBytes: size.allocatedBytes, pileFreesBytes: review.totalFreesBytes });
            const moved = await service.trashMove({ machineId: 'machine', items: review.items.map(item => ({ ref: item.ref,
                expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(moved.outcomes).toMatchObject([{ status: 'moved' }]);
            const inTrash = HappierStorageSummaryV1Schema.parse(await service.summary({ actor }));
            expect(inTrash.volumes[0]).toMatchObject({ pileBytes: 0, pileFreesBytes: 0, trashBytes: size.allocatedBytes, trashFreesBytes: size.freesBytes });
            expect(inTrash.categories.find(category => category.categoryId === 'trash')?.size.freesBytes).toBe(size.freesBytes);
            const measuredBeforeCapacity = measurements();
            availableBytes = 400_000; volumeChanged();
            expect((await service.summary({ actor })).volumes[0]).toMatchObject({ freeBytes: availableBytes,
                trashBytes: size.allocatedBytes, trashFreesBytes: size.freesBytes });
            expect(measurements() - measuredBeforeCapacity).toBe(0);
            service.dispose(); service = open();
            expect((await service.trashRestore({ machineId: 'machine', batchId: moved.batchId }, { actor })).outcomes)
                .toMatchObject([{ status: 'restored' }]);
            expect(await readFile(marker, 'utf8')).toBe(ownerBytes);
            expect(await readFile(sample)).toEqual(Buffer.alloc(16_384, 7));
            expect((await lstat(sample)).ino).toBe(identity.ino);
            const again = await check();
            const second = await service.trashMove({ machineId: 'machine', items: again.items.map(item => ({ ref: item.ref,
                expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect((await service.trashEmpty({ machineId: 'machine', batchId: second.batchId }, { actor })).freedBytes).toBe(size.freesBytes);
            expect(await readFile(outside)).toEqual(Buffer.alloc(16_384, 7));
            expect((await lstat(outside)).ino).toBe(identity.ino);
            const pair = [createHappierTempDir({ root: tempRoot, purpose: 'pair-a' }),
                createHappierTempDir({ root: tempRoot, purpose: 'pair-b' })];
            for (const [index, path] of pair.entries()) await writeFile(getHappierTempDirOwnerPath(path),
                JSON.stringify({ v: 1, purpose: index === 0 ? 'pair-a' : 'pair-b', pid: process.pid, processInstanceFingerprint: 'former-instance' }));
            await writeFile(join(pair[0]!, 'linked'), Buffer.alloc(8192, 1));
            await link(join(pair[0]!, 'linked'), join(pair[1]!, 'linked'));
            await service.refresh();
            const refs = (await service.categoryList('temporary')).items.filter(item => pair.includes(item.path))
                .map(item => ({ itemId: item.itemId, path: item.path }));
            expect(refs).toHaveLength(2);
            await service.pileSet({ machineId: 'machine', add: refs }, { actor });
            const together = await service.itemsCheck(refs, { actor });
            expect(together.totalFreesBytes).toBeGreaterThan(together.items.reduce((sum, item) => sum + item.size.freesBytes, 0));
            await service.summary();
            const measuredBeforePileProjection = measurements();
            expect((await service.summary({ actor })).volumes[0]?.pileFreesBytes).toBe(together.totalFreesBytes);
            // Per-volume union attribution reuses the one pile measurement,
            // including links between selected roots; it adds no second walk.
            expect(measurements() - measuredBeforePileProjection).toBe(1);
        } finally { service.dispose(); }
    });

    it('serves retained logs with process protection facts without starving the daemon', async () => {
        const home = join(scratch, 'protected-log-inventory');
        await mkdir(join(home, 'logs'), { recursive: true });
        for (let index = 0; index < 650; index++) await writeFile(join(home, 'logs', `${index}.log`), 'fixture');
        // The OS process owner emits repeated cwd/executable paths for descendants.
        // The isolated full-summary profile reproduced a 2186ms stall at this inventory.
        const paths = Array.from({ length: 1_800 }, (_, index) => join(scratch, 'work', `project-${index % 180}`));
        const sessions = paths.map((path, index) => ({ path, sessionId: `session-${index % 180}` }));
        const warnings: Readonly<Record<string, unknown>>[] = [];
        const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [],
            warn: (_message, data) => warnings.push(data) });
        const service = createStorageService({ homeDir: scratch, readVolumes: () => [],
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'no-log-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths, sessions }) } });
        const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
        try {
            traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
            monitor.start();
            const summary = await service.summary();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(summary.categories.find(category => category.categoryId === 'logs')?.count).toBe(650);
            expect(warnings).toEqual([]);
        } finally { monitor.stop(); service.dispose(); traceEnv.restore(); }
    }, 60_000);

    it('reuses sized catalog facts for retained and fresh Account-qualified summary RPCs', async () => {
        const root = join(scratch, 'summary-cost'); const home = join(root, 'home'); const repo = join(root, 'repo');
        await mkdir(home, { recursive: true }); await mkdir(repo);
        await execute('git', ['init', repo]);
        await writeFile(join(repo, '.gitignore'), '.dev/\n');
        await execute('git', ['-C', repo, 'add', '.gitignore']);
        await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
        const worktree = join(repo, '.dev', 'worktree', 'summary');
        await execute('git', ['-C', repo, 'worktree', 'add', '-b', 'summary', worktree]);
        const cwds = [repo, worktree];
        for (let index = 0; index < 6; index++) {
            const cwd = join(repo, `source-${index}`); await mkdir(cwd); cwds.push(cwd);
        }
        for (let directory = 0; directory < 20; directory++) {
            const path = join(home, 'logs', `group-${directory}`); await mkdir(path, { recursive: true });
            await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(path, `${index}.log`), 'fixture')));
        }
        const oldLog = join(home, 'logs', 'group-0', '0.log'); await utimes(oldLog, 1, 1);
        const registration = createGitScmBackendRuntimeRegistration();
        const backend = createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) });
        const statusSnapshot = backend.statusSnapshot!;
        let phase = 'raw-fresh';
        const protectionReads = new Map<string, number>();
        let heldPaths: string[] = [];
        const inspections = new Map<string, number>();
        const statuses = new Map<string, string[]>(); const fingerprints = new Map<string, string[]>();
        const native = new Map<string, number>();
        // Observe real SCM contributions and OS calls; all results still come from Git and the native helper.
        const registry = createScmBackendRegistry([{ ...backend, statusSnapshot: async input => {
            const roots = statuses.get(phase) ?? []; roots.push(input.context.detection.rootPath!); statuses.set(phase, roots);
            return statusSnapshot(input);
        } }]);
        const readDirectories = vi.mocked(filesystem.readdir);
        const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const nativeSpawn = vi.mocked(childProcess.spawn).mockImplementation(((...args: unknown[]) => {
            const operation = phase;
            const child = Reflect.apply(actualChildProcess.spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
            if (Array.isArray(args[1]) && args[1][0] === 'disk-measure') {
                native.set(operation, (native.get(operation) ?? 0) + 1);
                // A holder can appear while native sizing is in flight. The
                // Account projection must read it after that operation settles.
                if (operation === 'actor-fresh') child.once('close', () => { heldPaths = [oldLog]; });
            }
            // This exact Git read belongs to the canonical change-fingerprint owner.
            if (Array.isArray(args[1]) && args[1].join(' ') === 'ls-files -z --others --exclude-standard'
                && args[2] !== null && typeof args[2] === 'object' && 'cwd' in args[2] && typeof args[2].cwd === 'string') {
                const roots = fingerprints.get(operation) ?? []; roots.push(args[2].cwd); fingerprints.set(operation, roots);
            }
            return child;
        }) as typeof childProcess.spawn);
        const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
        const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(),
            deps: () => ({ homeDir: home, scmRegistry: registry,
                catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(root, 'absent-temp'),
                    readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }),
                    readInUsePaths: () => {
                        protectionReads.set(phase, (protectionReads.get(phase) ?? 0) + 1);
                        return { reliable: true, paths: heldPaths };
                    },
                    readWorktrees: async () => {
                        const operation = phase;
                        inspections.set(operation, (inspections.get(operation) ?? 0) + 1);
                        return readStorageWorktrees({ cwds, happyHomeDir: home, registry });
                    } },
                readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: root, totalBytes: 1_000_000, availableBytes: 500_000 }] }) });
        const handlers: RpcHandlerMap = new Map();
        registerDaemonStorageRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, routes);
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        const rpcSummary = async () => HappierStorageSummaryV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)!({ machineId: 'machine' }, context));
        const metrics: Record<string, { scm: number; native: number; directoryReads: number }> = {};
        async function readPhase<T>(operation: string, read: () => Promise<T>): Promise<T> {
            phase = operation; const before = readDirectories.mock.calls.length;
            const result = await read();
            metrics[operation] = { scm: inspections.get(operation) ?? 0,
                native: native.get(operation) ?? 0, directoryReads: readDirectories.mock.calls.slice(before)
                    .filter(([path]) => typeof path === 'string' && path.startsWith(root)).length };
            return result;
        }
        try {
            const service = await routes.getService(identity);
            const raw = await readPhase('raw-fresh', () => service.summary());
            const retained = await readPhase('actor-retained', rpcSummary);
            await readPhase('raw-retained', () => service.summary());
            service.invalidate();
            const fresh = await readPhase('actor-fresh', rpcSummary);
            expect(fresh.suggestionsTop.some(item => item.path === oldLog)).toBe(false);
            heldPaths = [];
            const refreshed = await readPhase('actor-refresh', () => service.refresh({ actor: {
                accountId: 'owner', custodianAccountId: 'owner', kind: 'person', assertCurrent: async () => {}, assertCurrentAuthority: async () => {},
            } }));
            expect(retained.categories).toEqual(raw.categories);
            expect(retained.suggestionsTop).toEqual(raw.suggestionsTop);
            expect(retained.suggestionsTop).toContainEqual(expect.objectContaining({ path: oldLog, categoryId: 'logs' }));
            expect(fresh.categories.find(category => category.categoryId === 'logs')?.count).toBe(400);
            expect(refreshed.suggestionsTop).toContainEqual(expect.objectContaining({ path: oldLog, categoryId: 'logs' }));
            expect(metrics['raw-fresh']?.directoryReads).toBeGreaterThan(0);
            expect.soft(Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value.scm])))
                .toEqual({ 'raw-fresh': 1, 'actor-retained': 0, 'raw-retained': 0, 'actor-fresh': 1, 'actor-refresh': 1 });
            expect.soft(Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value.native])))
                .toEqual({ 'raw-fresh': 1, 'actor-retained': 0, 'raw-retained': 0, 'actor-fresh': 1, 'actor-refresh': 1 });
            expect.soft(metrics['actor-retained']?.directoryReads).toBe(0);
            // One raw sizing operation shares one native process observation
            // across discovery, protection and both recognition passes. Account
            // projection separately refreshes protection after sizing completes.
            expect.soft(Object.fromEntries(protectionReads)).toEqual({ 'raw-fresh': 1, 'actor-retained': 1,
                'actor-fresh': 2, 'actor-refresh': 2 });
            heldPaths = [oldLog];
            const held = await readPhase('actor-held', rpcSummary);
            expect(held.suggestionsTop.some(item => item.path === oldLog)).toBe(false);
            expect(protectionReads.get('actor-held')).toBe(1);
            expect.soft(statuses.get('raw-fresh')?.sort()).toEqual([repo, worktree].sort());
            expect.soft(statuses.get('actor-fresh')?.sort()).toEqual([repo, worktree].sort());
            expect.soft(fingerprints.get('raw-fresh')?.sort()).toEqual([repo, worktree].sort());
            expect.soft(fingerprints.get('actor-fresh')?.sort()).toEqual([repo, worktree].sort());
        } finally {
            routes.dispose(); nativeSpawn.mockImplementation(actualChildProcess.spawn); nativeSpawn.mockClear(); readDirectories.mockClear();
        }
    });

    it('projects an empty retained summary without gathering unused process protection facts', async () => {
        const home = join(scratch, 'empty-summary'); await mkdir(home);
        let reads = 0;
        const service = createStorageService({ homeDir: scratch,
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'empty-summary-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }),
                readInUsePaths: () => { reads++; return { reliable: true, paths: [] }; } }, readVolumes: () => [] });
        const actor = { accountId: 'owner', custodianAccountId: 'owner', kind: 'person' as const,
            assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        try {
            expect((await service.summary()).suggestionsTop).toEqual([]);
            const measuredReads = reads;
            expect(measuredReads).toBeGreaterThan(0);
            expect((await service.summary({ actor })).suggestionsTop).toEqual([]);
            expect(reads).toBe(measuredReads);
        } finally { service.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('reads native process facts once per changed Storage watch, without a discarded warmup projection', async () => {
        const home = join(scratch, 'watch-native-facts');
        const oldLog = join(home, 'logs', 'old.log');
        await mkdir(join(home, 'logs'), { recursive: true });
        await writeFile(oldLog, Buffer.alloc(4096, 1));
        await utimes(oldLog, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
        const os = await createLinuxVitalsFixture();
        await os.put('/proc/self/mountinfo', `1 0 8:1 / ${scratch} rw - ext4 /dev/sda rw\n`);
        // The real reader admits directory-backed mounts, so the redirected
        // procfs fixture must contain the mount directory it reports.
        await mkdir(join(os.root, scratch), { recursive: true });
        let available = 500;
        let sampledAt = Date.UTC(2026, 9, 24);
        let nextSample = () => {};
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: os.root, homePath: home,
                statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: available, bavail: available, files: 100, ffree: 50 }) }),
            historyStore: await createMinuteHistoryStore({ directory: join(home, 'vitals') }),
            nowMs: () => sampledAt, monotonicMs: () => sampledAt,
            setTimeoutFn: callback => { nextSample = callback; return {}; }, clearTimeoutFn: () => {},
            onError: error => { throw error; },
        });
        await sampler.start();
        const releaseDemand = sampler.demand('live');
        const binding = createDaemonStorageVitalsBindings(sampler);
        const tick = async () => { sampledAt += 2000; nextSample(); await sampler.start(); };
        let holder: ReturnType<typeof childProcess.spawn> | undefined;
        const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
        const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(),
            deps: () => ({ homeDir: scratch, ...binding, subscribeChanges: binding.subscribeVolumes,
                catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(home, 'absent-temp'),
                    readProjects: () => ({ status: 'ready', projects: [] }),
                    // Keep the process reader and protection logic real. The existing
                    // pass-through filesystem spy counts actual /proc enumerations.
                    readInUsePaths: async () => {
                        const observed = await readProcessCensus({ freshness: 'fresh', fields: ['cwd'] });
                        if (observed.status !== 'ok') throw new Error('Native process fixture unavailable');
                        // This fixture owns only its test process; unrelated host
                        // processes (including shells at /) are not its holders.
                        return { reliable: true, paths: observed.rows.filter(row => row.pid === process.pid || row.pid === holder?.pid)
                            .flatMap(row => row.cwd ? [row.cwd] : []) };
                    } } }) });
        const handlers: RpcHandlerMap = new Map();
        registerDaemonStorageRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, routes);
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        const enumerations = () => vi.mocked(filesystem.readdir).mock.calls.filter(([path]) => path === '/proc').length;
        const cancellation = new AbortController();
        let pendingWatch: Promise<unknown> | undefined;
        let unsubscribeChanges: (() => void) | undefined;
        try {
            expect(binding.readVolumes()).toMatchObject([{ availableBytes: available * 4096 }]);
            const service = await routes.getService(identity);
            // A live holder can change cwd without a process start/end or a
            // Storage invalidation. Observe that real OS boundary, not a cached
            // protection fixture that only changes alongside lifecycle events.
            const idleCwd = join(scratch, 'watch-native-idle');
            await mkdir(idleCwd);
            holder = childProcess.spawn(testHostExecutable, ['-e',
                "process.on('message', path => { process.chdir(path); process.send('moved'); }); process.send('ready');"],
            { cwd: idleCwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            const initial = await service.summary();
            expect(initial.suggestionsTop).toContainEqual(expect.objectContaining({ path: oldLog }));
            const before = enumerations();
            for (let arrival = 0; arrival < 3; arrival++) {
                const result = await handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: 0 }, context);
                expect(result).toMatchObject({ changed: true, summary: {
                    suggestionsTop: expect.arrayContaining([expect.objectContaining({ path: oldLog })]),
                } });
            }
            expect(enumerations() - before).toBe(3);
            let completions = 0;
            let publications = 0;
            unsubscribeChanges = service.subscribe(() => { publications++; });
            const revision = service.revision();
            const parked = handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: revision },
                { ...context, signal: cancellation.signal }).then((result: unknown) => { completions++; return result; });
            pendingWatch = parked;
            await vi.waitFor(() => expect(watcherCount()).toBe(1));
            const beforeSamples = enumerations();
            for (let sample = 0; sample < 10; sample++) await tick();
            expect(sampler.latest()?.sampledAt).toBe(sampledAt);
            expect(service.revision()).toBe(revision);
            expect(publications, 'unchanged volume facts must not publish Storage changes').toBe(0);
            expect(completions, 'ten unchanged Storage observations must leave the watch parked').toBe(0);
            expect(watcherCount()).toBe(1);
            expect(enumerations() - beforeSamples, 'unchanged Vitals must not gather Storage protection').toBe(0);
            available = 400;
            await tick();
            expect(await parked).toMatchObject({ changed: true, summary: {
                volumes: [expect.objectContaining({ freeBytes: available * 4096 })],
                suggestionsTop: expect.arrayContaining([expect.objectContaining({ path: oldLog })]),
            } });
            expect(completions).toBe(1);
            expect(publications).toBe(1);
            expect(enumerations() - beforeSamples, 'one real change gets one fresh disclosure observation').toBe(1);
            const holderRevision = service.revision();
            const holderMoved = once(holder, 'message');
            holder.send!(join(home, 'logs'));
            await holderMoved;
            expect(service.revision(), 'a live cwd change has no Storage lifecycle edge').toBe(holderRevision);
            const beforeHolder = enumerations();
            pendingWatch = handlers.get(RPC_METHODS.DAEMON_STORAGE_WATCH)!({ machineId: 'machine', sinceRevision: holderRevision },
                { ...context, signal: cancellation.signal });
            await vi.waitFor(() => expect(watcherCount()).toBe(1));
            available = 300;
            await tick();
            const changedHolder = await pendingWatch;
            expect(changedHolder).toMatchObject({ changed: true, summary: {
                volumes: [expect.objectContaining({ freeBytes: available * 4096 })], suggestionsTop: [],
            } });
            expect(enumerations() - beforeHolder, 'a capacity edge must not reuse protection across a real holder change').toBe(1);
        } finally { cancellation.abort(); await pendingWatch?.catch(() => {}); unsubscribeChanges?.();
            if (holder?.exitCode === null) { const exited = once(holder, 'exit'); holder.kill(); await exited; }
            routes.dispose(); releaseDemand(); await sampler.stop(); await os.cleanup(); }
    });

    it.each(['linux', 'darwin', 'win32'] as const)('serves daemon-qualified %s scan shortcuts through the strict summary consumer', async platform => {
        const home = join(scratch, `shortcut-${platform}`); await mkdir(home);
        const downloads = join(scratch, `relocated-downloads-${platform}`);
        const cache = join(scratch, `relocated-cache-${platform}`);
        const service = createStorageService({ machineId: 'machine', homeDir: home,
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'no-shortcut-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) },
            readStorageProtectionFacts: () => ({ platform, knownFolders: { Downloads: downloads },
                env: { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache } }), readVolumes: () => [] });
        try {
            const summary = HappierStorageSummaryV1Schema.parse(await service.summary());
            const shortcuts = summary.scanShortcuts;
            expect(shortcuts).toEqual([{ kind: 'downloads', path: downloads }, { kind: 'cache',
                path: platform === 'darwin' ? join(home, 'Library', 'Caches') : cache }]);
        } finally { service.dispose(); }
    });

    it('uses the daemon cache environment when no custom environment reader is bound', async () => {
        const home = join(scratch, 'shortcut-daemon-environment'); await mkdir(home);
        const cache = join(scratch, 'actual-daemon-cache');
        vi.stubEnv('XDG_CACHE_HOME', cache);
        const service = createStorageService({ homeDir: home,
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'no-env-shortcut-temp') },
            readStorageProtectionFacts: () => ({ platform: 'linux' }), readVolumes: () => [] });
        try {
            expect(HappierStorageSummaryV1Schema.parse(await service.summary()).scanShortcuts)
                .toContainEqual({ kind: 'cache', path: cache });
        } finally { service.dispose(); vi.unstubAllEnvs(); }
    });

    it('removes orphaned ACP installs through their owner and refuses ancestor, descendant and live-session bypasses', async () => {
        const home = join(scratch, 'acp-installs-home'); const server = join(home, 'servers', 'fixture');
        const root = join(home, 'tools', `dep.${managedAcpInstallId({ accountId: 'owner', definitionId: 'removed', version: '1.0' })}`); const current = join(root, 'current');
        const bytes = join(current, 'agent');
        await mkdir(current, { recursive: true }); await mkdir(server, { recursive: true });
        await writeFile(bytes, 'fixture executable');
        await writeFile(join(current, '.happier-managed-version'), JSON.stringify({ definitionId: 'removed', title: 'Fixture agent', kind: 'archive', version: '1.0' }));
        let running = true;
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ machineId: 'machine', homeDir: scratch,
            activityLog: await createActivityLog({ activeServerDir: server, resourceSummary }),
            catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'acp-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }),
                acpAccountId: 'owner', readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [] } }),
                isAcpDefinitionInUse: () => running },
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
        });
        try {
            const item = (await service.categoryList('caches')).items.find(item => item.path === root)!;
            expect(item).toMatchObject({ title: 'Fixture agent · removed agent', reason: { code: 'in_use' } });
            const scan = await service.scanStart({ machineId: 'machine', target: { folderPath: join(home, 'tools') } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            for (const path of [join(home, 'tools'), bytes]) {
                const review = await service.itemsCheck([{ itemId: path, path }], { actor });
                expect(review.items.every(item => item.verdict === 'forbidden')).toBe(true);
                expect(review.staying[0]?.reason.code).toMatch(/unsupported|happier_data|contains_forbidden/);
                const removed = await service.deleteNow({ machineId: 'machine', items: review.items.map(value => ({
                    ref: value.ref, expect: value.expect, claimedVerdict: value.verdict,
                })) }, { actor });
                expect(removed.outcomes.every(outcome => outcome.status !== 'deleted')).toBe(true);
                await expect(lstat(bytes)).resolves.toBeDefined();
            }
            const collected = await service.pileSet({ machineId: 'machine', add: [{ itemId: item.itemId, path: root }] }, { actor });
            let reviewed = await service.itemsCheck(collected.items, { actor });
            const live = await service.deleteNow({ machineId: 'machine', items: reviewed.items.map(value => ({ ref: value.ref, expect: value.expect, claimedVerdict: value.verdict })) }, { actor });
            expect(live.outcomes[0]?.status).toBe('failed');
            await expect(lstat(bytes)).resolves.toBeDefined();
            running = false; reviewed = await service.itemsCheck(collected.items, { actor });
            const removed = await service.deleteNow({ machineId: 'machine', items: reviewed.items.map(value => ({ ref: value.ref, expect: value.expect, claimedVerdict: value.verdict })) }, { actor });
            expect(removed.outcomes[0]?.status).toBe('deleted');
            await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('sizes the home union once, attributes nested categories and preserves revision after a read', async () => {
        const home = join(scratch, 'home');
        const server = join(home, 'servers', 'fixture');
        await mkdir(join(home, 'cache'), { recursive: true });
        await mkdir(server, { recursive: true });
        const shared = join(home, 'cache', 'cache.bin');
        await writeFile(shared, Buffer.alloc(8192, 1));
        await link(shared, join(server, 'retained.bin'));
        await writeFile(join(home, 'retained.bin'), Buffer.alloc(4096, 2));
        const tempRoot = join(scratch, 'owned-temp');
        const temporary = createHappierTempDir({ root: tempRoot, purpose: 'service-fixture' });
        await writeFile(join(temporary, 'bytes'), Buffer.alloc(4096, 6));
        const uidRoot = getHappierTempRoot(tempRoot);
        let availableBytes = 800_000;
        let availableIncludingPurgeableBytes: number | undefined = 850_000;
        let volumeChanged = () => {};
        let projectsReported = false;
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: server,
            tempRoot, bootedAt: Date.now(),
            readProjects: () => projectsReported ? { status: 'ready', projects: [] } : { status: 'unavailable' } },
            readVolumes: () => [{ id: 'fixture-volume', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes, availableIncludingPurgeableBytes }],
            subscribeVolumeChanges(listener) { volumeChanged = listener; return () => { volumeChanged = () => {}; }; },
        });
        try {
            const { stdout } = await execute('du', process.platform === 'linux' ? ['-s', '--block-size=1', home] : ['-sk', home]);
            const tempAllocation = await execute('du', process.platform === 'linux' ? ['-s', '--block-size=1', uidRoot] : ['-sk', uidRoot]);
            const actualAllocation = (Number(stdout.trim().split(/\s/u)[0]) + Number(tempAllocation.stdout.trim().split(/\s/u)[0]))
                * (process.platform === 'darwin' ? 1024 : 1);
            const summary = await service.summary();
            expect(summary.volumes[0]).toMatchObject({ freeBytes: 800_000, availableIncludingPurgeableBytes: 850_000 });
            expect(summary.volumes[0]?.happierBytes).toBe(actualAllocation);
            expect(summary.categories.reduce((sum, category) => sum + category.size.allocatedBytes, 0)).toBe(actualAllocation);
            expect(summary.categories.find(category => category.categoryId === 'caches')?.size.allocatedBytes)
                .toBeGreaterThanOrEqual((await lstat(shared)).blocks * 512);
            expect(summary.categories.map(category => category.categoryId).sort())
                .toEqual(['agentHomes', 'caches', 'logs', 'modelPacks', 'ownData', 'recordings', 'sessionFolders', 'temporary', 'trash', 'worktrees'].sort());
            const ownData = await service.categoryList('ownData');
            expect(summary.categories.find(category => category.categoryId === 'worktrees')?.size.atLeast).toBe(true);
            expect(ownData.items.every(item => !item.collectable && item.verdict === 'forbidden')).toBe(true);
            expect(ownData.items.some(item => item.path === uidRoot)).toBe(true);
            expect((await service.summary()).revision).toBe(summary.revision);
            await writeFile(join(home, 'cache', 'new.bin'), Buffer.alloc(8192, 3));
            availableBytes = 700_000;
            availableIncludingPurgeableBytes = undefined;
            volumeChanged();
            const capacityOnly = await service.summary();
            expect(capacityOnly.volumes[0]?.freeBytes).toBe(700_000);
            expect(capacityOnly.volumes[0]?.availableIncludingPurgeableBytes).toBeUndefined();
            expect(capacityOnly.volumes[0]?.happierBytes).toBe(summary.volumes[0]?.happierBytes);
            expect(capacityOnly.sizedAt).toBe(summary.sizedAt);
            let notified = false;
            availableIncludingPurgeableBytes = 0;
            const unsubscribe = service.subscribe(() => { notified = true; });
            projectsReported = true;
            const refreshed = await service.refresh();
            expect(refreshed.volumes[0]).toMatchObject({ freeBytes: 700_000, availableIncludingPurgeableBytes: 0 });
            unsubscribe();
            expect(refreshed.revision).toBeGreaterThan(summary.revision);
            expect(notified).toBe(true);
            expect(refreshed.volumes[0]?.happierBytes).toBeGreaterThan(summary.volumes[0]!.happierBytes);
            expect((await service.categoryList('caches')).revision).toBe(refreshed.revision);
            expect(refreshed.categories.find(category => category.categoryId === 'worktrees')?.size.atLeast).toBe(false);
            await expect(service.categoryList('caches', { cursor: 'not-issued' })).rejects.toMatchObject({ code: 'invalid_storage_cursor' });
            const aborted = new AbortController();
            aborted.abort();
            await expect(service.summary({ signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
        } finally { service.dispose(); }
    });

    it('reports verified-Safe reclaimable unions per volume and retains them across capacity-only edges', async () => {
        const home = join(scratch, 'volume-can-go-home');
        const cache = join(home, 'cache');
        const secondary = join(home, 'tools', 'secondary');
        const oldLog = join(home, 'logs', 'old.log');
        const caution = join(cache, 'caution');
        const kept = join(cache, 'kept');
        const unknown = join(home, '.runner-snapshots', 'unknown');
        const safe = join(cache, 'safe');
        await mkdir(cache, { recursive: true });
        await mkdir(secondary, { recursive: true });
        await mkdir(join(home, 'logs'), { recursive: true });
        await mkdir(unknown, { recursive: true });
        await writeFile(safe, Buffer.alloc(8192, 1));
        await link(safe, oldLog);
        await utimes(oldLog, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
        await writeFile(join(secondary, 'bytes'), Buffer.alloc(16384, 2));
        await writeFile(caution, Buffer.alloc(32768, 3));
        await writeFile(kept, Buffer.alloc(65536, 4));
        await writeFile(join(unknown, 'bytes'), Buffer.alloc(8192, 5));
        let free = 500_000;
        let volumeChanged = () => {};
        const service = createStorageService({ homeDir: join(scratch, 'volume-can-go-person'),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'volume-can-go-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }),
                readInUsePaths: () => ({ reliable: true, paths: [kept] }) },
            readStorageProtectionFacts: () => ({ cloudSyncedFolders: [caution] }),
            readVolumes: () => [
                { id: 'main', label: 'Main', mount: scratch, totalBytes: 1_000_000, availableBytes: free },
                { id: 'secondary', label: 'Secondary', mount: join(home, 'tools'), totalBytes: 1_000_000, availableBytes: free },
                { id: 'empty', label: 'Empty', mount: join(scratch, 'empty-volume'), totalBytes: 1_000_000, availableBytes: free },
            ],
            subscribeVolumeChanges(listener) { volumeChanged = listener; return () => {}; },
        });
        try {
            const summary = await service.summary();
            const mainBytes = (await lstat(safe)).blocks * 512;
            const secondaryBytes = ((await lstat(secondary)).blocks + (await lstat(join(secondary, 'bytes'))).blocks) * 512;
            expect(summary.suggestionsTop.find(item => item.path === caution)?.verdict).toBe('caution');
            expect(summary.suggestionsTop.some(item => item.path === kept || item.path === unknown)).toBe(false);
            expect(summary.volumes).toMatchObject([{ canGoBytes: mainBytes }, { canGoBytes: secondaryBytes }, { canGoBytes: 0 }]);
            free = 400_000; volumeChanged();
            const capacityOnly = await service.summary();
            expect(capacityOnly.sizedAt).toBe(summary.sizedAt);
            expect(capacityOnly.volumes).toMatchObject([
                { freeBytes: free, canGoBytes: mainBytes }, { freeBytes: free, canGoBytes: secondaryBytes }, { canGoBytes: 0 },
            ]);
        } finally { service.dispose(); }
    });

    it('returns canonical stopped and recent category groups with policy thresholds and recipient-scoped membership', async () => {
        const home = join(scratch, 'groups-home');
        const workspace = join(scratch, 'groups-workspace');
        const now = 100 * 86_400_000;
        const sessions = [{ sessionId: 'old', cwd: workspace, running: false, stoppedAt: now - 7 * 86_400_000 },
            { sessionId: 'recent', cwd: workspace, running: false, stoppedAt: now - 6 * 86_400_000 },
            { sessionId: 'running', cwd: workspace, running: true, stoppedAt: now - 10 * 86_400_000 }];
        for (const session of sessions) {
            const path = join(workspace, '.happier', 'uploads', 'images', session.sessionId);
            await mkdir(path, { recursive: true }); await writeFile(join(path, 'bytes'), 'attachment');
        }
        const oldLog = join(home, 'logs', 'old.log'); const recentLog = join(home, 'logs', 'recent.log');
        await mkdir(join(home, 'logs'), { recursive: true });
        await writeFile(oldLog, 'old'); await writeFile(recentLog, 'recent');
        await utimes(oldLog, new Date(now - 14 * 86_400_000), new Date(now - 14 * 86_400_000));
        await utimes(recentLog, new Date(now - 13 * 86_400_000), new Date(now - 13 * 86_400_000));
        const service = createStorageService({ homeDir: join(scratch, 'groups-person'), nowMs: () => now,
            catalog: { happyHomeDir: home, activeServerDir: home, now: () => now, tempRoot: join(scratch, 'groups-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }), readTrackedSessions: () => sessions,
                readPolicy: () => ({ suggestUnusedAfterDays: 7 }) },
            readVolumes: () => [{ id: 'fixture-volume', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const category = await service.categoryList('sessionFolders');
            const id = (sessionId: string) => category.items.find(item => item.path.endsWith(`/${sessionId}`))!.itemId;
            expect(category.groups).toEqual([{ id: 'stopped', olderThanDays: 7, itemIds: [id('old')] },
                { id: 'recent', itemIds: expect.arrayContaining([id('recent'), id('running')]) }]);
            expect(category.groups![1]!.itemIds).toHaveLength(2);
            const recipient = await service.categoryList('sessionFolders', { sessionIds: new Set(['old']) });
            expect(recipient.groups).toEqual([{ id: 'stopped', olderThanDays: 7, itemIds: [id('old')] }]);
            const logs = await service.categoryList('logs');
            expect(logs.groups).toEqual([{ id: 'old', olderThanDays: 14, itemIds: [logs.items.find(item => item.path === oldLog)!.itemId] },
                { id: 'recent', itemIds: [logs.items.find(item => item.path === recentLog)!.itemId] }]);
        } finally { service.dispose(); }
    });

    it('projects the current whole-disk opt-in after policy edges instead of a hard-coded disabled snapshot', async () => {
        const home = join(scratch, 'policy-edge-home');
        await mkdir(home, { recursive: true });
        let policy = MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true });
        let changed = () => {};
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: home,
            tempRoot: join(scratch, 'policy-edge-absent-temp') }, readPolicy: () => policy,
            subscribeChanges(listener) { changed = listener; return () => { changed = () => {}; }; },
            readVolumes: () => [{ id: 'policy-edge', label: 'Policy', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
        });
        try {
            expect((await service.summary()).wholeDisk.enabled).toBe(true);
            policy = MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: false });
            changed();
            expect((await service.summary()).wholeDisk).toEqual({ enabled: false, scans: [] });
        } finally { service.dispose(); }
    });

    it.each(['cancelled', 'interrupted'] as const)('retains a %s folder scan across a storage-service restart before policy hydration', async termination => {
        const home = join(scratch, `restart-${termination}-home`);
        const server = join(home, 'servers', 'home');
        const root = join(scratch, `restart-${termination}-target`);
        const finished = join(root, 'finished');
        await mkdir(server, { recursive: true }); await mkdir(join(finished, 'nested'), { recursive: true });
        await writeFile(join(finished, 'nested', 'bytes'), Buffer.alloc(8192));
        let metadata: Record<string, unknown> = { resourcesPolicyV1: { v: 1, storage: { wholeDiskEnabled: true } } };
        let availability: 'ready' | 'unavailable' | 'locked' = 'ready';
        let observedAt = 1_000;
        const volumes = [{ id: 'restart-volume', label: 'Restart', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }];
        const seed = createStorageScanIndex({ activeServerDir: server, nowMs: () => observedAt });
        const retainedDates = new Map<string, number>();
        let cut = false;
        let state: DiskScanStateV1;
        try {
            await seed.initialize([{ id: volumes[0].id, mountPath: scratch, usedBytes: 500_000 }], true);
            state = await seed.begin({ volumeId: volumes[0].id, root, target: { folderPath: root }, usedBytes: 0,
                fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
            // Retain a real native stream prefix ending after a finished child,
            // before the parent completes, as an abrupt transport stop does.
            const native = startNativeDiskScan({ root, keepMinBytes: 0 }, { onRecord: record => {
                if (cut) return;
                seed.ingest(volumes[0].id, record);
                if (record.type === 'dir' && record.id === finished && record.complete) cut = true;
            } });
            await native.done;
            expect(cut).toBe(true);
            for (const path of [finished, join(finished, 'nested')]) retainedDates.set(path, seed.readNode(path)!.scannedAt);
            if (termination === 'cancelled') seed.finish(volumes[0].id, 'cancelled');
        } finally { seed.close(); }
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const openService = () => {
            const policy = createMachineResourcesPolicyRuntime({ port: {
                read: async () => availability === 'ready' ? { status: 'ready', metadata, metadataVersion: 1 } : { status: availability },
                compareAndSwap: async () => ({ status: 'unavailable' }),
            } });
            const service = createStorageService({ machineId: 'machine', homeDir: scratch, nowMs: () => observedAt,
                catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'restart-no-temp') },
                resourcesPolicy: policy,
                // The daemon supplies this same safe default while metadata is unavailable.
                readPolicy: () => { const snapshot = policy.read(); return snapshot.status === 'ready'
                    ? snapshot.policy.storage : MachineStoragePolicyV1Schema.parse({}); },
                subscribeChanges: listener => policy.subscribe(listener), readVolumes: () => volumes,
            });
            return { service, policy };
        };
        const first = openService();
        let restarted: ReturnType<typeof openService> | undefined;
        try {
            await first.policy.reload(); await first.service.initialize();
            const before = MachineStorageScanGetResultV1Schema.parse(await first.service.scanGet({ machineId: 'machine', scanId: state.scanId }, { actor }));
            expect(before.state?.status).toBe(termination);
            expect(before.nodes.find(node => node.nodeId === finished)?.size.atLeast).toBe(false);
            expect(before.state!.progress.sizedBytes).toBeGreaterThan(0);
            first.service.dispose(); first.policy.stop();
            availability = 'unavailable';
            restarted = openService();
            await restarted.service.initialize();
            await expect(restarted.service.scanStart({ machineId: 'machine', target: state.target, resume: true }, { actor }))
                .rejects.toMatchObject({ code: 'storage_whole_disk_disabled' });
            for (const status of ['unavailable', 'locked'] as const) {
                availability = status;
                await restarted.policy.reload();
                await restarted.service.initialize();
            }
            availability = 'ready';
            await restarted.policy.reload();
            const summary = HappierStorageSummaryV1Schema.parse(await restarted.service.summary({ actor }));
            expect(summary.wholeDisk.scans).toContainEqual(before.state);
            const after = MachineStorageScanGetResultV1Schema.parse(await restarted.service.scanGet({ machineId: 'machine', scanId: state.scanId }, { actor }));
            expect(after.state).toEqual(before.state);
            expect(after.nodes.find(node => node.nodeId === finished)).toEqual(before.nodes.find(node => node.nodeId === finished));
            observedAt = 2_000;
            const resumed = await restarted.service.scanStart({ machineId: 'machine', target: state.target, resume: true }, { actor });
            expect(resumed.scanId).toBe(state.scanId);
            await waitForStorageScan(restarted.service, resumed.scanId, actor);
            const complete = await restarted.service.scanGet({ machineId: 'machine', scanId: state.scanId }, { actor });
            expect(complete.state?.status).toBe('complete');
            expect(complete.root?.size.allocatedBytes).toBe((await measureNativeDisk({ paths: [root] })).totalAllocatedBytes);
            const persisted = createStorageScanIndex({ activeServerDir: server, nowMs: () => observedAt });
            try {
                await persisted.initialize([{ id: volumes[0].id, mountPath: scratch, usedBytes: 500_000 }], true);
                for (const [path, scannedAt] of retainedDates) expect(persisted.readNode(path)?.scannedAt).toBe(scannedAt);
            } finally { persisted.close(); }
            metadata = { resourcesPolicyV1: { v: 1, storage: { wholeDiskEnabled: false } } };
            await restarted.policy.reload(); await restarted.service.initialize();
            expect((await restarted.service.summary({ actor })).wholeDisk).toEqual({ enabled: false, scans: [] });
        } finally {
            first.service.dispose(); first.policy.stop(); restarted?.service.dispose(); restarted?.policy.stop();
        }
    });

    it('lets an admitted Manage grantee own opted-in native folder scans, exposes folded files and purges indexes when disabled', async () => {
        const home = join(scratch, 'scan-service-home');
        const fixture = join(scratch, 'scan-service-fixture');
        await mkdir(home, { recursive: true });
        await mkdir(fixture, { recursive: true });
        const otherVolume = join(home, 'cache'); const otherCache = join(otherVolume, 'other-volume-cache');
        await mkdir(otherCache, { recursive: true }); await writeFile(join(otherCache, 'bytes'), Buffer.alloc(32768, 3));
        await writeFile(join(fixture, 'tiny.bin'), Buffer.alloc(1, 2));
        const largeBytes = Math.max(65536, (await lstat(join(fixture, 'tiny.bin'))).blocks * 512 * (STORAGE_CHART_MAX_DRAWABLE_NODES + 1));
        await writeFile(join(fixture, 'large.bin'), Buffer.alloc(largeBytes, 1));
        const bytePath = Buffer.concat([Buffer.from(`${fixture}/`), Buffer.from([0xff]), Buffer.from('-bytes')]);
        if (process.platform === 'linux') {
            await writeFile(bytePath, 'native-exact-bytes'); await writeFile(bytePath.toString('utf8'), 'replacement-twin');
        }
        let policy = MachineStoragePolicyV1Schema.parse({});
        let changed = () => {};
        const actor = { accountId: 'manager', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(home, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const service = createStorageService({ machineId: 'machine', homeDir: home,
            activityLog: await createActivityLog({ activeServerDir: home, resourceSummary }),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'scan-service-no-temp'),
                readInUsePaths: () => ({ reliable: true, paths: [join(fixture, 'tiny.bin')],
                    sessions: [{ path: join(fixture, 'tiny.bin'), sessionId: 'holding-session' }] }) },
            readPolicy: () => policy,
            subscribeChanges(listener) { changed = listener; return () => { changed = () => {}; }; },
            readVolumes: () => [{ id: 'scan-volume', label: 'Scan', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 },
                { id: 'other-volume', label: 'Other', mount: otherVolume, totalBytes: 1_000_000, availableBytes: 500_000 }],
        });
        try {
            const request = { machineId: 'machine', target: { folderPath: fixture } };
            await expect(service.scanStart(request, { actor })).rejects.toMatchObject({ code: 'storage_whole_disk_disabled' });
            await expect(service.scanStart(request, { actor: { ...actor, accountId: 'recipient', sessionIds: new Set<string>() } }))
                .rejects.toMatchObject({ code: 'unauthorized' });
            policy = MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }); changed();
            const state = await service.scanStart(request, { actor });
            expect(DiskScanStateV1Schema.parse(state)).toEqual(state);
            await waitForStorageScan(service, state.scanId, actor);
            const large = await service.scanGet({ machineId: 'machine', scanId: state.scanId,
                view: { tab: 'large' as const, depth: 1 as const, minBytes: 0 } }, { actor });
            expect(MachineStorageScanGetResultV1Schema.parse(large)).toEqual(large);
            // Reopen the daemon's real database independently of the resident service.
            // A wrong service→index path binding must lose both admission and file facts.
            const persisted = createStorageScanIndex({ activeServerDir: home });
            try {
                await persisted.initialize([
                    { id: 'scan-volume', mountPath: scratch, usedBytes: 500_000 },
                    { id: 'other-volume', mountPath: otherVolume, usedBytes: 500_000 },
                ], true);
                const replay = persisted.readView({ scanId: state.scanId, view: { tab: 'large', depth: 1, minBytes: 0 } });
                expect(replay.state?.scanId).toBe(state.scanId);
                expect(replay.nodes.find(node => node.name === 'large.bin')).toMatchObject({
                    nodeId: join(fixture, 'large.bin'), logicalBytes: largeBytes,
                });
                expect(MachineStorageScanGetResultV1Schema.parse(replay)).toEqual(replay);
            } finally { persisted.close(); }
            expect(large.nodes.filter(node => node.name === 'large.bin' || node.name === 'tiny.bin').map(node => node.name).sort()).toEqual(['large.bin', 'tiny.bin']);
            expect(large.nodes.find(node => node.name === 'tiny.bin')?.flags).toMatchObject({ inUse: true, protection: 'keep' });
            const folded = await service.scanGet({ machineId: 'machine', scanId: state.scanId }, { actor });
            expect(MachineStorageScanGetResultV1Schema.parse(folded)).toEqual(folded);
            expect(folded).toHaveProperty('root', expect.objectContaining({ nodeId: fixture,
                size: expect.objectContaining({ allocatedBytes: folded.state?.progress.sizedBytes }) }));
            const small = folded.nodes.find(node => node.kind === 'small-items')!;
            expect(small).toBeDefined();
            expect(small.flags).toMatchObject({ protection: 'keep', inUse: true });
            expect(small.loses).toContainEqual({ code: 'in_use', detail: { path: join(fixture, 'tiny.bin'), sessionId: 'holding-session' } });
            const scannedFile = large.nodes.find(node => node.name === 'large.bin')!;
            const ref = { itemId: scannedFile.nodeId, path: join(fixture, 'large.bin') };
            const inventedReview = await service.itemsCheck([{ ...ref, itemId: 'unknown-index-id' }], { actor });
            expect(PileReviewV1Schema.parse(inventedReview)).toEqual(inventedReview);
            expect(inventedReview.items).toEqual([]);
            expect(inventedReview.staying).toEqual([{ item: { ...ref, itemId: 'unknown-index-id' }, reason: { code: 'facts_unavailable' } }]);
            const directReview = await service.itemsCheck([ref], { actor });
            expect(directReview.staying).toEqual([]);
            expect(directReview.items).toEqual([expect.objectContaining({ ref: expect.objectContaining(ref), expect: expect.any(String) })]);
            expect((await service.pileGet({ actor })).items).toEqual([]);
            await expect(service.pileSet({ machineId: 'machine', add: [{ ...ref, itemId: 'unknown-index-id' }] }, { actor }))
                .rejects.toMatchObject({ code: 'storage_item_not_collectable' });
            const collected = await service.pileSet({ machineId: 'machine', add: [ref] }, { actor });
            expect(MachineStoragePileResultV1Schema.parse(collected)).toEqual(collected);
            await expect(service.pileSet({ machineId: 'machine', add: [ref] },
                { actor: { ...actor, accountId: 'recipient', sessionIds: new Set<string>() } })).rejects.toMatchObject({ code: 'unauthorized' });
            const review = await service.itemsCheck(collected.items.map(({ itemId, path }) => ({ itemId, path })), { actor });
            expect(PileReviewV1Schema.parse(review)).toEqual(review);
            expect(review.items).toHaveLength(1);
            const moveInput = MachineStorageTrashMoveInputV1Schema.parse({ machineId: 'machine', items: review.items.map(item => ({
                ref: item.ref, expect: item.expect, claimedVerdict: item.verdict,
            })) });
            const moved = await service.trashMove(moveInput, { actor });
            expect(PileApplyResultV1Schema.parse(moved)).toEqual(moved);
            expect(moved.outcomes).toEqual([{ itemId: ref.itemId, status: 'moved' }]);
            await expect(lstat(ref.path)).rejects.toMatchObject({ code: 'ENOENT' });
            const trash = await service.categoryList('trash');
            expect(MachineStorageCategoryListResultV1Schema.parse(trash)).toEqual(trash);
            expect(trash.trashEntries).toContainEqual(expect.objectContaining({ batchId: moved.batchId, originalPath: ref.path }));
            const otherItem = (await service.categoryList('caches')).items.find(item => item.path === otherCache)!;
            const otherCollected = await service.pileSet({ machineId: 'machine', add: [{ ...ref, itemId: otherItem.itemId, path: otherCache }] }, { actor });
            const otherReview = await service.itemsCheck(otherCollected.items, { actor });
            const otherMoved = await service.trashMove({ machineId: 'machine', items: otherReview.items.map(item => ({ ref: item.ref,
                expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(otherMoved.outcomes[0]?.status).toBe('moved');
            expect((await service.scanGet({ machineId: 'machine', scanId: state.scanId,
                view: { tab: 'insights', depth: 1 } }, { actor })).insights?.trashBytes).toBe(moved.inTrashBytes);
            await service.trashRestore({ machineId: 'machine', batchId: otherMoved.batchId }, { actor });
            const restored = await service.trashRestore({ machineId: 'machine', batchId: moved.batchId }, { actor });
            expect(TrashRestoreResultV1Schema.parse(restored)).toEqual(restored);
            expect(restored.outcomes)
                .toEqual([expect.objectContaining({ status: 'restored', path: ref.path })]);
            expect((await lstat(ref.path)).size).toBe(largeBytes);
            if (process.platform === 'linux') {
                const byteId = `bytes:${bytePath.toString('base64')}`;
                expect(large.nodes.find(node => node.nodeId === byteId)?.nameBytes).toBe(Buffer.concat([Buffer.from([0xff]), Buffer.from('-bytes')]).toString('base64'));
                const bytesCollected = await service.pileSet({ machineId: 'machine', add: [{ ...ref, itemId: byteId, path: byteId }] }, { actor });
                const bytesReview = await service.itemsCheck(bytesCollected.items, { actor });
                const bytesMoved = await service.trashMove({ machineId: 'machine', items: bytesReview.items.map(item => ({ ref: item.ref,
                    expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
                expect(bytesMoved.outcomes).toEqual([{ itemId: byteId, status: 'moved' }]);
                await expect(lstat(bytePath)).rejects.toMatchObject({ code: 'ENOENT' });
                expect((await service.trashRestore({ machineId: 'machine', batchId: bytesMoved.batchId }, { actor })).outcomes[0]?.status).toBe('restored');
                expect(await readFile(bytePath, 'utf8')).toBe('native-exact-bytes');
                const recollected = await service.pileSet({ machineId: 'machine', add: [{ ...ref, itemId: byteId, path: byteId }] }, { actor });
                const finalReview = await service.itemsCheck(recollected.items, { actor });
                expect((await service.deleteNow({ machineId: 'machine', items: finalReview.items.map(item => ({ ref: item.ref,
                    expect: item.expect, claimedVerdict: item.verdict })) }, { actor })).outcomes).toEqual([{ itemId: byteId, status: 'deleted' }]);
                await expect(lstat(bytePath)).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await readFile(bytePath.toString('utf8'), 'utf8')).toBe('replacement-twin');
            }
            expect((await service.summary()).wholeDisk.scans.some(scan => scan.scanId === state.scanId)).toBe(true);
            policy = MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: false }); changed();
            expect((await service.scanGet({ machineId: 'machine', scanId: state.scanId }, { actor })).state).toBeNull();
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it.each(['trash', 'delete'] as const)('skips changed indexed-folder holders during %s while applying unchanged approved Keep and Caution items', async mode => {
        const home = join(scratch, `holder-${mode}-home`); const root = join(scratch, `holder-${mode}-items`);
        const paths = ['new-holder', 'replaced-holder', 'keep', 'caution'].map(name => join(root, name));
        await mkdir(home); await mkdir(root);
        for (const path of paths) { await mkdir(path); await writeFile(join(path, 'content'), path); }
        let sessions = [{ path: paths[1]!, sessionId: 'original-session' },
            { path: paths[2]!, sessionId: 'stable-session-a' }, { path: paths[2]!, sessionId: 'stable-session-b' }];
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'agent', custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        const service = createStorageService({ machineId: 'machine', homeDir: home, activityLog,
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true,
                protectedFolders: [{ path: paths[2]!, addedAt: 1 }] }),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, `holder-${mode}-no-temp`),
                readProjects: () => ({ status: 'ready', projects: [] }),
                readInUsePaths: () => ({ reliable: true, paths: sessions.map(session => session.path), sessions }) },
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const scan = await service.scanStart({ machineId: 'machine', target: { folderPath: root } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            const collected = await service.pileSet({ machineId: 'machine', add: paths.map(path => ({ itemId: path, path })) }, { actor });
            const review = PileReviewV1Schema.parse(await service.itemsCheck(collected.items, { actor }));
            expect(review.items.map(item => item.verdict)).toEqual(['caution', 'keep', 'keep', 'caution']);
            expect(review.items[1]?.loses).toContainEqual({ code: 'in_use', detail: { path: paths[1], sessionId: 'original-session' } });
            sessions = [{ path: paths[0]!, sessionId: 'new-session' }, { path: paths[1]!, sessionId: 'replacement-session' },
                { path: paths[2]!, sessionId: 'stable-session-b' }, { path: paths[2]!, sessionId: 'stable-session-a' }];
            const result = PileApplyResultV1Schema.parse(mode === 'trash'
                ? await service.trashMove(MachineStorageTrashMoveInputV1Schema.parse({ machineId: 'machine',
                    items: review.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) }), { actor })
                : await service.deleteNow(MachineStorageDeleteNowInputV1Schema.parse({ machineId: 'machine',
                    items: review.items.map(item => ({ ref: item.ref, expect: item.expect })) }), { actor }));
            expect(result.outcomes).toEqual(paths.map((itemId, index) => index < 2
                ? { itemId, status: 'skipped', reason: { code: 'changed_since_review' } }
                : { itemId, status: mode === 'trash' ? 'moved' : 'deleted' }));
            for (const path of paths.slice(0, 2)) expect(await readFile(join(path, 'content'), 'utf8')).toBe(path);
            for (const path of paths.slice(2)) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await service.pileGet({ actor })).items.map(item => item.path)).toEqual(paths.slice(0, 2));
            if (mode === 'trash') {
                expect((await service.trashEntries()).map(entry => entry.originalPath).sort()).toEqual(paths.slice(2).sort());
                expect(result.inTrashBytes).toBeGreaterThan(0); expect(result.freedBytes).toBe(0);
                expect((await service.trashRestore({ machineId: 'machine', batchId: result.batchId }, { actor })).outcomes
                    .every(outcome => outcome.status === 'restored')).toBe(true);
                for (const path of paths.slice(2)) expect(await readFile(join(path, 'content'), 'utf8')).toBe(path);
            } else { expect(await service.trashEntries()).toEqual([]); expect(result.freedBytes).toBeGreaterThan(0); }
        } finally { service.dispose(); }
    });

    it.each(['none', 'holder', 'cloud', 'cloud-removed', 'unknown-holder'] as const)('normalizes completed child facts while retaining changed parent protection (%s)', async protection => {
        const home = join(scratch, `completed-holder-${protection}-home`); const workspace = join(scratch, `completed-holder-${protection}-workspace`);
        const root = join(workspace, '.happier', 'uploads', 'attachments'); const upload = join(root, 'completed-session');
        await mkdir(home); await mkdir(upload, { recursive: true }); await writeFile(join(upload, 'content'), 'retained upload');
        const uploadPresent = () => lstat(upload).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;
        });
        let retired = false;
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'agent', custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        const service = createStorageService({ machineId: 'machine', homeDir: home, activityLog,
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
            readStorageProtectionFacts: async () => ({ cloudSyncedFolders: (protection === 'cloud' && !await uploadPresent()
                || protection === 'cloud-removed' && await uploadPresent()) ? [root] : [] }),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'completed-holder-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }),
                readTrackedSessions: () => retired ? [] : [{ sessionId: 'completed-session', cwd: workspace, running: false, stoppedAt: 1 }],
                // OS cwd observations follow a renamed child out of its original container.
                readInUsePaths: async () => {
                    const present = await uploadPresent();
                    if (protection === 'unknown-holder' && (!present || retired)) {
                        retired = true;
                        const path = join(upload, 'unknown-work'); await mkdir(path, { recursive: true });
                        await writeFile(join(path, 'content'), 'new work');
                        return { reliable: true, paths: [path], sessions: [{ path, sessionId: 'new-unknown-session' }] };
                    }
                    return { reliable: true, paths: present ? [upload] : protection === 'holder' ? [root] : [],
                        sessions: present ? [{ path: upload, sessionId: 'holding-session' }]
                            : protection === 'holder' ? [{ path: root, sessionId: 'new-parent-session' }] : [] };
                } },
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const scan = await service.scanStart({ machineId: 'machine', target: { folderPath: root } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            const collected = await service.pileSet({ machineId: 'machine', add: [{ itemId: root, path: root }] }, { actor });
            const review = await service.itemsCheck(collected.items, { actor });
            expect(review.items[0]).toMatchObject({ verdict: 'keep', absorbs: [expect.any(String)] });
            const result = await service.trashMove({ machineId: 'machine', items: review.items.map(item => ({ ref: item.ref,
                expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(result.outcomes.map(outcome => outcome.status)).toEqual(['moved', protection === 'none' ? 'moved' : 'skipped']);
            expect((await service.trashEntries()).map(entry => entry.originalPath).sort()).toEqual((protection === 'none' ? [upload, root] : [upload]).sort());
            if (protection !== 'none') {
                expect(result.outcomes[1]).toEqual({ itemId: root, status: 'skipped', reason: { code: 'changed_since_review' } });
                expect((await lstat(root)).isDirectory()).toBe(true);
                if (protection === 'unknown-holder') expect(await readFile(join(upload, 'unknown-work', 'content'), 'utf8')).toBe('new work');
            } else await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { service.dispose(); }
    });

    it('uses filesystem cleanup for indexed worktree contents and SCM ownership for the exact indexed worktree', async () => {
        const home = join(scratch, 'indexed-worktree-home'); const repo = join(scratch, 'indexed-worktree-repo');
        const worktree = join(repo, '.dev', 'worktree', 'cleanup'); const modules = join(worktree, 'node_modules');
        await mkdir(home); await mkdir(repo);
        await execute('git', ['init', repo]);
        await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
        await execute('git', ['-C', repo, 'worktree', 'add', '-b', 'fixture-cleanup', worktree]);
        await mkdir(modules); await writeFile(join(modules, 'dependency'), 'dependency');
        await writeFile(join(worktree, 'package.json'), '{}');
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(home, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        let inspectionPhase = 'scan';
        const inspectionCounts = new Map<string, number>();
        const service = createStorageService({ machineId: 'machine', homeDir: home, scmRegistry: registry,
            activityLog: await createActivityLog({ activeServerDir: home, resourceSummary }),
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'indexed-worktree-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }),
                readInUsePaths: () => ({ reliable: true, paths: [] }),
                readWorktrees: async () => {
                    const phase = inspectionPhase;
                    inspectionCounts.set(phase, (inspectionCounts.get(phase) ?? 0) + 1);
                    return readStorageWorktrees({ cwds: [repo], happyHomeDir: home, registry });
                },
                worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: home, registry }) },
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const scan = await service.scanStart({ machineId: 'machine', target: { folderPath: repo } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            const ref = (path: string) => ({ itemId: path, path, identity: { dev: 'ignored', ino: 'ignored', kind: 'directory' as const },
                collectedAt: 0, collectedBy: { accountId: 'owner', kind: 'person' as const } });
            inspectionPhase = 'contents.collect';
            const contents = await service.pileSet({ machineId: 'machine', add: [ref(modules)] }, { actor });
            expect(inspectionCounts.get(inspectionPhase)).toBe(1);
            inspectionPhase = 'contents.review';
            const reviewed = await service.itemsCheck(contents.items, { actor });
            expect(reviewed.items[0]?.verdict).toBe('keep');
            inspectionPhase = 'contents.apply';
            const moved = await service.trashMove({ machineId: 'machine', items: [{ ref: contents.items[0]!, expect: reviewed.items[0]!.expect,
                claimedVerdict: reviewed.items[0]!.verdict }] }, { actor });
            expect(moved.outcomes).toEqual([{ itemId: modules, status: 'moved' }]);
            expect((await execute('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout).toContain(`worktree ${worktree}`);
            expect((await execute('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true');
            inspectionPhase = 'contents.restore';
            await service.trashRestore({ machineId: 'machine', batchId: moved.batchId }, { actor });
            inspectionPhase = 'exact.collect';
            const exact = await service.pileSet({ machineId: 'machine', add: [ref(worktree)] }, { actor });
            inspectionPhase = 'exact.review';
            const exactReview = await service.itemsCheck(exact.items, { actor });
            inspectionPhase = 'exact.apply';
            const retired = await service.trashMove({ machineId: 'machine', items: [{ ref: exact.items[0]!, expect: exactReview.items[0]!.expect,
                claimedVerdict: exactReview.items[0]!.verdict }] }, { actor });
            expect(retired.outcomes).toEqual([{ itemId: worktree, status: 'moved' }]);
            const registrationAfter = (await execute('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout;
            expect(registrationAfter).not.toContain(`worktree ${worktree}\n`);
            expect(registrationAfter).toContain('locked');
            inspectionPhase = 'exact.restore';
            expect((await service.trashRestore({ machineId: 'machine', batchId: retired.batchId }, { actor })).outcomes[0]?.status).toBe('restored');
            expect((await execute('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true');
            inspectionPhase = 'summary';
            await service.summary();
            // Each read shares one inspection. Apply checks initial facts and
            // the adapter effect; exact SCM also binds its owner.
            expect(Object.fromEntries(['contents.collect', 'contents.review', 'contents.apply', 'exact.collect', 'exact.review', 'exact.apply', 'summary']
                .map(phase => [phase, inspectionCounts.get(phase) ?? 0]))).toEqual({
                'contents.collect': 1, 'contents.review': 1, 'contents.apply': 2,
                'exact.collect': 1, 'exact.review': 1, 'exact.apply': 3, summary: 1,
            });
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('reviews an exact scanned Keep container, rejects changed and Forbidden children, and restores nested SCM owners on batch Undo', async () => {
        const home = join(scratch, 'keep-container-home'); const repo = join(scratch, 'keep-container-repo');
        const container = join(repo, '.dev', 'worktree'); const worktree = join(container, 'outer');
        const nested = join(worktree, '.dev', 'worktree', 'inner');
        await mkdir(home); await mkdir(repo);
        await execute('git', ['init', repo]);
        await writeFile(join(repo, '.gitignore'), '.dev/\n');
        await execute('git', ['-C', repo, 'add', '.gitignore']);
        await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
        await execute('git', ['-C', repo, 'worktree', 'add', '-b', 'container-outer', worktree]);
        await execute('git', ['-C', repo, 'worktree', 'add', '-b', 'container-inner', nested]);
        await writeFile(join(worktree, 'changed.txt'), 'outer changes');
        await writeFile(join(nested, 'changed.txt'), 'inner changes');
        await writeFile(join(nested, 'extra.txt'), 'additional inner changes');
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        let systemPaths: string[] = [];
        const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ machineId: 'machine', homeDir: home, scmRegistry: registry, activityLog,
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
            readStorageProtectionFacts: () => ({ systemPaths }),
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'keep-container-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }),
                readTrackedSessions: () => [{ sessionId: 'container-session', cwd: repo, running: false, stoppedAt: 1 }],
                readInUsePaths: () => ({ reliable: true, paths: [] }),
                readWorktrees: () => readStorageWorktrees({ cwds: [repo], happyHomeDir: home, registry }),
                worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: home, registry }) },
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const scan = await service.scanStart({ machineId: 'machine', target: { folderPath: container } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            const disk = await service.scanGet({ machineId: 'machine', scanId: scan.scanId }, { actor });
            expect(disk.root?.flags.protection).toBe('keep');
            expect(disk.nodes.find(node => node.nodeId === worktree)?.flags.protection).toBe('keep');
            const selected = { itemId: container, path: container };
            const collected = await service.pileSet({ machineId: 'machine', add: [selected] }, { actor });
            const checked = await service.itemsCheck(collected.items, { actor });
            expect(checked.staying).toEqual([]);
            expect(checked.items[0]).toMatchObject({ verdict: 'keep', reason: { code: 'contains' } });
            expect(checked.items[0]?.absorbs).toHaveLength(2);
            await writeFile(join(nested, 'changed.txt'), 'edited after review');
            const changed = await service.trashMove({ machineId: 'machine', items: checked.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(changed.outcomes).toEqual([{ itemId: container, status: 'skipped', reason: { code: 'changed_since_review' } }]);
            expect(await service.trashEntries()).toEqual([]);
            const approved = await service.itemsCheck(collected.items, { actor });
            systemPaths = [nested];
            const forbidden = await service.trashMove({ machineId: 'machine', items: approved.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(forbidden.outcomes).toEqual([{ itemId: container, status: 'refused', reason: expect.objectContaining({ code: 'contains_forbidden' }) }]);
            expect(await readFile(join(nested, 'changed.txt'), 'utf8')).toBe('edited after review');
            systemPaths = [];
            const current = await service.itemsCheck(collected.items, { actor });
            const moved = await service.trashMove({ machineId: 'machine', items: current.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) }, { actor });
            expect(moved.outcomes.map(outcome => outcome.status)).toEqual(['moved', 'moved', 'moved']);
            await expect(lstat(container)).rejects.toMatchObject({ code: 'ENOENT' });
            await execute('git', ['-C', repo, 'worktree', 'prune']);
            expect((await execute('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout.match(/locked/gu)).toHaveLength(2);
            const restored = await service.trashRestore({ machineId: 'machine', batchId: moved.batchId }, { actor });
            expect(restored.outcomes.map(outcome => outcome.status)).toEqual(['restored', 'restored', 'restored']);
            expect(restored.outcomes[0]?.path).toBe(container);
            expect(await readFile(join(worktree, 'changed.txt'), 'utf8')).toBe('outer changes');
            expect(await readFile(join(nested, 'changed.txt'), 'utf8')).toBe('edited after review');
            expect(await readFile(join(nested, 'extra.txt'), 'utf8')).toBe('additional inner changes');
            for (const [path, branch] of [[worktree, 'container-outer'], [nested, 'container-inner']]) {
                expect((await execute('git', ['-C', path!, 'branch', '--show-current'])).stdout.trim()).toBe(branch);
                expect((await execute('git', ['-C', path!, 'status', '--porcelain'])).stdout).toContain('changed.txt');
            }
            const upload = join(repo, '.happier', 'uploads', 'attachments', 'container-session');
            const attachment = join(upload, 'attachment.bin');
            await mkdir(upload, { recursive: true }); await writeFile(attachment, 'retained attachment');
            const mainScan = await service.scanStart({ machineId: 'machine', target: { folderPath: repo } }, { actor });
            await waitForStorageScan(service, mainScan.scanId, actor);
            const administrativePath = join(repo, '.git', 'refs');
            const administrative = await service.itemsCheck([{ itemId: administrativePath, path: administrativePath }], { actor });
            expect(administrative.items).toEqual([]);
            expect(administrative.staying).toMatchObject([{ reason: { code: 'unsupported',
                detail: { cause: 'owner_requires_whole_item', categoryId: 'worktrees', path: join(repo, '.git') } } }]);
            const partial = await service.itemsCheck([{ itemId: attachment, path: attachment }], { actor });
            expect(partial.staying).toMatchObject([{ reason: { code: 'unsupported',
                detail: { cause: 'owner_requires_whole_item', categoryId: 'sessionFolders', path: upload } } }]);
            expect(await readFile(attachment, 'utf8')).toBe('retained attachment');
            const mainRef = { itemId: repo, path: repo };
            const limited = await service.itemsCheck([mainRef], { actor });
            expect(limited.items).toEqual([]);
            expect(limited.staying).toMatchObject([{ reason: { code: 'unsupported',
                detail: { cause: 'checkout_reference_owner_unavailable', owner: 'scm', path: repo } } }]);
            const refusedDelete = await service.deleteNow({ machineId: 'machine', items: [{ ref: { ...mainRef,
                identity: { dev: String((await lstat(repo)).dev), ino: String((await lstat(repo)).ino), kind: 'directory' },
                collectedAt: 0, collectedBy: { accountId: 'owner', kind: 'person' } }, expect: 'unreviewed' }] }, { actor });
            expect(refusedDelete.outcomes).toMatchObject([{ status: 'skipped', reason: { code: 'unsupported',
                detail: { cause: 'checkout_reference_owner_unavailable' } } }]);
            expect((await execute('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout).toContain(`worktree ${nested}`);
        } finally { service.dispose(); }
        // Observed composed native/SCM replay: 80 s under concurrent remote-host validation.
    }, 120_000);

    it('cancels one reader without cancelling another and recovers after the last reader cancels', async () => {
        const home = join(scratch, 'readers');
        await mkdir(join(home, 'cache'), { recursive: true });
        await writeFile(join(home, 'cache', 'bytes'), Buffer.alloc(8192, 4));
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: home,
            tempRoot: join(scratch, 'reader-absent-temp') },
            readVolumes: () => [{ id: 'readers', label: 'Readers', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
        });
        try {
            const first = new AbortController();
            const second = new AbortController();
            const cancelled = service.summary({ signal: first.signal });
            const retained = service.summary({ signal: second.signal });
            first.abort();
            await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
            const good = await retained;
            expect(good.volumes[0]?.happierBytes).toBeGreaterThan(0);
            const last = new AbortController();
            const cancelledRefresh = service.refresh({ signal: last.signal });
            last.abort();
            await expect(cancelledRefresh).rejects.toMatchObject({ name: 'AbortError' });
            expect((await service.summary()).volumes[0]?.happierBytes).toBe(good.volumes[0]?.happierBytes);
            service.dispose();
            await expect(service.summary()).rejects.toMatchObject({ name: 'AbortError' });
        } finally { service.dispose(); }
    });

    it('filters worktrees by canonical Project anchor without leaking private bindings', async () => {
        const home = join(scratch, 'project-filter-home');
        const firstRoot = join(scratch, 'project-first');
        const secondRoot = join(scratch, 'project-second');
        const firstPath = join(firstRoot, '.dev', 'worktree', 'first');
        const secondPath = join(secondRoot, '.dev', 'worktree', 'second');
        await Promise.all([home, firstPath, secondPath].map(path => mkdir(path, { recursive: true })));
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: home,
            tempRoot: join(scratch, 'project-filter-no-temp'),
            readProjects: () => ({ status: 'ready', projects: [{ projectId: 'first', repositoryRoot: firstRoot },
                { projectId: 'second', repositoryRoot: secondRoot }] }),
            readWorktrees: () => [{ path: firstPath, repositoryRoot: firstRoot }, { path: secondPath, repositoryRoot: secondRoot }] },
            readVolumes: () => [{ id: 'projects', label: 'Projects', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const page = await service.worktreesList({ machineId: 'machine', projectId: 'first' }, { actor });
            expect(page.items.map(item => item.path)).toEqual([firstPath]);
            expect(page.items[0]).not.toHaveProperty('projectIds');
            expect((await service.worktreesList({ machineId: 'machine', projectId: 'unknown' }, { actor })).items).toEqual([]);
        } finally { service.dispose(); }
    });

    it('summarizes retained Trash payloads per volume without counting empty roots or manifest overhead', async () => {
        const home = join(scratch, 'trash-totals-home');
        const secondary = join(scratch, 'trash-totals-secondary');
        const volumes = [{ id: 'main', label: 'Main', mount: home, totalBytes: 1_000_000, availableBytes: 500_000 },
            { id: 'secondary', label: 'Secondary', mount: secondary, totalBytes: 1_000_000, availableBytes: 500_000 }];
        await Promise.all([home, secondary, join(home, 'trash')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(home, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary });
        const store = createTrashStore({ happyHomeDir: home, osUserId: await resolveTrashOsUserId(),
            target: { machineId: 'machine' }, readVolumes: () => volumes, activityLog,
            attributionFor: () => ({ kind: 'unknown' }), classifyRestorePath: async () => null, readEmptyAfterDays: () => 7 });
        const service = createStorageService({ homeDir: scratch, machineId: 'machine', activityLog,
            catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'trash-totals-no-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) },
            readVolumes: () => volumes });
        const assertTotals = async (expected: readonly number[], count: number) => {
            const summary = await service.refresh();
            const category = summary.categories.find(category => category.categoryId === 'trash')!;
            const allocatedBytes = expected.reduce((sum, bytes) => sum + bytes, 0);
            expect(summary.trash).toEqual({ count, allocatedBytes });
            expect(category).toMatchObject({ count, size: { allocatedBytes } });
            expect(summary.volumes.map(volume => volume.trashBytes)).toEqual(expected);
            expect(summary.volumes.reduce((sum, volume) => sum + volume.happierBytes, 0))
                .toBe(summary.categories.reduce((sum, category) => sum + category.size.allocatedBytes, 0));
            return category;
        };
        try {
            await assertTotals([0, 0], 0);
            const entries = [];
            for (const [index, volume] of volumes.entries()) {
                const path = join(volume.mount, 'payload');
                await writeFile(path, Buffer.alloc(8192 * (index + 1), index + 1));
                const prepared = await store.prepare({ path, batchId: 'totals', title: 'Payload',
                    size: { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
                    movedBy: { accountId: 'owner', kind: 'person' } });
                entries.push(await prepared.commit());
            }
            const category = await assertTotals(entries.map(entry => entry.size.allocatedBytes), 2);
            expect(category.size.freesBytes).toBe(entries.reduce((sum, entry) => sum + entry.size.freesBytes, 0));
            expect(category.size.sharedExtentsUnmeasured).toBe(entries.some(entry => entry.size.sharedExtentsUnmeasured));
            expect((await service.categoryList('trash')).trashEntries).toEqual(entries);
            // A persisted partial payload measurement remains partial even when
            // a later full root measurement succeeds. The manifest is the size authority.
            const manifestPath = join((await store.roots())[0]!.path, entries[0]!.entryId, 'entry.json');
            const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath, 'utf8'));
            const entry = TrashEntryV1Schema.parse(manifest.entry);
            const freesUpToBytes = entry.size.freesBytes + 4096;
            await writeFile(manifestPath, JSON.stringify({ ...manifest, entry: { ...entry,
                size: { ...entry.size, atLeast: true, freesUpToBytes } } }));
            const partial = await assertTotals(entries.map(entry => entry.size.allocatedBytes), 2);
            expect(partial.size).toMatchObject({ atLeast: true,
                freesUpToBytes: freesUpToBytes + entries[1]!.size.freesBytes });
            const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
            const emptied = await service.trashEmpty({ machineId: 'machine', batchId: 'totals' }, { actor });
            expect(emptied.outcomes).toHaveLength(2);
            expect(emptied.outcomes).toEqual(entries.map(entry => ({ entryId: entry.entryId, status: 'deleted' })));
            await assertTotals([0, 0], 0);
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('collects trusted refs, permits approved Keep, measures growth and records reversible Trash in the incumbent Activity log', async () => {
        const home = join(scratch, 'cleanup-home');
        const server = join(home, 'servers', 'fixture');
        const cache = join(home, 'cache', 'approved-keep');
        const protectedCache = join(home, 'cache', 'protected');
        await mkdir(cache, { recursive: true });
        await mkdir(protectedCache, { recursive: true });
        await writeFile(join(protectedCache, 'bytes'), Buffer.alloc(4096, 9));
        await mkdir(server, { recursive: true });
        await writeFile(join(cache, 'bytes'), Buffer.alloc(4096, 7));
        const sampler = createMachineVitalsSampler({
            // The absent OS reader is the only substituted system boundary; these
            // real storage/Activity owners must not publish an automatic Guard dot.
            readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }),
        });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const serviceDeps = { catalog: { happyHomeDir: home, activeServerDir: server,
            tempRoot: join(scratch, 'cleanup-absent-temp'), readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [cache] }) },
            activityLog, machineId: 'machine', custodianAccountId: 'owner', homeDir: scratch,
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ protectedFolders: [{ path: protectedCache, addedAt: 1 }] }),
            readVolumes: () => [{ id: 'fixture-volume', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
        } satisfies StorageServiceDeps;
        const service = createStorageService(serviceDeps);
        try {
            const category = await service.categoryList('caches');
            const protectedItem = category.items.find(item => item.path === protectedCache)!;
            expect(protectedItem).toMatchObject({ verdict: 'keep', collectable: true, reason: { code: 'user_protected' },
                loses: [expect.objectContaining({ code: 'user_protected' })] });
            const protectedRef = { itemId: protectedItem.itemId, path: protectedCache };
            expect((await service.pileSet({ machineId: 'machine', add: [protectedRef] }, { actor })).items).toHaveLength(1);
            await service.pileSet({ machineId: 'machine', clear: true }, { actor });
            const item = category.items.find(item => item.path === cache)!;
            expect(item.verdict).toBe('keep');
            expect((await service.summary()).suggestionsTop.some(item => item.path === protectedCache)).toBe(false);
            const served = { itemId: item.itemId, path: cache };
            const collected = await service.pileSet({ machineId: 'machine', add: [served] }, { actor });
            expect(collected.items[0]).toMatchObject({ collectedBy: { accountId: 'owner', kind: 'person' } });
            expect(collected.items[0]!.identity.dev).toBe(String((await lstat(cache, { bigint: true })).dev));
            expect((await service.summary({ actor })).pile.count).toBe(1);
            const review = await service.itemsCheck(collected.items.map(({ itemId, path }) => ({ itemId, path })), { actor });
            expect(review.items[0]?.verdict).toBe('keep');
            expect(review.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: cache } });
            expect(PileReviewV1Schema.parse(review)).toEqual(review);
            expect(review.items[0]?.ref).toMatchObject({ identity: collected.items[0]!.identity,
                collectedBy: { accountId: 'owner', kind: 'person' } });
            const unavailable = { itemId: 'missing-ref', path: join(scratch, 'missing-ref') };
            expect((await service.itemsCheck([unavailable], { actor })).staying).toEqual([
                { item: unavailable, reason: { code: 'facts_unavailable' } },
            ]);
            expect((await service.itemsCheck([{ ...served, path: protectedCache }], { actor })).items).toEqual([]);
            await writeFile(join(cache, 'grew'), Buffer.alloc(32768, 8));
            const applied = await service.trashMove({ machineId: 'machine', items: [{ ref: collected.items[0]!,
                expect: review.items[0]!.expect, claimedVerdict: 'safe' }] }, { actor });
            expect(applied.outcomes).toEqual([{ itemId: item.itemId, status: 'moved' }]);
            expect(applied.inTrashBytes).toBeGreaterThan(review.items[0]!.size.allocatedBytes);
            await expect(lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await service.pileGet({ actor })).items).toEqual([]);
            const receipts = await activityLog.list({ range: 'today' });
            const moved = receipts.entries.find(entry => entry.kind === 'trash_moved')!;
            expect(moved.wayBack?.[0]?.input).toMatchObject({ machineId: 'machine', entryIds: [expect.any(String)] });
            expect(resourceSummary.getSummary()?.lastAutomaticAction).toBeUndefined();
            const coldMoved = createStorageService(serviceDeps);
            try {
                const listed = MachineStorageCategoryListResultV1Schema.parse(await coldMoved.categoryList('trash'));
                expect(listed.trashEntries).toEqual([expect.objectContaining({ batchId: applied.batchId, originalPath: cache,
                    size: expect.objectContaining({ allocatedBytes: applied.inTrashBytes }) })]);
                expect(listed.items[0]?.size).toEqual(listed.trashEntries?.[0]?.size);
            } finally { coldMoved.dispose(); }
            const restored = await service.trashRestore({ machineId: 'machine', batchId: applied.batchId }, { actor });
            expect(restored.outcomes).toEqual([expect.objectContaining({ status: 'restored', path: cache })]);
            expect((await lstat(join(cache, 'grew'))).size).toBe(32768);
            service.dispose();
            // An unrelated catalog root can become unavailable after a successful
            // Undo. A cold receipt still reads the canonical Trash manifests.
            await writeFile(join(home, 'tools'), 'not a directory');
            const observedAt = Date.now();
            const cold = createStorageService({ ...serviceDeps, nowMs: () => observedAt });
            try {
                await expect(cold.categoryList('caches')).rejects.toMatchObject({ code: 'ENOTDIR' });
                const receipt = MachineStorageCategoryListResultV1Schema.parse(await cold.categoryList('trash'));
                expect(receipt).toMatchObject({ categoryId: 'trash', items: [], trashEntries: [], sizedAt: observedAt });
                expect(receipt.revision).toBe(cold.revision());
                const cancelled = new AbortController(); cancelled.abort();
                await expect(cold.categoryList('trash', { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
                await expect(cold.categoryList('trash', { assertCurrent: async () => {
                    throw Object.assign(new Error('Authority changed'), { code: 'unauthorized' });
                } })).rejects.toMatchObject({ code: 'unauthorized' });
            } finally { cold.dispose(); }
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('projects physical protection into category flags and refuses collecting a cache containing the running executable', async () => {
        const home = join(scratch, 'forbidden-cache-home'); const server = join(home, 'servers', 'fixture');
        const cache = join(home, 'cache', 'contains-runtime'); const executable = join(cache, 'active-runtime');
        await mkdir(executable, { recursive: true }); await mkdir(server, { recursive: true }); await writeFile(join(executable, 'happier.exe'), Buffer.alloc(4096, 1));
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: server, installDir: executable,
            tempRoot: join(scratch, 'forbidden-absent-temp'), readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }) }, homeDir: scratch, machineId: 'machine', activityLog,
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const item = (await service.categoryList('caches')).items.find(item => item.path === cache)!;
            const ref = { itemId: item.itemId, path: cache, identity: { dev: 'fake', ino: 'fake', kind: 'directory' as const },
                collectedAt: 0, collectedBy: { accountId: 'owner', kind: 'person' as const } };
            await expect(service.pileSet({ machineId: 'machine', add: [ref] }, { actor })).rejects.toMatchObject({ code: 'storage_item_not_collectable' });
            expect(item).toMatchObject({ verdict: 'forbidden', collectable: false, reason: { code: 'contains_forbidden' } });
            expect((await service.summary()).categories.find(category => category.categoryId === 'caches')?.canGoBytes).toBe(0);
            expect((await service.pileGet({ actor })).items).toEqual([]);
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('declines the current descendant timestamp from the same real review measurement, not a cached snapshot', async () => {
        const home = join(scratch, 'decline-home');
        const server = join(home, 'servers', 'fixture');
        const cache = join(home, 'cache', 'unused');
        const bytes = join(cache, 'bytes');
        await mkdir(cache, { recursive: true }); await mkdir(server, { recursive: true });
        await writeFile(bytes, Buffer.alloc(4096, 1));
        const before = new Date(Date.now() - 10 * 86_400_000);
        await utimes(bytes, before, before); await utimes(cache, before, before);
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: server,
            tempRoot: join(scratch, 'decline-absent-temp'), readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }) }, activityLog, machineId: 'machine', homeDir: scratch,
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        try {
            const cached = (await service.categoryList('caches')).items.find(item => item.path === cache)!;
            const forged = { itemId: cached.itemId, path: cache, identity: { dev: 'fake', ino: 'fake', kind: 'directory' as const },
                collectedAt: 0, collectedBy: { accountId: 'owner', kind: 'person' as const } };
            const collected = await service.pileSet({ machineId: 'machine', add: [forged] }, { actor });
            await service.summary();
            const changed = new Date(Date.now() + 86_400_000);
            await utimes(bytes, changed, changed);
            const reviewed = await service.itemsCheck(collected.items, { actor });
            const suggestion = (await service.suggestionsList({ machineId: 'machine' }, { actor })).items.find(item => item.itemId === cached.itemId)!;
            expect(suggestion.title).toBe(cached.title);
            expect(collected.items[0]).toHaveProperty('title', suggestion.title);
            expect(reviewed.items[0]).toHaveProperty('title', suggestion.title);
            expect(reviewed.items[0]?.ref).toHaveProperty('title', suggestion.title);
            const declined = await service.suggestionsDecline({ machineId: 'machine', items: reviewed.items.map(item => ({ ref: item.ref, expect: item.expect })) }, { actor });
            expect(declined.declinedCount).toBe(1);
            expect((await service.suggestionsList({ machineId: 'machine' }, { actor: { ...actor, kind: 'agent' } })).items.some(item => item.path === cache)).toBe(false);
            expect((await service.suggestionsList({ machineId: 'machine' }, { actor })).items.some(item => item.path === cache)).toBe(true);
            expect((await service.summary({ actor: { ...actor, kind: 'agent' } })).suggestionsTop.some(item => item.path === cache)).toBe(false);
            expect((await service.summary({ actor })).suggestionsTop.some(item => item.path === cache)).toBe(true);
        } finally { service.dispose(); resourceSummary.stop(); await sampler.stop(); }
    });

    it('consumes the completed native whole-disk index and verifies build outputs through the real SCM owner', async () => {
        const home = join(scratch, 'suggestions-home'); const repo = join(scratch, 'suggestions-repo');
        await mkdir(home); await mkdir(repo);
        await execute('git', ['init', repo]);
        await writeFile(join(repo, 'package.json'), '{}'); await writeFile(join(repo, '.gitignore'), 'dist/\n');
        for (const name of ['dist', 'build']) { await mkdir(join(repo, name)); await writeFile(join(repo, name, 'bytes'), Buffer.alloc(4096, 1)); }
        await mkdir(join(repo, 'empty', 'child'), { recursive: true });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const registration = createGitScmBackendRuntimeRegistration();
        const scmRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
        let inUsePaths: string[] = []; let reliable = true; let protectedFolders: { path: string; addedAt: number }[] = [];
        const service = createStorageService({ catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'scan-absent-temp'),
            readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }), readInUsePaths: () => ({ reliable, paths: inUsePaths }) }, homeDir: scratch, scmRegistry,
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true, protectedFolders }),
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: repo, totalBytes: 1_000_000, availableBytes: 500_000 }],
            readStorageProtectionFacts: () => ({ cloudSyncedFolders: [repo] }),
        });
        try {
            expect((await service.suggestionsList({ machineId: 'machine', group: 'outside-happier' }, { actor })).items).toEqual([]);
            const scan = await service.scanStart({ machineId: 'machine', target: { volumeId: 'fixture' } }, { actor });
            await waitForStorageScan(service, scan.scanId, actor);
            const listed = await service.suggestionsList({ machineId: 'machine', group: 'outside-happier' }, { actor });
            expect(listed.items.filter(item => ['dist', 'build'].some(name => item.path === join(repo, name))).map(item => item.path))
                .toEqual([join(repo, 'dist')]);
            expect(listed.items.find(item => item.path === join(repo, 'dist')))
                .toMatchObject({ itemId: join(repo, 'dist'), verdict: 'caution', reason: { detail: { cloudSynced: true } }, evidence: expect.arrayContaining(['scm_ignored']) });
            const measured = await service.summary();
            expect(measured.suggestionsTop).toContainEqual(expect.objectContaining({ path: join(repo, 'dist') }));
            expect(measured.suggestionsTop).toContainEqual(expect.objectContaining({ path: join(repo, 'empty'),
                evidence: expect.arrayContaining(['empty_folder_relisted']) }));
            const { DatabaseSync } = await import('node:sqlite');
            const prepare = DatabaseSync.prototype.prepare;
            let traversedRows = 0;
            const { Session } = await import('node:inspector');
            const profiler = process.env.STO19_SUMMARY_PROFILE ? new Session() : undefined;
            profiler?.connect();
            if (profiler) { await new Promise<void>((done, fail) => profiler.post('Profiler.enable', error => error ? fail(error) : done()));
                await new Promise<void>((done, fail) => profiler.post('Profiler.start', error => error ? fail(error) : done())); }
            // Observe the real retained-index iterator; Account projection must
            // consume the measured suggestions, not enumerate the volume again.
            const observe = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
                const statement = prepare.call(this, sql);
                if (sql.includes('ORDER BY length(n.id) DESC,n.id')) {
                    const iterate = statement.iterate.bind(statement);
                    statement.iterate = function* (...args) {
                        const rows: ReturnType<typeof statement.iterate> = Reflect.apply(iterate, undefined, args);
                        for (const row of rows) { traversedRows++; yield row; }
                    };
                }
                return statement;
            });
            try {
                const retained = await service.summary({ actor });
                expect(retained.suggestionsTop).toEqual(measured.suggestionsTop);
                expect.soft(traversedRows).toBe(0);
                // A sibling process in the repository makes build outputs
                // ineligible even though its cwd does not overlap dist itself.
                inUsePaths = [join(repo, 'source')];
                expect((await service.summary({ actor })).suggestionsTop.some(item => item.path === join(repo, 'dist'))).toBe(false);
                inUsePaths = []; reliable = false;
                expect((await service.summary({ actor })).suggestionsTop.some(item => item.path === join(repo, 'dist'))).toBe(false);
                reliable = true; protectedFolders = [{ path: join(repo, 'dist'), addedAt: 1 }];
                expect((await service.summary({ actor })).suggestionsTop.some(item => item.path === join(repo, 'dist'))).toBe(false);
                protectedFolders = [];
                expect((await service.summary({ actor })).suggestionsTop).toEqual(measured.suggestionsTop);
                expect.soft(traversedRows).toBe(0);
                const recipient = { ...actor, accountId: 'recipient', sessionIds: new Set<string>() };
                expect((await service.summary({ actor: recipient })).suggestionsTop).toEqual([]);
            } finally {
                observe.mockRestore();
                if (profiler) {
                    const profile = await new Promise<unknown>((done, fail) => profiler.post('Profiler.stop', (error, value) => error ? fail(error) : done(value.profile)));
                    await writeFile(process.env.STO19_SUMMARY_PROFILE!, JSON.stringify(profile)); profiler.disconnect();
                }
            }
        } finally { service.dispose(); }
    });

    it('serves real sized RPC snapshots while restricting a recipient to proven Session folders', async () => {
        const home = join(scratch, 'rpc-home');
        const server = join(home, 'servers', 'home');
        const workspace = join(scratch, 'workspace');
        for (const sessionId of ['own-session', 'other-session']) {
            const directory = join(workspace, '.happier', 'uploads', 'messages', sessionId);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'attachment'), Buffer.alloc(4096, 5));
        }
        await mkdir(server, { recursive: true });
        const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
        // The canonical transport map erases payload types; real registered routes validate schemas.
        const handlers: RpcHandlerMap = new Map();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        const routes = createDaemonStorageRoutes({ target: () => identity,
            deps: () => ({ catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'rpc-absent-temp'),
                readTrackedSessions: () => ['own-session', 'other-session'].map(sessionId => ({ sessionId, cwd: workspace, running: true })) },
                readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] }),
            readOwnSessionIds: accountId => new Set(accountId === 'recipient' ? ['own-session'] : []),
        });
        registerDaemonStorageRpcHandlers(registrar, routes);
        const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
            signal: new AbortController().signal,
            machineAdmission: { ...identity, actorAccountId, role, encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        });
        const invoke = (method: string, input: object, actorAccountId = 'owner', role: 'use' | 'manage' = 'manage') =>
            handlers.get(method)!({ machineId: 'machine', ...input }, context(actorAccountId, role));
        try {
            const full = await invoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {});
            expect(full).toMatchObject({ volumes: [{ happierBytes: expect.any(Number), canGoBytes: expect.any(Number) }],
                categories: expect.arrayContaining([expect.objectContaining({ categoryId: 'sessionFolders', count: 2 })]) });
            expect(HappierStorageSummaryV1Schema.parse(full).scanShortcuts).toHaveLength(2);
            const shared = await invoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, {}, 'recipient', 'use');
            expect(shared).toMatchObject({ categories: [], suggestionsTop: [] });
            expect(JSON.stringify(shared)).not.toContain('"canGoBytes"');
            expect(JSON.stringify(shared)).not.toContain('"scanShortcuts"');
            const own = await invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'sessionFolders' }, 'recipient', 'use');
            expect(own).toMatchObject({ items: [expect.objectContaining({ path: join(workspace, '.happier', 'uploads', 'messages', 'own-session'),
                size: expect.objectContaining({ allocatedBytes: expect.any(Number) }) })] });
            expect(JSON.stringify(own)).not.toContain('other-session');
            expect(JSON.stringify(own)).not.toContain('"sessionId"');
            await expect(invoke(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, {}, 'recipient', 'use'))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            expect(await invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, { categoryId: 'trash' }, 'recipient', 'use'))
                .toMatchObject({ categoryId: 'trash', items: [], trashEntries: [] });
            const service = await routes.getService(identity);
            const first = await service.summary();
            const changed = invoke(RPC_METHODS.DAEMON_STORAGE_WATCH, { sinceRevision: first.revision }, 'recipient', 'use');
            await new Promise<void>(resolve => setImmediate(resolve));
            service.invalidate();
            expect(await changed).toMatchObject({ changed: true, summary: { categories: [], revision: expect.any(Number) } });
        } finally { routes.dispose(); }
    });
});
