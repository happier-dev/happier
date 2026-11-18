import {
    projectReviewNeedsYouV1,
    ReviewHumanStateV1Schema,
    type ReviewHumanStateV1,
    type ReviewNeedsYouV1,
    type ReviewRequestedReviewerV1,
    type ReviewVerdictV1,
} from '@happier-dev/protocol/reviews/reviewHumanV1';
import { PrincipalRefV1Schema } from '@happier-dev/protocol/teams/principal';
import type { ReviewAccessCapability } from './reviewAccess';
import { readAdmittedReviewCountsInTx } from './reviewListService';
import type { Tx } from '@/storage/inTx';

type HumanRows = Readonly<{
    requests: readonly ReviewRequestedReviewerV1[];
    verdicts: readonly ReviewVerdictV1[];
    needsYou: ReviewNeedsYouV1;
}>;

function projectRequest(row: Readonly<{
    id: string;
    roundOrdinal: number;
    principal: unknown;
    required: boolean;
    eligibleAccounts: readonly Readonly<{ accountId: string }>[];
}>): ReviewRequestedReviewerV1 {
    const principal = PrincipalRefV1Schema.parse(row.principal);
    return { id: row.id, roundOrdinal: row.roundOrdinal, principal, required: row.required,
        // Access is admitted separately from reviewer eligibility. An empty audience
        // is the canonical unavailable signal; callers never infer this from Team state.
        needsAccess: row.eligibleAccounts.length === 0 };
}
async function readHumanRowsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    access: ReviewAccessCapability;
}>): Promise<HumanRows> {
    const metadata = await tx.reviewMetadata.findUnique({
        where: { artifactId: input.access.reviewId },
        select: { currentRoundOrdinal: true },
    });
    if (!metadata) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
    const [requestRows, verdictRows, counts] = await Promise.all([
        tx.reviewRequestedReviewer.findMany({
            where: { reviewId: input.access.reviewId },
            orderBy: [{ roundOrdinal: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, roundOrdinal: true, principal: true, required: true,
                eligibleAccounts: { select: { accountId: true } } },
        }),
        tx.reviewVerdict.findMany({
            where: { reviewId: input.access.reviewId },
            orderBy: [{ roundOrdinal: 'asc' }, { accountId: 'asc' }],
            select: { accountId: true, roundOrdinal: true, verdict: true, content: true, revision: true, submittedAt: true },
        }),
        readAdmittedReviewCountsInTx(tx, [input.access.reviewId]),
    ]);
    const requests = requestRows.map(projectRequest);
    const verdicts = verdictRows.map(row => ({ accountId: row.accountId, roundOrdinal: row.roundOrdinal,
        verdict: row.verdict as ReviewVerdictV1['verdict'], content: row.content === null ? undefined : row.content,
        submittedAt: row.submittedAt.getTime(), revision: row.revision }));
    const canRead = true;
    const canDecide = input.access.level !== 'view';
    const pendingDecisionCount = counts.get(input.access.reviewId)?.needsDecision ?? 0;
    const needsYou = projectReviewNeedsYouV1({ reviewId: input.access.reviewId,
        roundOrdinal: metadata.currentRoundOrdinal, actorAccountId: input.actorAccountId, canRead, canDecide,
        pendingDecisionCount, requests: requests.map(request => ({ roundOrdinal: request.roundOrdinal,
            eligibleAccountIds: requestRows.find(row => row.id === request.id)?.eligibleAccounts.map(account => account.accountId) ?? [] })),
        verdicts });
    return { requests, verdicts, needsYou };
}

/** Canonical admitted human-state reader. Access must already be resolved at request admission. */
export async function readAdmittedReviewHumanStateInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    access: ReviewAccessCapability;
}>): Promise<ReviewHumanStateV1> {
    const rows = await readHumanRowsInTx(tx, input);
    return ReviewHumanStateV1Schema.parse({ reviewId: input.access.reviewId,
        roundOrdinal: rows.needsYou.roundOrdinal, requests: rows.requests, verdicts: rows.verdicts,
        needsYou: rows.needsYou });
}

/** Batch projection used by list and Inbox consumers; it performs no per-review access lookup. */
export async function readAdmittedReviewNeedsYouInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    reviews: readonly ReviewAccessCapability[];
}>): Promise<ReadonlyMap<string, ReviewNeedsYouV1>> {
    const result = new Map<string, ReviewNeedsYouV1>();
    for (const access of input.reviews) {
        const rows = await readHumanRowsInTx(tx, { actorAccountId: input.actorAccountId, access });
        result.set(access.reviewId, rows.needsYou);
    }
    return result;
}
