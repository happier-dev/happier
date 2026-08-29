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
    intrinsicExpiry?: true;
}>;

export function createDeleteManyRetentionRule(params: CreateDeleteManyRetentionRuleParams): RetentionRule {
    let dryRunOffset = 0;
    return {
        id: params.id,
        run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
            const domains = resolveEffectiveRetentionDomains(policy);
            const domainPolicy = domains[params.id];
            const intrinsicExpiry = params.intrinsicExpiry === true;
            let cutoff: Date;
            let cutoffFilter: Readonly<{ lte: Date } | { lt: Date }>;
            if (intrinsicExpiry) {
                cutoff = now;
                cutoffFilter = { lte: cutoff };
            } else {
                if (domainPolicy.mode === 'keep_forever') {
                    return { id: params.id, deleted: 0 };
                }
                cutoff = new Date(
                    now.getTime() - domainPolicy.days * 24 * 60 * 60 * 1000,
                );
                cutoffFilter = { lt: cutoff };
            }
            const limit = Math.max(1, Math.min(batchSize, maxDeletesPerRulePerRun));
            const model = db[params.modelName] as any;
            const where = {
                [params.cutoffField]: cutoffFilter,
                ...(params.extraWhere ? params.extraWhere(cutoff) : null),
            };
            const rows = await model.findMany({
                where,
                orderBy: { [params.cutoffField]: 'asc' },
                take: limit,
                ...(dryRun && dryRunOffset > 0 ? { skip: dryRunOffset } : null),
                select: {
                    [params.primaryField]: true,
                },
            });
            if (dryRun) {
                dryRunOffset += rows.length;
                return {
                    id: params.id,
                    deleted: rows.length,
                    candidatesExamined: rows.length,
                    hasMore: rows.length === limit,
                };
            }
            if (rows.length === 0) {
                return { id: params.id, deleted: 0, candidatesExamined: 0, hasMore: false };
            }

            const identifiers = rows.map((row: Record<string, unknown>) => row[params.primaryField]);
            const result = await model.deleteMany({
                where: {
                    [params.primaryField]: { in: identifiers },
                    [params.cutoffField]: cutoffFilter,
                    ...(params.extraWhere ? params.extraWhere(cutoff) : null),
                },
            });
            return {
                id: params.id,
                deleted: result.count,
                candidatesExamined: rows.length,
                hasMore: rows.length === limit,
            };
        },
    };
}
