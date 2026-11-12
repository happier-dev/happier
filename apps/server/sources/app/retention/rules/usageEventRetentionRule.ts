import { refreshTeamCredentialUsageCountersInTx } from '@/app/teams/credentials/teamCredentialUsageCounters';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

export function createUsageEventRetentionRule(): RetentionRule {
    let dryRunOffset = 0;
    return {
        id: 'usageEvents',
        run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
            const domain = resolveEffectiveRetentionDomains(policy).usageEvents;
            if (domain.mode === 'keep_forever') return { id: 'usageEvents', deleted: 0 };
            const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(batchSize, maxDeletesPerRulePerRun));
            const candidates = await db.usageEvent.findMany({
                where: { observedAt: { lt: cutoff } },
                orderBy: { observedAt: 'asc' },
                take: limit,
                ...(dryRun && dryRunOffset > 0 ? { skip: dryRunOffset } : null),
                select: { id: true, accountId: true },
            });
            if (dryRun) {
                dryRunOffset += candidates.length;
                return { id: 'usageEvents', deleted: candidates.length,
                    candidatesExamined: candidates.length, hasMore: candidates.length === limit };
            }
            if (candidates.length === 0) return { id: 'usageEvents', deleted: 0,
                candidatesExamined: 0, hasMore: false };

            const byAccount = new Map<string, string[]>();
            for (const candidate of candidates) {
                const ids = byAccount.get(candidate.accountId) ?? [];
                ids.push(candidate.id);
                byAccount.set(candidate.accountId, ids);
            }
            let deleted = 0;
            for (const [accountId, ids] of byAccount) {
                deleted += await inTx(async tx => {
                    const removed = await tx.usageEvent.findMany({
                        where: { accountId, id: { in: ids }, observedAt: { lt: cutoff } },
                        select: { sessionId: true, teamCredentialResourceId: true, observedAt: true },
                    });
                    const result = await tx.usageEvent.deleteMany({
                        where: { accountId, id: { in: ids }, observedAt: { lt: cutoff } },
                    });
                    if (result.count > 0) await refreshTeamCredentialUsageCountersInTx(tx, {
                        changedObservedAts: removed.map(row => row.observedAt),
                        resourceIds: removed.flatMap(row => row.teamCredentialResourceId ? [row.teamCredentialResourceId] : []),
                        sessionIds: removed.flatMap(row => row.sessionId ? [row.sessionId] : []),
                    });
                    return result.count;
                }, { transactionClass: 'usage-retention' });
            }
            return { id: 'usageEvents', deleted, candidatesExamined: candidates.length,
                hasMore: candidates.length === limit };
        },
    };
}
