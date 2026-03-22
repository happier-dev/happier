import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let stopCalls = 0;

vi.mock('../process/cliLaunchSpec', () => ({
    resolveCliTestLaunchSpec: vi.fn(async (params: { testDir: string }) => ({
        command: process.execPath,
        args: [resolve(params.testDir, 'fake-cli.mjs')],
        cwd: resolve(params.testDir),
        env: {},
    })),
}));

vi.mock('../process/spawnProcess', () => ({
    spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string }) => {
        writeFileSync(
            params.stdoutPath,
            'https://127.0.0.1:4011/terminal/connect#key=test-key\n',
            'utf8',
        );
        writeFileSync(params.stderrPath, '', 'utf8');
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            once: EventEmitter['once'];
        };
        child.exitCode = null;
        child.signalCode = null;
        return {
            child,
            stdoutPath: params.stdoutPath,
            stderrPath: params.stderrPath,
            stop: async () => {
                stopCalls += 1;
                child.exitCode = 0;
                child.emit('exit', 0, null);
            },
        };
    },
}));

import {
    resolveCliTerminalConnectOwnershipLeasesDir,
    startCliAuthLoginForTerminalConnect,
} from './cliTerminalConnect';
import { spawnDetachedTestProcess } from '../process/testSpawn';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stopCalls = 0;
});

function readProcessStartTime(pid: number): string {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`Failed to inspect process start time for pid ${pid}`);
    }
    return String(res.stdout ?? '').trim();
}

describe('startCliAuthLoginForTerminalConnect', () => {
    it('reclaims stale terminal-connect auth helpers from dead owners before starting a new one', async () => {
        if (process.platform === 'win32') return;

        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        let stalePid: number | null = null;

        try {
            await mkdir(cliHomeDir, { recursive: true });

            const staleProc = spawnDetachedTestProcess(
                process.execPath,
                ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);", 'auth', 'login', '--force', '--no-open', '--method', 'web'],
                { stdio: 'ignore' },
            );
            stalePid = staleProc.pid ?? null;
            expect(typeof stalePid).toBe('number');

            const leaseDir = resolveCliTerminalConnectOwnershipLeasesDir();
            await mkdir(leaseDir, { recursive: true });
            writeFileSync(
                join(leaseDir, `pid-${stalePid}.json`),
                JSON.stringify({
                    childPid: stalePid,
                    childStartTime: readProcessStartTime(stalePid!),
                    ownerPid: 999999001,
                    ownerStartTime: 'Tue Mar 18 09:09:09 2026',
                    createdAtMs: Date.now(),
                    metadata: { cliHomeDir },
                }),
                'utf8',
            );

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: {},
            });

            expect(started.connectUrl).toContain('/terminal/connect#key=');

            await expect(async () => process.kill(stalePid!, 0)).rejects.toBeDefined();

            await started.stop();
            expect(stopCalls).toBeGreaterThan(0);
        } finally {
            if (stalePid) {
                try {
                    process.kill(stalePid, 'SIGKILL');
                } catch {
                    // ignore
                }
            }
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
