import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRunningInspection } from './controlClient';

const stopDaemonMock = vi.fn(async () => undefined);
const checkIfDaemonRunningMock = vi.fn(async () => true);
const inspectDaemonRunningStateMock = vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({
    status: 'running' as const,
    state: {
        pid: 1234,
        startedAt: 100,
        httpPort: 9400,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        controlToken: 'token-1',
    },
}));
const spawnDetachedDaemonStartSyncMock = vi.fn<(params?: Record<string, unknown>) => Promise<{ unref: () => void }>>(async () => ({ unref: vi.fn() }));
const waitForDaemonRunningWithinBudgetMock = vi.fn(async () => true);
const restartAllDaemonSessionRunnersMock = vi.fn(async () => ({
    ok: true,
    mode: 'force_current_cli' as const,
    requestedCount: 1,
    restartedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    results: [],
}));

describe('restartDaemonAndWait', () => {
    afterEach(() => {
        stopDaemonMock.mockReset();
        checkIfDaemonRunningMock.mockReset();
        inspectDaemonRunningStateMock.mockReset();
        spawnDetachedDaemonStartSyncMock.mockReset();
        waitForDaemonRunningWithinBudgetMock.mockReset();
        restartAllDaemonSessionRunnersMock.mockReset();
        vi.restoreAllMocks();
        vi.resetModules();
        delete process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS;
    });

    async function importSubject() {
        vi.doMock('@/daemon/controlClient', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
            return {
                ...actual,
                stopDaemon: stopDaemonMock,
                restartAllDaemonSessionRunners: restartAllDaemonSessionRunnersMock,
                checkIfDaemonRunningAndCleanupStaleState: checkIfDaemonRunningMock,
                inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonRunningStateMock,
            };
        });
        vi.doMock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
            spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
        }));
        vi.doMock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
            waitForDaemonRunningWithinBudget: waitForDaemonRunningWithinBudgetMock,
        }));

        stopDaemonMock.mockImplementation(async () => undefined);
        checkIfDaemonRunningMock.mockImplementation(async () => true);
        inspectDaemonRunningStateMock.mockImplementationOnce(async () => ({
            status: 'running',
            state: {
                pid: 1234,
                startedAt: 100,
                httpPort: 9400,
                startedWithCliVersion: '0.2.8',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                controlToken: 'token-1',
            },
        }));
        inspectDaemonRunningStateMock.mockImplementation(async () => ({
            status: 'running',
            state: {
                pid: 5678,
                startedAt: 200,
                httpPort: 9500,
                startedWithCliVersion: '0.2.8',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'self-restart',
                controlToken: 'token-2',
            },
        }));
        spawnDetachedDaemonStartSyncMock.mockImplementation(async () => ({ unref: vi.fn() }));
        waitForDaemonRunningWithinBudgetMock.mockImplementation(async () => true);
        restartAllDaemonSessionRunnersMock.mockImplementation(async () => ({
            ok: true,
            mode: 'force_current_cli',
            requestedCount: 1,
            restartedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            results: [],
        }));
        process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS = '1';

        return await import('./restartDaemonAndWait');
    }

    it('restarts through the self-restart takeover path by default', async () => {
        const { restartDaemonAndWait } = await importSubject();

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: true,
        });

        expect(stopDaemonMock).toHaveBeenCalledWith({
            stopSessions: true,
        });
        expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
            startupSource: 'self-restart',
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledTimes(1);
    });

    it('omits takeover only when explicitly disabled', async () => {
        const { restartDaemonAndWait } = await importSubject();

        await expect(restartDaemonAndWait({ stopSessions: false, takeover: false })).resolves.toEqual({
            ok: true,
        });

        expect(stopDaemonMock).toHaveBeenCalledWith({
            stopSessions: false,
        });
        expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
            startupSource: 'self-restart',
        }));
        const firstCall = (spawnDetachedDaemonStartSyncMock.mock.calls[0] ?? [undefined])[0] as Record<string, unknown> | undefined;
        expect(firstCall).toBeDefined();
        expect(firstCall).not.toHaveProperty('env.HAPPIER_DAEMON_TAKEOVER');
    });

    it('does not report success when stopping the old daemon fails', async () => {
        const { restartDaemonAndWait } = await importSubject();
        stopDaemonMock.mockRejectedValueOnce(new Error('stop failed'));

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'stop',
            daemonStatusAfterFailure: 'running',
        });

        expect(stopDaemonMock).toHaveBeenCalledWith({
            stopSessions: true,
        });
        expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
            startupSource: 'self-restart',
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledTimes(1);
    });

    it('does not report success when the restarted daemon is not proven running', async () => {
        const { restartDaemonAndWait } = await importSubject();
        waitForDaemonRunningWithinBudgetMock.mockResolvedValueOnce(false);

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'start',
            daemonStatusAfterFailure: 'running',
        });

        expect(stopDaemonMock).toHaveBeenCalledWith({
            stopSessions: true,
        });
        expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
        expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledTimes(1);
    });

    it('reports the failed phase and the daemon state it leaves behind when the start half fails', async () => {
        // F-DAEMON-6: `happier daemon restart` stopped the daemon, failed to start the replacement and
        // reported only "Failed to restart daemon" — the user was never told the stack was now
        // daemonless, nor what to run. A bare `{ ok: false }` cannot carry any of that.
        const { restartDaemonAndWait } = await importSubject();
        waitForDaemonRunningWithinBudgetMock.mockResolvedValueOnce(false);
        inspectDaemonRunningStateMock.mockReset();
        inspectDaemonRunningStateMock
            .mockResolvedValueOnce({
                status: 'running',
                state: {
                    pid: 1234,
                    startedAt: 100,
                    httpPort: 9400,
                    startedWithCliVersion: '0.2.8',
                    startedWithPublicReleaseChannel: 'preview',
                    startupSource: 'manual',
                    controlToken: 'token-1',
                },
            })
            .mockResolvedValue({ status: 'not-running' });

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'start',
            daemonStatusAfterFailure: 'not-running',
        });
    });

    it('reports a stop-phase failure while naming the daemon that is now running', async () => {
        // The mirror-image lie: the replacement daemon is up and healthy, but because the OLD daemon's
        // stop could not be confirmed the command printed the same bare "Failed to restart daemon".
        const { restartDaemonAndWait } = await importSubject();
        stopDaemonMock.mockRejectedValueOnce(new Error('stop failed'));

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'stop',
            daemonStatusAfterFailure: 'running',
        });
    });

    it('uses the shared daemon startup wait budget by default', async () => {
        const { restartDaemonAndWait } = await importSubject();

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: true,
        });

        expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledWith(expect.objectContaining({
            timeoutMs: 60_000,
            pollMs: 100,
        }));
    });

    it('does not report success when restart keeps the same daemon identity', async () => {
        const { restartDaemonAndWait } = await importSubject();
        inspectDaemonRunningStateMock.mockReset();
        inspectDaemonRunningStateMock
            .mockResolvedValueOnce({
                status: 'running',
                state: {
                    pid: 2222,
                    startedAt: 500,
                    httpPort: 9400,
                    startedWithCliVersion: '0.2.8',
                    startedWithPublicReleaseChannel: 'preview',
                    startupSource: 'manual',
                    controlToken: 'same-token',
                },
            })
            .mockResolvedValueOnce({
                status: 'running',
                state: {
                    pid: 2222,
                    startedAt: 500,
                    httpPort: 9400,
                    startedWithCliVersion: '0.2.8',
                    startedWithPublicReleaseChannel: 'preview',
                    startupSource: 'manual',
                    controlToken: 'same-token',
                },
            });

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'start',
            daemonStatusAfterFailure: 'running',
        });
    });

    it('does not report success when daemon is not stable after restart wait', async () => {
        const { restartDaemonAndWait } = await importSubject();
        inspectDaemonRunningStateMock.mockReset();
        inspectDaemonRunningStateMock
            .mockResolvedValueOnce({
                status: 'not-running',
            })
            .mockResolvedValue({
                status: 'not-running',
            });

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'start',
            daemonStatusAfterFailure: 'not-running',
        });
    });

    it('does not restart session runners by default', async () => {
        const { restartDaemonAndWait } = await importSubject();

        await expect(restartDaemonAndWait({ stopSessions: false })).resolves.toEqual({
            ok: true,
        });

        expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    });

    it('restarts session runners only after the new daemon is stable when explicitly requested', async () => {
        const events: string[] = [];
        const { restartDaemonAndWait } = await importSubject();
        waitForDaemonRunningWithinBudgetMock.mockImplementation(async () => {
            events.push('wait-new-daemon');
            return true;
        });
        restartAllDaemonSessionRunnersMock.mockImplementation(async () => {
            events.push('restart-runners');
            return {
                ok: true,
                mode: 'force_current_cli',
                requestedCount: 1,
                restartedCount: 1,
                skippedCount: 0,
                failedCount: 0,
                results: [],
            };
        });

        await expect(restartDaemonAndWait({
            stopSessions: false,
            restartSessionRunners: true,
            restartSessionRunnersMode: 'force_current_cli',
        })).resolves.toEqual({
            ok: true,
            sessionRunnerRestart: {
                ok: true,
                mode: 'force_current_cli',
                requestedCount: 1,
                restartedCount: 1,
                skippedCount: 0,
                failedCount: 0,
                results: [],
            },
        });

        expect(restartAllDaemonSessionRunnersMock).toHaveBeenCalledWith({
            mode: 'force_current_cli',
            dryRun: false,
            reason: 'daemon_restart_session_runners',
        });
        expect(events).toEqual(['wait-new-daemon', 'restart-runners']);
    });

    it('does not restart runners when the daemon restart did not stabilize', async () => {
        const { restartDaemonAndWait } = await importSubject();
        waitForDaemonRunningWithinBudgetMock.mockResolvedValueOnce(false);

        await expect(restartDaemonAndWait({ stopSessions: false, restartSessionRunners: true })).resolves.toEqual({
            ok: false,
            failedPhase: 'start',
            daemonStatusAfterFailure: 'running',
        });

        expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    });
});
