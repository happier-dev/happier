import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
    spawnDetachedDaemonStartSyncMock,
    stopDaemonMock,
    restartDaemonAndWaitMock,
    waitForDaemonRunningWithinBudgetMock,
} = vi.hoisted(() => ({
    spawnDetachedDaemonStartSyncMock: vi.fn(async () => ({ unref() {} })),
    stopDaemonMock: vi.fn(async () => undefined),
    restartDaemonAndWaitMock: vi.fn(async () => true),
    waitForDaemonRunningWithinBudgetMock: vi.fn(async () => true),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        stopDaemon: stopDaemonMock,
    };
});

vi.mock('@/daemon/restartDaemonAndWait', () => ({
    restartDaemonAndWait: restartDaemonAndWaitMock,
}));

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
    waitForDaemonRunningWithinBudget: waitForDaemonRunningWithinBudgetMock,
}));

describe('handleDaemonCliCommand ownership conflicts', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_SERVER_URL',
        'HAPPIER_LOCAL_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    afterEach(() => {
        envScope.restore();
        spawnDetachedDaemonStartSyncMock.mockReset();
        stopDaemonMock.mockReset();
        restartDaemonAndWaitMock.mockReset();
        waitForDaemonRunningWithinBudgetMock.mockReset();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('fails closed for daemon start, stop, and restart when a background service owns the relay', async () => {
        await withTempDir('happier-daemon-service-owned-conflict-', async (homeDir) => {
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

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);
            const controlClient = await import('@/daemon/controlClient');

            const serviceOwnedState: DaemonLocallyPersistedState = {
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            };
            writeDaemonState(serviceOwnedState);
            vi.spyOn(controlClient, 'inspectDaemonRunningStateAndCleanupStaleState').mockResolvedValue({
                status: 'running',
                state: serviceOwnedState,
            });

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'start'],
                        rawArgv: ['node', 'happier', 'daemon', 'start'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('background service');
            expect(output.text()).toContain('relay');
            expect(output.text()).toContain('happier service restart');

            const stopOutput = captureConsoleText();
            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'stop'],
                        rawArgv: ['node', 'happier', 'daemon', 'stop'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                stopOutput.restore();
            }

            expect(stopDaemonMock).not.toHaveBeenCalled();
            expect(stopOutput.text()).toContain('background service');
            expect(stopOutput.text()).toContain('happier service stop');

            const restartOutput = captureConsoleText();
            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart'],
                        rawArgv: ['node', 'happier', 'daemon', 'restart'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                restartOutput.restore();
            }

            expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
            expect(restartOutput.text()).toContain('background service');
            expect(restartOutput.text()).toContain('happier service restart');

            exitSpy.mockRestore();
        });
    });

    it('allows daemon start takeover to spawn a replacement relay when the current owner is manual', async () => {
        await withTempDir('happier-daemon-start-takeover-', async (homeDir) => {
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

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43114,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'start', '--takeover'],
                        rawArgv: ['node', 'happier', 'daemon', 'start', '--takeover'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
            const [spawnCall] = spawnDetachedDaemonStartSyncMock.mock.calls as unknown as Array<[Record<string, unknown>]>;
            expect(spawnCall?.[0]).toEqual(
                expect.objectContaining({
                    env: expect.objectContaining({
                        HAPPIER_DAEMON_TAKEOVER: '1',
                    }),
                }),
            );
            expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(0);
            exitSpy.mockRestore();
        });
    });

    it('prints JSON when daemon start is already running for the current invocation', async () => {
        await withTempDir('happier-daemon-start-json-already-running-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_WEBAPP_URL: 'https://app.example.test',
            });
            vi.resetModules();

            const [{ configuration }, { writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/configuration'),
                import('@/persistence'),
                import('./daemon'),
            ]);
            const controlClient = await import('@/daemon/controlClient');

            const compatibleState = {
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                startedWithPublicReleaseChannel: 'stable' as const,
                startupSource: 'manual' as const,
                runtimeId: 'runtime-compatible',
            };
            writeDaemonState(compatibleState);
            vi.spyOn(controlClient, 'inspectDaemonRunningStateAndCleanupStaleState').mockResolvedValue({
                status: 'running',
                state: compatibleState,
            });

            const output = captureStdoutJsonOutput<{
                ok: boolean;
                status: string;
                relayId: string;
            }>();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'start', '--json'],
                        rawArgv: ['node', 'happier', 'daemon', 'start', '--json'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:0/);
            } finally {
                exitSpy.mockRestore();
            }

            expect(output.json()).toEqual(expect.objectContaining({
                ok: true,
                status: 'already_running',
                relayId: 'cloud',
            }));
            output.restore();
        });
    });

    it('fails closed for daemon start when a background service is installed for the active relay', async () => {
        await withTempDir('happier-daemon-service-installed-', async (homeDir) => {
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

            const [{ handleDaemonCliCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('./daemon'),
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
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            const output = captureConsoleText();
            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'start'],
                        rawArgv: ['node', 'happier', 'daemon', 'start'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('background service is already installed');
            expect(output.text()).toContain('happier service start');
            expect(output.text()).toContain('stop or replace the installed background service first');
        });
    });

    it('prints JSON when daemon start is blocked by an installed background service', async () => {
        await withTempDir('happier-daemon-start-json-service-installed-', async (homeDir) => {
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

            const { handleDaemonCliCommand } = await import('./daemon');

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

            const output = captureStdoutJsonOutput<{
                ok: boolean;
                error: string;
                message: string;
            }>();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'start', '--json'],
                        rawArgv: ['node', 'happier', 'daemon', 'start', '--json'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                exitSpy.mockRestore();
            }

            expect(output.json()).toEqual(expect.objectContaining({
                ok: false,
                error: 'installed_background_service_conflict',
                message: expect.stringContaining('background service'),
            }));
            output.restore();
        });
    });
});
