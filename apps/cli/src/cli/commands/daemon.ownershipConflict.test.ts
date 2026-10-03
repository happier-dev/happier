import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import type { DaemonRunningInspection, DaemonStopResult } from '@/daemon/controlClient';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

type DaemonStartupServiceConflictEvaluation =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'installed-background-service-conflict'; services: readonly DaemonServiceListEntry[] }>;

const {
    evaluateDaemonStartupServiceConflictMock,
    renderDaemonInstalledServiceConflictMock,
} = vi.hoisted(() => ({
    evaluateDaemonStartupServiceConflictMock: vi.fn<() => Promise<DaemonStartupServiceConflictEvaluation>>(async () => ({ kind: 'none' })),
    renderDaemonInstalledServiceConflictMock: vi.fn((params?: { action?: string }) => ({
        title: 'A background service is already installed for the selected relay.',
        lines: params?.action === 'daemon-restart'
            ? [
                'Use `happier doctor repair` to switch automatic startup to this installation.',
                'If you want to restart the daemon manually, stop or replace the installed background service first.',
            ]
            : [
                'Use `happier service start` to start the installed background service instead of starting another daemon.',
                'If you want to start another daemon, stop or replace the installed background service first.',
            ],
    })),
}));

const inspectDaemonMock = vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' }));
const spawnDetachedDaemonStartSyncMock = vi.fn(async () => ({ unref() {} }));
const stopDaemonMock = vi.fn<() => Promise<DaemonStopResult>>(async () => ({ status: 'stopped', method: 'graceful' }));
const waitForDaemonRunningWithinBudgetMock = vi.fn(async () => true);
const restartDaemonAndWaitMock = vi.fn(async () => true);

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
        stopDaemon: stopDaemonMock,
    };
});

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
    waitForDaemonRunningWithinBudget: waitForDaemonRunningWithinBudgetMock,
}));

vi.mock('@/daemon/restartDaemonAndWait', () => ({
    restartDaemonAndWait: restartDaemonAndWaitMock,
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
    evaluateDaemonStartupServiceConflict: evaluateDaemonStartupServiceConflictMock,
    renderDaemonInstalledServiceConflict: renderDaemonInstalledServiceConflictMock,
}));

