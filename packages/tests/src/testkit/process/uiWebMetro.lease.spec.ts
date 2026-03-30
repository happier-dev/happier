import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let spawnStdoutText = '';

vi.mock('./spawnProcess', () => ({
    spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string }) => {
        writeFileSync(params.stdoutPath, spawnStdoutText, 'utf8');
        writeFileSync(params.stderrPath, '', 'utf8');
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = null;
        child.signalCode = null;
        return {
            child,
            stdoutPath: params.stdoutPath,
            stderrPath: params.stderrPath,
            stop: async () => {
                child.exitCode = 0;
                child.emit('exit', 0, null);
            },
        };
    },
}));

import {
    resolveUiWebMetroOwnershipLeasesDir,
    startUiWebMetro,
} from './uiWebMetro';
import { spawnDetachedTestProcess } from './testSpawn';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

beforeEach(() => {
    spawnStdoutText = 'http://127.0.0.1:19077\n';
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/status')) {
            return {
                ok: true,
                headers: { get: () => 'text/plain' },
                text: async () => 'packager-status:running',
            };
        }
        if (url.endsWith('/index.js')) {
            return {
                ok: true,
                headers: { get: () => 'application/javascript' },
                text: async () => 'globalThis.__HAPPIER_E2E__ = true;',
            };
        }
        return {
            ok: true,
            headers: { get: () => 'text/html' },
            text: async () => '<!doctype html><html><head><script src="/index.js"></script></head><body></body></html>',
        };
    }));
});

function readProcessStartTime(pid: number): string {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`Failed to inspect process start time for pid ${pid}`);
    }
    return String(res.stdout ?? '').trim();
}

describe('startUiWebMetro', () => {
    it('reclaims stale metro leases from dead owners before launching Expo web', async () => {
        if (process.platform === 'win32') return;

        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-lease-'));
        let stalePid: number | null = null;

        try {
            await mkdir(testDir, { recursive: true });

            const staleProc = spawnDetachedTestProcess(
                process.execPath,
                ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);", 'start', '--web', '--host', 'localhost', '--port', '19077'],
                { stdio: 'ignore' },
            );
            stalePid = staleProc.pid ?? null;
            expect(typeof stalePid).toBe('number');

            const leaseDir = resolveUiWebMetroOwnershipLeasesDir();
            await mkdir(leaseDir, { recursive: true });
            writeFileSync(
                join(leaseDir, `pid-${stalePid}.json`),
                JSON.stringify({
                    childPid: stalePid,
                    childStartTime: readProcessStartTime(stalePid!),
                    ownerPid: 999999002,
                    ownerStartTime: 'Tue Mar 18 09:09:09 2026',
                    createdAtMs: Date.now(),
                    metadata: { port: 19077 },
                }),
                'utf8',
            );

            const started = await startUiWebMetro({
                testDir,
                env: {},
                port: 19077,
            });

            expect(started.baseUrl).toBe('http://127.0.0.1:19077');
            await expect(async () => process.kill(stalePid!, 0)).rejects.toBeDefined();

            await started.stop();
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
