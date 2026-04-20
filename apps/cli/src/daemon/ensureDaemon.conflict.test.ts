import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const spawnDetachedDaemonStartSyncMock = vi.fn(async () => ({ unref() {} }));
vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
}));

describe('ensureDaemonRunningForSessionCommand conflict handling', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
        'HAPPIER_DAEMON_START_WAIT_POLL_MS',
    ]);

    afterEach(() => {
        envScope.restore();
        spawnDetachedDaemonStartSyncMock.mockClear();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('warns and skips autostart when a different background service already owns the relay', async () => {
        await withTempDir('happier-ensure-daemon-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { ensureDaemonRunningForSessionCommand }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/ensureDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-conflict',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('background service');
            expect(output.text()).toContain('relay');
            expect(output.text()).toContain('happier service restart');
        });
    });

    it('warns and skips autostart when a different manual relay runtime already owns the relay', async () => {
        await withTempDir('happier-ensure-daemon-manual-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { ensureDaemonRunningForSessionCommand }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/ensureDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-manual-conflict',
                startupSource: 'manual',
            });

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('relay runtime');
            expect(output.text()).toContain('without starting another relay runtime');
            expect(output.text()).toContain('happier daemon restart');
        });
    });

    it('still autostarts a daemon when a background service is installed but no relay owner is active', async () => {
        await withTempDir('happier-ensure-daemon-installed-service-', async (homeDir) => {
            const happierHomeDir = join(homeDir, '.happier');
            envScope.patch({
                HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: '',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                HAPPIER_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_WEBAPP_URL: 'https://cloud.example.test',
                HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
                HAPPIER_DAEMON_START_WAIT_POLL_MS: '5',
            });
            vi.resetModules();

            // This test is about "autostart when no current relay owner exists", not about daemon-state
            // fallback discovery. Stub the control client inspection to avoid scanning a developer's real
            // servers dir if configuration was loaded before the test's env patch.
            const isDaemonRunningMock = vi.fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            vi.doMock('@/daemon/controlClient', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
                return {
                    ...actual,
                    inspectDaemonRunningStateAndCleanupStaleState: vi.fn(async () => ({ status: 'not-running' as const })),
                    isDaemonRunningCurrentlyInstalledHappyVersion: isDaemonRunningMock,
                };
            });

            const [{ ensureDaemonRunningForSessionCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('@/daemon/ensureDaemon'),
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
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
            expect(output.text()).not.toContain('background service is already installed');
        });
    });
});
