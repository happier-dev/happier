import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let spawnStdoutText = '';
let lastSpawnEnv: NodeJS.ProcessEnv | null = null;
let lastSpawnArgs: string[] | null = null;
let sourceFingerprint = 'fingerprint-a';
let reservedMetroPort = 19077;
let fetchResponder: ((input: unknown, init?: RequestInit) => Promise<unknown>) | null = null;
let spawnStdoutTextSequence: string[] | null = null;
let spawnExitSignalSequence: Array<NodeJS.Signals | null> | null = null;
let spawnInvocationIndex = 0;
let runLoggedCommandCalls: RunLoggedCommandMockParams[] = [];
let startOrder: string[] = [];

type RunLoggedCommandMockParams = {
    stdoutPath: string;
    stderrPath?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
};

vi.mock('./spawnProcess', () => ({
    spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string; args: string[]; env?: NodeJS.ProcessEnv }) => {
        startOrder.push('spawn');
        const currentStdout = spawnStdoutTextSequence?.[spawnInvocationIndex] ?? spawnStdoutText;
        writeFileSync(params.stdoutPath, currentStdout, 'utf8');
        writeFileSync(params.stderrPath, '', 'utf8');
        lastSpawnEnv = params.env && typeof params.env === 'object' ? params.env as NodeJS.ProcessEnv : null;
        lastSpawnArgs = [...params.args];
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = null;
        child.signalCode = null;

        const exitSignal = spawnExitSignalSequence?.[spawnInvocationIndex] ?? null;
        spawnInvocationIndex += 1;
        if (exitSignal) {
            setImmediate(() => {
                child.exitCode = null;
                child.signalCode = exitSignal;
                child.emit('exit', null, exitSignal);
            });
        }

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
    runLoggedCommand: async (params: RunLoggedCommandMockParams) => {
        startOrder.push('workspace-prebuild');
        runLoggedCommandCalls.push(params);
    },
}));

vi.mock('./uiWebSourceFingerprint', () => ({
    resolveUiWebSourceFingerprint: () => sourceFingerprint,
}));

vi.mock('../network/reserveAvailablePort', () => ({
    reserveAvailablePort: async () => reservedMetroPort,
}));

import {
    resolveUiWebMetroOwnershipLeasesDir,
    startUiWebMetro,
} from './uiWebMetro';
import { spawnDetachedTestProcess } from './testSpawn';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

afterAll(() => {
    vi.doUnmock('./spawnProcess');
    vi.doUnmock('./uiWebSourceFingerprint');
    vi.doUnmock('../network/reserveAvailablePort');
    vi.resetModules();
});

beforeEach(() => {
    spawnStdoutText = 'http://127.0.0.1:19077\n';
    lastSpawnEnv = null;
    lastSpawnArgs = null;
    sourceFingerprint = 'fingerprint-a';
    reservedMetroPort = 19077;
    fetchResponder = async (input: unknown) => {
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
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => await fetchResponder!(input, init)));
    spawnStdoutTextSequence = null;
    spawnExitSignalSequence = null;
    spawnInvocationIndex = 0;
    runLoggedCommandCalls = [];
    startOrder = [];
});

function isWorkspacePrebuildInvocation(params: RunLoggedCommandMockParams | undefined): boolean {
    return Array.isArray(params?.args) && params.args.includes('--input-type=module');
}

function readProcessStartTime(pid: number): string {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`Failed to inspect process start time for pid ${pid}`);
    }
    return String(res.stdout ?? '').trim();
}

