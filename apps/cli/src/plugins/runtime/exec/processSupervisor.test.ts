import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    readSupervisedPluginProcessIdForHost,
    spawnSupervisedPluginProcess,
} from './processSupervisor';

describe('spawnSupervisedPluginProcess', () => {
    it('terminates the owned POSIX process group after its launcher root exits', async () => {
        if (process.platform === 'win32') return;
        const directory = mkdtempSync(join(tmpdir(), 'happier-supervised-tree-'));
        const childPidPath = join(directory, 'child.pid');
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', [
                'const { spawn } = require("node:child_process");',
                'const fs = require("node:fs");',
                'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
                `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            ].join('\n')],
            env: {},
            spawnOptions: { detached: true },
        });
        let childPid: number | null = null;
        try {
            await supervised.handle.wait();
            await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true));
            childPid = Number.parseInt(readFileSync(childPidPath, 'utf8'), 10);
            expect(Number.isSafeInteger(childPid)).toBe(true);
            expect(() => process.kill(childPid!, 0)).not.toThrow();

            await expect(supervised.dispose('hostShutdown')).resolves.toBeUndefined();
            await vi.waitFor(() => {
                expect(() => process.kill(childPid!, 0)).toThrow();
            }, { timeout: 3_000 });
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
            expect(await supervised.handle.wait()).toMatchObject({
                termination: {
                    observed: { kind: 'exit', exitCode: 0 },
                    requestedBy: { kind: 'none' },
                },
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
