import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';

import { createRetentionRuleRegistry } from './retentionRuleRegistry';

export type RetentionSweepResult = Readonly<{
    deleted: number;
    byRule: Readonly<Record<string, number>>;
}>;

export async function runRetentionSweep(params: {
    policy: RetentionPolicy;
    now?: Date;
}): Promise<RetentionSweepResult> {
    const now = params.now ?? new Date();
    const registry = createRetentionRuleRegistry();
    const byRule: Record<string, number> = {};
    let deleted = 0;

    for (const rule of registry) {
        const result = await rule.run({
            policy: params.policy,
            batchSize: params.policy.batchSize,
            dryRun: params.policy.dryRun,
            maxDeletesPerRulePerRun: params.policy.maxDeletesPerRulePerRun,
            now,
        });
        byRule[result.id] = result.deleted;
        deleted += result.deleted;
    }

    return {
        deleted,
        byRule,
    };
}
