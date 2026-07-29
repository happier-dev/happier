import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const {
    inspectDaemonMock,
    stopDaemonMock,
    spawnDetachedMock,
    waitRunningMock,
    restartDaemonAndWaitMock,
    restartAllSessionRunnersMock,
    restartSessionRunnerMock,
} = vi.hoisted(() => ({
    inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
    stopDaemonMock: vi.fn(),
	    spawnDetachedMock: vi.fn<(params?: Record<string, unknown>) => Promise<{ unref: () => void }>>(async () => ({ unref: () => {} })),
    waitRunningMock: vi.fn(async () => true),
    restartDaemonAndWaitMock: vi.fn(async (params: { stopSessions?: boolean; takeover?: boolean }): Promise<unknown> => {
        await stopDaemonMock({ stopSessions: params.stopSessions });
        await spawnDetachedMock(params.takeover === false ? {} : {
            env: {
                HAPPIER_DAEMON_TAKEOVER: '1',
            },
        });
        await waitRunningMock();
        return true;
    }),
    restartAllSessionRunnersMock: vi.fn(async () => ({
        ok: true,
        mode: 'if_stale',
        requestedCount: 1,
        restartedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        results: [{ ok: true, status: 'dry_run_restartable', sessionId: 'sess-1' }],
    })),
    restartSessionRunnerMock: vi.fn(async () => ({ ok: true, status: 'dry_run_restartable', sessionId: 'sess-1' })),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
        checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
        listDaemonSessions: vi.fn(async () => []),
        stopDaemon: stopDaemonMock,
        stopDaemonSession: vi.fn(async () => false),
        restartAllDaemonSessionRunners: restartAllSessionRunnersMock,
        requestDaemonSessionRunnerRestart: restartSessionRunnerMock,
    };
});

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedMock,
}));

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
    waitForDaemonRunningWithinBudget: waitRunningMock,
}));

vi.mock('@/daemon/restartDaemonAndWait', () => ({
    restartDaemonAndWait: restartDaemonAndWaitMock,
}));

