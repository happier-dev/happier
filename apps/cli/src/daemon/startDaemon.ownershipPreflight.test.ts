import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const waitForInitialCredentialsMock = vi.fn(async () => ({ action: 'shutdown' as const }));

vi.mock('./startup/waitForInitialCredentials', () => ({
    waitForInitialCredentials: waitForInitialCredentialsMock,
}));

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
    ]);
    const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
    }));

    afterEach(() => {
        envScope.restore();
        waitForInitialCredentialsMock.mockReset();
        fetchMock.mockReset();
        vi.unstubAllGlobals();
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
                pid: process.pid,
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
                pid: process.pid,
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
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
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
                pid: process.pid,
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
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
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
                pid: process.pid,
                httpPort: 43117,
                controlToken: 'control-token',
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                runtimeId: 'runtime-legacy-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
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
                pid: process.pid,
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

            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
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
            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
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
                pid: process.pid,
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
            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();

            logger.flushSync();
            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Installed background service prevented manual daemon startup');
        });
    });
});
