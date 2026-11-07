import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
    readSupervisedPluginProcessIdForHost,
    spawnSupervisedPluginProcess,
} from './processSupervisor';
import { createEndOwnerRemainder } from '@/daemon/processes/endOwnerRemainder';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { readProcessCensus } from '@/processes/census/processCensus';
import { resolveProcessOwnership } from '@/daemon/processes/ownership/resolveProcessOwnership';
import type { HappierProcessRoot } from '@/daemon/processes/ownership/types';
import { logger } from '@/ui/logger';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';

describe('spawnSupervisedPluginProcess', () => {
    it.each([0, 17])('drains finite stdout and stderr delivered after exit %s before returning the result', async exitCode => {
        const stdout = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
        const stderr = Buffer.from([0x80, 0x42, 0x00, 0x0a]);
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', `process.stdout.write(Buffer.from([0,255,65,10])); process.stderr.write(Buffer.from([128,66,0,10])); process.exitCode = ${exitCode};`],
            env: {},
            // Only the OS termination boundary is substituted; the actual finite
            // child has already exited when cleanup joins it.
            terminateProcessTree: async () => {},
        });
        const held: (() => void)[] = [];
        let released = false;
        const spies = [supervised.child.stdout, supervised.child.stderr, supervised.child].map(emitter => {
            const emit = emitter.emit.bind(emitter);
            return vi.spyOn(emitter, 'emit').mockImplementation((event, ...args) => {
                // Model legal OS ordering: pipe bytes and close follow root exit.
                if (!released && (event === 'data' || event === 'end' || event === 'close')) {
                    held.push(() => { emit(event, ...args); });
                    return true;
                }
                return emit(event, ...args);
            });
        });
        supervised.child.once('exit', () => setImmediate(() => {
            released = true;
            for (const deliver of held) deliver();
        }));
        try {
            await supervised.handle.closeStdin();
            const termination = await supervised.handle.waitForExit();
            expect(termination).toEqual({ observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } });
            const result = await supervised.handle.wait();
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode });
            expect(Buffer.from(result.stdout)).toEqual(stdout);
            expect(Buffer.from(result.stderr)).toEqual(stderr);
        } finally {
            await supervised.dispose();
            for (const spy of spies) spy.mockRestore();
        }
    });

    it('closes stdin after a finite child has already exited without rejecting its successful result', async () => {
        expect.assertions(5);
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath, args: ['-e', 'process.stdout.write("done", () => process.exit(0))'], env: {},
        });
        try {
            const result = await supervised.handle.wait();
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(result.stdout).toString()).toBe('done');
            expect(supervised.child.stdin.destroyed).toBe(true);
            await expect(supervised.handle.closeStdin()).resolves.toBeUndefined();
            await expect(supervised.handle.closeStdin()).resolves.toBeUndefined();
        } finally { await supervised.dispose(); }
    });

    it('bounds an unanswered graceful protocol stop inside the existing termination grace and removes the child', async () => {
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: ['-e', `
            process.on('SIGTERM', () => {});
            process.stdin.on('data', () => process.stdout.write('shutdown received\\n'));
            process.stdout.write('ready\\n');
        `], env: {} });
        try {
            await once(supervised.child.stdout, 'data');
            let aborted = false;
            await supervised.dispose('caller', { async beforeTerminate(signal) {
                await supervised.handle.write(Buffer.from('shutdown\n'));
                await new Promise<void>(resolve => signal.addEventListener('abort', () => {
                    aborted = true; resolve();
                }, { once: true }));
            } });
            const result = await supervised.handle.wait();
            expect(Buffer.from(result.stdout).toString()).toContain('shutdown received');
            expect(aborted).toBe(true);
            expect(await waitForProcessExit(supervised.child.pid!)).toBe(true);
        } finally { await supervised.dispose(); }
    });

    it.for([
        { descendantDisposition: undefined, detached: true },
        { descendantDisposition: undefined, detached: false },
        { descendantDisposition: 'preserve-on-success', detached: true },
        { descendantDisposition: 'preserve-on-success', detached: false },
    ] as const)('settles a daemonizing launcher with descendant disposition $descendantDisposition and detached $detached', async ({ descendantDisposition, detached }, { task }) => {
        await withTempDir('happier-native-descendants-', async directory => {
            const fixture = createDaemonizingProcessFixture(directory);
            const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: fixture.args,
                env: {}, spawnOptions: { detached, windowsHide: true }, descendantDisposition });
            try {
                const pid = await fixture.ready({ timeoutMs: task.timeout });
                await fixture.release();
                expect(await supervised.handle.waitForExit()).toEqual({ observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } });
                await supervised.dispose();
                await supervised.waitForSettlement();
                expect(await waitForProcessExit(pid, { timeoutMs: 200 })).toBe(descendantDisposition === undefined);
            } finally {
                supervised.child.kill('SIGKILL');
                await supervised.dispose().catch(() => undefined);
                await fixture.cleanup();
            }
        });
    });

    it.for(['abort', 'dispose', 'timeout', 'failed-exit'] as const)('does not hand off descendants after %s', async (kind, { task }) => {
        await withTempDir('happier-native-cancel-', async directory => {
            const fixture = createDaemonizingProcessFixture(directory);
            const controller = new AbortController();
            const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: fixture.args,
                env: {}, signals: [controller.signal], spawnOptions: { detached: true, windowsHide: true },
                descendantDisposition: 'preserve-on-success' });
            try {
                const pid = await fixture.ready({ timeoutMs: task.timeout });
                if (kind === 'abort') controller.abort();
                else if (kind === 'failed-exit') await fixture.release(1);
                else await supervised.requestTermination(kind === 'timeout' ? { kind: 'timeout' } : { kind: 'dispose', reason: 'caller' });
                const result = await supervised.handle.wait();
                expect(result.termination.requestedBy.kind).toBe(kind === 'failed-exit' ? 'none' : kind);
                await supervised.dispose();
                expect(await waitForProcessExit(pid)).toBe(true);
            } finally {
                supervised.child.kill('SIGKILL');
                await supervised.dispose().catch(() => undefined);
                await fixture.cleanup();
            }
        });
    });

    it('records OS launch timing without logging command arguments or environment', async () => {
        const fileLog = vi.spyOn(logger, 'infoFile');
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
            args: ['-e', 'process.stdout.write("private-output")'], env: { PRIVATE_TOKEN: 'private-secret' } });
        try {
            await supervised.handle.wait();
            const launches = fileLog.mock.calls.filter(([name]) => name === '[PluginExec] Process launched');
            expect(launches).toEqual([[expect.any(String), expect.objectContaining({
                phase: 'launcher_spawn', pid: supervised.child.pid, durationMs: expect.any(Number),
            })]]);
            expect(JSON.stringify(launches)).not.toContain('private');
            expect(JSON.stringify(launches)).not.toContain(process.execPath);
        } finally {
            await supervised.dispose();
            fileLog.mockRestore();
        }
    });

    it('awaits native cleanup beyond five seconds without rejecting the next turn preparation', async () => {
        let releaseNativeCleanup!: () => void;
        const nativeCleanup = new Promise<void>(resolve => { releaseNativeCleanup = resolve; });
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'], env: {},
            // The OS cleanup adapter is the boundary; custody and joining stay real.
            terminateProcessTree: async child => {
                await nativeCleanup;
                const exited = once(child, 'exit');
                child.kill('SIGKILL');
                await exited;
            },
        });
        let outcome: 'pending' | 'settled' | 'rejected' = 'pending';
        let disposal: Promise<void> | undefined;
        try {
            vi.useFakeTimers();
            disposal = supervised.dispose();
            void disposal.then(() => { outcome = 'settled'; }, () => { outcome = 'rejected'; });
            await vi.advanceTimersByTimeAsync(5_001);
            expect(outcome).toBe('pending');
            vi.useRealTimers();
            releaseNativeCleanup();
            await disposal;
            expect(outcome).toBe('settled');
            await expect(supervised.waitForSettlement()).resolves.toEqual({ status: 'ended' });
        } finally {
            vi.useRealTimers();
            releaseNativeCleanup();
            await disposal?.catch(() => undefined);
            await supervised.handle.wait();
        }
    });
    it('settles a generic departed spawner and observes captured survivors without killing shared-owner peers', async () => {
        if (process.platform === 'win32') return;
        const directory = mkdtempSync(join(tmpdir(), 'happier-generic-root-exit-'));
        const childPidPath = join(directory, 'child.pid');
        const owner = { kind: 'happier' } as const;
        const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        if (initial.status !== 'ok') throw new Error('Native census unavailable');
        const self = initial.rows.find(row => row.pid === process.pid)!;
        const roots: HappierProcessRoot[] = [{ owner, pid: self.pid, start: self.start, live: true, ownerCreatedAtMs: 0 }];
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => roots });
        let observed = false;
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
            retainEndedRoots: ended => { roots.push(...ended); }, firstPass: () => { observed = true; } });
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath, env: {},
            args: ['-e', `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1000));fs.writeFileSync(${JSON.stringify(childPidPath)},String(c.pid));process.stdout.write('ready');setInterval(()=>{},1000);`],
            rootExitObservation: { owner, ownerRemainder: remainder }, spawnOptions: { detached: true } });
        let childPid: number | undefined;
        try {
            await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true));
            childPid = Number(readFileSync(childPidPath, 'utf8'));
            // The existing root-first stop is an actual pre-exit capture opportunity.
            // SIGTERM exits this launcher while its independent child survives.
            const exited = once(supervised.child, 'exit');
            supervised.child.kill('SIGTERM'); await exited;
            await supervised.handle.wait();
            await supervised.dispose();
            await supervised.waitForSettlement();
            expect(observed).toBe(true);
            expect(() => process.kill(childPid!, 0)).not.toThrow();
            expect(roots.some(root => root.pid === process.pid && root.live)).toBe(true);
            const current = await runtime.readOwners({ freshness: 'fresh' });
            if (current.status !== 'ok') throw new Error('Native census unavailable');
            const rows = resolveProcessOwnership({ snapshot: current.snapshot, roots, daemonScopeKey: '123456789abc', daemonPrincipal: self.principal });
            expect(rows.find(row => row.pid === childPid)?.level).toBe('left_behind');
        } finally {
            supervised.child.kill('SIGKILL');
            if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* owned probe only */ } }
            rmSync(directory, { recursive: true, force: true });
        }
    }, 15_000);
    it('preserves an asynchronous spawn errno in the existing failed diagnostic', async () => {
        const fileLog = vi.spyOn(logger, 'infoFile');
        const supervised = spawnSupervisedPluginProcess({ command: 'happier-nonexistent-spawn-fixture', args: [], env: {} });
        try {
            await expect(supervised.handle.wait()).resolves.toMatchObject({
                termination: { observed: { kind: 'failed', diagnostic: {
                    code: 'PLUGIN_EXEC_PROCESS_FAILED', details: { errorCode: 'ENOENT', spawnFailure: { reason: 'other', errno: 'ENOENT' } },
                } } },
            });
            await supervised.waitForSettlement();
            expect(fileLog.mock.calls.filter(([name]) => name === '[PluginExec] Process launched')).toHaveLength(0);
        } finally {
            fileLog.mockRestore();
        }
    });
    it('lets an admitted activation clean up before terminating its owned descendants', async () => {
        if (process.platform === 'win32') return;
        const directory = mkdtempSync(join(tmpdir(), 'happier-native-activation-stop-'));
        const childPidPath = join(directory, 'child.pid');
        const cleanupPath = join(directory, 'cleanup');
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', [
                'const { spawn } = require("node:child_process");',
                'const fs = require("node:fs");',
                'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
                'process.on("SIGTERM", () => setTimeout(() => {',
                `fs.writeFileSync(${JSON.stringify(cleanupPath)}, child.exitCode === null && child.signalCode === null ? "present" : "terminated");`,
                'process.exit(0);',
                '}, 50));',
                `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
                'setInterval(() => {}, 1000);',
            ].join('\n')],
            env: {},
            spawnOptions: { detached: true },
            waitForGracefulRootExitBeforeTreeStop: true,
        });
        let childPid: number | undefined;
        try {
            await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true));
            childPid = Number.parseInt(readFileSync(childPidPath, 'utf8'), 10);
            await supervised.dispose('hostShutdown');
            expect(readFileSync(cleanupPath, 'utf8')).toBe('present');
            await supervised.waitForSettlement();
            expect(() => process.kill(childPid!, 0)).toThrow();
        } finally {
            supervised.child.kill('SIGKILL');
            if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already settled */ } }
            await supervised.dispose('hostShutdown');
            rmSync(directory, { recursive: true, force: true });
        }
    }, 10_000);

    it.each([undefined, 'happier', 'session', 'run', 'service'] as const)('settles only a shared-owner departed launcher as unobserved without sweeping survivors (owner=%s)', async (ownerKind) => {
        if (process.platform === 'win32') return;
        const directory = mkdtempSync(join(tmpdir(), 'happier-supervised-tree-'));
        const childPidPath = join(directory, 'child.pid');
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', [
                'const { spawn } = require("node:child_process");',
                'const fs = require("node:fs");',
                'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
                'child.unref();',
                `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            ].join('\n')],
            env: ownerKind ? { HAPPIER_PROCESS_OWNER: `v1.123456789abc.${ownerKind}.${ownerKind === 'happier' ? 'daemon' : 'fixture'}` } : {},
            spawnOptions: { detached: true },
        });
        let childPid: number | null = null;
        try {
            await supervised.handle.wait();
            await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true));
            childPid = Number.parseInt(readFileSync(childPidPath, 'utf8'), 10);
            expect(Number.isSafeInteger(childPid)).toBe(true);
            expect(() => process.kill(childPid!, 0)).not.toThrow();

            if (ownerKind === 'run' || ownerKind === 'service') {
                await expect(supervised.dispose('hostShutdown')).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
            } else {
                await supervised.dispose('hostShutdown');
                await expect(supervised.waitForSettlement()).resolves.toEqual({ status: 'ended', remainder: 'unobserved' });
            }
            expect(() => process.kill(childPid!, 0)).not.toThrow();
        } finally {
            if (childPid) {
                try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
            }
            rmSync(directory, { recursive: true, force: true });
        }
    }, 10_000);

    it('keeps process identity host-private without narrowing semantic handle operations', async () => {
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: {},
        });

        expect(supervised.handle).not.toHaveProperty('pid');
        expect(readSupervisedPluginProcessIdForHost(supervised.handle))
            .toBe(supervised.child.pid);
        expect(supervised.handle).toEqual(expect.objectContaining({
            write: expect.any(Function),
            closeStdin: expect.any(Function),
            wait: expect.any(Function),
            onOutput: expect.any(Function),
            dispose: expect.any(Function),
        }));
        await expect(supervised.handle.wait()).resolves.toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
    });

    it('bounds retained output when a plugin omits author-selected byte limits', async () => {
        const retainedOutputSamples: Array<{
            family: 'plugin-process-stdout' | 'plugin-process-stderr';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
            sequence?: number;
        }> = [];
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 7))'],
            env: {},
            recordRuntimeLimitMeasurement: (sample) => {
                if (
                    sample.family === 'plugin-process-stdout'
                    || sample.family === 'plugin-process-stderr'
                ) retainedOutputSamples.push(sample);
            },
        });

        const result = await supervised.handle.wait();

        expect(result.termination).toEqual({
            observed: { kind: 'exit', exitCode: 0 },
            requestedBy: { kind: 'none' },
        });
        expect(result.stdout.byteLength).toBeLessThan(9 * 1024 * 1024);
        expect(result.stdoutTruncated).toBe(true);
        expect(retainedOutputSamples.at(-1)).toMatchObject({
            family: 'plugin-process-stdout',
            queuedBytes: 9 * 1024 * 1024,
            backpressured: true,
        });
        expect(retainedOutputSamples.at(-1)?.queuedItems).toBeGreaterThan(0);
    });

    it('returns one sticky failed terminal fact when spawning fails after the handle exists', async () => {
        const supervised = spawnSupervisedPluginProcess({
            command: `/definitely-missing-happier-executable-${Date.now()}`,
            args: [],
            env: {},
        });

        const first = await supervised.handle.wait();
        const second = await supervised.handle.wait();

        expect(second).toBe(first);
        expect(first).toMatchObject({
            termination: {
                observed: {
                    kind: 'failed',
                    diagnostic: { code: 'PLUGIN_EXEC_PROCESS_FAILED', severity: 'error' },
                },
                requestedBy: { kind: 'none' },
            },
            stdoutTruncated: false,
            stderrTruncated: false,
        });
    });

    it('preserves binary output, sequence order, and explicit truncation', async () => {
        const chunks: Array<{ sequence: number; stream: string; data: number[] }> = [];
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', [
                'process.stdout.write(Buffer.from([0, 255, 1, 2]));',
                'process.stderr.write(Buffer.from([3, 0, 254]));',
            ].join('')],
            env: {},
            maxStdoutBytes: 3,
            maxStderrBytes: 2,
        });
        supervised.handle.onOutput((chunk) => {
            chunks.push({ sequence: chunk.sequence, stream: chunk.stream, data: [...chunk.data] });
        });

        const result = await supervised.handle.wait();

        expect(result.termination).toEqual({
            observed: { kind: 'exit', exitCode: 0 },
            requestedBy: { kind: 'none' },
        });
        expect([...result.stdout]).toEqual([0, 255, 1]);
        expect([...result.stderr]).toEqual([3, 0]);
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stderrTruncated).toBe(true);
        expect(chunks.map((chunk) => chunk.sequence)).toEqual(
            chunks.map((_, index) => index + 1),
        );
        expect(chunks.flatMap((chunk) => chunk.data)).toEqual([0, 255, 1, 2, 3, 0, 254]);
    });

    it('does not relabel an observed exit when disposal happens before close reconciliation', async () => {
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: {},
        });

        await new Promise<void>((resolve) => supervised.child.once('exit', () => resolve()));
        await supervised.dispose('caller');

        expect(await supervised.handle.wait()).toMatchObject({
            termination: {
                observed: { kind: 'exit', exitCode: 0 },
                requestedBy: { kind: 'none' },
            },
        });
    });

    it('bounds disposal after exit observation even when close reconciliation never arrives', async () => {
        const terminateProcessTree = vi.fn(async () => undefined);
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            env: {},
            terminationJoinTimeoutMs: 20,
            terminateProcessTree,
        });
        const dispose = (() => {
            supervised.child.emit('exit', 0, null);
            return supervised.dispose('hostShutdown');
        })();

        try {
            const outcome = await Promise.race([
                dispose.then(() => 'disposed' as const),
                new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
            ]);

            expect(outcome).toBe('disposed');
            expect(await supervised.handle.waitForExit()).toMatchObject({
                observed: { kind: 'exit', exitCode: 0 },
                requestedBy: { kind: 'none' },
            });
            expect(terminateProcessTree).toHaveBeenCalledOnce();
        } finally {
            supervised.child.kill('SIGKILL');
            await dispose;
        }
    });

    it('freezes the first accepted host termination request and isolates output listeners', async () => {
        const received: number[][] = [];
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            env: {},
        });
        supervised.handle.onOutput(() => {
            throw new Error('listener failure');
        });
        supervised.handle.onOutput((chunk) => {
            received.push([...chunk.data]);
        });
        await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

        const abort = supervised.requestTermination({ kind: 'abort' });
        const timeout = supervised.requestTermination({ kind: 'timeout' });
        await Promise.all([abort, timeout]);

        expect(await supervised.handle.wait()).toMatchObject({
            termination: {
                requestedBy: { kind: 'abort' },
            },
        });
    });

    it('waits for native termination settlement without an implicit join deadline', async () => {
        let finishTermination!: () => void;
        const nativeTermination = new Promise<void>((resolve) => { finishTermination = resolve; });
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: {},
            // Only the OS termination boundary is delayed; supervision stays real.
            terminateProcessTree: () => nativeTermination,
        });
        const terminal = await supervised.handle.wait();
        const uncertainty = vi.fn();
        supervised.onOutcomeUncertain(uncertainty);
        vi.useFakeTimers();
        let outcome = 'pending';
        const disposal = supervised.dispose('caller');
        const observedDisposal = disposal.then(
            () => { outcome = 'disposed'; },
            () => { outcome = 'failed'; },
        );
        try {
            await vi.advanceTimersByTimeAsync(6_000);
            expect(outcome).toBe('pending');
            expect(uncertainty).not.toHaveBeenCalled();
            finishTermination();
            await expect(disposal).resolves.toBeUndefined();
            await expect(supervised.waitForSettlement()).resolves.toEqual({ status: 'ended' });
            expect(await supervised.handle.wait()).toBe(terminal);
        } finally {
            finishTermination();
            await observedDisposal;
            vi.useRealTimers();
        }
    });

    it('reports incomplete termination without manufacturing a terminal process fact', async () => {
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            env: {},
            terminationJoinTimeoutMs: 20,
            terminateProcessTree: async () => undefined,
        });
        try {
            await expect(supervised.dispose('hostShutdown')).rejects.toMatchObject({
                code: 'plugin_exec_termination_incomplete',
            });
            await expect(Promise.race([
                supervised.handle.wait().then(() => 'terminal' as const),
                new Promise<'pending'>((resolve) => {
                    setTimeout(() => resolve('pending'), 30);
                }),
            ])).resolves.toBe('pending');
            expect(readSupervisedPluginProcessIdForHost(supervised.handle))
                .toBe(supervised.child.pid);
        } finally {
            supervised.child.kill('SIGKILL');
            await supervised.handle.wait();
            await expect(supervised.dispose('hostShutdown')).resolves.toBeUndefined();
        }
    });
});
