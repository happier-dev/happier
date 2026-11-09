import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, reloadConfiguration } from '@/configuration';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { releaseSessionHandoffPrepareTargetJobLease, tryAcquireSessionHandoffPrepareTargetJobLease } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobLease';
import { startDaemonHeartbeatLoop } from './heartbeat';

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
        reloadConfiguration();
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
        reloadConfiguration();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('hydrates non-terminal prepare-target jobs as awaiting explicit user Resume on daemon startup', async () => {
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
            (globalThis as any).__tick = handler;
            return 1 as any;
        }) as any);

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
            currentCliVersion: configuration.currentCliVersion,
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
        const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
            activeServerDir: configuration.activeServerDir,
            jobId,
            ownerId: runnerOwnerId,
            nowMs: Date.now(),
        });
        expect(leaseAttempt.acquired).toBe(true);
        if (!leaseAttempt.acquired) throw new Error('Missing live target owner');

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
            currentCliVersion: configuration.currentCliVersion,
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
            leaseId: leaseAttempt.lease.leaseId,
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
