import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

    it('hydrates non-terminal prepare-target jobs as awaiting explicit user Resume on daemon startup', async () => {
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
        const jobPath = join(
            configuration.activeServerDir,
            'session-handoff',
            'prepare-target-jobs',
            `${jobId}.json`,
        );
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
            prepareTargetRequest: {
                handoffId,
                sourceMachineId: 'machine-source',
                targetMachineId: 'machine-target',
                negotiatedTransportStrategy: 'server_routed_stream',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo',
                endpointCandidates: [],
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
      writeDaemonStateForCurrentOwner: vi.fn(() => true),
        });

        expect(setIntervalSpy).toHaveBeenCalled();
        const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
        expect(tick).toBeTypeOf('function');

        await tick!();

        const recovered = await store.read(jobId);
        expect(recovered).toMatchObject({
            schemaVersion: 2,
            transitionRevision: 0,
            prepareRecovery: { status: 'awaiting_user_resume' },
            status: {
                status: 'awaiting_user_resume',
                progress: {
                    resumable: true,
                    current: { phaseDetail: 'daemon_restart_awaiting_user_resume' },
                },
            },
        });

        const recoveredBytes = readFileSync(jobPath);
        await tick!();
        expect(readFileSync(jobPath)).toEqual(recoveredBytes);
        const recoveredAfterSecondTick = await store.read(jobId);
        expect(
            recoveredAfterSecondTick?.schemaVersion === 2
                ? recoveredAfterSecondTick.transitionRevision
                : null,
        ).toBe(0);
    });

    it('rechecks startup recovery after a live prepare-target runner lease disappears', async () => {
        vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
            (globalThis as any).__tick = handler;
            return 1 as any;
        }) as any);

        const { configuration } = await import('@/configuration');
        const { createSessionHandoffPrepareTargetJobStore } = await import(
            '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore',
        );
        const {
            releaseSessionHandoffPrepareTargetJobLease,
            tryAcquireSessionHandoffPrepareTargetJobLease,
        } = await import('@/session/handoff/prepare/sessionHandoffPrepareTargetJobLease');

        const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir: configuration.activeServerDir });
        const jobId = 'prepare_restart_late_runner_exit_1';
        const handoffId = 'handoff_restart_late_runner_exit_1';
        const runnerOwnerId = `cli-daemon:${process.pid}:old-prepare-target-runner`;
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
            prepareTargetRequest: {
                handoffId,
                sourceMachineId: 'machine-source',
                targetMachineId: 'machine-target',
                negotiatedTransportStrategy: 'server_routed_stream',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo',
                endpointCandidates: [],
            },
        });
        await expect(tryAcquireSessionHandoffPrepareTargetJobLease({
            activeServerDir: configuration.activeServerDir,
            jobId,
            ownerId: runnerOwnerId,
            nowMs: Date.now(),
            ttlMs: 60_000,
        })).resolves.toMatchObject({ acquired: true });

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
      writeDaemonStateForCurrentOwner: vi.fn(() => true),
        });

        const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
        expect(tick).toBeTypeOf('function');
        await tick!();
        await expect(store.read(jobId)).resolves.toMatchObject({
            status: { status: 'pending' },
        });

        await releaseSessionHandoffPrepareTargetJobLease({
            activeServerDir: configuration.activeServerDir,
            jobId,
            ownerId: runnerOwnerId,
        });
        await tick!();

        await expect(store.read(jobId)).resolves.toMatchObject({
            schemaVersion: 2,
            transitionRevision: 0,
            prepareRecovery: { status: 'awaiting_user_resume' },
            status: {
                status: 'awaiting_user_resume',
                progress: {
                    resumable: true,
                    current: { phaseDetail: 'daemon_restart_awaiting_user_resume' },
                },
            },
        });

        const recoveredBytes = readFileSync(join(
            configuration.activeServerDir,
            'session-handoff',
            'prepare-target-jobs',
            `${jobId}.json`,
        ));
        await tick!();
        expect(readFileSync(join(
            configuration.activeServerDir,
            'session-handoff',
            'prepare-target-jobs',
            `${jobId}.json`,
        ))).toEqual(recoveredBytes);
    });
});
