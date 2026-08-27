import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerUrlComparableKey } from '@happier-dev/protocol';

let stopCalls = 0;
const terminalConnectUrl = 'https://127.0.0.1:4011/terminal/connect#key=test-key';
const waitForRegexInFileMock = vi.hoisted(() => vi.fn(async () => {
    const url = 'https://127.0.0.1:4011/terminal/connect#key=test-key';
    const match = [url] as RegExpMatchArray;
    match.index = 0;
    match.input = `${url}\n`;
    return match;
}));

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

vi.mock('../waitForRegexInFile', () => ({
    waitForRegexInFile: waitForRegexInFileMock,
}));

import {
    resolveCliTerminalConnectOwnershipLeasesDir,
    sanitizeCliTerminalConnectEnv,
    startCliAuthLoginForTerminalConnect,
} from './cliTerminalConnect';
import { spawnDetachedTestProcess } from '../process/testSpawn';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stopCalls = 0;
    waitForRegexInFileMock.mockClear();
});

function readProcessStartTime(pid: number): string {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`Failed to inspect process start time for pid ${pid}`);
    }
    return String(res.stdout ?? '').trim();
}

function deriveServerIdFromUrl(url: string): string {
    const comparableKey = (() => {
        try {
            return createServerUrlComparableKey(url);
        } catch {
            return '';
        }
    })();
    const value = comparableKey || url;
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
}

describe('sanitizeCliTerminalConnectEnv', () => {
    it('strips ambient server-selection overrides while preserving unrelated harness env', () => {
        const sanitized = sanitizeCliTerminalConnectEnv({
            PATH: '/usr/bin',
            HAPPIER_ACTIVE_SERVER_ID: 'ambient-server',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'ambient-instance',
            HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://ambient.invalid',
        });

        expect(sanitized).toEqual({ PATH: '/usr/bin' });
    });
});

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

    it('uses a validation-safe default timeout while waiting for the terminal-connect URL', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-timeout-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: {},
            });

            expect(started.connectUrl).toBe(terminalConnectUrl);
            expect(waitForRegexInFileMock).toHaveBeenCalledWith(expect.objectContaining({
                context: 'CLI terminal connect URL',
                timeoutMs: 180_000,
            }));

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('switches active server to the relay profile after successful auth when scoped credentials exist', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-active-server-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const serverUrl = 'http://127.0.0.1:4011';
        const webappUrl = 'http://127.0.0.1:19006';
        const serverId = deriveServerIdFromUrl(serverUrl);
        const settingsPath = resolve(cliHomeDir, 'settings.json');

        try {
            await mkdir(resolve(cliHomeDir, 'servers', serverId), { recursive: true });
            writeFileSync(resolve(cliHomeDir, 'servers', serverId, 'access.key'), '{"token":"fake"}\n', 'utf8');
            writeFileSync(settingsPath, JSON.stringify({
                schemaVersion: 6,
                activeServerId: 'cloud',
                servers: {
                    cloud: {
                        id: 'cloud',
                        name: 'Happier Cloud',
                        serverUrl: 'https://api.happier.dev',
                        webappUrl: 'https://app.happier.dev',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                },
            }) + '\n', 'utf8');

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl,
                webappUrl,
                env: {},
            });

            (started.proc.child as unknown as { exitCode: number | null }).exitCode = 0;
            started.proc.child.emit('exit', 0, null);
            await started.waitForSuccess();

            const updated = JSON.parse(await readFile(settingsPath, 'utf8')) as {
                activeServerId?: string;
                servers?: Record<string, { serverUrl?: string }>;
            };
            expect(updated.activeServerId).toBe(serverId);
            expect(updated.servers?.[serverId]?.serverUrl).toBe(serverUrl);

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