describe('handleDaemonCliCommand ownership conflicts', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ]);

    afterEach(() => {
        envScope.restore();
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' }));
        spawnDetachedDaemonStartSyncMock.mockReset();
        stopDaemonMock.mockReset();
        waitForDaemonRunningWithinBudgetMock.mockReset();
        restartDaemonAndWaitMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockImplementation(async () => ({ kind: 'none' }));
        renderDaemonInstalledServiceConflictMock.mockReset();
        renderDaemonInstalledServiceConflictMock.mockImplementation((params?: { action?: string }) => ({
            title: 'A background service is already installed for the selected relay.',
            lines: params?.action === 'daemon-restart'
                ? [
                    'Use `happier doctor repair` to switch automatic startup to this installation.',
                    'If you want to restart the daemon manually, stop or replace the installed background service first.',
                ]
                : [
                    'Use `happier service start` to start the installed background service instead of starting another daemon.',
                    'If you want to start another daemon, stop or replace the installed background service first.',
                ],
        }));
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('fails closed for daemon start and stop when a background service is already running for the selected relay', async () => {
        await withTempDir('happier-daemon-service-owned-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const serviceOwnedState = {
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
                startupSource: 'background-service' as const,
                serviceLabel: 'com.happier.cli.daemon.default',
            };
            writeDaemonState(serviceOwnedState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: serviceOwnedState,
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                const startOutput = captureConsoleText();
                try {
                    await expect(
                        handleDaemonCliCommand({
                            args: ['daemon', 'start'],
                            rawArgv: ['node', 'happier', 'daemon', 'start'],
                            terminalRuntime: null,
                        }),
                    ).rejects.toThrow(/exit:1/);
                } finally {
                    startOutput.restore();
                }

                expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
                expect(startOutput.text()).toContain('background service');
                expect(startOutput.text()).toContain('selected relay');
                expect(startOutput.text()).toContain('happier doctor repair');

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

                expect(restartOutput.text()).toContain('background service');
                expect(restartOutput.text()).toContain('happier doctor repair');
                expect(restartOutput.text()).not.toContain('happier service stop');
            } finally {
                exitSpy.mockRestore();
            }
        });
    });

    it('allows daemon start takeover to spawn a replacement relay when the current owner is manual', async () => {
        await withTempDir('happier-daemon-start-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const manualOwnedState = {
                pid: process.pid,
                httpPort: 43114,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
                startupSource: 'manual' as const,
                runtimeId: 'runtime-manual',
            };
            writeDaemonState(manualOwnedState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: manualOwnedState,
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
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: compatibleState,
            });

            const output = captureStdoutJsonOutput<{
                ok: boolean;
                status: string;
                relayId: string;
                relay: string;
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
                relay: 'https://cloud.example.test',
            }));
            output.restore();
        });
    });

    it('fails closed for daemon restart without --takeover when a manual daemon is already running', async () => {
        await withTempDir('happier-daemon-restart-manual-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const manualOwnedState = {
                pid: process.pid,
                httpPort: 43119,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
                startupSource: 'manual' as const,
                runtimeId: 'runtime-manual-restart',
            };
            writeDaemonState(manualOwnedState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: manualOwnedState,
            });

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart'],
                        rawArgv: ['node', 'happier', 'daemon', 'restart'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(stopDaemonMock).not.toHaveBeenCalled();
            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(waitForDaemonRunningWithinBudgetMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('manual daemon');
            expect(output.text()).toContain('daemon restart --takeover');
        });
    });

    it('fails closed when daemon restart sees an installed background service for the active relay', async () => {
        await withTempDir('happier-daemon-restart-service-installed-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: '',
            });
            vi.resetModules();

            const [{ handleDaemonCliCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('./daemon'),
                import('@/daemon/service/cli'),
            ]);
            evaluateDaemonStartupServiceConflictMock.mockImplementationOnce(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({
                kind: 'installed-background-service-conflict',
                services: [{
                  label: 'background-service',
                  name: 'background-service',
                  installed: true,
                  serverId: 'cloud',
                  platform: 'linux',
                  releaseChannel: 'stable',
                  targetMode: 'default-following',
                  path: join(homeDir, '.config/systemd/user/happier-daemon.cloud.service'),
                }],
            }));

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(paths.installedPath, '[unit]', 'utf-8');

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            const output = captureConsoleText();
            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart'],
                        rawArgv: ['node', 'happier', 'daemon', 'restart'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(stopDaemonMock).not.toHaveBeenCalled();
            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(waitForDaemonRunningWithinBudgetMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('background service is already installed');
            expect(output.text()).toContain('happier doctor repair');
        });
    });

    it('prints JSON when daemon start is blocked by an installed background service', async () => {
        await withTempDir('happier-daemon-start-json-service-installed-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: '',
            });
            vi.resetModules();

            const [{ handleDaemonCliCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('./daemon'),
                import('@/daemon/service/cli'),
            ]);
            evaluateDaemonStartupServiceConflictMock.mockImplementationOnce(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({
                kind: 'installed-background-service-conflict',
                services: [{
                  label: 'background-service',
                  name: 'background-service',
                  installed: true,
                  serverId: 'cloud',
                  platform: 'linux',
                  releaseChannel: 'stable',
                  targetMode: 'default-following',
                  path: join(homeDir, '.config/systemd/user/happier-daemon.cloud.service'),
                }],
            }));

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(paths.installedPath, '[unit]', 'utf-8');

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

    it('allows daemon restart takeover to replace a manual daemon explicitly', async () => {
        await withTempDir('happier-daemon-restart-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const manualOwnedState = {
                pid: process.pid,
                httpPort: 43120,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
                startupSource: 'manual' as const,
                runtimeId: 'runtime-manual-restart',
            };
            writeDaemonState(manualOwnedState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: manualOwnedState,
            });

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart', '--takeover'],
                        rawArgv: ['node', 'happier', 'daemon', 'restart', '--takeover'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(restartDaemonAndWaitMock).toHaveBeenCalledWith({ stopSessions: false, takeover: true });
            expect(output.text()).toContain('Taking over the current manual daemon');
        });
    });

    it('allows daemon stop to stop a legacy manual daemon without startup metadata', async () => {
        await withTempDir('happier-daemon-stop-legacy-manual-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const legacyManualState = {
                pid: process.pid,
                httpPort: 43124,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
            };
            writeDaemonState(legacyManualState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: legacyManualState,
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'stop'],
                        rawArgv: ['node', 'happier', 'daemon', 'stop'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:0/);
            } finally {
                exitSpy.mockRestore();
            }

            expect(stopDaemonMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows daemon restart takeover to replace a legacy manual daemon without startup metadata', async () => {
        await withTempDir('happier-daemon-restart-legacy-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const legacyManualState = {
                pid: process.pid,
                httpPort: 43125,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
            };
            writeDaemonState(legacyManualState);
            inspectDaemonMock.mockResolvedValue({
                status: 'running',
                state: legacyManualState,
            });

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart', '--takeover'],
                        rawArgv: ['node', 'happier', 'daemon', 'restart', '--takeover'],
                        terminalRuntime: null,
                    }),
                ).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(restartDaemonAndWaitMock).toHaveBeenCalledWith({ stopSessions: false, takeover: true });
            expect(output.text()).toContain('Taking over the current manual daemon');
        });
    });

    it('fails closed for daemon start when a background service is installed for the active relay', async () => {
        await withTempDir('happier-daemon-service-installed-', async (homeDir) => {
            const happierHomeDir = join(homeDir, '.happier');
            envScope.patch({
                HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: '',
                HAPPIER_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_WEBAPP_URL: 'https://cloud.example.test',
            });
            vi.resetModules();

            const [{ handleDaemonCliCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('./daemon'),
                import('@/daemon/service/cli'),
            ]);

            await writeDaemonSettingsFixture(happierHomeDir, {
                servers: {
                    cloud: {
                        id: 'cloud',
                        name: 'Cloud',
                        serverUrl: 'https://cloud.example.test',
                        webappUrl: 'https://cloud.example.test',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                },
            });

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );
            evaluateDaemonStartupServiceConflictMock.mockImplementationOnce(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({
                kind: 'installed-background-service-conflict',
                services: [
                    {
                        serverId: 'cloud',
                        name: 'Default background service',
                        installed: true,
                        platform: 'linux',
                        label: 'com.happier.cli.daemon.default',
                        releaseChannel: 'stable',
                        targetMode: 'default-following',
                        path: paths.installedPath,
                    },
                ],
            }));

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
});
