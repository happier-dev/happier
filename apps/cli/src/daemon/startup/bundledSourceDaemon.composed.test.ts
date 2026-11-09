import childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';

it('serves a throwaway source daemon without requesting workspace builds during startup', async () => {
    const launched = performance.now();
    const initialCpu = process.cpuUsage();
    console.log(JSON.stringify({ sourceDaemonBoot: { phase: 'launch', pid: process.pid } }));
    const { startInstalledDaemonFixture } = await import('../testkit/installedDaemon.testkit');
    const { readDaemonState } = await import('@/persistence');
    const imported = performance.now();
    console.log(JSON.stringify({ sourceDaemonBoot: { phase: 'fixtureImported', elapsedMs: Math.round(imported - launched) } }));
    const spawnProcess = childProcess.spawn;
    let buildRequests = 0;
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
        if (args[1]?.some(value => String(value).endsWith('/syncSharedDepsForDev.mjs'))) {
            buildRequests++;
            throw new Error('A source daemon must not build workspace dist before opening its listener');
        }
        return spawnProcess(...args);
    });
    syncBuiltinESMExports();
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('NODE_ENV', 'development');
    let fixture: Awaited<ReturnType<typeof startInstalledDaemonFixture>> | undefined;
    try {
        fixture = await startInstalledDaemonFixture();
        const state = await readDaemonState();
        expect(state?.pid).toBe(process.pid);
        expect(state?.httpPort).toBeGreaterThan(0);
        expect(buildRequests).toBe(0);
        const lines = (await readFile(state!.daemonLogPath!, 'utf8')).split('\n');
        const marker = (phrase: string) => lines.find(line => line.includes(phrase))?.match(/^\[([\d:.]+)\]/)?.[1] ?? null;
        console.log(JSON.stringify({ sourceDaemonBoot: {
            importMs: Math.round(imported - launched), readyMs: Math.round(performance.now() - launched),
            buildRequests, cpu: process.cpuUsage(initialCpu),
            startDaemon: marker('Starting daemon process'), listener: marker('[CONTROL SERVER] Started on port'),
        } }));
    } finally {
        try { await fixture?.stop(); }
        finally {
            spawn.mockRestore();
            syncBuiltinESMExports();
            vi.unstubAllEnvs();
        }
    }
// This is a count contract. The outer test operation owns cancellation; cold
// source compilation and disposable Home preparation are measured, not gated.
}, 0);
