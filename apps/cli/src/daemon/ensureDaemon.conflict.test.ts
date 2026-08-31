import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { mockCurrentProcessAsDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';

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

    beforeEach(() => {
        mockCurrentProcessAsDaemonLifecycleOwner();
    });

    afterEach(() => {
        envScope.restore();
        spawnDetachedDaemonStartSyncMock.mockClear();
        vi.restoreAllMocks();
        vi.doUnmock('@/daemon/controlClient');
        vi.doUnmock('@/daemon/ownership/daemonServiceInventory');
        vi.unmock('@/daemon/controlClient');
        vi.unmock('@/daemon/ownership/daemonServiceInventory');
        vi.doUnmock('@/daemon/doctor');
        vi.resetModules();
    });

    it('warns and skips autostart when a different background service is already running for the selected relay', async () => {
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
            expect(output.text()).toContain('selected relay');
            expect(output.text()).toContain('happier doctor repair');
        });
    });

    it('warns and skips autostart when a different manually started daemon is already running for the selected relay', async () => {
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
            expect(output.text()).toContain('manually started daemon');
            expect(output.text()).toContain('without starting another daemon');
            expect(output.text()).toContain('happier daemon restart');
        });
    });

    it('warns and skips autostart when a background service is installed but no daemon is active', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: '',
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        });
        vi.resetModules();
        vi.doMock('@/daemon/controlClient', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
            return {
                ...actual,
                inspectDaemonRunningStateAndCleanupStaleState: vi.fn(async () => ({ status: 'not-running' as const })),
                isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
            };
        });
        vi.doMock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
            return {
                ...actual,
                evaluateDaemonStartupServiceConflict: vi.fn(async () => ({
                    kind: 'installed-background-service-conflict' as const,
                    services: [{
                        serverId: 'cloud',
                        name: 'Cloud',
                        relayUrl: 'https://cloud.example.test',
                        installed: true,
                        path: '/tmp/happier-daemon.service',
                        platform: 'linux' as const,
                        mode: 'user' as const,
                        happierHomeDir: '/tmp/.happier',
                        releaseChannel: 'stable' as const,
                        label: 'happier-daemon.service',
                        targetMode: 'default-following' as const,
                    }],
                })),
            };
        });

        const { ensureDaemonRunningForSessionCommand } = await import('@/daemon/ensureDaemon');

        const output = captureConsoleText();
        try {
            spawnDetachedDaemonStartSyncMock.mockClear();
            await ensureDaemonRunningForSessionCommand();
        } finally {
            output.restore();
        }

        expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
        expect(output.text()).toContain('A background service is already installed');
        expect(output.text()).toContain('happier service start');
    });
});
