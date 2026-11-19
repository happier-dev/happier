import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { expireSessionMessageToolOutputAtRevision } from '@/app/session/sessionMessageRevisionWrite';
import { db } from '@/storage/db';

export function createSessionToolOutputRetentionRule(): RetentionRule {
    let afterId: string | undefined;
    const id = 'toolOutputs';
    return {
        id,
        run: async ({ policy, batchSize, maxCandidatesPerRulePerRun, shouldContinue, dryRun, now }) => {
            const domain = resolveEffectiveRetentionDomains(policy).toolOutputs;
            if (domain.mode === 'keep_forever') return { id, deleted: 0, hasMore: false };

            const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
            const take = Math.min(batchSize, maxCandidatesPerRulePerRun ?? batchSize);
            const rows = await db.sessionMessage.findMany({
                where: {
                    ...(afterId === undefined ? {} : { id: { gt: afterId } }),
                    createdAt: { lt: cutoff },
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
                if (dryRun || await expireSessionMessageToolOutputAtRevision({ ...row, cutoff, now, days: domain.days })) {
                    deleted += 1;
                }
                afterId = row.id;
                examined += 1;
            }
            return { id, deleted, candidatesExamined: examined, hasMore: examined < rows.length || rows.length === take };
        },
    };
}
