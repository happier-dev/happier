import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readdir, readlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileWithDeadline, isPidPresent, probeProcessGroupLiveness } from '@happier-dev/cli-common/process';
import { createProcessCensusReader, type ProcessCensusRow } from '@/processes/census/processCensus';
import { readLinuxProcFile } from '@/processes/census/linuxProcfs';
import { spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { descendantsOf, indexCensus, membersOfCgroup, membersOfJob, membersOfPgid, protectedSet } from '@/processes/tree/processTree';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { createProcessTreeTerminator, type ProcessTreeTerminationInput } from './terminateProcessTree';

const moduleOwner = createRequire(import.meta.url)(resolveCliRuntimeAssetPath('scripts', 'process_tree.cjs')) as {
    createProcessTreeOwner(adapters: Record<string, unknown>): {
        terminateProcessTree(root: { pid: number; start?: ProcessCensusRow['start']; exitCode?: number }, options?: { graceMs: number; ownedProcessGroup?: boolean }): Promise<unknown>;
        captureTargets(root: { pid: number; start?: ProcessCensusRow['start'] }): Promise<{ status: string; capturedTargets: readonly { pid: number; start: ProcessCensusRow['start'] }[] }>;
        terminateTargets(input: ProcessTreeTerminationInput): Promise<{ status: string; outcomes: readonly { pid: number; outcome: string }[]; capturedTargets?: readonly { pid: number; start: ProcessCensusRow['start'] }[] }>;
    };
};

function fixture(rows: Map<number, { parent: number; start: number; uid?: number; group?: number; cgroup?: string; disappearBeforeStatus?: boolean; unreadableStatus?: boolean }>, systemBoundary: Record<string, unknown> = {}, censusUnavailable: boolean | (() => boolean) = false, observeRead?: (path: string) => void) {
    let readUnavailable = false;
    const reader = createProcessCensusReader({ platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir(path) {
            if (readUnavailable) throw Object.assign(new Error('procfs unavailable'), { code: 'EIO' });
            if (path.endsWith('/task')) return [path.split('/')[2]!];
            return [...rows.keys()].map(String);
        },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            if (path === `/proc/${process.pid}/status`) readUnavailable = typeof censusUnavailable === 'function' ? censusUnavailable() : censusUnavailable;
            if (readUnavailable) throw Object.assign(new Error('procfs unavailable'), { code: 'EIO' });
            observeRead?.(path);
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/children')) return [...rows].filter(([, child]) => child.parent === pid).map(([child]) => child).join(' ');
            if (path.endsWith('/status')) {
                if (row.disappearBeforeStatus) { rows.delete(pid); throw Object.assign(new Error('exited during procfs read'), { code: 'ENOENT' }); }
                if (row.unreadableStatus) throw Object.assign(new Error('principal unreadable'), { code: 'EACCES' });
                return `Uid:\t${row.uid ?? 1000}\n`;
            }
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            if (path.endsWith('/stat')) {
                const fields = ['S', String(row.parent), String(row.group ?? pid), '1', '0', '0', ...Array(7).fill('0'), ...Array(6).fill('0'), String(row.start), '0', '0'];
                return `${pid} (fixture) ${fields.join(' ')}`;
            }
            return '';
        },
    } });
    return moduleOwner.createProcessTreeOwner({ readProcessCensus: reader, indexCensus, descendantsOf,
        membersOfCgroup, membersOfJob, membersOfPgid, protectedSet, execFileWithDeadline, isPidPresent, probeProcessGroupLiveness, ...systemBoundary });
}

afterEach(() => vi.restoreAllMocks());

