import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { mockCurrentProcessAsDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';

const waitForInitialCredentialsMock = vi.fn(async () => ({ action: 'shutdown' as const }));
type DaemonStartupServiceConflictEvaluation =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'installed-background-service-conflict'; services: readonly DaemonServiceListEntry[] }>;
const {
    evaluateDaemonStartupServiceConflictMock,
    reapSameHomeDaemonOrphansBeforeStartMock,
    renderDaemonInstalledServiceConflictMock,
} = vi.hoisted(() => ({
    evaluateDaemonStartupServiceConflictMock: vi.fn(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({ kind: 'none' })),
    reapSameHomeDaemonOrphansBeforeStartMock: vi.fn(async () => ({
        stoppedPids: [],
        preservedPids: [],
        failedPids: [],
    })),
    renderDaemonInstalledServiceConflictMock: vi.fn(() => ({
        title: 'A background service is already installed for the selected relay.',
        lines: [
            'Use `happier service start` to start the installed background service instead of starting another daemon.',
            'If you want to start a manual daemon, stop or replace the installed background service first.',
        ],
    })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
    waitForInitialCredentials: waitForInitialCredentialsMock,
}));

vi.mock('./multiDaemon', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./multiDaemon')>();
    return {
        ...actual,
        reapSameHomeDaemonOrphansBeforeStart: reapSameHomeDaemonOrphansBeforeStartMock,
    };
});

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
    return {
        ...actual,
        evaluateDaemonStartupServiceConflict: evaluateDaemonStartupServiceConflictMock,
        renderDaemonInstalledServiceConflict: renderDaemonInstalledServiceConflictMock,
    };
});

