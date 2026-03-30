import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

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

describe('startDaemonHeartbeatLoop workspace replication gc', () => {
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    let happyHomeDir: string;

    beforeEach(() => {
        happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-workspace-replication-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
        process.env.HAPPIER_DAEMON_WORKSPACE_REPLICATION_CAS_UNREFERENCED_TTL_MS = '1';
        vi.useFakeTimers();
        vi.resetModules();
    });

    afterEach(() => {
        delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
        delete process.env.HAPPIER_DAEMON_WORKSPACE_REPLICATION_CAS_UNREFERENCED_TTL_MS;
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

    it('removes stale unreferenced CAS blobs during heartbeat', async () => {
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
            (globalThis as any).__tick = handler;
            return 1 as any;
        }) as any);

        const { configuration } = await import('@/configuration');
        const {
            createWorkspaceReplicationPaths,
            resolveWorkspaceReplicationCasBlobPath,
        } = await import('@/workspaces/replication/state/workspaceReplicationPaths');

        const paths = createWorkspaceReplicationPaths({ activeServerDir: configuration.activeServerDir });
        const digest = `sha256:${'d'.repeat(64)}`;
        const blobPath = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest });
        mkdirSync(dirname(blobPath), { recursive: true });
        writeFileSync(blobPath, Buffer.from('stale', 'utf8'));
        const { utimes } = await import('node:fs/promises');
        await utimes(blobPath, 0, 0);

        expect(existsSync(blobPath)).toBe(true);

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

        expect(existsSync(blobPath)).toBe(false);
    });

    it('marks non-terminal workspace replication jobs as awaiting_recovery on daemon startup and clears stale leases', async () => {
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
            (globalThis as any).__tick = handler;
            return 1 as any;
        }) as any);

        const { configuration } = await import('@/configuration');
        const { createWorkspaceReplicationPaths, resolveWorkspaceReplicationJobPath } = await import(
            '@/workspaces/replication/state/workspaceReplicationPaths',
        );

        const paths = createWorkspaceReplicationPaths({ activeServerDir: configuration.activeServerDir });
        mkdirSync(paths.jobsDirectory, { recursive: true });
        const jobId = 'job_stale_1';
        const jobPath = resolveWorkspaceReplicationJobPath({ jobsDirectory: paths.jobsDirectory, jobId });
        const leasePath = join(paths.stagingDirectory, jobId, 'lease', 'lease.json');
        mkdirSync(join(paths.stagingDirectory, jobId, 'lease'), { recursive: true });
        writeFileSync(
            leasePath,
            JSON.stringify({
                ownerId: 'cli-daemon:999999',
                acquiredAtMs: Date.now() - 1000,
                renewedAtMs: Date.now() - 1000,
                expiresAtMs: Date.now() + 60 * 60 * 1000,
            }),
            'utf8',
        );
        expect(existsSync(leasePath)).toBe(true);

        const createdAtMs = Date.now() - 5000;
        const updatedAtMs = Date.now() - 5000;
        writeFileSync(
            jobPath,
            JSON.stringify({
                schemaVersion: 1,
                jobId,
                createdAtMs,
                updatedAtMs,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                    progressCounters: {
                        plannedFiles: 1,
                        plannedBytes: 1,
                        transferredFiles: 0,
                        transferredBytes: 0,
                        appliedFiles: 0,
                        appliedBytes: 0,
                    },
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            }),
            'utf8',
        );

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

        const { readFile } = await import('node:fs/promises');
        const recovered = JSON.parse(await readFile(jobPath, 'utf8')) as any;
        expect(recovered.status).toBeTypeOf('object');
        expect(recovered.status?.status).toBe('awaiting_recovery');
        expect(recovered.status?.warnings).toContain('recovered_after_daemon_restart');
        expect(String(recovered.lastErrorMessage ?? '').toLowerCase()).toContain('daemon');
        expect(existsSync(leasePath)).toBe(false);
    });
});
