import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { pruneProviderAccountUsageSummaryDetail, readExpiredProviderAccountUsageSummaryDays,
    type ProviderAccountUsageDayKey } from '@/app/api/routes/connect/providerAccountUsage/daySummaryStorage';

export function createProviderAccountUsageHistoryRetentionRule(): RetentionRule {
    let after: ProviderAccountUsageDayKey | undefined;
    let afterHistory: Readonly<{ id: string; observedAtMs: number }> | undefined;
    return { id: 'providerAccountUsageHistory', run: async ({ policy, now, batchSize, dryRun,
        maxDeletesPerRulePerRun, maxCandidatesPerRulePerRun, shouldContinue }) => {
        const domain = resolveEffectiveRetentionDomains(policy).providerAccountUsageHistory;
        if (domain.mode === 'keep_forever') return { id: 'providerAccountUsageHistory', deleted: 0, hasMore: false };
        const cutoff = new Date(now.getTime() - domain.days * PROVIDER_ACCOUNT_USAGE_DAY_MS);
        const limit = Math.min(batchSize, maxDeletesPerRulePerRun);
        const candidateLimit = Math.min(batchSize, maxCandidatesPerRulePerRun ?? batchSize);
        const days = await readExpiredProviderAccountUsageSummaryDays({ cutoff, limit: candidateLimit, after }, db);
        let deleted = 0;
        let examined = 0;
        for (const day of days) {
            if (shouldContinue?.() === false) break;
            const run = (tx: Tx) => pruneProviderAccountUsageSummaryDetail({ ...day,
                cutoff, limit: limit - deleted, dryRun, ...(dryRun && afterHistory ? { afterHistory } : {}) }, tx);
            const result = dryRun ? await inReadSnapshot(run) : await inTx(run, { transactionClass: 'provider-usage-retention' });
            deleted += result.deleted;
            examined++;
            if (result.hasMoreInDay) {
                if (dryRun) afterHistory = result.afterHistory;
                return { id: 'providerAccountUsageHistory', deleted, candidatesExamined: examined, hasMore: true };
            }
            after = day;
            afterHistory = undefined;
            if (deleted >= limit) break;
        }
        return { id: 'providerAccountUsageHistory', deleted, candidatesExamined: examined,
            hasMore: examined < days.length || days.length === candidateLimit || deleted >= limit };
    } };
}
