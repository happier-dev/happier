import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { DiskScanStateV1Schema, MachineStorageCategoryListResultV1Schema, MachineStorageScanGetResultV1Schema, MachineStoragePileResultV1Schema, PileApplyResultV1Schema,
    PileReviewV1Schema, TrashRestoreResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from '@/rpc/handlers/storage';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { createScmBackendRegistry } from '@/scm/registry';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { createStorageWorktreeOperations } from '@/storage/worktrees/storageWorktreeOperations';
import { createProjectWorkspaceRetirement } from '@/workspaces/projectWorkspaceRetirement';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';

const execute = promisify(execFile);
afterEach(() => { withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });

it.each(['catalog', 'scan'] as const)('retires reviewed main/common checkouts and registration-gone orphans through real Storage Actions (%s) and restores exact Git and Project state', async source => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-action-retirement-')));
    const home = join(scratch, 'home'); const repo = join(scratch, 'repository'); const dependent = join(scratch, 'dependent');
    const orphan = source === 'scan' ? join(scratch, 'orphan') : join(repo, '.dev', 'worktree', 'orphan');
    const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd })).stdout.trim();
    await mkdir(home); await mkdir(repo);
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Storage fixture');
    await git(repo, 'config', 'user.email', 'storage@example.invalid');
    await writeFile(join(repo, '.gitignore'), '.dev/\n'); await writeFile(join(repo, 'file'), 'original');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'initial');
    await git(repo, 'worktree', 'add', '-b', 'dependent', dependent);
    await git(repo, 'worktree', 'add', '-b', 'orphan', orphan);
    const backReference = await readFile(join(orphan, '.git'));
    await rm(join(repo, '.git', 'worktrees', 'orphan'), { recursive: true });
    await writeFile(join(orphan, 'file'), 'orphan bytes');
    await writeFile(join(repo, 'file'), 'stash bytes'); await git(repo, 'stash', 'push', '-m', 'saved work');
    await writeFile(join(repo, 'file'), 'pending bytes'); await writeFile(join(repo, 'untracked'), 'untracked bytes');
    await git(repo, 'branch', 'unpushed');
    const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: `storage-retirement-token-${source}`, encryption: null }));
    if (!credentials) throw new Error('Fixture credentials did not pass the real local ingress');
    const ref = (id: string, rootPath: string) => WorkspaceRefV1WriteSchema.parse({ id, serverId: 'home', machineId: 'machine', rootPath,
        createdAtMs: 1, label: id, projectKey: 'project' });
    const mainRef = ref('main-ref', repo); const dependentRef = ref('dependent-ref', dependent);
    const otherRef = ref('other-ref', join(scratch, 'other'));
    const rows: unknown[] = [mainRef, dependentRef, otherRef].map(value => createPlainProjectAccountRefRow(value, 2));
    let conflictNextRetirement = false;
    mockProjectAccountRowsHttpBoundary(rows, { beforeMutation: request => {
        if (!conflictNextRetirement || !request.mutations.some(mutation => mutation.key.kind === 'workspace-ref' && mutation.content === null)) return;
        conflictNextRetirement = false;
        const key = { kind: 'relationship-graph' as const };
        const index = rows.findIndex(row => row && typeof row === 'object' && Reflect.get(Reflect.get(row, 'key'), 'kind') === key.kind);
        const revision = index < 0 ? 0 : Number(Reflect.get(rows[index] as object, 'revision')) + 1;
        const graph = { key, revision, content: { t: 'plain', v: { key, value: { relationships: [] } } } };
        if (index < 0) rows.push(graph); else rows[index] = graph;
    } });
    // The installed Account owns the Project census consumed by Storage discovery.
    await readProjectAccountRows({ credentials, serverId: 'home', publication: 'installed' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
        qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
        hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
    const disposeNative = await createProcessCustodyFixture();
    const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
        historyStore: await createMinuteHistoryStore({ directory: join(home, 'history') }) });
    const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    let censusAvailable = source === 'catalog';
    const readProjects = () => ({ status: 'ready' as const, projects: (censusAvailable ? getActiveProjectAccountRowsSnapshot()?.workspaceRefs ?? [] : [])
        .map(value => ({ repositoryRoot: value.rootPath, projectId: value.projectKey })) });
    const references = createProjectWorkspaceRetirement({ authority: { credentials, serverId: 'home' }, ...identity,
        assertCurrentAuthority: async () => {} });
    const routes = createDaemonStorageRoutes({ target: () => identity, readOwnSessionIds: () => new Set(), deps: async () => ({
        ...identity, homeDir: home, scmRegistry: registry, activityLog: await createActivityLog({ activeServerDir: home, resourceSummary: summary }),
        resourcesPolicy: await createStoragePolicyFixture({ wholeDiskEnabled: true }),
        catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(scratch, 'absent-temp'),
            readProjects, readInUsePaths: () => ({ reliable: true, paths: [] }),
            readWorktrees: () => readStorageWorktrees({ cwds: readProjects().projects.map(value => value.repositoryRoot), registry }),
            worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: home, registry }), checkoutReferences: references },
        readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
    }) });
    registerDaemonStorageRpcHandlers(registrar, routes);
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true };
    // Only Machine RPC and Account HTTP are network boundaries; every registered handler and lifecycle owner is real.
    const transport = await import('@/session/transport/rpc/machineRpc');
    vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async input => {
        const handler = handlers.get(input.method);
        if (!handler) throw new Error(`Missing real Storage registration: ${input.method}`);
        return handler(input.request, context);
    });
    const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global',
        serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null });
    const invoke = async (id: Parameters<typeof executor.execute>[0], input: object) => {
        const result = await executor.execute(id, { serverId: 'home', machineId: 'machine', ...input },
            { surface: 'cli', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: id } });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.result;
    };
    const category = () => invoke('machines.storage.category.list', { categoryId: 'worktrees' })
        .then(value => MachineStorageCategoryListResultV1Schema.parse(value));
    const check = (itemId: string, path: string) => invoke('machines.storage.items.check', { refs: [{ itemId, path }] })
        .then(value => PileReviewV1Schema.parse(value));
    const move = (review: ReturnType<typeof PileReviewV1Schema.parse>) => invoke('machines.storage.trash.move', {
        items: review.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })),
    }).then(value => PileApplyResultV1Schema.parse(value));
    const undo = (batchId: string) => invoke('machines.storage.trash.restore', { batchId }).then(value => TrashRestoreResultV1Schema.parse(value));
    const scan = async (path: string) => {
        const started = await invoke('machines.storage.scan.start', { target: { folderPath: path } });
        const { scanId } = DiskScanStateV1Schema.parse(started);
        let result = MachineStorageScanGetResultV1Schema.parse(await invoke('machines.storage.scan.get', { scanId }));
        await vi.waitFor(async () => {
            result = MachineStorageScanGetResultV1Schema.parse(await invoke('machines.storage.scan.get', { scanId }));
            expect(result.state?.status).toBe('complete');
        }, { timeout: 30_000 });
        return result;
    };
    try {
        if (source === 'scan') {
            const orphanScan = await scan(orphan);
            expect(orphanScan.root?.reason).toMatchObject({ code: 'not_rebuildable', detail: { kind: 'orphan' } });
            const mainScan = await scan(repo);
            expect(mainScan.root?.flags.protection).toBe('keep');
            expect(mainScan.root?.loses).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unpushed_commits' })]));
            const adminReview = await check(join(repo, '.git', 'refs'), join(repo, '.git', 'refs'));
            expect(adminReview.items).toHaveLength(0);
            expect(adminReview.staying[0]?.reason).toMatchObject({ code: 'unsupported', detail: { cause: 'owner_requires_whole_item' } });
            await writeFile(join(orphan, '.git'), 'gitdir: /different/repository/worktrees/missing\n');
            expect((await check(orphan, orphan)).items).toHaveLength(0);
            expect(await readFile(join(orphan, 'file'), 'utf8')).toBe('orphan bytes');
            await writeFile(join(orphan, '.git'), backReference);
        }
        const orphanItem = source === 'catalog' ? (await category()).items.find(item => item.path === orphan)!
            : { itemId: orphan, path: orphan };
        const orphanReview = await check(orphanItem.itemId, orphan);
        expect(orphanReview.items[0]).toMatchObject({ verdict: 'caution', reason: { code: 'not_rebuildable', detail: { kind: 'orphan' } } });
        const orphanMoved = await move(orphanReview);
        expect(orphanMoved.outcomes).toEqual([{ itemId: orphanItem.itemId, status: 'moved' }]);
        expect((await undo(orphanMoved.batchId)).outcomes[0]?.status).toBe('restored');
        expect(await readFile(join(orphan, '.git'))).toEqual(backReference);
        expect(await readFile(join(orphan, 'file'), 'utf8')).toBe('orphan bytes');
        expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(orphan);

        const main = source === 'catalog' ? (await category()).items.find(item => item.path === repo)! : { itemId: repo, path: repo };
        const pile = MachineStoragePileResultV1Schema.parse(await invoke('machines.storage.pile.set', { add: [{ itemId: main.itemId, path: repo }] }));
        expect(pile.items).toHaveLength(1);
        const reviewed = await check(main.itemId, repo);
        expect(reviewed.items[0]?.loses).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'unpushed_commits', detail: { branch: 'unpushed', count: 1 } }),
            expect.objectContaining({ code: 'contains', detail: expect.objectContaining({ kind: 'stash', name: 'stash@{0}' }) }),
            expect.objectContaining({ code: 'changed_files', detail: { path: join(repo, 'untracked'), untracked: true } }),
            expect.objectContaining({ code: 'contains', detail: { kind: 'dependent_worktree', path: dependent } }),
        ]));
        if (source === 'catalog') {
            await writeFile(join(orphan, '.git'), 'gitdir: /different/repository/worktrees/missing\n');
            expect((await move(reviewed)).outcomes[0]).toMatchObject({ status: 'skipped', reason: { code: 'changed_since_review' } });
            await writeFile(join(orphan, '.git'), backReference);
        }
        const beforeEdit = await check(main.itemId, repo);
        await writeFile(join(repo, 'file'), 'changed again');
        expect((await move(beforeEdit)).outcomes).toEqual([{ itemId: main.itemId, status: 'skipped', reason: { code: 'changed_since_review' } }]);
        const fresh = await check(main.itemId, repo);
        const nextStash = await git(repo, 'stash', 'create', 'second saved work');
        expect(nextStash).not.toBe(await git(repo, 'rev-parse', 'refs/stash'));
        await git(repo, 'stash', 'store', '-m', 'second saved work', nextStash);
        expect((await git(repo, 'stash', 'list')).split('\n')).toHaveLength(2);
        expect((await move(fresh)).outcomes[0]).toMatchObject({ status: 'skipped', reason: { code: 'changed_since_review' } });
        const before = { status: await git(repo, 'status', '--porcelain'), refs: await git(repo, 'show-ref'), stashes: await git(repo, 'stash', 'list') };
        const beforeConflict = await check(main.itemId, repo);
        conflictNextRetirement = true;
        expect((await move(beforeConflict)).outcomes[0]).toMatchObject({ status: 'skipped', reason: { code: 'changed_since_review' } });
        expect(await readFile(join(repo, 'file'), 'utf8')).toBe('changed again');
        expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual(expect.arrayContaining([mainRef, dependentRef]));
        const moved = await move(await check(main.itemId, repo));
        expect(moved.outcomes).toEqual([{ itemId: main.itemId, status: 'moved' }]);
        await expect(lstat(repo)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([otherRef]);
        expect((await undo(moved.batchId)).outcomes[0]?.status).toBe('restored');
        expect({ status: await git(repo, 'status', '--porcelain'), refs: await git(repo, 'show-ref'), stashes: await git(repo, 'stash', 'list') }).toEqual(before);
        expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual(expect.arrayContaining([mainRef, dependentRef, otherRef]));
        expect(await git(dependent, 'branch', '--show-current')).toBe('dependent');
        expect(await readFile(join(orphan, '.git'))).toEqual(backReference);

        censusAvailable = true;
        const common = (await category()).items.find(item => item.path === join(repo, '.git'))!;
        const commonMoved = await move(await check(common.itemId, common.path));
        expect(commonMoved.outcomes[0]?.status).toBe('moved');
        expect(await readFile(join(repo, 'file'), 'utf8')).toBe('changed again');
        expect((await undo(commonMoved.batchId)).outcomes[0]?.status).toBe('restored');
        expect(await git(dependent, 'branch', '--show-current')).toBe('dependent');
    } finally { routes.dispose(); summary.stop(); await sampler.stop(); await disposeNative(); await rm(scratch, { recursive: true, force: true }); }
}, 120_000);
