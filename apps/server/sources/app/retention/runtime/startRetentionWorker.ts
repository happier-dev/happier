import type { ServerConfigEnv } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import { maybeCaptureSentryMonitorCheckIn } from '@/app/monitoring/sentryMonitors';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { hasRetentionRulesThatRunWhenGlobalPolicyIsDisabled } from '@/app/retention/config/retentionDomains';
import { resolveEffectiveRetentionEnabled } from '@/app/retention/config/retentionPolicyState';

import { runRetentionSweep } from './runRetentionSweep';
import { logRetentionSweepCompleted, logRetentionSweepFailed } from './retentionRunLogging';
import { acquireRetentionSweepLock } from './retentionSweepLock';
import { retentionSweepLockTtlMs } from './retentionSweepLockTtl';

/**
 * The retention worker. The policy — switches, domain rules, cadence and resource caps — is
 * resolved through the Home overlay at every sweep (plan §3.6), so a rule an owner stores from the
 * console applies to the next sweep without a restart, and the next sweep is scheduled with the
 * interval that sweep read.
 */
export function startRetentionWorker(params: Readonly<{
    /** The Home-effective configuration for one sweep (startup passes the Home overlay over `process.env`). */
    readEnv: () => Promise<ServerConfigEnv>;
    /**
     * Storage space reclamation after each sweep's deletions (the light server's SQLite
     * incremental vacuum). It rides this hourly pass instead of owning a timer.
     */
    reclaimStorage?: () => Promise<void>;
}>): { stop: () => void } {
    const readEnv = params.readEnv;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The interval the last successful policy read set; the registry default until one succeeds. */
    let intervalMs: number | null = null;

    const run = async (reason: 'startup' | 'interval') => {
        let lock: Awaited<ReturnType<typeof acquireRetentionSweepLock>> = null;
        try {
            const policy = readRetentionPolicyFromEnv(await readEnv());
            intervalMs = policy.intervalMs;
            if (!resolveEffectiveRetentionEnabled(policy) && !hasRetentionRulesThatRunWhenGlobalPolicyIsDisabled()) return;

            lock = await acquireRetentionSweepLock({ ttlMs: retentionSweepLockTtlMs(policy) });
            if (!lock) return;
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
                        details: result.details,
                        dryRun: policy.dryRun,
                    });
                    await params.reclaimStorage?.();
                },
            });
        } catch (error) {
            logRetentionSweepFailed({ reason, error });
        } finally {
            await lock?.release();
        }
    };

    const scheduleNext = () => {
        if (stopped) return;
        timer = setTimeout(() => {
            void run('interval').then(scheduleNext);
        }, intervalMs ?? readRetentionPolicyFromEnv({}).intervalMs);
        timer.unref?.();
    };

    void run('startup').then(scheduleNext);

    return {
        stop: () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}
