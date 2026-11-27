import type { Prisma } from '@prisma/client';

import { accountTierWhere } from '@/app/plans/accountPlanEntitlement';
import { resolveLimitTable, type LimitTable } from '@/app/plans/accountLimits';
import type { AccountLimitsV1 } from '@happier-dev/protocol';

import type { RetentionRule } from './retentionRuleRegistry';

type RetentionLimit = 'sessionRetentionDays' | 'subagentRetentionDays' | 'toolOutputRetentionDays';
type Tier = { key: string; days: number; sessionWhere?: Prisma.SessionWhereInput };

export function resolveSweepLimitTable(env: NodeJS.ProcessEnv | undefined): LimitTable | undefined {
    return env ? resolveLimitTable(env) : undefined;
}

/** Round-robin the tiers inside the domain's existing batch, time and row budgets. */
export function retainByAccountTier(
    id: string,
    limit: RetentionLimit,
    table: LimitTable | undefined,
    fallbackDays: (policy: Parameters<RetentionRule['run']>[0]['policy']) => number | null,
    createTierRule: (tier: Tier) => RetentionRule['run'],
): RetentionRule {
    const pending: RetentionRule['run'][] = [];
    let initialized = false;
    return {
        id,
        run: async params => {
            if (!initialized) {
                initialized = true;
                if (params.policy.enabled && table?.ok) {
                    const add = (plan: string | null, limits: AccountLimitsV1) => {
                        const days = limits[limit];
                        if (days === null) return;
                        pending.push(createTierRule({
                            key: plan === null ? 'base' : `plan.${plan}`,
                            days,
                            sessionWhere: { account: accountTierWhere(plan, table, params.now) },
                        }));
                    };
                    add(null, table.base);
                    for (const [id, plan] of table.plans) add(id, plan.limits);
                } else if (!table) {
                    const days = fallbackDays(params.policy);
                    if (days !== null) pending.push(createTierRule({ key: 'legacy', days }));
                }
            }
            while (params.shouldContinue?.() !== false) {
                const next = pending.shift();
                if (!next) break;
                const result = await next(params);
                if (result.hasMore) pending.push(next);
                if (result.hasMore || result.deleted > 0 || (result.candidatesExamined ?? 0) > 0) {
                    return { ...result, hasMore: pending.length > 0 };
                }
            }
            return { id, deleted: 0, hasMore: pending.length > 0 };
        },
    };
}
