import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createStorageService } from '@/storage/storageService';
import { projectStorageProcessUse } from './projectStorageProcessUse';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';
import { readLinuxProcFile } from '@/processes/census/linuxProcfs';
import type { ProcessOwnerRef } from '@/daemon/processes/ownership/types';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { createScmBackendRegistry } from '@/scm/registry';
import { readStorageWorktrees } from './readStorageWorktrees';
import { createStorageWorktreeOperations } from '@/storage/worktrees/storageWorktreeOperations';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { StorageWorktree } from '@/storage/categories/types';

// Child fixture processes run the actual test host executable; the custody fixture swaps execPath.
const testHostExecutable = process.execPath;
const execute = promisify(childProcess.execFile);
let scratch: string;
let disposeNative: (() => Promise<void>) | undefined;

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('Storage in-use facts from the process ownership census', () => {
    beforeAll(async () => {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-process-use-')));
        disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../../..') });
    });
    afterAll(async () => {
        await disposeNative?.();
        if (scratch) await rm(scratch, { recursive: true, force: true });
    });

    it('protects ordinary cwd descendants while releasing only unused child worktrees', async () => {
        const home = join(scratch, 'home');
        const server = join(home, 'servers', 'fixture');
        const ordinary = join(home, 'cache', 'ordinary');
        const repo = join(home, 'repository');
        const held = join(repo, '.dev', 'worktree', 'unused');
        const unregistered = join(repo, '.dev', 'worktree', 'ordinary');
        await mkdir(ordinary, { recursive: true });
        await mkdir(repo, { recursive: true });
        await mkdir(server, { recursive: true });
        await writeFile(join(ordinary, 'bytes'), Buffer.alloc(8192, 1));
        await execute('git', ['init', '-b', 'main', repo]);
        await writeFile(join(repo, 'bytes'), 'tracked input');
        await execute('git', ['-C', repo, 'add', 'bytes']);
        await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
        await execute('git', ['-C', repo, 'worktree', 'add', '-b', 'unused', held]);
        const remote = join(scratch, 'remote.git');
        await execute('git', ['init', '--bare', '-b', 'main', remote]);
        await execute('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
        await execute('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
        await execute('git', ['-C', held, 'push', '-u', 'origin', 'unused']);
        await execute('git', ['-C', repo, 'remote', 'set-head', 'origin', '-a']);
        await mkdir(unregistered);
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }) })]);
        let ambientOwner: ProcessOwnerRef = { kind: 'happier' };
        let workspacePath: string | undefined;
        let rootPid: number | undefined;
        let enumerations = 0;
        const censusPids = new Set([process.pid]);
        let latestWorktrees: readonly StorageWorktree[] = [];
        const ownership = createProcessOwnershipRuntime({ daemonScopeKey: 'fixture-scope', listRoots: snapshot => {
            const row = snapshot.rows.find(row => row.pid === (rootPid ?? ambient.pid));
            return row ? [{ owner: ambientOwner, pid: row.pid, start: row.start, live: true,
                ownerCreatedAtMs: 0, workspacePath }] : [];
        },
            // Observe only this fixture's real processes at the OS boundary.
            // Unrelated shared-host processes may have unreadable custody fields.
            censusDependencies: process.platform === 'linux' ? { linuxBoundary: {
                readFile: readLinuxProcFile, readlink,
                readdir: async path => {
                    const entries = await readdir(path);
                    if (path !== '/proc') return entries;
                    enumerations++;
                    return entries.filter(entry => censusPids.has(Number(entry)));
                },
            } } : { execFile: (file, args, options) => execFileWithDeadline(file,
                args[0] === 'process-census' ? [...args, `--pids=${[...censusPids].join(',')}`] : args, options) },
        });
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ machineId: 'machine', custodianAccountId: 'owner', homeDir: scratch, scmRegistry: registry,
            activityLog: await createActivityLog({ activeServerDir: server, resourceSummary }),
            catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'absent-temp'),
                readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: repo }] }),
                readWorktrees: async () => latestWorktrees = await readStorageWorktrees({ cwds: [repo], happyHomeDir: home, registry }),
                worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: home, registry }),
                readInUsePaths: async () => projectStorageProcessUse(await ownership.readOwners({ freshness: 'shared' })) },
            resourcesPolicy: await createStoragePolicyFixture(),
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        let holder: ReturnType<typeof childProcess.spawn> | undefined;
        const ambient = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
            { cwd: home, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await once(ambient, 'message');
        censusPids.add(ambient.pid!);
        try {
            const ambientOwnership = await ownership.readOwners({ freshness: 'fresh' });
            expect(ambientOwnership.status === 'ok' && ambientOwnership.rows.find(row => row.pid === ambient.pid)?.level).toBe('proven');
            expect(projectStorageProcessUse(ambientOwnership).reliable).toBe(true);
            const ordinaryItem = (await service.categoryList('caches')).items.find(item => item.path === ordinary)!;
            // Ordinary folders inside a live cwd remain in use; only a known
            // unused child worktree may be released from the parent's cwd.
            expect(ordinaryItem.verdict, JSON.stringify(ordinaryItem.reason)).toBe('keep');
            const worktrees = (await service.categoryList('worktrees')).items;
            expect(worktrees.find(item => item.path === unregistered)).toMatchObject({ verdict: 'keep' });
            const item = worktrees.find(item => item.path === held)!;
            expect(item.verdict, JSON.stringify({ reason: item.reason,
                worktree: latestWorktrees.find(worktree => worktree.path === held) })).toBe('safe');
            // Parent cwd exemptions apply to the SCM-proven child, including
            // terminal and Session workspaces, never its ordinary sibling.
            ambientOwner = { kind: 'terminal', terminalId: 'plain-terminal' };
            workspacePath = home;
            expect((await service.itemsCheck([{ itemId: item.itemId, path: held }], { actor })).items[0])
                .toMatchObject({ verdict: 'safe' });
            expect((await service.itemsCheck([{ itemId: ordinaryItem.itemId, path: ordinary }], { actor })).items[0])
                .toMatchObject({ verdict: 'keep' });
            workspacePath = undefined;
            const collected = await service.pileSet({ machineId: 'machine', add: [{ itemId: item.itemId, path: held }] }, { actor });
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
                { cwd: held, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            censusPids.add(holder.pid!);
            const owners = await ownership.readOwners({ freshness: 'fresh' });
            expect(owners.status === 'ok' && owners.rows.find(row => row.pid === holder!.pid)?.level).toBe('not_happier');

            const beforeReview = enumerations;
            const review = await service.itemsCheck(collected.items, { actor });
            expect(review.items[0]).toMatchObject({ verdict: 'keep' });
            expect(review.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: held } });
            if (process.platform === 'linux') expect(enumerations - beforeReview).toBe(1);

            holder.kill('SIGKILL');
            await once(holder, 'exit');
            censusPids.delete(holder.pid!);
            holder = undefined;
            const released = await service.itemsCheck(collected.items, { actor });
            expect(released.items[0]).toMatchObject({ verdict: 'safe' });

            ambientOwner = { kind: 'session', sessionId: 'live-session' };
            workspacePath = home;
            const workspaceHeld = await service.itemsCheck(collected.items, { actor });
            expect(workspaceHeld.items[0]).toMatchObject({ verdict: 'safe' });
            expect((await service.itemsCheck([{ itemId: ordinaryItem.itemId, path: ordinary }], { actor })).items[0])
                .toMatchObject({ verdict: 'keep' });
            workspacePath = undefined;
            expect((await service.itemsCheck(collected.items, { actor })).items[0]).toMatchObject({ verdict: 'safe' });
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
                { cwd: held, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            censusPids.add(holder.pid!);
            rootPid = holder.pid;
            const sessionCwdHeld = await service.itemsCheck(collected.items, { actor });
            expect(sessionCwdHeld.items[0]).toMatchObject({ verdict: 'keep' });
            expect(sessionCwdHeld.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: held, sessionId: 'live-session' } });
            holder.kill('SIGKILL'); await once(holder, 'exit'); censusPids.delete(holder.pid!); holder = undefined;
            // An explicit input file remains a real dependency even when the
            // process's workspace is only the parent of this candidate.
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);", join(held, 'bytes')],
                { cwd: home, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            censusPids.add(holder.pid!);
            rootPid = holder.pid;
            workspacePath = home;
            const argumentHeld = await service.itemsCheck(collected.items, { actor });
            expect(argumentHeld.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: join(held, 'bytes'), sessionId: 'live-session' } });
            holder.kill('SIGKILL'); await once(holder, 'exit'); censusPids.delete(holder.pid!); holder = undefined;
            rootPid = ambient.pid;
            workspacePath = home;
            const unusedChild = await service.itemsCheck(collected.items, { actor });
            expect(unusedChild.items[0]).toMatchObject({ verdict: 'safe' });
            const removed = await service.deleteNow({ machineId: 'machine', items: unusedChild.items.map(item => ({
                ref: item.ref, expect: item.expect,
            })) }, { actor });
            expect(removed.outcomes).toEqual([{ itemId: item.itemId, status: 'deleted' }]);
            expect(await readFile(join(ordinary, 'bytes'))).toEqual(Buffer.alloc(8192, 1));
        } finally {
            holder?.kill('SIGKILL');
            ambient.kill('SIGKILL');
            await once(ambient, 'exit');
            service.dispose(); resourceSummary.stop(); await sampler.stop();
        }
    });
});
