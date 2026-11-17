import { deleteArtifact } from '@/app/artifacts/artifactWriteService';
import { resolveEffectiveRetentionDomains } from '@/app/retention/config/retentionPolicyState';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';

/** Review history expires independently of its runs, through the ordinary Artifact lifecycle. */
export function createReviewRetentionRule(): RetentionRule {
    let after: Readonly<{ finishedAt: Date; artifactId: string }> | undefined;
    return {
        id: 'reviews',
        run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, maxCandidatesPerRulePerRun, shouldContinue, now }) => {
            const domain = resolveEffectiveRetentionDomains(policy).reviews;
            if (domain.mode === 'keep_forever') return { id: 'reviews', deleted: 0, candidatesExamined: 0, hasMore: false };
            const cutoff = new Date(now.getTime() - domain.days * 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(batchSize, maxDeletesPerRulePerRun,
                maxCandidatesPerRulePerRun ?? batchSize));
            // The round writer keeps finishedAt null until all admitted reviewers settle and
            // resets it for a new round. No run reads or second lifecycle classification belong here.
            const candidates = await db.reviewMetadata.findMany({
                where: {
                    finishedAt: { lt: cutoff },
                    ...(after ? { OR: [
                        { finishedAt: { gt: after.finishedAt } },
                        { finishedAt: after.finishedAt, artifactId: { gt: after.artifactId } },
                    ] } : {}),
                },
                orderBy: [{ finishedAt: 'asc' }, { artifactId: 'asc' }],
                take: limit,
                select: {
                    artifactId: true, finishedAt: true,
                    artifact: { select: { accountId: true } },
                },
            });
            let deleted = 0;
            let candidatesExamined = 0;
            for (const candidate of candidates) {
                if (shouldContinue && !shouldContinue()) break;
                candidatesExamined += 1;
                // The SQL age predicate excludes null, while Prisma retains the nullable field type.
                after = { finishedAt: candidate.finishedAt!, artifactId: candidate.artifactId };
                if (dryRun) {
                    deleted += 1;
                    continue;
                }
                const result = await deleteArtifact({
                    actorUserId: candidate.artifact.accountId,
                    artifactId: candidate.artifactId,
                    artifactWhereGuard: { reviewMetadata: { finishedAt: { lt: cutoff } } },
                });
                if (result.ok) deleted += 1;
            }
            return { id: 'reviews', deleted, candidatesExamined, hasMore: candidates.length === limit };
        },
    };
}
