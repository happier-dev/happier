// Prepare the real normal-command runtime during collection, as before lazy worker dispatch.
import './daemonControl';

import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import { resolveDaemonServiceSystemdUnitLabel } from '@/daemon/service/plan';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const { inspectDaemonMock, startDaemonMock, serviceManager } = vi.hoisted(() => ({
    inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
    startDaemonMock: vi.fn(async () => {}),
    /** systemd's `ActiveState` per unit, as `systemctl show` reports it (OS boundary). */
    serviceManager: { activeStateByUnit: new Map<string, string>() },
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawnSync: (command: string, args: readonly string[] = [], options?: Parameters<typeof actual.spawnSync>[2]) => {
            if (command === 'systemctl' && args.includes('show')) {
                const unit = args.find((arg) => arg.endsWith('.service')) ?? '';
                const activeState = serviceManager.activeStateByUnit.get(unit) ?? 'inactive';
                return { status: 0, stdout: `ActiveState=${activeState}\nSubState=${activeState === 'active' ? 'running' : 'dead'}\n`, stderr: '' };
            }
            return actual.spawnSync(command, [...args], options ?? {});
        },
    };
});

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
    };
});

vi.mock('@/daemon/startDaemon', () => ({
    startDaemon: startDaemonMock,
}));

// The real ownership evaluation runs unless a case substitutes the owner it reports.
const ownerEvaluation = vi.hoisted(() => ({ next: null as null | (() => Promise<unknown>) }));
vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/ownership/evaluateCurrentDaemonOwner')>();
    return {
        ...actual,
        evaluateCurrentDaemonOwner: (...args: Parameters<typeof actual.evaluateCurrentDaemonOwner>) => {
            const substitute = ownerEvaluation.next;
            return substitute
                ? substitute() as ReturnType<typeof actual.evaluateCurrentDaemonOwner>
                : actual.evaluateCurrentDaemonOwner(...args);
        },
    };
});

