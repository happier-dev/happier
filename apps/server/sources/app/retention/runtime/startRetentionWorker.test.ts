import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';

const readRetentionPolicyFromEnv = vi.fn();
const resolveEffectiveRetentionEnabled = vi.fn();
const runRetentionSweep = vi.fn();
const acquireRetentionSweepLock = vi.fn();
const maybeCaptureSentryMonitorCheckIn = vi.fn();
const logRetentionSweepCompleted = vi.fn();
const logRetentionSweepFailed = vi.fn();

vi.mock('@/app/retention/config/readRetentionPolicyFromEnv', () => ({
    readRetentionPolicyFromEnv,
}));

vi.mock('@/app/retention/config/retentionPolicyState', () => ({
    resolveEffectiveRetentionEnabled,
}));

vi.mock('./runRetentionSweep', () => ({
    runRetentionSweep,
}));

vi.mock('./retentionSweepLock', () => ({
    acquireRetentionSweepLock,
}));

vi.mock('@/app/monitoring/sentryMonitors', () => ({
    maybeCaptureSentryMonitorCheckIn,
}));

vi.mock('./retentionRunLogging', () => ({
    logRetentionSweepCompleted,
    logRetentionSweepFailed,
}));

function createPolicy(overrides: Partial<Pick<RetentionPolicy, 'enabled' | 'intervalMs' | 'batchSize' | 'dryRun' | 'maxDeletesPerRulePerRun'>> = {}): RetentionPolicy {
    return {
        enabled: true,
        intervalMs: 60_000,
        batchSize: 10,
        dryRun: false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'keep_forever' },
            userFeedItems: { mode: 'keep_forever' },
            sessionShareAccessLogs: { mode: 'keep_forever' },
            publicShareAccessLogs: { mode: 'keep_forever' },
            terminalAuthRequests: { mode: 'keep_forever' },
            accountAuthRequests: { mode: 'keep_forever' },
            authPairingSessions: { mode: 'keep_forever' },
            repeatKeys: { mode: 'keep_forever' },
            globalLocks: { mode: 'keep_forever' },
            automationRuns: { mode: 'keep_forever' },
            automationRunEvents: { mode: 'keep_forever' },
        },
        ...overrides,
    };
}

describe('startRetentionWorker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readRetentionPolicyFromEnv.mockReturnValue(createPolicy());
        resolveEffectiveRetentionEnabled.mockImplementation((policy: RetentionPolicy) => policy.enabled);
        acquireRetentionSweepLock.mockResolvedValue({
            release: vi.fn(async () => {}),
        });
        runRetentionSweep.mockResolvedValue({
            deleted: 1,
            byRule: { sessions: 1 },
        });
        maybeCaptureSentryMonitorCheckIn.mockImplementation(async ({ run }: { run: () => Promise<void> }) => run());
    });

    it('returns null when retention is disabled', async () => {
        readRetentionPolicyFromEnv.mockReturnValue(createPolicy({ enabled: false }));

        const { startRetentionWorker } = await import('./startRetentionWorker');
        expect(startRetentionWorker()).toBeNull();
        expect(acquireRetentionSweepLock).not.toHaveBeenCalled();
    });

    it('rethrows sweep failures so the monitor wrapper can capture them', async () => {
        const sweepError = new Error('retention sweep failed');
        const release = vi.fn(async () => {});
        acquireRetentionSweepLock.mockResolvedValueOnce({ release });
        runRetentionSweep.mockRejectedValueOnce(sweepError);

        let capturedRun: Promise<void> | undefined;
        maybeCaptureSentryMonitorCheckIn.mockImplementation(async ({ run }: { run: () => Promise<void> }) => {
            capturedRun = run();
            return capturedRun;
        });

        const { startRetentionWorker } = await import('./startRetentionWorker');
        const worker = startRetentionWorker();

        expect(worker).not.toBeNull();
        await vi.waitFor(() => {
            expect(capturedRun).toBeDefined();
        });
        await expect(capturedRun!).rejects.toBe(sweepError);
        expect(logRetentionSweepFailed).toHaveBeenCalledWith({
            reason: 'startup',
            error: sweepError,
        });
        expect(release).toHaveBeenCalledTimes(1);

        worker!.stop();
    });
});
