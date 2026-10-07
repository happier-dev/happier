import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { projectPath } from '@/projectPath';

let ownerProcess: ReturnType<typeof spawnSleepyDetachedProcess> | undefined;
function spawnOwner() {
    ownerProcess ??= spawnSleepyDetachedProcess([join(projectPath(), 'src/index.ts'), 'daemon', 'start-sync']);
    return ownerProcess;
}

async function expectCredentialGateReached(expected: boolean) {
    const { logger } = await import('@/ui/logger');
    logger.flushSync();
    const diagnostic = await readFile(logger.logFilePath, 'utf8');
    expect(diagnostic.includes('[DAEMON RUN] Waiting for credentials')).toBe(expected);
}

describe('startDaemon ownership preflight', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_SERVER_URL',
        'HAPPIER_LOCAL_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_RUNTIME_ID',
        'HAPPIER_DAEMON_TAKEOVER',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_WAIT_FOR_AUTH',
    ]);
    const fetchMock = vi.fn();
    let inputTty: boolean | undefined;
    let outputTty: boolean | undefined;

    beforeEach(() => {
        envScope.patch({ HAPPIER_DAEMON_WAIT_FOR_AUTH: '1' });
        inputTty = process.stdin.isTTY;
        outputTty = process.stdout.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
        fetchMock.mockImplementation(async (input: unknown) => {
            if (String(input).includes('/stop')) {
                await ownerProcess?.kill();
                // A real OS shutdown signal retires the following auth wait;
                // the waiter and daemon shutdown owner stay real.
                process.emit('SIGTERM');
            }
            return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
        });
    });

    afterEach(async () => {
        await ownerProcess?.kill();
        ownerProcess = undefined;
        envScope.restore();
        fetchMock.mockReset();
        vi.unstubAllGlobals();
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: inputTty });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: outputTty });
        vi.resetModules();
    });

    it('fails closed before auth setup when a different relay owner already owns the relay', async () => {
        await withTempDir('happier-start-daemon-owner-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_LOCAL_SERVER_URL: undefined,
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }, { logger }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                return undefined as never;
            }) as typeof process.exit);

            await expect(startDaemon()).resolves.toBeUndefined();
            expect(exitSpy).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(1);

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Relay ownership conflict prevented daemon startup');
            expect(logContent).toContain('already owns this relay');
            expect(logContent).not.toContain('[DAEMON RUN][FATAL] Failed somewhere unexpectedly');
            exitSpy.mockRestore();
        });
    });

    it('exits with code 0 for background-service ownership conflicts without falling through to the fatal handler', async () => {
        await withTempDir('happier-start-daemon-owner-conflict-background-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }, { logger }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
                httpPort: 43111,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                return undefined as never;
            }) as typeof process.exit);

            await expect(startDaemon()).resolves.toBeUndefined();
            expect(exitSpy).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(0);

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Relay ownership conflict prevented daemon startup');
            expect(logContent).not.toContain('[DAEMON RUN][FATAL] Failed somewhere unexpectedly');
            exitSpy.mockRestore();
        });
    });

    it('allows takeover to continue past a manual relay runtime conflict', async () => {
        await withTempDir('happier-start-daemon-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
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
            await expectCredentialGateReached(true);
        });
    });

    it('allows a self-restart to replace the current manual relay runtime without an explicit takeover flag', async () => {
        await withTempDir('happier-start-daemon-self-restart-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
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
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            await expectCredentialGateReached(true);
        });
    });

    it('allows replacing a stale manual relay runtime without an explicit takeover flag', async () => {
        await withTempDir('happier-start-daemon-stale-manual-replace-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
                httpPort: 43118,
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
            await expectCredentialGateReached(true);
        });
    });

    it('allows takeover to continue past a legacy manual relay runtime conflict when startup source is missing', async () => {
        await withTempDir('happier-start-daemon-legacy-manual-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: spawnOwner().pid,
                httpPort: 43117,
                controlToken: 'control-token',
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                runtimeId: 'runtime-legacy-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            await expectCredentialGateReached(true);
        });
    });

    it('reuses an inherited runtime id for startup', async () => {
        envScope.patch({
            HAPPIER_DAEMON_RUNTIME_ID: 'runtime-self-restart',
        });
        const { resolveDaemonRuntimeId } = await import('./startDaemon');

        expect(resolveDaemonRuntimeId(process.env)).toBe('runtime-self-restart');
    });

    it('exits cleanly when background-service startup finds another relay owner', async () => {
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
                pid: spawnOwner().pid,
                httpPort: 43120,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                return undefined as never;
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).resolves.toBeUndefined();
            } finally {
                exitSpy.mockRestore();
            }

            await expectCredentialGateReached(false);
        });
    });

    it('fails closed before auth setup when a background service is installed for the active relay', async () => {
        await withTempDir('happier-start-daemon-installed-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_LOCAL_SERVER_URL: undefined,
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [
                { startDaemon },
                { logger },
                { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
            ] = await Promise.all([
                import('./startDaemon'),
                import('@/ui/logger'),
                import('@/daemon/service/cli'),
            ]);
            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                return undefined as never;
            }) as typeof process.exit);
            const flushSpy = vi.spyOn(logger, 'flushSync');

            try {
                await expect(startDaemon()).resolves.toBeUndefined();
                expect(flushSpy).toHaveBeenCalledTimes(1);
                expect(flushSpy.mock.invocationCallOrder[0]!).toBeLessThan(exitSpy.mock.invocationCallOrder[0]!);
            } finally {
                exitSpy.mockRestore();
                flushSpy.mockRestore();
            }

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Installed background service prevented manual daemon startup');
            expect(logContent).toContain('happier service start');
            await expectCredentialGateReached(false);
        });
    });

    it('does not stop the current manual relay runtime before reporting an installed-service conflict during takeover', async () => {
        await withTempDir('happier-start-daemon-installed-service-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_LOCAL_SERVER_URL: undefined,
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

            const [
                { writeDaemonState },
                { startDaemon },
                { logger },
                { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
            ] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
                import('@/ui/logger'),
                import('@/daemon/service/cli'),
            ]);
            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            writeDaemonState({
                pid: spawnOwner().pid,
                httpPort: 43125,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                return undefined as never;
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).resolves.toBeUndefined();
            } finally {
                exitSpy.mockRestore();
            }

            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(false);
            await expectCredentialGateReached(false);

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Installed background service prevented manual daemon startup');
        });
    });
});
