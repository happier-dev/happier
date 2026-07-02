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

describe('restartDaemonAndWait', () => {
    afterEach(() => {
        stopDaemonMock.mockReset();
        checkIfDaemonRunningMock.mockReset();
        inspectDaemonRunningStateMock.mockReset();
        spawnDetachedDaemonStartSyncMock.mockReset();
        waitForDaemonRunningWithinBudgetMock.mockReset();
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
        process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS = '1';

        return await import('./restartDaemonAndWait');
    }

    it('restarts through the self-restart takeover path by default', async () => {
        const { restartDaemonAndWait } = await importSubject();

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toBe(true);

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
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

        await expect(restartDaemonAndWait({ stopSessions: false, takeover: false })).resolves.toBe(true);

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

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toBe(false);

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
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

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toBe(false);

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
        expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
        expect(waitForDaemonRunningWithinBudgetMock).toHaveBeenCalledTimes(1);
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

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toBe(false);
    });

    it('does not report success when daemon is not stable after restart wait', async () => {
        const { restartDaemonAndWait } = await importSubject();
        inspectDaemonRunningStateMock.mockReset();
        inspectDaemonRunningStateMock
            .mockResolvedValueOnce({
                status: 'not-running',
            })
            .mockResolvedValueOnce({
                status: 'not-running',
            });

        await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toBe(false);
    });
});