describe('startDaemon ownership preflight', () => {
    const daemonLifecycleProcessEvents = [
        'SIGINT',
        'SIGTERM',
        'uncaughtException',
        'unhandledRejection',
        'exit',
        'beforeExit',
    ] as const;
    let processListenersBeforeTest = daemonLifecycleProcessEvents.map((event) => [event, process.rawListeners(event)] as const);
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_RUNTIME_ID',
        'HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID',
        'HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS',
        'HAPPIER_DAEMON_TAKEOVER',
        'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
    ]);
    let currentProcessDaemonFixtureAlive = true;
    const fetchMock = vi.fn();

    beforeEach(() => {
        processListenersBeforeTest = daemonLifecycleProcessEvents.map((event) => [event, process.rawListeners(event)] as const);
        currentProcessDaemonFixtureAlive = true;
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
            if (url.pathname === '/stop') currentProcessDaemonFixtureAlive = false;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ success: true }),
            } as Response;
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === process.pid && (signal === 0 || signal === undefined) && !currentProcessDaemonFixtureAlive) {
                throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
            }
            return true;
        }) as typeof process.kill);
        mockCurrentProcessAsDaemonLifecycleOwner();
    });

    afterEach(() => {
        for (const [event, originalListeners] of processListenersBeforeTest) {
            const retainedListeners = new Set(originalListeners);
            for (const listener of process.rawListeners(event)) {
                if (!retainedListeners.has(listener)) {
                    process.removeListener(event, listener);
                }
            }
        }
        envScope.restore();
        waitForInitialCredentialsMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockImplementation(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({ kind: 'none' }));
        renderDaemonInstalledServiceConflictMock.mockReset();
        renderDaemonInstalledServiceConflictMock.mockImplementation(() => ({
            title: 'A background service is already installed for the selected relay.',
            lines: [
                'Use `happier service start` to start the installed background service instead of starting another daemon.',
                'If you want to start a manual daemon, stop or replace the installed background service first.',
            ],
        }));
        reapSameHomeDaemonOrphansBeforeStartMock.mockReset();
        reapSameHomeDaemonOrphansBeforeStartMock.mockImplementation(async () => ({
            stoppedPids: [],
            preservedPids: [],
            failedPids: [],
        }));
        vi.unstubAllGlobals();
        vi.doUnmock('@/daemon/doctor');
        vi.resetModules();
    });

    it('reaps same-home daemon orphans before waiting for auth setup', async () => {
        await withTempDir('happier-start-daemon-orphan-reaper-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const { startDaemon } = await import('./startDaemon');

            await expect(startDaemon()).resolves.toBeUndefined();

            expect(reapSameHomeDaemonOrphansBeforeStartMock).toHaveBeenCalledTimes(1);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
            expect(reapSameHomeDaemonOrphansBeforeStartMock.mock.invocationCallOrder[0]).toBeLessThan(
                waitForInitialCredentialsMock.mock.invocationCallOrder[0],
            );
        });
    }, 60_000);

    it('fails closed before auth setup when a different daemon is already running for the selected relay', async () => {
        await withTempDir('happier-start-daemon-owner-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }, { logger }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(1)');
            } finally {
                exitSpy.mockRestore();
            }

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Daemon ownership conflict prevented daemon startup');
            expect(logContent).toContain('already running for the selected relay');
            expect(logContent).not.toContain('[DAEMON RUN][FATAL] Failed somewhere unexpectedly');
        });
    });

    it('fails closed before auth setup when daemon state is missing but a same-runtime daemon process is alive', async () => {
        await withTempDir('happier-start-daemon-orphan-process-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            vi.doMock('@/daemon/doctor', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/daemon/doctor')>();
                return {
                    ...actual,
                    findAllHappyProcesses: async () => [
                        {
                            pid: 4242,
                            type: 'dev-daemon',
                            command: `${process.execPath} --import tsx ${join(process.cwd(), 'src/index.ts')} daemon start-sync`,
                        },
                    ],
                };
            });

            const [{ startDaemon }, { logger }] = await Promise.all([
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(1)');
            } finally {
                exitSpy.mockRestore();
                vi.doUnmock('@/daemon/doctor');
            }

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Daemon ownership conflict prevented daemon startup');
            expect(logContent).toContain('Another running daemon is already using the selected relay');
            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
        });
    });

    it('force-stops a state-less same-runtime daemon process when takeover is requested', async () => {
        await withTempDir('happier-start-daemon-orphan-process-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();

            let orphanAlive = true;
            const processKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
                if (pid !== 4242) return true;
                if (signal === 0 || signal === undefined) {
                    if (orphanAlive) return true;
                    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
                }
                if (signal === 'SIGTERM') {
                    orphanAlive = false;
                    return true;
                }
                return true;
            }) as typeof process.kill);

            vi.doMock('@/daemon/doctor', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/daemon/doctor')>();
                const processInfo = {
                    pid: 4242,
                    type: 'dev-daemon',
                    command: `${process.execPath} --import tsx ${join(process.cwd(), 'src/index.ts')} daemon start-sync`,
                };
                return {
                    ...actual,
                    findAllHappyProcesses: async () => [processInfo],
                    classifyDaemonLifecycleProcessByPid: async (pid: number) => pid === processInfo.pid
                        ? { kind: 'daemon' as const, process: processInfo }
                        : await actual.classifyDaemonLifecycleProcessByPid(pid),
                };
            });

            const { startDaemon } = await import('./startDaemon');

            try {
                await expect(startDaemon()).resolves.toBeUndefined();
                expect(processKill).toHaveBeenCalledWith(4242, 'SIGTERM');
            } finally {
                processKill.mockRestore();
                vi.doUnmock('@/daemon/doctor');
            }

            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows takeover to continue past a manual daemon runtime conflict', async () => {
        await withTempDir('happier-start-daemon-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43115,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows a self-restart to overlap the current state-tracked manual daemon runtime without stopping it first', async () => {
        await withTempDir('happier-start-daemon-self-restart-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
                HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID: 'self-restart-test',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);
            envScope.patch({
                HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS: String(Date.now() + 60_000),
            });

            writeDaemonState({
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(false);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('lets self-restart runtime-id intent override a parsed false takeover option', async () => {
        await withTempDir('happier-start-daemon-self-restart-false-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_RUNTIME_ID: 'runtime-manual',
                HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID: 'self-restart-runtime-test',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);
            envScope.patch({
                HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS: String(Date.now() + 60_000),
            });

            writeDaemonState({
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon({ takeover: false })).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(false);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows replacing a stale manual daemon runtime without an explicit takeover flag', async () => {
        await withTempDir('happier-start-daemon-stale-manual-replace-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows takeover to continue past a legacy manual daemon runtime conflict when startup source is missing', async () => {
        await withTempDir('happier-start-daemon-legacy-manual-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43117,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                runtimeId: 'runtime-legacy-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('exits cleanly when automatic startup finds another running daemon for the selected relay', async () => {
        await withTempDir('happier-start-daemon-service-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43120,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(0)');
            } finally {
                exitSpy.mockRestore();
            }

            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
        });
    });

    it('fails closed before auth setup when a background service is installed for the active relay', async () => {
        await withTempDir('happier-start-daemon-installed-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ startDaemon }, { logger }] = await Promise.all([
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);
            evaluateDaemonStartupServiceConflictMock.mockImplementationOnce(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({
                kind: 'installed-background-service-conflict',
                services: [
                    {
                        serverId: 'default',
                        name: 'Default background service',
                        installed: true,
                        path: join(homeDir, 'service', 'happier-daemon.default.service'),
                        platform: 'linux',
                        releaseChannel: 'stable',
                        label: 'happier-daemon.default',
                        targetMode: 'default-following',
                    },
                ],
            }));

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(1)');
            } finally {
                exitSpy.mockRestore();
            }

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Installed background service prevented manual daemon startup');
            expect(logContent).toContain('happier service start');
            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
        });
    });
});