describe('process-tree generation safety', () => {
    it('observes isolated-UID descendants without granting signal authority over them', async () => {
        const signals: number[] = [];
        const owner = fixture(new Map([[process.pid, { parent: 1, start: 10 }],
            [4100, { parent: process.pid, start: 20 }], [4101, { parent: 4100, start: 30, uid: 997 }]]), {
            kill(pid: number) { signals.push(pid); return true; }, wait: async () => {},
        });
        expect(await owner.captureTargets({ pid: 4100 })).toMatchObject({ status: 'ok', capturedTargets: [
            { pid: 4100 }, { pid: 4101 },
        ] });
        expect(await owner.terminateTargets({ targets: [{ pid: 4101, start: { startTimeMs: 300 } }], tree: false }))
            .toMatchObject({ status: 'incomplete', outcomes: [{ pid: 4101, outcome: 'refused', reason: 'principal_unavailable' }] });
        expect(signals).toEqual([]);
    });
    it('captures exact subtree identities without reading command, environment, containment or metrics fields', async () => {
        const rows = new Map([[process.pid, { parent: 1, start: 10 }],
            [4100, { parent: 1, start: 20 }], [4101, { parent: 4100, start: 30 }],
            [5100, { parent: 1, start: 40 }]]);
        const reads: string[] = [];
        const owner = fixture(rows, {}, false, path => { reads.push(path); });
        expect(await owner.captureTargets({ pid: 4100 })).toMatchObject({ status: 'ok', capturedTargets: [
            { pid: 4100, start: { startTimeMs: 200, native: 'linux-proc:20' } },
            { pid: 4101, start: { startTimeMs: 300, native: 'linux-proc:30' } },
        ] });
        expect(reads.filter(path => !path.endsWith('/stat') && !path.endsWith('/status') && !path.endsWith('/children'))).toEqual([]);
        expect(await owner.captureTargets({ pid: 9999 })).toMatchObject({ status: 'refused' });
        expect(await owner.captureTargets({ pid: process.pid })).toMatchObject({ status: 'refused' });
        expect(await owner.captureTargets({ pid: 4100, start: { startTimeMs: 199 } }))
            .toMatchObject({ status: 'refused', reason: 'identity_changed' });
        const unreadable = fixture(new Map([[process.pid, { parent: 1, start: 10 }],
            [4100, { parent: 1, start: 20 }], [4101, { parent: 4100, start: 30, unreadableStatus: true }]]));
        expect(await unreadable.captureTargets({ pid: 4100 }))
            .toMatchObject({ status: 'ok', capturedTargets: [{ pid: 4100 }, { pid: 4101 }] });
    });

    it.skipIf(process.platform === 'win32')('gracefully ends a real many-member tree with exact checks while unrelated peers survive', async () => {
        const source = 'process.send("ready"); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50)); setInterval(() => {}, 1000);';
        const parent = spawnInlineNodeTestProcess(`
            const { spawn } = require('node:child_process');
            const children = Array.from({length: 12}, () => spawn(process.execPath, ['-e', ${JSON.stringify(source)}], {stdio: ['ignore','ignore','ignore','ipc']}));
            Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve)))).then(() => process.send(children.map(child => child.pid)));
            process.on('SIGTERM', () => { process.send('graceful'); setTimeout(() => process.exit(0), 50); });
            setInterval(() => {}, 1000);
        `, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const peer = spawnInlineNodeTestProcess(source, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const messages: unknown[] = [];
        parent.on('message', message => messages.push(message));
        const exited = once(parent, 'exit');
        let identityReads = 0;
        let fullReads = 0;
        let commandEnvironmentReads = 0;
        const terminate = createProcessTreeTerminator({ censusDependencies: {
            linuxBoundary: { readFile: async (path, encoding) => {
                if (path.endsWith('/cmdline') || path.endsWith('/environ')) commandEnvironmentReads++;
                return readLinuxProcFile(path, encoding);
            }, readlink, readdir: async path => { if (path === '/proc') fullReads++; return readdir(path); } },
            helperExecutablePath: resolveProcessCustodySupportExecutable(process.platform),
            execFile: async (command, args, options) => {
                if (args.includes('--identity-only=true')) identityReads++; else fullReads++;
                return execFileWithDeadline(command, [...args], options);
            },
        } });
        let children: number[] = [];
        try {
            const [pids] = await once(parent, 'message');
            children = pids as number[]; // This IPC boundary is our own disposable child fixture.
            await once(peer, 'message');
            const started = Date.now();
            const result = await terminate({ targets: [{ pid: parent.pid! }] });
            await exited;
            expect(messages).toContain('graceful');
            expect(parent.signalCode).toBeNull();
            expect(result.status, JSON.stringify(result)).toBe('complete');
            expect(result.outcomes.filter(row => row.outcome === 'ended')).toHaveLength(13);
            if (process.platform === 'linux') expect(result.outcomes.every(row => (row.freedBytes ?? 0) > 0)).toBe(true);
            expect(process.kill(peer.pid!, 0)).toBe(true);
            if (process.platform === 'darwin') expect(identityReads).toBe(0);
            console.info(`termination real platform=${process.platform} members=13 fullReads=${fullReads} nativeIdentityReads=${identityReads} commandEnvironmentReads=${commandEnvironmentReads} elapsedMs=${Date.now() - started}`);
            expect(commandEnvironmentReads).toBe(0);
        } finally {
            // Only fixture processes are owned; actual termination uses the same owner.
            await terminate({ targets: [parent.pid!, ...children, peer.pid!].map(pid => ({ pid })), tree: false, firstSignal: 'SIGKILL' });
            await waitForProcessExit(peer.pid!);
        }
    });
    it('gives the graceful root its existing exit grace after the atomic signal volley', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }], [4101, { parent: root, start: 30 }]]);
        let clock = 1000;
        let rootSignalAt: number | undefined;
        const rootSignals: NodeJS.Signals[] = [];
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        const owner = fixture(rows, {
            wait: async (ms: number) => { clock += ms; },
            kill(pid: number, signal: NodeJS.Signals) {
                if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;
                if (pid !== root) { clock += 200; rows.delete(pid); }
                else { rootSignals.push(signal); rootSignalAt = clock; }
            },
        }, false, path => {
            if (path === `/proc/${root}/stat` && rootSignalAt !== undefined && clock - rootSignalAt >= 100) rows.delete(root);
        });
        const result = await owner.terminateTargets({ targets: [{ pid: root }], graceMs: 100 });
        expect(rootSignals).toEqual(['SIGTERM']);
        expect(result.status).toBe('complete');
    });
    it('refuses the entire volley when execution authority is withdrawn before admission', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }], [4101, { parent: root, start: 30 }]]);
        const signals: number[] = [];
        const result = await fixture(rows, { kill(pid: number) { signals.push(pid); rows.delete(pid); } })
            .terminateTargets({ targets: [{ pid: root }], waitForExit: false, authorizeSignal: async () => false });
        expect(signals).toEqual([]);
        expect(result).toMatchObject({ status: 'incomplete', outcomes: expect.arrayContaining([{ pid: root, outcome: 'refused', reason: 'containment_authority_changed' }]) });
    });
    it.each([
        { members: 1, waitForExit: false }, { members: 20, waitForExit: false },
        { members: 1, waitForExit: true }, { members: 20, waitForExit: true },
    ])('revalidates $members owned members without reading a 3000-process host inventory (waitForExit=$waitForExit)', async ({ members, waitForExit }) => {
        const root = 4100;
        const unrelatedPids = Array.from({ length: 3001 }, (_, offset) => 5000 + offset)
            .filter(pid => pid !== process.pid).slice(0, 3000);
        const rows = new Map([[process.pid, { parent: 1, start: 10 }],
            ...Array.from({ length: members }, (_, offset) => [root + offset, { parent: offset ? root : 1, start: 20 + offset }] as const),
            ...unrelatedPids.map((pid, offset) => [pid, { parent: 1, start: 100 + offset }] as const)]);
        const statReads: string[] = [];
        const enrichmentReads: string[] = [];
        const signals: number[] = [];
        const owner = fixture(rows, { kill(pid: number, signal: NodeJS.Signals) {
            if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;
            signals.push(pid); rows.delete(pid);
        } }, false,
            path => {
                if (path.endsWith('/stat')) statReads.push(path);
                else if (!path.endsWith('/status') && !path.endsWith('/auxv') && !path.endsWith('/children')) enrichmentReads.push(path);
            });
        const result = await owner.terminateTargets({ targets: [{ pid: root }], waitForExit });
        expect(result.status).toBe('complete');
        expect(signals).toHaveLength(members);
        expect(signals[0]).toBe(root);
        console.info(`termination census work members=${members} unrelated=3000 waitForExit=${waitForExit} statReads=${statReads.length}`);
        // Cost is owned generations plus their protection ancestry, not host size.
        expect(statReads.length).toBeLessThan(members === 1 ? 12 : 200);
        const unrelated = new Set(unrelatedPids);
        expect(statReads.some(path => unrelated.has(Number(path.split('/')[2])))).toBe(false);
        expect(enrichmentReads).toHaveLength(0);
    });
    it('retains command observations when the lifecycle owner authorizes fresh snapshots', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signals: number[] = [];
        const owner = fixture(rows, { kill(pid: number) { signals.push(pid); rows.delete(pid); } });
        const result = await owner.terminateTargets({ targets: [{ pid: root }],
            authorizeSnapshot: snapshot => snapshot.rows.every(row => Array.isArray(row.argv)),
        });
        expect(result.status).toBe('complete');
        expect(signals).toEqual([root]);
    });
    it.each([undefined, 'SIGTERM'] as const)('applies kill policy while retaining explicit firstSignal=%s precedence', async firstSignal => {
        const root = 4100;
        const child = 4101;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }], [child, { parent: root, start: 30 }]]);
        const signals: Array<[number, NodeJS.Signals]> = [];
        const owner = fixture(rows, { kill(pid: number, signal: NodeJS.Signals) {
            if (signal === 'SIGSTOP' || signal === 'SIGCONT') return;
            signals.push([pid, signal]); rows.delete(pid);
        } });
        const result = await owner.terminateTargets({ targets: [{ pid: root }], policy: 'kill', rootKind: 'dev_server',
            ...(firstSignal ? { firstSignal } : {}), graceMs: 1 });
        expect(result.status).toBe('complete');
        expect(signals).toEqual([[root, firstSignal ?? 'SIGKILL'], [child, firstSignal ?? 'SIGKILL']]);
    });
    it('confirms an ended generation when procfs loses its principal during exit and the final census proves absence', async () => {
        const root = 4100;
        const rows = new Map<number, { parent: number; start: number; disappearBeforeStatus?: boolean }>(
            [[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signals: number[] = [];
        const result = await fixture(rows, { kill(pid: number) {
            signals.push(pid); rows.set(pid, { parent: 1, start: 20, disappearBeforeStatus: true });
        } }).terminateTargets({ targets: [{ pid: root }], graceMs: 1 });
        expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: root, outcome: 'ended' }] });
        expect(signals).toEqual([root]);
    });
    it('does not reconcile a still-present generation whose principal becomes unreadable', async () => {
        const root = 4100;
        const rows = new Map<number, { parent: number; start: number; unreadableStatus?: boolean }>(
            [[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signals: number[] = [];
        const result = await fixture(rows, { kill(pid: number) {
            signals.push(pid); rows.set(pid, { parent: 1, start: 20, unreadableStatus: true });
        } }).terminateTargets({ targets: [{ pid: root }], graceMs: 1 });
        expect(result).toMatchObject({ status: 'incomplete', outcomes: [{ pid: root, outcome: 'refused' }] });
        expect(signals).toEqual([root]);
    });
    it('does not flatten unavailable final verification into successful root cleanup', async () => {
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [4100, { parent: 1, start: 20 }]]);
        let postSignalReads = 0;
        const owner = fixture(rows, { kill(pid: number) { rows.delete(pid); } }, () => !rows.has(4100) && ++postSignalReads >= 2);
        await expect(owner.terminateProcessTree({ pid: 4100 }, { graceMs: 1 }))
            .rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete', result: { status: 'unavailable' } });
    });
    it('uses the existing native Job budget without a competing gentle phase for verified kill custody', async () => {
        const name = 'Local\\happier-svc09-known-generation';
        let live = true;
        const signals: string[] = [];
        const terminate = createProcessTreeTerminator({ platform: 'win32',
            censusDependencies: { platform: 'win32', helperExecutablePath: '/native-helper',
                execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 1,
                    rows: [process.pid, ...(live ? [4100] : [])].map(pid => ({ pid, ppid: 1,
                        start: { startTimeMs: pid }, principal: { kind: 'sid', value: 'S-1-5-21-1000' }, name: 'fixture', memory: null, cpuTimeUs: null,
                        ...(pid === 4100 ? { jobs: [name] } : {}) })), partial: [],
                    jobObservations: [{ name, ...(live ? { state: 'live', pids: [4100] } : { state: 'absent' }) }],
                }), stderr: '' }),
            },
            terminateWindowsJob: async input => { signals.push(`job:${input.timeoutMs}`); live = false; return 'absent'; },
            terminateWindowsTree: async () => { signals.push('pid'); },
        });
        expect(await terminate({ targets: [], containment: { kind: 'windows_job', name }, policy: 'kill' }))
            .toMatchObject({ status: 'complete', outcomes: [{ pid: 4100, outcome: 'ended' }] });
        expect(signals).toEqual(['job:5000']);
    });
    it('captures pre-exit descendant identities while signaling only the graceful root', async () => {
        const root = 4100;
        const child = 4101;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }], [child, { parent: root, start: 30 }]]);
        const signaled: number[] = [];
        const owner = fixture(rows, { kill(pid: number) { signaled.push(pid); rows.delete(pid); } });
        const capture = await owner.captureTargets({ pid: root });
        expect(capture.capturedTargets).toHaveLength(2);
        expect(signaled).toEqual([]);
        const requested = await owner.terminateTargets({ targets: [{ pid: root }], tree: false,
            captureDescendants: true, waitForExit: false });
        expect(signaled).toEqual([root]);
        expect(requested.capturedTargets).toContainEqual({ pid: child, start: { startTimeMs: 300, native: 'linux-proc:30' } });
        rows.set(child, { parent: 1, start: 30 });
        await owner.terminateTargets({ targets: requested.capturedTargets!, tree: false, graceMs: 1 });
        expect(signaled).toEqual([root, child]);
    });
    it('does not claim an empty fence when its native census is unavailable', async () => {
        const result = await fixture(new Map(), {}, true).terminateTargets({ targets: [], containment: { kind: 'linux_unit', prefix: '/owned-scope' } });
        expect(result).toMatchObject({ status: 'unavailable', outcomes: [] });
    });
    it('can end independently owned fence members after their numeric launcher disappeared', async () => {
        const member = 4101;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [member, { parent: 1, start: 20, cgroup: '/owned-scope' }]]);
        const signaled: number[] = [];
        const result = await fixture(rows, { kill(pid: number) { signaled.push(pid); rows.delete(pid); } })
            .terminateTargets({ targets: [], containment: { kind: 'linux_unit', prefix: '/owned-scope' }, graceMs: 1 });
        expect(result.outcomes).toEqual([{ pid: member, outcome: 'ended' }]);
        expect(signaled).toEqual([member]);
    });
    it('escalates a Windows headless process when taskkill cannot deliver a graceful stop', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const requests: boolean[] = [];
        const result = await fixture(rows, { platform: 'win32',
            taskkillWindowsProcessTree: async (input: { pid: number; force: boolean }) => {
                requests.push(input.force);
                if (!input.force) throw Object.assign(new Error('headless process requires force'), { code: 1 });
                rows.delete(input.pid);
            },
        }).terminateTargets({ targets: [{ pid: root }], graceMs: 1 });
        expect(result.outcomes).toEqual([{ pid: root, outcome: 'ended' }]);
        expect(requests).toEqual([false, true]);
    });
    it('does not certify owned group cleanup from a departed launcher without survivor identities', async () => {
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [4101, { parent: 1, start: 20, group: 4100 }]]);
        const signaled: number[] = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { if (signal !== 0) signaled.push(pid); return true; });
        await expect(fixture(rows).terminateProcessTree({ pid: 4100, exitCode: 0 }, { graceMs: 1, ownedProcessGroup: true }))
            .rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
        expect(signaled).toEqual([]);
    });
    it('leaves graceful runner waiting and escalation to its existing lifecycle budget', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signaled: Array<[number, unknown]> = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { signaled.push([pid, signal]); return true; });
        const result = await fixture(rows).terminateTargets({ targets: [{ pid: root }], waitForExit: false, graceMs: 1 });
        expect(signaled).toEqual([[root, 'SIGTERM']]);
        expect(result.outcomes).toEqual([{ pid: root, outcome: 'survived' }]);
    });
    it('does not sweep children or signal a missing root', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [4101, { parent: root, start: 20 }]]);
        const signaled: number[] = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
            signaled.push(pid); return true;
        });
        await fixture(rows).terminateProcessTree({ pid: root }, { graceMs: 1 });
        expect(signaled).toEqual([]);
    });

    it('never escalates against a generation recycled during grace', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: 1, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signaled: Array<[number, unknown]> = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0) return true;
            signaled.push([pid, signal]);
            if (pid === root && signal === 'SIGTERM') rows.set(root, { parent: 1, start: 30 });
            return true;
        });
        await fixture(rows).terminateProcessTree({ pid: root }, { graceMs: 1 }).catch(() => undefined);
        expect(signaled).toContainEqual([root, 'SIGTERM']);
        expect(signaled.filter(([, signal]) => signal === 'SIGKILL')).toEqual([]);
    });

    it('refuses protected ancestors before any signal', async () => {
        const root = 4100;
        const rows = new Map([[process.pid, { parent: root, start: 10 }], [root, { parent: 1, start: 20 }]]);
        const signaled: number[] = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { if (signal !== 0) signaled.push(pid); return true; });
        await fixture(rows).terminateProcessTree({ pid: root }, { graceMs: 1 }).catch(() => undefined);
        expect(signaled).toEqual([]);
    });
});
