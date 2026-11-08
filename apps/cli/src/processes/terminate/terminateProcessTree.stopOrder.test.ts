import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { windowsSystemToolCommand } from '@happier-dev/cli-common/process';
import { readProcessCensus } from '@/processes/census/processCensus';
import { descendantsOf, indexCensus, membersOfCgroup, membersOfJob, membersOfPgid, protectedSet } from '@/processes/tree/processTree';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { createProcessTreeTerminator, type ProcessTreeTerminationInput, type ProcessTreeTerminationResult } from './terminateProcessTree';

const { createProcessTreeOwner } = createRequire(import.meta.url)(resolveCliRuntimeAssetPath('scripts', 'process_tree.cjs')) as {
    createProcessTreeOwner(adapters: Record<string, unknown>): {
        terminateTargets(input: ProcessTreeTerminationInput): Promise<ProcessTreeTerminationResult>;
    };
};

describe('owned shell Stop', () => {
    it.each([false, true])('never advances past a terminated wait (detached=%s)', async detached => {
        const windows = process.platform === 'win32';
        const child = spawn(windows ? windowsSystemToolCommand('cmd.exe') : '/bin/sh', windows
            ? ['/d', '/s', '/c', 'echo READY & ping -n 121 127.0.0.1 >nul & echo UNEXPECTED_END']
            : ['-c', 'echo READY; sleep 120; echo UNEXPECTED_END'], {
            detached, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const closed = once(child, 'close');
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        const terminate = createProcessTreeTerminator();
        try {
            if (!output.includes('READY')) await once(child.stdout, 'data');
            // Readiness includes the actual sleeping descendant, not just the
            // shell's preceding write, which can arrive before sleep is spawned.
            let ready = false;
            while (!ready) {
                const census = await readProcessCensus({ freshness: 'fresh', pids: [child.pid!], includeDescendants: true, fields: [] });
                ready = census.status === 'ok' && descendantsOf(indexCensus(census.rows), [child.pid!]).length > 0;
            }
            const started = Date.now();
            const result = await terminate({ targets: [{ pid: child.pid! }] });
            await closed;
            expect(output).not.toContain('UNEXPECTED_END');
            expect(result.status, JSON.stringify(result)).toBe('complete');
            if (!windows) expect(child.signalCode).not.toBeNull();
            console.info(`shell Stop platform=${process.platform} detached=${detached} elapsedMs=${Date.now() - started}`);
        } finally {
            await terminate({ targets: [{ pid: child.pid! }], firstSignal: 'SIGKILL' });
        }
    });

    it('checks each live member immediately before termination without freezing the tree', async () => {
        const rows = new Map([[process.pid, { pid: process.pid, ppid: 1, state: 'running', start: { startTimeMs: 1 }, principal: { kind: 'uid', value: '1000' } }],
            ...Array.from({ length: 20 }, (_, i) => [4100 + i, { pid: 4100 + i, ppid: i ? 4100 : 1, state: 'running', start: { startTimeMs: i + 2 }, principal: { kind: 'uid', value: '1000' } }] as const)]);
        let reads = 0;
        let lastReadPids: readonly number[] | undefined;
        const terminated: number[] = [];
        const owner = createProcessTreeOwner({ platform: 'linux', indexCensus, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid,
            // The OS census and signal syscalls are the genuine system boundary.
            readProcessCensus: async (input: { pids?: readonly number[] }) => {
                reads++; lastReadPids = input.pids;
                return { status: 'ok', rows: [...rows.values()], capturedAtMs: Date.now() };
            },
            kill(pid: number, signal: NodeJS.Signals) {
                expect(signal).toBe('SIGTERM');
                expect(lastReadPids).toEqual([pid]);
                terminated.push(pid); rows.delete(pid);
            },
        });
        const result = await owner.terminateTargets({ targets: [{ pid: 4101 }, { pid: 4100 }], waitForExit: false });
        expect(result.status).toBe('complete');
        expect(result.outcomes).toHaveLength(20);
        // Admission, round discovery and settlement are constant; native checks
        // scale with signalled members, never with unrelated host processes.
        expect(reads).toBe(terminated.length + 3);
        expect(terminated[0]).toBe(4100);
    });

    it('reports a denied member without suspending the other admitted members', async () => {
        const rows = new Map([process.pid, 4100, 4101].map(pid => [pid, { pid, ppid: pid === 4101 ? 4100 : 1,
            state: 'running', start: { startTimeMs: pid }, principal: { kind: 'uid', value: '1000' } }]));
        const signals: Array<[number, NodeJS.Signals]> = [];
        const owner = createProcessTreeOwner({ platform: 'linux', indexCensus, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid,
            readProcessCensus: async () => ({ status: 'ok', rows: [...rows.values()], capturedAtMs: Date.now() }),
            kill(pid: number, signal: NodeJS.Signals) {
                signals.push([pid, signal]);
                if (pid === 4101) throw Object.assign(new Error('denied'), { code: 'EPERM' });
                rows.delete(pid);
            },
        });
        const result = await owner.terminateTargets({ targets: [{ pid: 4100 }], graceMs: 1 });
        expect(result.status).toBe('incomplete');
        expect(signals).toEqual([[4100, 'SIGTERM'], [4101, 'SIGTERM']]);
        expect(result.outcomes).toContainEqual({ pid: 4101, outcome: 'refused', reason: 'permission_denied' });
    });

    it('leaves Windows descendants to taskkill /T and the existing force round after a headless gentle failure', async () => {
        const rows = new Map([process.pid, 4100, 4101].map(pid => [pid, { pid, ppid: pid === 4101 ? 4100 : 1,
            state: 'running', start: { startTimeMs: pid }, principal: { kind: 'sid', value: 'fixture-owner' } }]));
        const requests: Array<{ pid: number; tree: boolean; force: boolean }> = [];
        const owner = createProcessTreeOwner({ platform: 'win32', indexCensus, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid,
            readProcessCensus: async () => ({ status: 'ok', rows: [...rows.values()], capturedAtMs: Date.now() }),
            taskkillWindowsProcessTree: async (input: { pid: number; tree: boolean; force: boolean }) => {
                requests.push(input);
                if (!input.force) throw Object.assign(new Error('headless'), { code: 1 });
                rows.delete(4100); rows.delete(4101);
            },
        });
        const result = await owner.terminateTargets({ targets: [{ pid: 4100 }], graceMs: 1 });
        expect(result.status).toBe('complete');
        expect(requests.map(({ pid, tree, force }) => ({ pid, tree, force }))).toEqual([
            { pid: 4100, tree: true, force: false }, { pid: 4100, tree: true, force: true },
        ]);
    });

    it('never grants Windows /T authority over a refused descendant', async () => {
        const rows = new Map([process.pid, 4100, 4101].map(pid => [pid, { pid, ppid: pid === 4101 ? 4100 : 1,
            state: 'running', start: { startTimeMs: pid }, principal: { kind: 'sid', value: pid === 4101 ? 'other-owner' : 'fixture-owner' } }]));
        const requests: Array<{ pid: number; tree: boolean }> = [];
        const owner = createProcessTreeOwner({ platform: 'win32', indexCensus, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid,
            readProcessCensus: async () => ({ status: 'ok', rows: [...rows.values()], capturedAtMs: Date.now() }),
            taskkillWindowsProcessTree: async (input: { pid: number; tree: boolean }) => { requests.push(input); rows.delete(input.pid); },
        });
        const result = await owner.terminateTargets({ targets: [{ pid: 4100 }], waitForExit: false });
        expect(result.status).toBe('incomplete');
        expect(requests.map(({ pid, tree }) => ({ pid, tree }))).toEqual([{ pid: 4100, tree: false }]);
        expect(rows.has(4101)).toBe(true);
    });
});
