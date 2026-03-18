import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const maybeCaptureSentryMonitorCheckIn = vi.fn(async ({ run }: { run: () => Promise<void> }) => {
    await run();
});
const readRetentionPolicyFromEnv = vi.fn();
const resolveEffectiveRetentionEnabled = vi.fn();
const runRetentionSweep = vi.fn(async () => ({ deleted: 0, byRule: {} }));
const logRetentionSweepCompleted = vi.fn();
const logRetentionSweepFailed = vi.fn();
const acquireRetentionSweepLock = vi.fn();

vi.mock('@/app/monitoring/sentryMonitors', () => ({
    maybeCaptureSentryMonitorCheckIn,
}));

vi.mock('@/app/retention/config/readRetentionPolicyFromEnv', () => ({
    readRetentionPolicyFromEnv,
}));

vi.mock('@/app/retention/config/retentionPolicyState', () => ({
    resolveEffectiveRetentionEnabled,
}));

vi.mock('./runRetentionSweep', () => ({
    runRetentionSweep,
}));

vi.mock('./retentionRunLogging', () => ({
    logRetentionSweepCompleted,
    logRetentionSweepFailed,
}));

vi.mock('./retentionSweepLock', () => ({
    acquireRetentionSweepLock,
}));

function createPolicy(intervalMs: number) {
    return {
        enabled: true,
        intervalMs,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 1000,
        domains: {
            sessions: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'delete_older_than', days: 7 },
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
    };
}

describe('startRetentionWorker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        resolveEffectiveRetentionEnabled.mockReturnValue(true);
        acquireRetentionSweepLock.mockResolvedValue({
            release: vi.fn(async () => {}),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses a lock ttl floor that is longer than very short retention intervals', async () => {
        readRetentionPolicyFromEnv.mockReturnValue(createPolicy(15_000));

        const { startRetentionWorker } = await import('./startRetentionWorker');

        const worker = startRetentionWorker();
        await vi.advanceTimersByTimeAsync(0);

        expect(acquireRetentionSweepLock).toHaveBeenCalledWith({
            ttlMs: 30 * 60 * 1000,
        });
        worker?.stop();
    });
});
