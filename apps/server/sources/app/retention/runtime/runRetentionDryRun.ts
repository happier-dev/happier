import type { HomeRetentionDryRunResultV1 } from '@happier-dev/protocol/home/governance';
import type { ServerConfigEnv } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';

import { runRetentionSweep } from './runRetentionSweep';
import { acquireRetentionSweepLock } from './retentionSweepLock';
import { retentionSweepLockTtlMs } from './retentionSweepLockTtl';

export type RetentionDryRunOutcome =
    | Readonly<{ status: 'ok'; result: HomeRetentionDryRunResultV1 }>
    | Readonly<{ status: 'in_progress' }>;

/**
 * `home.retention.dryRun` (plan §3.6): one sweep of the Home's effective retention policy with
 * deletion forced off. It takes the retention sweep lock (answering `in_progress` while a worker
 * sweep holds it), is bounded by the policy's own sweep time budget, and reports per domain what
 * would be deleted, how many candidates were examined and why the domain stopped. Nothing is
 * deleted and nothing is persisted.
 */
export async function runRetentionDryRun(params: Readonly<{
    /** The Home-effective configuration (the request overlay). */
    env: ServerConfigEnv;
    now?: Date;
    readClockMs?: () => number;
}>): Promise<RetentionDryRunOutcome> {
    const policy = { ...readRetentionPolicyFromEnv(params.env), dryRun: true };
    const lock = await acquireRetentionSweepLock({ ttlMs: retentionSweepLockTtlMs(policy) });
    if (!lock) return { status: 'in_progress' };
    try {
        const ranAt = params.now ?? new Date();
        const sweep = await runRetentionSweep({
            policy,
            env: params.env,
            now: ranAt,
            ...(params.readClockMs ? { readClockMs: params.readClockMs } : {}),
        });
        const byDomain: HomeRetentionDryRunResultV1['byDomain'] = {};
        for (const [domainId, detail] of Object.entries(sweep.details)) {
            byDomain[domainId] = {
                wouldDelete: detail.deleted,
                candidatesExamined: detail.candidatesExamined,
                stopReason: detail.stopReason,
            };
        }
        return { status: 'ok', result: { ranAt: ranAt.toISOString(), byDomain } };
    } finally {
        await lock.release();
    }
}
