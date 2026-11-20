import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

// Child fixture processes run the actual test host executable; the custody fixture swaps execPath.
const testHostExecutable = process.execPath;
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

    it('protects contained cwd and argument holders without claiming unused descendants of a Session workspace', async () => {
        const home = join(scratch, 'home');
        const server = join(home, 'servers', 'fixture');
        const held = join(home, 'cache', 'held-by-standalone');
        await mkdir(held, { recursive: true });
        await mkdir(server, { recursive: true });
        await writeFile(join(held, 'bytes'), Buffer.alloc(8192, 1));
        // A live Session in the parent workspace must not claim an unused
        // child; removing an ancestor that contains its cwd remains protected.
        let ambientOwner: ProcessOwnerRef = { kind: 'happier' };
        let workspacePath: string | undefined;
        let rootPid: number | undefined;
        let enumerations = 0;
        const ownership = createProcessOwnershipRuntime({ daemonScopeKey: 'fixture-scope', listRoots: snapshot => {
            const row = snapshot.rows.find(row => row.pid === (rootPid ?? ambient.pid));
            return row ? [{ owner: ambientOwner, pid: row.pid, start: row.start, live: true,
                ownerCreatedAtMs: 0, workspacePath }] : [];
        },
            // Count the real Linux OS census, retaining its actual rows and field reads.
            ...(process.platform === 'linux' ? { censusDependencies: { linuxBoundary: {
                readFile: readLinuxProcFile, readlink,
                readdir: async path => { if (path === '/proc') enumerations++; return readdir(path); },
            } } } : {}),
        });
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
        const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const actor = { accountId: 'owner', kind: 'person' as const, custodianAccountId: 'owner', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
        const service = createStorageService({ machineId: 'machine', custodianAccountId: 'owner', homeDir: scratch,
            activityLog: await createActivityLog({ activeServerDir: server, resourceSummary }),
            catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'absent-temp'),
                readProjects: () => ({ status: 'ready', projects: [] }),
                readInUsePaths: async () => projectStorageProcessUse(await ownership.readOwners({ freshness: 'shared' })) },
            resourcesPolicy: await createStoragePolicyFixture(),
            readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }] });
        let holder: ReturnType<typeof childProcess.spawn> | undefined;
        const ambient = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
            { cwd: home, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await once(ambient, 'message');
        try {
            const ambientOwnership = await ownership.readOwners({ freshness: 'fresh' });
            expect(ambientOwnership.status === 'ok' && ambientOwnership.rows.find(row => row.pid === ambient.pid)?.level).toBe('proven');
            const item = (await service.categoryList('caches')).items.find(item => item.path === held)!;
            // Working in an ancestor folder alone does not hold every folder beneath it.
            expect(item.verdict, JSON.stringify(item.reason)).toBe('safe');
            // A plain terminal opened in home holds that directory, not every
            // fresh file beneath it. Its registered workspace is a cwd fact.
            ambientOwner = { kind: 'terminal', terminalId: 'plain-terminal' };
            workspacePath = home;
            expect((await service.itemsCheck([{ itemId: item.itemId, path: held }], { actor })).items[0])
                .toMatchObject({ verdict: 'safe' });
            workspacePath = undefined;
            const collected = await service.pileSet({ machineId: 'machine', add: [{ itemId: item.itemId, path: held }] }, { actor });
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
                { cwd: held, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            const owners = await ownership.readOwners({ freshness: 'fresh' });
            expect(owners.status === 'ok' && owners.rows.find(row => row.pid === holder!.pid)?.level).toBe('not_happier');

            const beforeReview = enumerations;
            const review = await service.itemsCheck(collected.items, { actor });
            expect(review.items[0]).toMatchObject({ verdict: 'keep' });
            expect(review.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: held } });
            if (process.platform === 'linux') expect(enumerations - beforeReview).toBe(1);

            holder.kill('SIGKILL');
            await once(holder, 'exit');
            holder = undefined;
            const released = await service.itemsCheck(collected.items, { actor });
            expect(released.items[0]).toMatchObject({ verdict: 'safe' });

            ambientOwner = { kind: 'session', sessionId: 'live-session' };
            workspacePath = home;
            const workspaceHeld = await service.itemsCheck(collected.items, { actor });
            expect(workspaceHeld.items[0]).toMatchObject({ verdict: 'safe' });
            workspacePath = undefined;
            expect((await service.itemsCheck(collected.items, { actor })).items[0]).toMatchObject({ verdict: 'safe' });
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);"],
                { cwd: held, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            rootPid = holder.pid;
            const sessionCwdHeld = await service.itemsCheck(collected.items, { actor });
            expect(sessionCwdHeld.items[0]).toMatchObject({ verdict: 'keep' });
            expect(sessionCwdHeld.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: held, sessionId: 'live-session' } });
            holder.kill('SIGKILL'); await once(holder, 'exit'); holder = undefined;
            // An explicit input file remains a real dependency even when the
            // process's workspace is only the parent of this candidate.
            holder = childProcess.spawn(testHostExecutable, ['-e', "process.send('ready'); setInterval(() => {}, 60_000);", join(held, 'bytes')],
                { cwd: home, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            await once(holder, 'message');
            rootPid = holder.pid;
            workspacePath = home;
            const argumentHeld = await service.itemsCheck(collected.items, { actor });
            expect(argumentHeld.items[0]?.loses).toContainEqual({ code: 'in_use', detail: { path: join(held, 'bytes'), sessionId: 'live-session' } });
            holder.kill('SIGKILL'); await once(holder, 'exit'); holder = undefined;
            rootPid = ambient.pid;
            workspacePath = home;
            const unusedChild = await service.itemsCheck(collected.items, { actor });
            expect(unusedChild.items[0]).toMatchObject({ verdict: 'safe' });
            const removed = await service.deleteNow({ machineId: 'machine', items: unusedChild.items.map(item => ({
                ref: item.ref, expect: item.expect,
            })) }, { actor });
            expect(removed.outcomes).toEqual([{ itemId: item.itemId, status: 'deleted' }]);
        } finally {
            holder?.kill('SIGKILL');
            ambient.kill('SIGKILL');
            await once(ambient, 'exit');
            service.dispose(); resourceSummary.stop(); await sampler.stop();
        }
    });
});
