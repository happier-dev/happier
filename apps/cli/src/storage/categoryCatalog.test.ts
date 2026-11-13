import { mkdtemp, mkdir, rm, writeFile, utimes, chmod, realpath, symlink } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageCategoryCatalog } from './categoryCatalog';
import type { StorageCategoryCatalogDeps } from './categories/types';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createHappierTempDir, getHappierTempDirOwnerPath, getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import { createGitScmBackendRuntimeRegistration } from '../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { runScmCommand } from '@/scm/runtime';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import type { ScmStatusSnapshotRequest, ScmStatusSnapshotResponse } from '@happier-dev/protocol/scm';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { createDaemonEventLoopStallMonitor } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';

// The real filesystem remains underneath; only one test projects an OS ownership fact.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: vi.fn(actual.lstat) };
});

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'storage-catalog-'))); scratch.push(root);
    const happyHomeDir = join(root, 'home');
    const activeServerDir = join(happyHomeDir, 'servers', 'active');
    const tempRoot = join(root, 'os-tmp');
    await Promise.all([happyHomeDir, activeServerDir, tempRoot].map(path => mkdir(path, { recursive: true })));
    const add = async (path: string) => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'bytes'), 'fixture'); return path; };
    return { root, happyHomeDir, activeServerDir, tempRoot, add };
}