vi.mock('@/daemon/multiDaemon', () => ({
    listDaemonStatusesForAllKnownServers: vi.fn(async () => []),
    stopAllDaemonsBestEffort: vi.fn(async () => {}),
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand: daemon restart', () => {
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
    ]);

    afterEach(() => {
        envScope.restore();
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' as const }));
        stopDaemonMock.mockReset();
        spawnDetachedMock.mockReset();
        waitRunningMock.mockReset();
        restartDaemonAndWaitMock.mockReset();
        restartDaemonAndWaitMock.mockImplementation(async (params: { stopSessions?: boolean; takeover?: boolean }): Promise<unknown> => {
            await stopDaemonMock({ stopSessions: params.stopSessions });
            await spawnDetachedMock(params.takeover === false ? {} : {
                env: {
                    HAPPIER_DAEMON_TAKEOVER: '1',
                },
            });
            await waitRunningMock();
            return true;
        });
        restartAllSessionRunnersMock.mockReset();
        restartAllSessionRunnersMock.mockResolvedValue({
            ok: true,
            mode: 'if_stale',
            requestedCount: 1,
            restartedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            results: [{ ok: true, status: 'dry_run_restartable', sessionId: 'sess-1' }],
        });
        restartSessionRunnerMock.mockReset();
        restartSessionRunnerMock.mockResolvedValue({ ok: true, status: 'dry_run_restartable', sessionId: 'sess-1' });
        vi.restoreAllMocks();
    });

    it('stops and then starts the daemon', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: false });
        expect(spawnDetachedMock).toHaveBeenCalledTimes(1);
        expect(waitRunningMock).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('passes stopSessions when --kill-sessions is provided', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--kill-sessions'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('rejects daemon restart runner refresh when sessions are killed', async () => {
        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--kill-sessions', '--restart-session-runners'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).not.toHaveBeenCalled();
        expect(output.text()).toContain('cannot be combined');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints daemon restart runner refresh summary in JSON output', async () => {
        restartDaemonAndWaitMock.mockImplementation(async () => ({
            ok: true,
            sessionRunnerRestart: {
                ok: true,
                mode: 'force_current_cli',
                requestedCount: 2,
                restartedCount: 1,
                skippedCount: 1,
                failedCount: 0,
                results: [
                    { ok: true, status: 'restarted', sessionId: 'sess-1' },
                    { ok: true, status: 'already_current', sessionId: 'sess-2' },
                ],
            },
        }));
        const output = captureStdoutJsonOutput();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--restart-session-runners', '--json'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(output.json()).toEqual(expect.objectContaining({
            ok: true,
            status: 'restarted',
            sessionRunnerRestart: expect.objectContaining({
                ok: true,
                requestedCount: 2,
                restartedCount: 1,
                skippedCount: 1,
                failedCount: 0,
            }),
        }));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('reports daemon restart runner refresh failures distinctly in text output', async () => {
        restartDaemonAndWaitMock.mockImplementation(async () => ({
            ok: false,
            sessionRunnerRestart: {
                ok: false,
                mode: 'force_current_cli',
                requestedCount: 2,
                restartedCount: 1,
                skippedCount: 0,
                failedCount: 1,
                results: [
                    { ok: true, status: 'restarted', sessionId: 'sess-1' },
                    {
                        ok: false,
                        status: 'spawn_failed',
                        sessionId: 'sess-2',
                        reasonCode: 'missing_credentials',
                    },
                ],
            },
        }));
        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--restart-session-runners'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(output.text()).not.toContain('Failed to restart daemon');
        expect(output.text()).toContain('Session runner restart failed after daemon restart');
        expect(output.text()).toContain('1 restarted, 0 skipped, 1 failed');
        expect(output.text()).toContain('sess-2: spawn_failed (missing_credentials)');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('reports daemon restart runner refresh failures distinctly in JSON output', async () => {
        restartDaemonAndWaitMock.mockImplementation(async () => ({
            ok: false,
            sessionRunnerRestart: {
                ok: false,
                mode: 'force_current_cli',
                requestedCount: 1,
                restartedCount: 0,
                skippedCount: 0,
                failedCount: 1,
                results: [
                    {
                        ok: false,
                        status: 'spawn_failed',
                        sessionId: 'sess-2',
                        reasonCode: 'missing_credentials',
                    },
                ],
            },
        }));
        const output = captureStdoutJsonOutput();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--restart-session-runners', '--json'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(output.json()).toEqual(expect.objectContaining({
            ok: false,
            error: 'session_runner_restart_failed_after_daemon_restart',
            message: 'Session runner restart failed after daemon restart',
            sessionRunnerRestart: expect.objectContaining({
                ok: false,
                failedCount: 1,
                results: [
                    expect.objectContaining({
                        sessionId: 'sess-2',
                        status: 'spawn_failed',
                        reasonCode: 'missing_credentials',
                    }),
                ],
            }),
        }));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('runs bulk session-runner restart command with dry-run JSON', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart-session-runners', '--dry-run', '--json'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(restartAllSessionRunnersMock).toHaveBeenCalledWith({
            mode: 'if_stale',
            dryRun: true,
            reason: 'daemon_restart_session_runners_command',
        });
        expect(restartSessionRunnerMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('runs single session-runner restart when --session-id is provided', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart-session-runners', '--session-id', 'sess-1', '--force-current-cli', '--dry-run', '--json'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(restartSessionRunnerMock).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            mode: 'force_current_cli',
            dryRun: true,
            reason: 'daemon_restart_session_runners_command',
        });
        expect(restartAllSessionRunnersMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('rejects a missing session id before falling back to bulk runner restart', async () => {
        const output = captureStdoutJsonOutput();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart-session-runners', '--force-current-cli', '--session-id', '--json'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(restartSessionRunnerMock).not.toHaveBeenCalled();
        expect(restartAllSessionRunnersMock).not.toHaveBeenCalled();
        expect(output.json()).toEqual({
            ok: false,
            error: 'session_id_required',
            message: 'Session id is required after --session-id.',
        });
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('forwards takeover intent to restartDaemonAndWait when --takeover is provided', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--takeover'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(spawnDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('fails closed without --takeover when a manual relay runtime owns the relay', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual-restart',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).not.toHaveBeenCalled();
        expect(spawnDetachedMock).not.toHaveBeenCalled();
        expect(waitRunningMock).not.toHaveBeenCalled();
        expect(output.text()).toContain('manual relay runtime');
        expect(output.text()).toContain('daemon restart --takeover');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails closed when the current relay owner source is unknown', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).not.toHaveBeenCalled();
        expect(spawnDetachedMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('daemon restart --takeover');
    });

    it('prints a takeover notice before restarting when --takeover replaces a manual relay runtime', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual-restart',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--takeover'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
        expect(spawnDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(waitRunningMock).toHaveBeenCalledTimes(1);
        expect(output.text()).toContain('Taking over the current manual relay runtime');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('fails closed when a background service is already installed for the active relay', async () => {
        await withTempDir('happier-daemon-restart-service-installed-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
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
                        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as any);

            try {
                expect(process.env.HAPPIER_DAEMON_STARTUP_SOURCE).toBe('self-restart');
                await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
            }

            expect(output.text()).toContain('background service is already installed');
            expect(output.text()).toContain('happier service restart');
            expect(stopDaemonMock).not.toHaveBeenCalled();
            expect(spawnDetachedMock).not.toHaveBeenCalled();
            expect(waitRunningMock).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
});
