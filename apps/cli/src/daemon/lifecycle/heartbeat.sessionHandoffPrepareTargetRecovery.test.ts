import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' }) as any),
    };
});
vi.mock('@/persistence', () => ({
    readDaemonState: vi.fn(),
    writeDaemonState: vi.fn(),
}));

describe('startDaemonHeartbeatLoop session handoff prepare-target recovery', () => {
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    let happyHomeDir: string;

    beforeEach(() => {
        happyHomeDir = join(
            tmpdir(),
            `happier-cli-heartbeat-handoff-prepare-target-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
        vi.useFakeTimers();
        vi.resetModules();
    });

    afterEach(() => {
        delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
        if (existsSync(happyHomeDir)) {
            rmSync(happyHomeDir, { recursive: true, force: true });
        }
        if (originalHappyHomeDir === undefined) {
            delete process.env.HAPPIER_HOME_DIR;
        } else {
            process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('marks non-terminal prepare-target jobs as awaiting_recovery on daemon startup so status does not hang pending forever', async () => {
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
            (globalThis as any).__tick = handler;
            return 1 as any;
        }) as any);

        const { configuration } = await import('@/configuration');
        const { createSessionHandoffPrepareTargetJobStore } = await import(
            '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore',
        );

        const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir: configuration.activeServerDir });
        const jobId = 'prepare_restart_stale_1';
        const handoffId = 'handoff_restart_stale_1';
        await store.write({
            jobId,
            handoffId,
            createdAtMs: Date.now() - 5000,
            updatedAtMs: Date.now() - 5000,
            status: {
                handoffId,
                jobId,
                status: 'pending',
                phase: 'staging_target',
                transportStrategy: 'server_routed_stream',
                progress: {
                    updatedAtMs: Date.now() - 5000,
                    checkpoint: 'stage_target',
                    planned: {},
                    transferred: {},
                    current: { phaseDetail: 'importing_workspace' },
                    resumable: false,
                },
                recoveryActions: [],
            },
        });

        const { startDaemonHeartbeatLoop } = await import('./heartbeat');

        startDaemonHeartbeatLoop({
            pidToTrackedSession: new Map(),
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            getApiMachineForSessions: () => null,
            controlPort: 8765,
            fileState: {
                pid: process.pid,
                httpPort: 8765,
                startedAt: Date.now(),
                startedWithCliVersion: '1.0.0',
                daemonLogPath: '/tmp/daemon.log',
            },
            currentCliVersion: '1.0.0',
            requestShutdown: vi.fn(),
        });

        expect(setIntervalSpy).toHaveBeenCalled();
        const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
        expect(tick).toBeTypeOf('function');

        await tick!();

        const recovered = await store.read(jobId);
        expect(recovered?.status.status).toBe('awaiting_recovery');
        expect(recovered?.lastErrorMessage?.toLowerCase()).toContain('daemon');
        expect(recovered?.status.progress?.current?.phaseDetail?.toLowerCase()).toContain('daemon');
    });
});