describe('startUiWebMetro', () => {
    it('builds apps/ui workspace packages before launching Expo web', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-prebuild-'));

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: {
                    HAPPIER_E2E_UI_WEB_METRO_WORKSPACE_PREBUILD_TIMEOUT_MS: '1234',
                },
                port: 19077,
            });

            expect(runLoggedCommandCalls).toHaveLength(1);
            expect(isWorkspacePrebuildInvocation(runLoggedCommandCalls[0])).toBe(true);
            expect(runLoggedCommandCalls[0]?.timeoutMs).toBe(1234);
            expect(startOrder).toEqual(['workspace-prebuild', 'spawn']);

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('retries once when the expo web dev server exits before ready', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-retry-'));

        try {
            await mkdir(testDir, { recursive: true });
            spawnStdoutTextSequence = [
                '',
                'http://127.0.0.1:19077\n',
            ];
            spawnExitSignalSequence = [
                'SIGKILL',
                null,
            ];

            const started = await startUiWebMetro({
                testDir,
                env: { HAPPIER_E2E_UI_WEB_METRO_START_ATTEMPTS: '2' },
                port: 19077,
            });

            expect(started.baseUrl).toBe('http://127.0.0.1:19077');
            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('does not force narrowed metro workspace/node_modules flags unless explicitly requested', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-spawn-env-'));

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: {},
                port: 19077,
            });

            expect(lastSpawnEnv?.EXPO_NO_METRO_WORKSPACE_ROOT).toBeUndefined();
            expect(lastSpawnEnv?.HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS).toBeUndefined();

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('binds Expo localhost to the IPv4 origin returned to browser callers', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-loopback-origin-'));

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: { NODE_ENV: 'test', NODE_OPTIONS: '--trace-warnings' },
                port: 19077,
            });

            expect(lastSpawnArgs).toContain('--host');
            expect(lastSpawnArgs?.[lastSpawnArgs.indexOf('--host') + 1]).toBe('localhost');
            expect(lastSpawnEnv?.NODE_OPTIONS).toBe('--trace-warnings --dns-result-order=ipv4first');
            expect(started.baseUrl).toBe('http://127.0.0.1:19077');

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

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

    it('passes a Metro cache version bust through to the web dev server process', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-cache-bust-'));

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: {},
                port: 19077,
            });

            expect(lastSpawnEnv?.HAPPIER_UI_METRO_CACHE_VERSION_BUST).toMatch(/^[a-f0-9]{16,}$/u);

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('waits for the entry html to include scripts before treating metro as ready', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-entry-ready-'));
        reservedMetroPort = 19079;
        spawnStdoutText = `Waiting on http://localhost:${reservedMetroPort}`;
        const startedAtMs = Date.now();

        fetchResponder = async (input: unknown) => {
            const url = String(input);
            const elapsedMs = Date.now() - startedAtMs;

            if (url === `http://localhost:${reservedMetroPort}/status` || url === `http://127.0.0.1:${reservedMetroPort}/status`) {
                return {
                    ok: true,
                    headers: { get: () => 'text/plain' },
                    text: async () => 'packager-status:running',
                };
            }

            if (url === `http://localhost:${reservedMetroPort}` || url === `http://127.0.0.1:${reservedMetroPort}`) {
                if (elapsedMs < 250) {
                    return {
                        ok: true,
                        headers: { get: () => 'text/plain' },
                        text: async () => 'still compiling',
                    };
                }
                if (elapsedMs < 500) {
                    return {
                        ok: true,
                        headers: { get: () => 'text/html' },
                        text: async () => '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
                    };
                }
                return {
                    ok: true,
                        headers: { get: () => 'text/html' },
                        text: async () => '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
                };
            }

            if (url === `http://localhost:${reservedMetroPort}/app.js` || url === `http://127.0.0.1:${reservedMetroPort}/app.js`) {
                return {
                    ok: true,
                    headers: { get: () => 'application/javascript' },
                    text: async () => 'globalThis.__HAPPIER_E2E__ = true;',
                };
            }

            return {
                ok: false,
                headers: { get: () => 'text/plain' },
                text: async () => '',
            };
        };

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: {
                    HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
                    HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '1000',
                    HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
                },
                port: reservedMetroPort,
            });

            expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(450);
            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('changes the Metro cache version bust when the source fingerprint changes', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-cache-bust-source-'));

        try {
            await mkdir(testDir, { recursive: true });

            sourceFingerprint = 'fingerprint-a';
            const startedA = await startUiWebMetro({
                testDir,
                env: {},
                port: 19077,
            });
            const bustA = lastSpawnEnv?.HAPPIER_UI_METRO_CACHE_VERSION_BUST;

            sourceFingerprint = 'fingerprint-b';
            const startedB = await startUiWebMetro({
                testDir,
                env: {},
                port: 19078,
            });
            const bustB = lastSpawnEnv?.HAPPIER_UI_METRO_CACHE_VERSION_BUST;

            expect(bustA).toMatch(/^[a-f0-9]{16,}$/u);
            expect(bustB).toMatch(/^[a-f0-9]{16,}$/u);
            expect(bustB).not.toBe(bustA);

            await startedA.stop();
            await startedB.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('reanchors to the live reserved metro port when stdout still advertises a stale prior entry page', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-web-metro-reanchor-'));
        reservedMetroPort = 19079;
        spawnStdoutText = ['http://127.0.0.1:19077', `Waiting on http://localhost:${reservedMetroPort}`].join('\n');
        let liveEntryPageReady = false;

        fetchResponder = async (input: unknown) => {
            const url = String(input);

            if (url === `http://localhost:${reservedMetroPort}/status` || url === `http://127.0.0.1:${reservedMetroPort}/status`) {
                liveEntryPageReady = true;
                return {
                    ok: true,
                    headers: { get: () => 'text/plain' },
                    text: async () => 'packager-status:running',
                };
            }

            if (url === 'http://127.0.0.1:19077/status' || url === 'http://localhost:19077/status') {
                return {
                    ok: false,
                    headers: { get: () => 'text/plain' },
                    text: async () => '',
                };
            }

            if (url === 'http://127.0.0.1:19077' || url === 'http://localhost:19077') {
                return {
                    ok: true,
                    headers: { get: () => 'text/html' },
                    text: async () => '<!doctype html><html><head><script src="/index.js"></script></head><body></body></html>',
                };
            }

            if (url === 'http://127.0.0.1:19077/index.js' || url === 'http://localhost:19077/index.js') {
                return {
                    ok: true,
                    headers: { get: () => 'application/javascript' },
                    text: async () => 'globalThis.__HAPPIER_E2E__ = true;',
                };
            }

            if (url === `http://127.0.0.1:${reservedMetroPort}` || url === `http://localhost:${reservedMetroPort}`) {
                if (!liveEntryPageReady) {
                    return {
                        ok: false,
                        headers: { get: () => 'text/plain' },
                        text: async () => '',
                    };
                }
                return {
                    ok: true,
                    headers: { get: () => 'text/html' },
                    text: async () => '<!doctype html><html><head><script src="/index.js"></script></head><body></body></html>',
                };
            }

            if (url === `http://127.0.0.1:${reservedMetroPort}/index.js` || url === `http://localhost:${reservedMetroPort}/index.js`) {
                if (!liveEntryPageReady) {
                    return {
                        ok: false,
                        headers: { get: () => 'text/plain' },
                        text: async () => '',
                    };
                }
                return {
                    ok: true,
                    headers: { get: () => 'application/javascript' },
                    text: async () => 'globalThis.__HAPPIER_E2E__ = true;',
                };
            }

            return {
                ok: false,
                headers: { get: () => 'text/plain' },
                text: async () => '',
            };
        };

        try {
            await mkdir(testDir, { recursive: true });

            const started = await startUiWebMetro({
                testDir,
                env: {
                    HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
                    HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '500',
                    HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
                    HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
                },
            });

            expect(new URL(started.baseUrl).port).toBe(String(reservedMetroPort));
            expect(['127.0.0.1', 'localhost']).toContain(new URL(started.baseUrl).hostname);

            await started.stop();
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

});
