import { db } from '@/storage/db';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';

type RuleDomainId = Exclude<keyof RetentionPolicy['domains'], 'sessions' | 'accountChanges'>;

type CreateDeleteManyRetentionRuleParams = Readonly<{
    id: RuleDomainId;
    modelName: keyof typeof db;
    primaryField: string;
    cutoffField: string;
    extraWhere?: (cutoff: Date) => Record<string, unknown>;
}>;

export function createDeleteManyRetentionRule(params: CreateDeleteManyRetentionRuleParams): RetentionRule {
    return {
        id: params.id,
        run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
            const domains = resolveEffectiveRetentionDomains(policy);
            const domainPolicy = domains[params.id];
            if (domainPolicy.mode === 'keep_forever') {
                return { id: params.id, deleted: 0 };
            }

            const cutoff = new Date(now.getTime() - domainPolicy.days * 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(batchSize, maxDeletesPerRulePerRun));
            const model = db[params.modelName] as any;
            const where = {
                [params.cutoffField]: { lt: cutoff },
                ...(params.extraWhere ? params.extraWhere(cutoff) : null),
            };
            const rows = await model.findMany({
                where,
                orderBy: { [params.cutoffField]: 'asc' },
                take: limit,
                select: {
                    [params.primaryField]: true,
                },
            });
            if (dryRun) {
                return { id: params.id, deleted: rows.length };
            }
            if (rows.length === 0) {
                return { id: params.id, deleted: 0 };
            }

            const identifiers = rows.map((row: Record<string, unknown>) => row[params.primaryField]);
            const result = await model.deleteMany({
                where: {
                    [params.primaryField]: { in: identifiers },
                    [params.cutoffField]: { lt: cutoff },
                    ...(params.extraWhere ? params.extraWhere(cutoff) : null),
                },
            });
            return { id: params.id, deleted: result.count };
        },
    };
}