describe('Happier storage category catalog', () => {
    it.each(['sessionFolders', 'temporary'] as const)('keeps readable %s siblings and Check when an ownership probe is denied', async categoryId => {
        const f = await fixture();
        const owner = createManagedSessionDirectories({ activeServerDir: f.activeServerDir });
        const first = categoryId === 'sessionFolders' ? await owner.materializeForFreshSpawn({ sessionCreationTag: 'denied' }) : undefined;
        const second = categoryId === 'sessionFolders' ? await owner.materializeForFreshSpawn({ sessionCreationTag: 'readable' }) : undefined;
        const denied = first?.directory ?? await f.add(join(f.tempRoot, 'happier-denied'));
        const readable = second?.directory ?? await f.add(join(f.tempRoot, 'happier-readable'));
        const blocked = categoryId === 'sessionFolders' ? denied : getHappierTempDirOwnerPath(denied);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (String(args[0]) === blocked) throw Object.assign(new Error('Denied ownership probe'), { code: 'EACCES' });
            return actual.lstat(...args);
        });
        try {
            const snapshot = await createStorageCategoryCatalog({ ...f, managedSessionDirectories: owner,
                bootedAt: Date.now() + 1_000 }).discoverSnapshot();
            expect(snapshot.items.find(item => item.path === readable)).toMatchObject({ categoryId });
            expect(snapshot.items.find(item => item.path === denied)).toMatchObject({ categoryId, verdict: 'check', collectable: false });
            expect(snapshot.incomplete).toContainEqual({ categoryId, reason: 'permission_denied',
                remedy: 'grant_admin_access_or_run_as_machine_owner' });
        } finally { boundary.mockImplementation(actual.lstat); }
    });
    it('keeps readable recordings and denied ancestry protection when one recording is unreadable', async () => {
        const f = await fixture();
        const parent = join(f.happyHomeDir, 'cache', 'recording-archive');
        const denied = await f.add(join(parent, 'denied'));
        const readable = await f.add(join(parent, 'readable'));
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        // Only the OS read is denied; category discovery and descendant
        // protection remain the real catalog used by read and effect callers.
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (String(args[0]) === denied) throw Object.assign(new Error('Denied recording'), { code: 'EACCES' });
            return actual.lstat(...args);
        });
        try {
            const snapshot = await createStorageCategoryCatalog({ ...f, readRecordings: async () => [
                { recordingId: 'denied', path: denied, active: false },
                { recordingId: 'readable', path: readable, active: false },
            ] }).discoverSnapshot();
            expect(snapshot.items.find(item => item.path === parent)).toMatchObject({ verdict: 'check', collectable: false });
            expect(snapshot.items.find(item => item.path === readable)).toMatchObject({ categoryId: 'recordings',
                evidence: ['browser_recording_owner'], verdict: 'caution' });
            expect(snapshot.items.find(item => item.path === denied)).toMatchObject({ categoryId: 'recordings',
                verdict: 'check', collectable: false, evidence: ['directory_permission_unavailable'] });
            expect(snapshot.incomplete).toEqual([{ categoryId: 'recordings', reason: 'permission_denied',
                remedy: 'grant_admin_access_or_run_as_machine_owner' }]);
        } finally { boundary.mockImplementation(actual.lstat); }
    });
    it('keeps unavailable SCM supplementation explicit when path-use facts are absent', async () => {
        const f = await fixture();
        const candidate = await f.add(join(f.root, 'unavailable-scm'));
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (String(args[0]) === join(candidate, '.git')) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
            return actual.lstat(...args);
        });
        try {
            const items = await createStorageCategoryCatalog(f).discover([candidate], []);
            expect(items.find(item => item.path === candidate)).toMatchObject({ categoryId: 'worktrees', verdict: 'check', collectable: false });
        } finally { boundary.mockImplementation(actual.lstat); }
    });
    it('keeps retained descendant facts unchanged when supplementing unrelated SCM paths', async () => {
        const f = await fixture();
        const parent = join(f.root, '.dev', 'worktree', 'parent');
        const nested = await f.add(join(parent, 'nested'));
        const candidates = await Promise.all(['first-checkout', 'second-checkout'].map(name => f.add(join(f.root, name))));
        const catalog = createStorageCategoryCatalog({ ...f, scmRegistry: createScmBackendRegistry([]),
            readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: f.root }] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }),
            readWorktrees: () => [{ path: parent, repositoryRoot: f.root, pullRequestState: null,
                facts: { path: parent, changeCount: 0, ahead: 0, upstream: 'origin/main', upstreamGone: false,
                    mergedIntoDefault: true, headOid: '123456' } }, { path: nested, repositoryRoot: f.root }],
        });
        let current = await catalog.discover();
        const retained = current.find(item => item.path === parent)!;
        expect(retained.loses?.filter(reason => reason.code === 'facts_unavailable')).toHaveLength(1);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (candidates.some(candidate => String(args[0]) === join(candidate, '.git')))
                throw Object.assign(new Error('Denied'), { code: 'EACCES' });
            return actual.lstat(...args);
        });
        try {
            for (const candidate of candidates) {
                current = await catalog.discover([candidate], current);
                expect(current.find(item => item.path === candidate)).toMatchObject({ categoryId: 'worktrees', verdict: 'check' });
                const projected = current.find(item => item.path === parent)!;
                expect(projected.loses?.filter(reason => reason.code === 'facts_unavailable')).toHaveLength(1);
                expect(projected).toEqual(retained);
            }
        } finally { boundary.mockImplementation(actual.lstat); }
    });
    it('preserves live managed-tool temporary facts on a page without walking unrelated tools or logs', async () => {
        const f = await fixture();
        const tool = await f.add(join(f.happyHomeDir, 'tools', 'selected'));
        const unrelated = await f.add(join(f.happyHomeDir, 'tools', 'unrelated'));
        const live = createHappierTempDir({ root: join(tool, '.tmp'), purpose: 'storage-page' });
        createHappierTempDir({ root: join(unrelated, '.tmp'), purpose: 'unrelated' });
        const logs = await f.add(join(f.happyHomeDir, 'logs'));
        const catalog = createStorageCategoryCatalog({ ...f, readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const full = await catalog.discover();
        expect(full.find(item => item.path === live)).toMatchObject({ categoryId: 'temporary', verdict: 'keep', reason: { code: 'in_use' } });
        expect(full.find(item => item.path === tool)).toMatchObject({ verdict: 'keep', loses: [{ code: 'in_use' }] });
        const directory = vi.spyOn(filesystem, 'readdir');
        try {
            const page = await catalog.discoverPage([tool], { reliable: true, paths: [] });
            expect(page.find(item => item.path === live)).toEqual(full.find(item => item.path === live));
            expect(page.find(item => item.path === tool)).toEqual(full.find(item => item.path === tool));
            expect(directory.mock.calls.filter(([path]) => String(path) === logs || String(path).startsWith(unrelated))).toHaveLength(0);
            directory.mockClear();
            await catalog.discoverPage([join(logs, 'bytes')], { reliable: true, paths: [] });
            expect(directory.mock.calls).toHaveLength(0);
        } finally { directory.mockRestore(); }
    });
    it('retains encountered SCM ownership for a page inside a checkout outside the managed worktree parent', async () => {
        const f = await fixture();
        const repository = await f.add(join(f.root, 'external-checkout'));
        await mkdir(join(repository, '.git'));
        const selected = await f.add(join(repository, 'selected'));
        const catalog = createStorageCategoryCatalog({ ...f, scmRegistry: createScmBackendRegistry([]),
            readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repository }] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const full = await catalog.discover([repository]);
        expect(full.find(item => item.path === repository)).toMatchObject({ categoryId: 'worktrees', verdict: 'check' });
        const page = await catalog.discoverPage([selected], { reliable: true, paths: [] });
        expect(page.find(item => item.path === repository)).toEqual(full.find(item => item.path === repository));
    });
    it.skipIf(process.platform === 'win32')('matches physical scan paths to category roots reached through a symlink', async () => {
        const f = await fixture();
        const selected = await f.add(join(f.happyHomeDir, 'cache', 'selected'));
        const alias = join(f.root, 'home-alias'); await symlink(f.happyHomeDir, alias, 'dir');
        const recording = join(selected, 'bytes');
        const catalog = createStorageCategoryCatalog({ ...f, happyHomeDir: alias,
            readRecordings: async () => [{ recordingId: 'recording', path: join(alias, 'cache', 'selected', 'bytes'), active: true }],
            readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const page = await catalog.discoverPage([selected], { reliable: true, paths: [] });
        expect(page.find(item => item.path === selected)).toMatchObject({ categoryId: 'caches', verdict: 'keep', reason: { code: 'contains' } });
        expect(page.find(item => item.path === recording)).toMatchObject({ categoryId: 'recordings', verdict: 'keep', reason: { code: 'in_use' } });
    });
    it('reads one owned log beside a thousand retained siblings without listing the inventory', async () => {
        const f = await fixture();
        const logs = join(f.happyHomeDir, 'logs'); await mkdir(logs);
        const selected = join(logs, 'selected.log');
        await Promise.all([writeFile(selected, 'selected'), ...Array.from({ length: 1000 }, (_, index) =>
            writeFile(join(logs, `unrelated-${index}.log`), 'retained'))]);
        const catalog = createStorageCategoryCatalog({ ...f, now: () => 1,
            readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const baseline = (await catalog.discover()).find(item => item.path === selected);
        expect(baseline).toMatchObject({ categoryId: 'logs', verdict: 'keep', reason: { code: 'recent' } });
        const directory = vi.spyOn(filesystem, 'readdir');
        try {
            const page = await catalog.discoverPage([selected], { reliable: true, paths: [] });
            expect(page.find(item => item.path === selected)).toEqual(baseline);
            expect(page.filter(item => item.categoryId === 'logs').map(item => item.path)).toEqual([selected]);
            expect(directory.mock.calls).toHaveLength(0);
            const held = await catalog.discoverPage([selected], { reliable: true, paths: [selected] });
            expect(held.find(item => item.path === selected)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
            expect(directory.mock.calls).toHaveLength(0);
        } finally { directory.mockRestore(); }
    });
    it('derives old log suggestions from retention policy and keeps Forever and current logs', async () => {
        const f = await fixture();
        const now = 100 * 86_400_000;
        const root = join(f.happyHomeDir, 'logs'); await mkdir(root);
        const threshold = join(root, 'threshold.log');
        const retained = join(root, 'retained.log');
        const current = join(root, 'current.log');
        for (const [path, ageDays] of [[threshold, 30], [retained, 20], [current, 60]] as const) {
            await writeFile(path, 'log');
            await utimes(path, (now - ageDays * 86_400_000) / 1000, (now - ageDays * 86_400_000) / 1000);
        }
        let policy = MachineStoragePolicyV1Schema.parse({ logRetentionDays: 30 });
        const catalog = createStorageCategoryCatalog({ ...f, now: () => now,
            readPolicy: () => policy, currentLogPaths: () => [current] });
        const discoverLogs = async () => new Map((await catalog.discover()).filter(item => item.categoryId === 'logs')
            .map(item => [item.path, item]));
        const initial = await discoverLogs();
        expect(initial.get(threshold)).toMatchObject({ verdict: 'safe', reason: { code: 'old' },
            categoryGroup: { id: 'old', olderThanDays: 30 } });
        expect(initial.get(retained)).toMatchObject({ verdict: 'keep', reason: { code: 'recent' }, categoryGroup: { id: 'recent' } });
        expect(initial.get(current)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
        policy = MachineStoragePolicyV1Schema.parse({ logRetentionDays: 7 });
        expect((await discoverLogs()).get(retained)).toMatchObject({ verdict: 'safe', reason: { code: 'old' },
            categoryGroup: { id: 'old', olderThanDays: 7 } });
        policy = MachineStoragePolicyV1Schema.parse({ logRetentionDays: null });
        const forever = await discoverLogs();
        expect(forever.get(threshold)).toMatchObject({ verdict: 'keep', reason: { code: 'recent' }, categoryGroup: { id: 'recent' } });
        expect(forever.get(retained)).toMatchObject({ verdict: 'keep', reason: { code: 'recent' }, categoryGroup: { id: 'recent' } });
        expect(forever.get(current)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
    });
    it('does not wait for legacy temporary descendants when the directory itself changed after boot', async () => {
        const f = await fixture();
        const legacy = await f.add(join(f.tempRoot, 'happier-running-scan'));
        const descendant = join(legacy, 'bytes');
        await utimes(legacy, 10, 10);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let release!: () => void;
        const parked = new Promise<void>(resolve => { release = resolve; });
        let descendantEntered!: () => void;
        const entered = new Promise<void>(resolve => { descendantEntered = resolve; });
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            const result = await actual.lstat(...args);
            if (String(args[0]) === descendant) { descendantEntered(); await parked; }
            return result;
        });
        const discovery = createStorageCategoryCatalog({ ...f, bootedAt: 5_000 }).discoverSnapshot();
        try {
            // A scan can keep this unrelated subtree's filesystem work busy. The
            // root timestamp already disproves pre-boot cleanup eligibility.
            const outcome = await Promise.race([
                discovery.then(() => 'completed' as const),
                entered.then(() => 'blocked-descendant' as const),
            ]);
            expect(outcome).toBe('completed');
            expect((await discovery).items.find(item => item.path === legacy)).toMatchObject({ verdict: 'check', collectable: false });
        } finally { release(); await discovery; boundary.mockImplementation(actual.lstat); }
    });
    it('reads independent temporary siblings before a parked metadata result settles', async () => {
        const f = await fixture();
        const first = createHappierTempDir({ root: f.tempRoot, purpose: 'a' });
        const sibling = createHappierTempDir({ root: f.tempRoot, purpose: 'b' });
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let enter!: () => void; let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const parked = new Promise<void>(resolve => { release = resolve; });
        let siblingEntered = false;
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (String(args[0]) === sibling) siblingEntered = true;
            const result = await actual.lstat(...args);
            if (String(args[0]) === first) { enter(); await parked; }
            return result;
        });
        const discovery = createStorageCategoryCatalog({ ...f }).discoverSnapshot();
        try {
            await entered;
            expect(siblingEntered).toBe(true);
            release();
            expect((await discovery).items.filter(item => item.categoryId === 'temporary').map(item => item.path)).toEqual([first, sibling]);
        } finally { release(); await discovery; boundary.mockImplementation(actual.lstat); }
    });
    it('reads sibling log metadata without waiting for a parked filesystem result', async () => {
        const f = await fixture();
        const root = join(f.happyHomeDir, 'logs'); await mkdir(root);
        const first = join(root, 'a.log'); const sibling = join(root, 'b.log');
        await Promise.all([writeFile(first, 'first'), writeFile(sibling, 'sibling')]);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let enter!: () => void; let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const parked = new Promise<void>(resolve => { release = resolve; });
        let siblingEntered = false;
        const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
            if (String(args[0]) === sibling) siblingEntered = true;
            const result = await actual.lstat(...args);
            if (String(args[0]) === first) { enter(); await parked; }
            return result;
        });
        const discovery = createStorageCategoryCatalog({ ...f }).discoverSnapshot();
        try {
            await entered;
            expect(siblingEntered).toBe(true);
            release();
            const result = await discovery;
            expect(result.items.filter(item => item.categoryId === 'logs').map(item => item.path)).toEqual([first, sibling]);
        } finally { release(); await discovery; boundary.mockImplementation(actual.lstat); }
    });
    it('names opaque cache and allocation folders by their owning tool instead of displaying digests', async () => {
        const f = await fixture();
        const digest = 'a'.repeat(64);
        const cache = await f.add(join(f.happyHomeDir, 'cache', digest));
        const snapshot = await f.add(join(f.happyHomeDir, '.runner-snapshots', digest));
        const skill = await f.add(join(f.happyHomeDir, 'skills', 'cache', digest));
        const namedCache = await f.add(join(f.happyHomeDir, 'cache', 'attachments'));
        const allocation = await f.add(join(f.activeServerDir, 'session-directories', digest));
        const agentHome = await f.add(join(f.activeServerDir, 'daemon', 'connected-services', 'homes', digest));
        const isolation = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', digest));
        const model = await f.add(join(f.activeServerDir, 'voiceInference', 'models', digest));
        const handoff = await f.add(join(f.activeServerDir, 'session-handoff', digest));
        const repositoryRoot = join(f.root, 'repo');
        const worktree = await f.add(join(repositoryRoot, digest));
        const byPath = new Map((await createStorageCategoryCatalog({ ...f,
            readWorktrees: () => [{ path: worktree, repositoryRoot }] }).discover()).map(item => [item.path, item]));
        expect(byPath.get(cache)?.title).toBe('Happier cache');
        expect(byPath.get(snapshot)?.title).toBe('Session runner snapshot');
        expect(byPath.get(skill)?.title).toBe('Skill cache');
        expect(byPath.get(allocation)?.title).toBe('Session folder');
        expect(byPath.get(namedCache)?.title).toBe('attachments');
        expect(byPath.get(agentHome)?.title).toBe('Agent home');
        expect(byPath.get(isolation)?.title).toBe('Agent run home');
        expect(byPath.get(model)?.title).toBe('Model pack');
        expect(byPath.get(handoff)?.title).toBe('Session handoff files');
        expect(byPath.get(worktree)?.title).toBe('Worktree');
    });
    it('does not multiply category reads by repeated process path facts', async () => {
        const f = await fixture();
        const logs = join(f.happyHomeDir, 'logs');
        await mkdir(logs);
        for (let index = 0; index < 64; index++) await writeFile(join(logs, `${index}.log`), 'fixture');
        const distinct = Array.from({ length: 180 }, (_, index) => join(f.root, 'work', `project-${index}`));
        let paths = distinct;
        const catalog = createStorageCategoryCatalog({ ...f, readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths }) });
        const started = performance.now();
        const baseline = await catalog.discoverSnapshot();
        const baselineMs = performance.now() - started;
        paths = Array.from({ length: 1_800 }, (_, index) => distinct[index % distinct.length]);
        const repeatedStarted = performance.now();
        const repeated = await catalog.discoverSnapshot();
        const repeatedMs = performance.now() - repeatedStarted;
        expect(repeated).toEqual(baseline);
        // A relative regression check, not an inventory limit or runtime cutoff.
        expect(repeatedMs, `distinct=${baselineMs}ms repeated=${repeatedMs}ms`).toBeLessThan(Math.max(1_000, baselineMs * 4));
    }, 30_000);
    it('folds protected deep descendants without protecting sibling-prefix caches', async () => {
        const f = await fixture();
        const parent = await f.add(join(f.happyHomeDir, 'cache', 'a'));
        const sibling = await f.add(join(f.happyHomeDir, 'cache', 'a-other'));
        const retained = await f.add(join(parent, 'deep', 'retained-server'));
        const catalog = createStorageCategoryCatalog({ ...f, activeServerDir: retained,
            readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const result = await catalog.discoverSnapshot();
        expect(result.items.find(item => item.path === parent)).toMatchObject({ verdict: 'forbidden', collectable: false,
            reason: { code: 'contains_forbidden', detail: { count: 1 } } });
        expect(result.items.find(item => item.path === sibling)).toMatchObject({ verdict: 'safe', collectable: true });
    });
    it('projects a retained log inventory without starving the daemon stall monitor', async () => {
        const f = await fixture();
        const logs = join(f.happyHomeDir, 'logs');
        await mkdir(logs);
        // QA21 observed649 files in just one live log root. This is an inventory,
        // not a product cap; the other Storage categories remain real underneath.
        for (let index = 0; index < 1_000; index++) await writeFile(join(logs, `${index}.log`), 'fixture');
        const warnings: Readonly<Record<string, unknown>>[] = [];
        const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [],
            warn: (_message, data) => warnings.push(data) });
        const catalog = createStorageCategoryCatalog({ ...f, readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
        try {
            traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
            monitor.start();
            const result = await catalog.discoverSnapshot();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(result.items.filter(item => item.categoryId === 'logs')).toHaveLength(1_000);
            expect(warnings).toEqual([]);
        } finally { monitor.stop(); traceEnv.restore(); }
    });
    it.skipIf(process.platform === 'win32')('binds a managed uv item to the same guarded Storage remover', async () => {
        const f = await fixture();
        const installRoot = join(f.happyHomeDir, 'tools', 'providers', managedAcpInstallId({ accountId: 'alice', definitionId: 'uv-agent', version: '1.0' }));
        await f.add(join(installRoot, 'current'));
        await writeFile(join(installRoot, 'current', 'uv.json'), JSON.stringify({ definitionId: 'uv-agent', title: 'Uv Agent',
            version: '1.0', kind: 'uv', package: 'fixture-agent', command: 'agent' }));
        const uvDir = join(f.happyHomeDir, 'tools', 'uv', 'current', 'bin');
        await mkdir(uvDir, { recursive: true });
        await writeFile(join(uvDir, 'uv'), '#!/bin/sh\n[ "$1 $2 $3" = "tool uninstall fixture-agent" ]\n', { mode: 0o755 });
        const catalog = createStorageCategoryCatalog({ ...f, acpAccountId: 'alice', isAcpDefinitionInUse: () => false,
            readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [] } }) });
        const item = (await catalog.discover()).find(item => item.path === installRoot)!;
        expect(item.title).toBe('Uv Agent · removed agent');
        const adapter = await catalog.resolveAdapter(item);
        await adapter.discard({});
        await expect(filesystem.access(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('binds ACP cleanup to one Account version and keeps its live-use guard', async () => {
        const f = await fixture();
        const installed: string[] = [];
        for (const [accountId, version] of [['alice', '1.0'], ['alice', '2.0'], ['bob', '1.0']] as const) {
            const root = join(f.happyHomeDir, 'tools', `dep.${managedAcpInstallId({ accountId, definitionId: 'same', version })}`);
            await f.add(join(root, 'current'));
            await writeFile(join(root, 'current', '.happier-managed-version'), JSON.stringify({ definitionId: 'same', title: 'Same', version, kind: 'archive' }));
            installed.push(root);
        }
        // A definition may change source kind without changing its version pin.
        const npmRoot = join(f.happyHomeDir, 'tools', 'providers', managedAcpInstallId({ accountId: 'alice', definitionId: 'same', version: '1.0' }));
        await f.add(join(npmRoot, 'current', 'workspace'));
        await writeFile(join(npmRoot, 'current', 'workspace', 'package.json'), JSON.stringify({ happierManagedAcp: {
            definitionId: 'same', title: 'Same npm', version: '1.0', kind: 'npm',
        } }));
        let running = true;
        const catalog = createStorageCategoryCatalog({ ...f, acpAccountId: 'alice', isAcpDefinitionInUse: () => running,
            readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [] } }) });
        const items = await catalog.discover();
        const old = items.find(item => item.path === installed[0])!;
        expect(old).toMatchObject({ title: 'Same · removed agent', reason: { code: 'in_use' } });
        expect(items.find(item => item.path === installed[2])?.title).toBe('Same');
        const adapter = await catalog.resolveAdapter(old);
        await expect(adapter.discard({})).rejects.toMatchObject({ code: 'owner_unavailable' });
        await expect(filesystem.access(installed[0]!)).resolves.toBeUndefined();
        running = false;
        await adapter.discard({});
        await expect(filesystem.access(installed[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(filesystem.access(installed[1]!)).resolves.toBeUndefined();
        await expect(filesystem.access(installed[2]!)).resolves.toBeUndefined();
        await expect(filesystem.access(npmRoot)).resolves.toBeUndefined();
    });
    it('skips vanished listed leaves while preserving permission-denied leaves as incomplete facts', async () => {
        const f = await fixture();
        const vanished = await Promise.all([
            f.add(join(f.tempRoot, 'happier-a-vanished')),
            f.add(join(f.activeServerDir, 'session-directories', 'a-vanished')),
            f.add(join(f.happyHomeDir, 'logs', 'a-vanished')),
        ]);
        const denied = await Promise.all([
            f.add(join(f.tempRoot, 'happier-denied')),
            f.add(join(f.activeServerDir, 'session-directories', 'denied')),
            f.add(join(f.happyHomeDir, 'logs', 'denied')),
        ]);
        const readStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat;
        // Real directory enumeration is retained; OS lstat models a concurrent unlink or permission change.
        const statBoundary = vi.spyOn(filesystem, 'lstat').mockImplementation(async (...args) => {
            if (vanished.includes(String(args[0]))) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            if (denied.includes(String(args[0]))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return readStat(...args);
        });
        try {
            const snapshot = await createStorageCategoryCatalog({ ...f }).discoverSnapshot();
            expect(snapshot.items.filter(item => vanished.includes(item.path))).toEqual([]);
            for (const path of denied) expect(snapshot.items.find(item => item.path === path)).toMatchObject({
                verdict: 'check', collectable: false, evidence: ['directory_permission_unavailable'],
            });
            const unexpected = Object.assign(new Error('storage I/O failure'), { code: 'EIO' });
            statBoundary.mockImplementation(async (...args) => {
                if (args[0] === vanished[0]) throw unexpected;
                return readStat(...args);
            });
            await expect(createStorageCategoryCatalog({ ...f }).discoverSnapshot()).rejects.toBe(unexpected);
        } finally { statBoundary.mockImplementation(readStat); }
    });
    it('discovers real owned paths across every category without treating state as a cache or temporary data', async () => {
        const f = await fixture();
        const repo = await f.add(join(f.root, 'repo'));
        const worktree = await f.add(join(repo, '.dev', 'worktree', 'branch'));
        const cache = await f.add(join(f.happyHomeDir, 'cache', 'pnpm'));
        const snapshot = await f.add(join(f.happyHomeDir, '.runner-snapshots', 'live'));
        const agentHome = await f.add(join(f.activeServerDir, 'daemon', 'connected-services', 'homes', 'agent'));
        const media = await f.add(join(repo, '.happier', 'uploads', 'messages', 's1'));
        const logs = join(f.happyHomeDir, 'logs'); await mkdir(logs);
        const oldLog = join(logs, 'old.log'); await writeFile(oldLog, 'log'); await utimes(oldLog, 1, 1);
        const legacy = await f.add(join(f.tempRoot, 'happier-old')); await utimes(join(legacy, 'bytes'), 1, 1); await utimes(legacy, 1, 1);
        const state = await f.add(join(f.happyHomeDir, 'tmp', 'session-runner-locks'));
        const deps: StorageCategoryCatalogDeps = { ...f, now: () => 10_000_000_000, bootedAt: 5_000,
            readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }),
            readTrackedSessions: () => [{ sessionId: 's1', cwd: repo, running: true }],
            readLiveRunnerSnapshotPaths: () => ({ reliable: true, paths: new Set([snapshot]) }),
            readInUsePaths: () => ({ reliable: true, paths: [repo] }) };
        const items = await createStorageCategoryCatalog(deps).discover();
        const byPath = new Map(items.map(item => [item.path, item]));
        expect(byPath.get(worktree)).toMatchObject({ categoryId: 'worktrees', verdict: 'check', collectable: false });
        expect(byPath.get(cache)).toMatchObject({ categoryId: 'caches', verdict: 'safe', collectable: true });
        expect(byPath.get(snapshot)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
        expect(byPath.get(agentHome)).toMatchObject({ categoryId: 'agentHomes', verdict: 'keep', reason: { code: 'agent_home' } });
        expect(byPath.get(media)).toMatchObject({ categoryId: 'sessionFolders', verdict: 'keep', reason: { code: 'in_use' } });
        expect(byPath.get(oldLog)).toMatchObject({ categoryId: 'logs', verdict: 'safe', collectable: true });
        expect(byPath.get(legacy)).toMatchObject({ categoryId: 'temporary',
            verdict: process.getuid ? 'safe' : 'check', collectable: Boolean(process.getuid) });
        expect(items.some(item => item.path === state && item.categoryId === 'temporary')).toBe(false);
        expect(byPath.get(f.happyHomeDir)).toMatchObject({ categoryId: 'ownData', verdict: 'forbidden', collectable: false });
    });

    it('uses owner lifecycle facts for cleanup and preserves unknown facts rather than inferring inactivity from directory age', async () => {
        const f = await fixture();
        const closed = await f.add(join(f.activeServerDir, 'session-handoff', 'closed'));
        const unknown = await f.add(join(f.activeServerDir, 'session-handoff', 'unknown'));
        const finishedIsolation = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', 'finished'));
        const runningIsolation = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', 'running'));
        const deps: StorageCategoryCatalogDeps = { ...f,
            readTemporaryFacts: async () => [{ path: closed, state: 'closed' }],
            readIsolationFacts: () => [{ path: finishedIsolation, state: 'finished' }, { path: runningIsolation, state: 'running' }] };
        const byPath = new Map((await createStorageCategoryCatalog(deps).discover()).map(item => [item.path, item]));
        expect(byPath.get(closed)).toMatchObject({ verdict: 'safe', collectable: true });
        expect(byPath.get(unknown)).toMatchObject({ verdict: 'check', collectable: false });
        expect(byPath.get(finishedIsolation)).toMatchObject({ categoryId: 'agentHomes', verdict: 'safe' });
        expect(byPath.get(runningIsolation)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
    });

    it('joins managed allocations to the canonical session binding and does not confer an owner on unknown upload folders', async () => {
        const f = await fixture();
        const owner = createManagedSessionDirectories({ activeServerDir: f.activeServerDir });
        const allocated = await owner.materializeForFreshSpawn({ sessionCreationTag: 'fixture' });
        await owner.bind({ allocationId: allocated.allocationId, sessionId: 'known' });
        const cwd = await f.add(join(f.root, 'workspace'));
        const knownUpload = await f.add(join(cwd, '.happier', 'uploads', 'artifacts', 'known'));
        const unknownUpload = await f.add(join(cwd, '.happier', 'uploads', 'messages', 'unknown'));
        const now = 100 * 24 * 60 * 60 * 1000;
        const catalog = createStorageCategoryCatalog({ ...f, managedSessionDirectories: owner, now: () => now,
            readTrackedSessions: () => [{ sessionId: 'known', cwd, running: false, stoppedAt: 1 }],
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ suggestUnusedAfterDays: 10 }) });
        const byPath = new Map((await catalog.discover()).map(item => [item.path, item]));
        expect(byPath.get(allocated.directory)).toMatchObject({ sessionId: 'known', verdict: 'caution', reason: { code: 'attachments_go' } });
        expect(byPath.get(knownUpload)).toMatchObject({ sessionId: 'known', verdict: 'caution' });
        expect(byPath.get(unknownUpload)).toMatchObject({ verdict: 'check', collectable: false });
        expect(byPath.get(unknownUpload)).not.toHaveProperty('sessionId');
        expect((await catalog.discover()).map(item => item.itemId)).toEqual([...byPath.values()].map(item => item.itemId));
        const recent = createStorageCategoryCatalog({ ...f, managedSessionDirectories: owner, now: () => now,
            readTrackedSessions: () => [{ sessionId: 'known', cwd, running: false, stoppedAt: now - 35 * 24 * 60 * 60 * 1000 }],
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ suggestUnusedAfterDays: 40 }) });
        expect((await recent.discover()).find(item => item.path === knownUpload)).toMatchObject({ verdict: 'keep', reason: { code: 'recent' } });
    });

    it('reports model use from the worker owner, keeps live logs and exposes recording and Trash bytes with all category ids', async () => {
        const f = await fixture();
        const packPath = await f.add(join(f.activeServerDir, 'voiceInference', 'packs', 'pack'));
        const unknownPack = await f.add(join(f.activeServerDir, 'voiceInference', 'models', 'historic'));
        const recording = join(f.root, 'recording.webm'); await writeFile(recording, 'video');
        const trashPath = await f.add(join(f.happyHomeDir, 'trash'));
        const logRoot = join(f.happyHomeDir, 'logs'); await mkdir(logRoot);
        const current = join(logRoot, 'current.log'); await writeFile(current, 'log'); await utimes(current, 1, 1);
        const catalog = createStorageCategoryCatalog({ ...f, now: () => 100 * 24 * 60 * 60 * 1000,
            currentLogPaths: () => [current],
            readModelPacks: async () => [{ key: 'pack', identity: { pluginId: 'fixture.voice', packId: 'pack' }, directoryKey: 'pack',
                descriptor: null, installedMetadata: null, installedManifest: null, runtimeDescriptor: null, supportArtifacts: [], lastUsedAt: 1 }],
            readRecordings: async () => [{ recordingId: 'r1', path: recording, expiresAtMs: 2, active: false }] });
        const byPath = new Map((await catalog.discover()).map(item => [item.path, item]));
        expect(byPath.get(packPath)).toMatchObject({ categoryId: 'modelPacks', lastUsedAt: 1, verdict: 'caution', reason: { code: 'feature_waits' } });
        expect(byPath.get(unknownPack)).toMatchObject({ verdict: 'check', collectable: false });
        expect(byPath.get(current)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
        expect(byPath.get(recording)).toMatchObject({ categoryId: 'recordings', verdict: 'caution' });
        expect(byPath.get(trashPath)).toMatchObject({ categoryId: 'trash', collectable: false });
        expect(catalog.categoryIds).toEqual(['worktrees', 'caches', 'modelPacks', 'sessionFolders', 'logs', 'agentHomes', 'temporary', 'recordings', 'trash', 'ownData']);
    });

    it('never calls an unmarked old parent unused when a descendant changed after boot', async () => {
        const f = await fixture();
        const oldParent = await f.add(join(f.tempRoot, 'happier-old-parent'));
        await utimes(oldParent, 1, 1);
        await utimes(join(oldParent, 'bytes'), 20, 20);
        const newer = await f.add(join(f.tempRoot, 'happier-new'));
        const items = await createStorageCategoryCatalog({ ...f, bootedAt: 10_000 }).discover();
        for (const path of [oldParent, newer]) expect(items.find(item => item.path === path)).toMatchObject({ verdict: 'check', collectable: false });
    });

    it('keeps the incumbent isolation owner’s local resume state after a run finishes', async () => {
        const f = await fixture();
        const empty = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', 'empty'));
        const resumable = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', 'resumable'));
        await mkdir(join(resumable, 'xdg', 'state'), { recursive: true });
        await writeFile(join(resumable, 'xdg', 'state', 'session.json'), '{}');
        const catalog = createStorageCategoryCatalog({ ...f,
            readIsolationFacts: async () => [{ path: empty, state: 'finished' }, { path: resumable, state: 'finished' }] });
        const byPath = new Map((await catalog.discover()).map(item => [item.path, item]));
        expect(byPath.get(empty)).toMatchObject({ verdict: 'safe' });
        expect(byPath.get(resumable)).toMatchObject({ verdict: 'keep', reason: { code: 'agent_home' } });
    });

    it('checks marked process-instance liveness and includes every managed-tool scratch root', async () => {
        const f = await fixture();
        const live = await createHappierTempDir({ root: f.tempRoot, purpose: 'live' });
        const recycledPid = await createHappierTempDir({ root: f.tempRoot, purpose: 'recycled' });
        await writeFile(getHappierTempDirOwnerPath(recycledPid), JSON.stringify({ v: 1, pid: process.pid, processInstanceFingerprint: 'different-instance', purpose: 'recycled' }));
        const scratchParent = join(f.happyHomeDir, 'tools', 'fixture-tool', '.tmp');
        const toolScratch = await createHappierTempDir({ root: scratchParent, purpose: 'tool-install' });
        const items = await createStorageCategoryCatalog({ ...f }).discover();
        expect(items.find(item => item.path === live)).toMatchObject({ categoryId: 'temporary', verdict: 'keep', reason: { code: 'in_use' } });
        expect(items.find(item => item.path === recycledPid)).toMatchObject({ verdict: 'safe', collectable: true });
        expect(items.find(item => item.path === toolScratch)).toMatchObject({ categoryId: 'temporary', verdict: 'keep' });
    });

    it.each(['filesystem-copy-destination', 'runtime-build'])('keeps retained %s output after its creator exits until its lifecycle owner closes it', async purpose => {
        const f = await fixture();
        const retained = createHappierTempDir({ root: f.tempRoot, purpose });
        await writeFile(getHappierTempDirOwnerPath(retained), JSON.stringify({ v: 1, pid: process.pid,
            processInstanceFingerprint: 'different-instance', purpose }));
        const catalog = createStorageCategoryCatalog({ ...f });
        expect((await catalog.discover()).find(item => item.path === retained)).toMatchObject({ verdict: 'keep' });
        const closed = createStorageCategoryCatalog({ ...f, readTemporaryFacts: async () => [{ path: retained, state: 'closed' }] });
        expect((await closed.discover()).find(item => item.path === retained)).toMatchObject({ verdict: 'safe' });
    });

    it('does not turn malformed or missing modern ownership markers into pre-boot legacy cleanup proof', async () => {
        const f = await fixture();
        const malformed = createHappierTempDir({ root: f.tempRoot, purpose: 'malformed' });
        await writeFile(getHappierTempDirOwnerPath(malformed), '{invalid');
        await utimes(getHappierTempDirOwnerPath(malformed), 1, 1); await utimes(malformed, 1, 1);
        const missing = createHappierTempDir({ root: f.tempRoot, purpose: 'missing' });
        await rm(getHappierTempDirOwnerPath(missing)); await utimes(missing, 1, 1);
        const items = await createStorageCategoryCatalog({ ...f, bootedAt: 5_000 }).discover();
        for (const path of [malformed, missing]) expect(items.find(item => item.path === path)).toMatchObject({ verdict: 'check', collectable: false });
    });

    it('reads current registered SCM facts from a tracked subdirectory without conferring unknown upload ownership', async () => {
        const f = await fixture();
        const repo = await f.add(join(f.root, 'repo'));
        const cwd = await f.add(join(repo, 'src'));
        const worktree = join(repo, '.dev', 'worktree', 'registered');
        for (const args of [['init'], ['add', 'bytes'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'],
            ['worktree', 'add', '-b', 'registered', worktree]]) {
            const result = await runScmCommand({ bin: 'git', cwd: repo, args });
            expect(result.success, result.stderr).toBe(true);
        }
        await writeFile(join(worktree, 'bytes'), 'tracked change');
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
        const snapshot = await runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({ request: { cwd }, workingDirectory: cwd,
            registry, onNonRepository: () => ({ success: false }), runWithBackend: ({ context, selection }) =>
                selection.backend.statusSnapshot({ context, request: { cwd } }) });
        expect(snapshot.success, JSON.stringify(snapshot)).toBe(true);
        expect(snapshot.snapshot?.repo.worktrees.some(entry => entry.path === worktree)).toBe(true);
        const catalog = createStorageCategoryCatalog({ ...f, readTrackedSessions: () => [{ sessionId: 'git-session', cwd, running: false }],
            readWorktrees: () => readStorageWorktrees({ cwds: [cwd], registry }) });
        const uploads = await f.add(join(worktree, '.happier', 'uploads', 'messages', 'historic-session'));
        const items = await catalog.discover();
        expect(items.find(item => item.path === repo)).toMatchObject({ categoryId: 'worktrees', kind: 'worktree', verdict: 'keep',
            reason: { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable' } } });
        expect(items.find(item => item.path === worktree)).toMatchObject({ categoryId: 'worktrees',
            kind: 'worktree', verdict: 'keep', reason: { code: 'changed_files' }, collectable: true });
        expect(items.find(item => item.path === uploads)).toMatchObject({ categoryId: 'sessionFolders', verdict: 'check', collectable: false });
        const logs = join(f.happyHomeDir, 'logs'); await mkdir(logs);
        const log = join(logs, 'retained.log'); await writeFile(log, 'retained');
        const unregistered = createStorageCategoryCatalog({ ...f, scmRegistry: registry,
            readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) });
        const retained = await unregistered.discover();
        vi.mocked(filesystem.lstat).mockClear();
        const supplemented = await unregistered.discover([repo], retained);
        expect(supplemented.find(item => item.path === repo)).toMatchObject({ categoryId: 'worktrees', verdict: 'keep' });
        expect(supplemented.find(item => item.path === log)).toEqual(retained.find(item => item.path === log));
        // Inspecting a page's newly encountered repository cannot rediscover
        // unrelated categories from the retained service snapshot.
        expect(vi.mocked(filesystem.lstat).mock.calls.filter(([path]) => String(path) === log)).toHaveLength(0);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('retains unreadable roots as Check while discovering accessible categories', async () => {
        const f = await fixture();
        const cache = await f.add(join(f.happyHomeDir, 'cache'));
        const logRoot = join(f.happyHomeDir, 'logs'); await mkdir(logRoot);
        const log = join(logRoot, 'old.log'); await writeFile(log, 'log'); await utimes(log, 1, 1);
        const isolation = await f.add(join(f.activeServerDir, 'isolation', 'agent', 'execution_run', 'unreadable'));
        const resumeState = await f.add(join(isolation, 'xdg', 'state'));
        await chmod(cache, 0);
        await chmod(resumeState, 0);
        try {
            const items = await createStorageCategoryCatalog({ ...f, now: () => 100 * 24 * 60 * 60 * 1000,
                readIsolationFacts: () => [{ path: isolation, state: 'finished' }] }).discover();
            expect(items.find(item => item.path === cache)).toMatchObject({ categoryId: 'caches', verdict: 'check', collectable: false });
            expect(items.find(item => item.path === isolation)).toMatchObject({ categoryId: 'agentHomes', verdict: 'check', collectable: false });
            expect(items.find(item => item.path === log)).toMatchObject({ categoryId: 'logs', verdict: 'safe' });
        } finally { await Promise.all([chmod(cache, 0o700), chmod(resumeState, 0o700)]); }
    });

    it('does not suggest an otherwise unused tool cache containing a known live temporary owner', async () => {
        const f = await fixture();
        const tool = await f.add(join(f.happyHomeDir, 'tools', 'fixture-tool'));
        createHappierTempDir({ root: join(tool, '.tmp'), purpose: 'installing' });
        const items = await createStorageCategoryCatalog({ ...f, readInUsePaths: () => ({ reliable: true, paths: [] }) }).discover();
        expect(items.find(item => item.path === tool)).toMatchObject({ categoryId: 'caches', verdict: 'keep', reason: { code: 'contains' } });
    });

    it('accounts for current-user temporary root and sibling markers as forbidden data remainder without blocking eligible children', async () => {
        const f = await fixture();
        const child = createHappierTempDir({ root: f.tempRoot, purpose: 'finished' });
        await writeFile(getHappierTempDirOwnerPath(child), JSON.stringify({ v: 1, pid: process.pid,
            processInstanceFingerprint: 'different-instance', purpose: 'finished' }));
        const items = await createStorageCategoryCatalog({ ...f }).discover();
        expect(items.find(item => item.path === getHappierTempRoot(f.tempRoot))).toMatchObject({ categoryId: 'ownData', verdict: 'forbidden', collectable: false });
        expect(items.find(item => item.path === child)).toMatchObject({ categoryId: 'temporary', verdict: 'safe' });
        expect(items.some(item => item.path === f.tempRoot)).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || !process.getuid)('does not claim a pre-boot legacy directory belongs to the current OS user from its prefix', async () => {
        const f = await fixture();
        const foreign = await f.add(join(f.tempRoot, 'happier-foreign'));
        await utimes(join(foreign, 'bytes'), 1, 1); await utimes(foreign, 1, 1);
        const readStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat;
        // OS metadata is the boundary: unprivileged native Mac tests cannot chown a fixture to another user.
        const statBoundary = vi.spyOn(filesystem, 'lstat').mockImplementation(async (...args) => {
            const stat = await readStat(...args);
            if (args[0] === foreign) stat.uid = typeof stat.uid === 'bigint' ? stat.uid + 1n : stat.uid + 1;
            return stat;
        });
        try {
            const items = await createStorageCategoryCatalog({ ...f, bootedAt: 5_000 }).discover();
            expect(items.find(item => item.path === foreign)).toMatchObject({ verdict: 'check', collectable: false });
        } finally { statBoundary.mockImplementation(readStat); }
    });

    it('distinguishes unavailable project facts from a ready empty inventory in the same discovery snapshot', async () => {
        const f = await fixture();
        const cache = await f.add(join(f.happyHomeDir, 'cache', 'known'));
        const unavailable = createStorageCategoryCatalog({ ...f, readProjects: () => ({ status: 'unavailable' }) });
        const ready = createStorageCategoryCatalog({ ...f, readProjects: async () => ({ status: 'ready', projects: [] }) });
        const unknownSnapshot = await unavailable.discoverSnapshot();
        const emptySnapshot = await ready.discoverSnapshot();
        expect(unknownSnapshot.incompleteCategoryIds).toEqual(['worktrees', 'sessionFolders']);
        expect(emptySnapshot.incompleteCategoryIds).toEqual([]);
        expect(unknownSnapshot.items.find(item => item.path === cache)).toMatchObject({ verdict: 'safe' });
        expect(emptySnapshot.items).toEqual(unknownSnapshot.items);
        expect(await unavailable.discover()).toEqual(unknownSnapshot.items);
        const repo = await f.add(join(f.root, 'known-repo'));
        const worktree = await f.add(join(repo, '.dev', 'worktree', 'known'));
        const partial = await createStorageCategoryCatalog({ ...f,
            readProjects: () => ({ status: 'unavailable', projects: [{ repositoryRoot: repo }] }) }).discoverSnapshot();
        expect(partial.incompleteCategoryIds).toEqual(['worktrees', 'sessionFolders']);
        expect(partial.items.find(item => item.path === worktree)).toMatchObject({ categoryId: 'worktrees', verdict: 'check' });
    });
});