import { reloadConfiguration } from '@/configuration';
import { writeSettings } from '@/persistence';
import { resolveDaemonServiceLaunchdLabel } from '@/daemon/service/plan';
import { writeInstalledLinuxDaemonService } from '@/daemon/service/installedDaemonServices.testkit';
import { handleDaemonCliCommand } from './daemon';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('handleDaemonCliCommand: daemon start-sync', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_RUNTIME_ID',
    ]);

    afterEach(() => {
        envScope.restore();
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' }));
        startDaemonMock.mockReset();
        vi.restoreAllMocks();
        ownerEvaluation.next = null;
        reloadConfiguration();
    });

    it('fails closed when a different relay owner already owns the relay', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: '',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(handleDaemonCliCommand({
            args: ['daemon', 'start-sync'],
        } as never)).rejects.toThrow(/exit:1/);

        expect(startDaemonMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('already owns this relay');
    });

    it('tells start-sync callers to use the matching takeover command for a manual relay runtime', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'unknown',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-manual-conflict',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const output = captureConsoleText();

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(startDaemonMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(output.text()).toContain('daemon start-sync --takeover');
        expect(output.text()).not.toContain('daemon start --takeover');
    });

    it('allows a stale manual relay owner to be replaced without requiring takeover', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-stale-manual',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledWith({ takeover: false });
    });

    it('passes explicit plugin recovery to the synchronous daemon owner', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync', '--plugin-recovery'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledWith({
            takeover: false,
            pluginRecovery: true,
        });
    });

    it('does not short-circuit a self-restart replacement when the current daemon is compatible', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
            HAPPIER_DAEMON_RUNTIME_ID: 'runtime-compatible',
        });
        const compatibleInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.2.8',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-compatible',
            },
        };
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        ownerEvaluation.next = async () => ({
                kind: 'compatible' as const,
                owner: {
                    status: 'running' as const,
                    state: compatibleInspection.state,
                    currentCliVersion: '0.2.10',
                    currentPublicReleaseChannel: 'stable' as const,
                    versionMatches: true,
                    releaseChannelMatches: true,
                    serviceManaged: false,
                    startupSource: 'manual' as const,
                },
            });

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledTimes(1);
        expect(startDaemonMock).toHaveBeenCalledWith({ takeover: false });
    });

    it('lets a pinned service that starts after the default-following one take its server over', async () => {
        // Login order is not deterministic: the default-following daemon may hold this server's
        // lock first. The pinned service must not stop at "already running" behind it.
        envScope.patch({ HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' });
        const targetModeScope = createEnvKeyScope(['HAPPIER_DAEMON_SERVICE_TARGET_MODE']);
        targetModeScope.patch({ HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned' });
        try {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            ownerEvaluation.next = async () => ({
                    kind: 'compatible' as const,
                    owner: {
                        status: 'running' as const,
                        source: 'state' as const,
                        state: {
                            pid: process.pid,
                            httpPort: 43141,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.3.0',
                            startupSource: 'background-service' as const,
                            serviceLabel: resolveDaemonServiceLaunchdLabel('default', 'stable', 'default-following'),
                        },
                        currentCliVersion: '0.3.0',
                        currentPublicReleaseChannel: 'stable' as const,
                        versionMatches: true,
                        releaseChannelMatches: true,
                        serviceManaged: true,
                        startupSource: 'background-service' as const,
                    },
                });
            const output = captureConsoleText();
            try {
                await expect(handleDaemonCliCommand({
                    args: ['daemon', 'start-sync', '--takeover'],
                } as never)).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(output.text()).not.toContain('Daemon already running');
            expect(startDaemonMock).toHaveBeenCalledWith({ takeover: true });
        } finally {
            targetModeScope.restore();
        }
    });

    describe('default-following background service', () => {
        const serviceEnvScope = createEnvKeyScope([
            'HAPPIER_HOME_DIR',
            'HAPPIER_ACTIVE_SERVER_ID',
            'HAPPIER_SERVER_URL',
            'HAPPIER_WEBAPP_URL',
            'HAPPIER_PUBLIC_SERVER_URL',
            'HAPPIER_DAEMON_SERVICE_PLATFORM',
            'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
            'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
            'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        ]);

        afterEach(() => {
            serviceEnvScope.restore();
            serviceManager.activeStateByUnit.clear();
        });

        async function startDefaultFollowingService(params: Readonly<{
            activeServerId: string;
            pinnedServerId: string;
            /** The pinned unit's systemd `ActiveState`. */
            pinnedActiveState?: string;
        }>): Promise<Readonly<{ exitCode: unknown; output: string }>> {
            serviceManager.activeStateByUnit.set(
                `${resolveDaemonServiceSystemdUnitLabel(params.pinnedServerId, 'stable', 'pinned')}.service`,
                params.pinnedActiveState ?? 'active',
            );
            return await withTempDir('happier-start-sync-default-following-', async (root) => {
                const userHomeDir = join(root, 'user');
                const happierHomeDir = join(userHomeDir, '.happier');
                envScope.patch({ HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' });
                serviceEnvScope.patch({
                    HAPPIER_HOME_DIR: happierHomeDir,
                    // The default-following unit pins no server: its daemon follows the settings.
                    HAPPIER_ACTIVE_SERVER_ID: undefined,
                    HAPPIER_SERVER_URL: undefined,
                    HAPPIER_WEBAPP_URL: undefined,
                    HAPPIER_PUBLIC_SERVER_URL: undefined,
                    HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                    HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
                    HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
                    // As the installed default-following unit sets it for its daemon.
                    HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                });
                reloadConfiguration();
                const profile = (id: string) => ({
                    id,
                    name: id,
                    serverUrl: `https://${id}.example.test`,
                    webappUrl: `https://${id}.example.test`,
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                });
                await writeSettings({
                    schemaVersion: 6,
                    onboardingCompleted: false,
                    activeServerId: params.activeServerId,
                    servers: { home: profile('home'), work: profile('work') },
                    machineIdByServerId: {},
                    machineIdByServerIdByAccountId: {},
                    lastTokenSubByServerId: {},
                    machineIdConfirmedByServerByServerId: {},
                });
                writeInstalledLinuxDaemonService({ userHomeDir, happierHomeDir, targetMode: 'default-following' });
                writeInstalledLinuxDaemonService({
                    userHomeDir,
                    happierHomeDir,
                    targetMode: 'pinned',
                    serverId: params.pinnedServerId,
                    serverUrl: `https://${params.pinnedServerId}.example.test`,
                });
                // A daemon process reads the selected server once, at startup, from these settings.
                reloadConfiguration();

                const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                    throw new Error(`exit:${code ?? ''}`);
                }) as never);
                const output = captureConsoleText();
                try {
                    await handleDaemonCliCommand({ args: ['daemon', 'start-sync', '--takeover'] } as never).catch(() => undefined);
                } finally {
                    output.restore();
                }
                return { exitCode: exitSpy.mock.calls[0]?.[0], output: output.text() };
            });
        }

        it('yields with a named reason and a clean exit when the followed server has this home\'s pinned service', async () => {
            const { exitCode, output } = await startDefaultFollowingService({ activeServerId: 'home', pinnedServerId: 'home' });

            // A clean exit: launchd (`SuccessfulExit=false`), systemd (`on-failure`) and Task
            // Scheduler restart only failures, so the default service stays down instead of
            // competing with the pinned one for the per-server lock.
            expect(startDaemonMock).not.toHaveBeenCalled();
            expect(exitCode).toBe(0);
            expect(output).toContain(resolveDaemonServiceSystemdUnitLabel('home', 'stable', 'pinned'));
        });

        it('serves the followed server when its pinned service is stopped, so the Home is never left unserved', async () => {
            const { exitCode } = await startDefaultFollowingService({ activeServerId: 'home', pinnedServerId: 'home', pinnedActiveState: 'inactive' });

            expect(startDaemonMock).toHaveBeenCalledWith({ takeover: true });
            expect(exitCode).toBe(0);
        });

        it('serves the followed server when the pinned service belongs to another server', async () => {
            const { exitCode } = await startDefaultFollowingService({ activeServerId: 'work', pinnedServerId: 'home' });

            expect(startDaemonMock).toHaveBeenCalledWith({ takeover: true });
            expect(exitCode).toBe(0);
        });
    });
});
