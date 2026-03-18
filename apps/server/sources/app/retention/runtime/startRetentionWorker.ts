import { maybeCaptureSentryMonitorCheckIn } from '@/app/monitoring/sentryMonitors';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { resolveEffectiveRetentionEnabled } from '@/app/retention/config/retentionPolicyState';

import { runRetentionSweep } from './runRetentionSweep';
import { logRetentionSweepCompleted, logRetentionSweepFailed } from './retentionRunLogging';
import { acquireRetentionSweepLock } from './retentionSweepLock';

const RETENTION_SWEEP_LOCK_TTL_FLOOR_MS = 30 * 60 * 1000;

export function startRetentionWorker(): { stop: () => void } | null {
    const policy = readRetentionPolicyFromEnv(process.env);
    if (!resolveEffectiveRetentionEnabled(policy)) {
        return null;
    }

    let stopped = false;
    let running = false;

    const run = async (reason: 'startup' | 'interval') => {
        if (running || stopped) return;
        running = true;
        const lock = await acquireRetentionSweepLock({
            ttlMs: Math.max(RETENTION_SWEEP_LOCK_TTL_FLOOR_MS, policy.intervalMs),
        });
        if (!lock) {
            running = false;
            return;
        }

        try {
            await maybeCaptureSentryMonitorCheckIn({
                env: process.env,
                monitorSlug: 'server.retentionWorker',
                intervalMs: policy.intervalMs,
                run: async () => {
                    const result = await runRetentionSweep({ policy });
                    logRetentionSweepCompleted({
                        reason,
                        deleted: result.deleted,
                        byRule: result.byRule,
                        dryRun: policy.dryRun,
                    });
                },
            });
        } catch (error) {
            logRetentionSweepFailed({ reason, error });
        } finally {
            await lock.release();
            running = false;
        }
    };

    void run('startup');

    const timer = setInterval(() => {
        void run('interval');
    }, policy.intervalMs);
    timer.unref?.();

    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}
