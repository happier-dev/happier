import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { retainByAccountTier } from '@/app/retention/runtime/retentionTierBatches';
import type { LimitTable } from '@/app/plans/accountLimits';
import { expireSessionMessageToolOutputAtRevision } from '@/app/session/sessionMessageRevisionWrite';
import { db } from '@/storage/db';

export function createSessionToolOutputRetentionRule(table?: LimitTable): RetentionRule {
    const id = 'toolOutputs';
    return retainByAccountTier(id, 'toolOutputRetentionDays', table, policy => {
        const domain = resolveEffectiveRetentionDomains(policy).toolOutputs;
        return domain.mode === 'delete_older_than' ? domain.days : null;
    }, ({ days, sessionWhere }) => {
        let afterId: string | undefined;
        return async ({ batchSize, maxCandidatesPerRulePerRun, shouldContinue, dryRun, now }) => {
            const cutoff = new Date(now.getTime() - days * 86_400_000);
            const take = Math.min(batchSize, maxCandidatesPerRulePerRun ?? batchSize);
            const rows = await db.sessionMessage.findMany({
                where: {
                    ...(afterId === undefined ? {} : { id: { gt: afterId } }),
                    createdAt: { lt: cutoff },
                    ...(sessionWhere ? { session: sessionWhere } : {}),
                    toolOutputBytes: { not: null },
                    toolOutputExpiredAfterDays: null,
                },
                orderBy: { id: 'asc' },
                take,
                select: { id: true, sessionId: true, seq: true, rowRevision: true, updatedAt: true },
            });

            let examined = 0;
            let deleted = 0;
            for (const row of rows) {
                if (shouldContinue?.() === false) break;
                if (dryRun || await expireSessionMessageToolOutputAtRevision({ ...row, cutoff, now, days, sessionWhere })) {
                    deleted += 1;
                }
                afterId = row.id;
                examined += 1;
            }
            return { id, deleted, candidatesExamined: examined, hasMore: examined < rows.length || rows.length === take };
        };
    });
}
