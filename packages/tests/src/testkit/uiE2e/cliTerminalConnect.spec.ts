import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let stopCalls = 0;
const defaultTerminalConnectStdout = 'https://127.0.0.1:4011/terminal/connect#key=test-key\n';
let terminalConnectStdout = defaultTerminalConnectStdout;
let lastSpawnCwd: string | null = null;

vi.mock('../process/cliLaunchSpec', () => ({
    resolveCliTestLaunchSpec: vi.fn(async (params: { testDir: string }) => ({
        command: process.execPath,
        args: [resolve(params.testDir, 'fake-cli.mjs')],
        cwd: resolve(params.testDir),
        env: {},
    })),
}));

vi.mock('../process/spawnProcess', () => ({
    spawnLoggedProcess: (params: { cwd: string; stdoutPath: string; stderrPath: string }) => {
        lastSpawnCwd = params.cwd;
        writeFileSync(params.stdoutPath, terminalConnectStdout, 'utf8');
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

vi.mock('../timing', async () => {
    const actual = await vi.importActual<typeof import('../timing')>('../timing');
    return {
        ...actual,
        waitFor: vi.fn(actual.waitFor),
    };
});

vi.mock('../waitForRegexInFile', async () => {
    const actual = await vi.importActual<typeof import('../waitForRegexInFile')>('../waitForRegexInFile');
    return {
        ...actual,
        waitForRegexInFile: vi.fn(actual.waitForRegexInFile),
    };
});

import {
    resolveCliTerminalConnectOwnershipLeasesDir,
    startCliAuthLoginForTerminalConnect,
} from './cliTerminalConnect';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { spawnDetachedTestProcess } from '../process/testSpawn';
import { waitFor } from '../timing';
import { waitForRegexInFile } from '../waitForRegexInFile';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stopCalls = 0;
    terminalConnectStdout = defaultTerminalConnectStdout;
    lastSpawnCwd = null;
});

function readProcessStartTime(pid: number): string {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`Failed to inspect process start time for pid ${pid}`);
    }
    return String(res.stdout ?? '').trim();
}

describe('startCliAuthLoginForTerminalConnect', () => {
    it('launches the CLI from the resolved snapshot cwd', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-cwd-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                waitForConnectUrlReady: false,
                env: {},
            });

            expect(lastSpawnCwd).toBe(resolve(testDir));

            await started.stop();
        } finally {
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
                waitForConnectUrlReady: false,
                env: {},
            });

            expect(started.connectUrl).toBe(defaultTerminalConnectStdout.trim());
            expect(waitForRegexInFile).toHaveBeenCalledWith(expect.objectContaining({
                context: 'CLI terminal connect URL',
                timeoutMs: 180_000,
            }));

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('reclaims stale terminal-connect auth helpers from dead owners before starting a new one', async () => {
        if (process.platform === 'win32') return;

        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const port = await reserveAvailablePort();
        const server = createServer((_, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
        });
        let stalePid: number | null = null;

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = `http://127.0.0.1:${port}/terminal/connect#key=test-key\n`;
            await new Promise<void>((resolveListen, rejectListen) => {
                server.once('error', rejectListen);
                server.listen(port, '127.0.0.1', () => resolveListen());
            });

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
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('waits for the terminal-connect URL to respond before returning it', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-ready-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const port = await reserveAvailablePort();
        const server = createServer((_, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
        });
        let startedListening: Promise<void> | null = null;

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = `http://127.0.0.1:${port}/terminal/connect#key=test-key\n`;

            startedListening = new Promise<void>((resolveListening, rejectListening) => {
                server.once('error', rejectListening);
                setTimeout(() => {
                    server.listen(port, '127.0.0.1', () => resolveListening());
                }, 3_000);
            });

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: {},
            });

            await expect(fetch(started.connectUrl)).resolves.toMatchObject({ status: 200 });

            await started.stop();
        } finally {
            if (startedListening) {
                await startedListening.catch(() => {});
            }
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('accepts a loopback-equivalent terminal-connect URL during readiness', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-loopback-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const fetchSpy = vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url === 'http://localhost:52576/terminal/connect#key=test-key') {
                return new Response('ok', { status: 200 });
            }
            throw new Error(`unreachable: ${url}`);
        });

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = 'http://127.0.0.1:52576/terminal/connect#key=test-key\n';
            vi.stubGlobal('fetch', fetchSpy);

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://localhost:19006',
                env: {
                    HAPPIER_E2E_CLI_TERMINAL_CONNECT_READY_TIMEOUT_MS: '1000',
                },
            });

            expect(started.connectUrl).toBe('http://localhost:52576/terminal/connect#key=test-key');
            expect(fetchSpy).toHaveBeenCalledWith(
                'http://localhost:52576/terminal/connect#key=test-key',
                expect.any(Object),
            );

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('falls back to a reachable loopback candidate during readiness', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-loopback-fallback-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const fetchSpy = vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url === 'http://localhost:52577/terminal/connect#key=test-key') {
                return new Response('ok', { status: 200 });
            }
            throw new Error(`unreachable: ${url}`);
        });

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = 'http://127.0.0.1:52577/terminal/connect#key=test-key\n';
            vi.stubGlobal('fetch', fetchSpy);

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: {
                    HAPPIER_E2E_CLI_TERMINAL_CONNECT_READY_TIMEOUT_MS: '1000',
                },
            });

            expect(started.connectUrl).toBe('http://localhost:52577/terminal/connect#key=test-key');
            expect(fetchSpy).toHaveBeenCalledWith(
                'http://127.0.0.1:52577/terminal/connect#key=test-key',
                expect.any(Object),
            );
            expect(fetchSpy).toHaveBeenCalledWith(
                'http://localhost:52577/terminal/connect#key=test-key',
                expect.any(Object),
            );

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('can skip the terminal-connect readiness probe when the caller will retry navigation', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-no-readiness-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const fetchSpy = vi.fn(async () => {
            throw new Error('unexpected fetch during terminal-connect startup');
        });

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = 'http://127.0.0.1:65533/terminal/connect#key=test-key\n';
            vi.stubGlobal('fetch', fetchSpy);

            const started = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                waitForConnectUrlReady: false,
                env: {},
            });

            expect(started.connectUrl).toContain('/terminal/connect#key=');
            expect(fetchSpy).not.toHaveBeenCalled();

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('honors an override for the terminal-connect readiness timeout', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-terminal-connect-timeout-'));
        const cliHomeDir = resolve(testDir, 'cli-home');
        const port = await reserveAvailablePort();
        const server = createServer((_, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
        });

        try {
            await mkdir(cliHomeDir, { recursive: true });
            terminalConnectStdout = `http://127.0.0.1:${port}/terminal/connect#key=test-key\n`;

            await new Promise<void>((resolveListen, rejectListen) => {
                server.once('error', rejectListen);
                server.listen(port, '127.0.0.1', () => resolveListen());
            });

            await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: {
                    HAPPIER_E2E_CLI_TERMINAL_CONNECT_READY_TIMEOUT_MS: '1234',
                },
            });

            expect(vi.mocked(waitFor)).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    timeoutMs: 1234,
                    intervalMs: 250,
                    context: 'terminal connect URL readiness',
                }),
            );
        } finally {
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
