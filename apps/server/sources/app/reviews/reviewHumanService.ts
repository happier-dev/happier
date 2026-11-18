import {
    projectReviewNeedsYouV1,
    ReviewHumanStateV1Schema,
    ReviewVerdictContentV1Schema,
    type ReviewHumanStateV1,
    type ReviewNeedsYouV1,
    type ReviewRequestedReviewerV1,
    type ReviewVerdictV1,
} from '@happier-dev/protocol/reviews/reviewHumanV1';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { PrincipalRefV1Schema } from '@happier-dev/protocol/teams/principal';
import type { ReviewAccessCapability } from './reviewAccess';
import { readAdmittedReviewCountsInTx } from './reviewListService';
import type { Tx } from '@/storage/inTx';
import type { ReviewReviewersSetInputV1, ReviewVerdictSubmitInputV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveArtifactAudiencesInTx } from '@/app/artifacts/artifactAccessService';

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
}>, audience: ReadonlySet<string>): ReviewRequestedReviewerV1 {
    const principal = PrincipalRefV1Schema.parse(row.principal);
    return { id: row.id, roundOrdinal: row.roundOrdinal, principal, required: row.required,
        needsAccess: row.eligibleAccounts.some(account => !audience.has(account.accountId)) };
}
function groupByReview<T extends { reviewId: string }>(rows: readonly T[]): ReadonlyMap<string, readonly T[]> {
    const result = new Map<string, T[]>();
    for (const row of rows) {
        const group = result.get(row.reviewId);
        if (group) group.push(row); else result.set(row.reviewId, [row]);
    }
    return result;
}

type AdmittedReviewAttentionFact = Readonly<{ currentRoundOrdinal: number; pendingDecisionCount: number }>;
type HumanReadInput = Readonly<{
    actorAccountId: string;
    reviews: readonly ReviewAccessCapability[];
    /** Metadata and counts already read in this admitted list snapshot. */
    facts?: ReadonlyMap<string, AdmittedReviewAttentionFact>;
}>;

async function readHumanRowsInTx(tx: Tx, input: HumanReadInput): Promise<ReadonlyMap<string, HumanRows>> {
    const result = new Map<string, HumanRows>();
    if (input.reviews.length === 0) return result;
    const counts = input.facts === undefined ? await readAdmittedReviewCountsInTx(tx, input.reviews.map(row => row.reviewId)) : undefined;
    for (const accesses of portableQueryChunks({ values: input.reviews, bindingsPerValue: 1 })) {
        const reviewIds = accesses.map(access => access.reviewId);
        const [metadataRows, requestRows, verdictRows] = await Promise.all([
            input.facts === undefined
                ? tx.reviewMetadata.findMany({ where: { artifactId: { in: reviewIds } }, select: { artifactId: true, currentRoundOrdinal: true } })
                : Promise.resolve(accesses.map(access => ({ artifactId: access.reviewId, currentRoundOrdinal: input.facts!.get(access.reviewId)!.currentRoundOrdinal }))),
            tx.reviewRequestedReviewer.findMany({
                where: { reviewId: { in: reviewIds } },
                orderBy: [{ roundOrdinal: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
                select: { reviewId: true, id: true, roundOrdinal: true, principal: true, required: true,
                    eligibleAccounts: { select: { accountId: true } } },
            }),
            tx.reviewVerdict.findMany({
                where: { reviewId: { in: reviewIds } },
                orderBy: [{ roundOrdinal: 'asc' }, { accountId: 'asc' }],
                select: { reviewId: true, accountId: true, roundOrdinal: true, verdict: true, content: true, revision: true, submittedAt: true },
            }),
        ]);
        const metadataById = new Map(metadataRows.map(row => [row.artifactId, row]));
        const requestsById = groupByReview(requestRows);
        const verdictsById = groupByReview(verdictRows);
        const audiences = await resolveArtifactAudiencesInTx(tx, [...requestsById.keys()]);
        for (const access of accesses) {
            const metadata = metadataById.get(access.reviewId);
            if (!metadata) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
            result.set(access.reviewId, projectHumanRows({ actorAccountId: input.actorAccountId, access,
                currentRoundOrdinal: metadata.currentRoundOrdinal,
                pendingDecisionCount: input.facts?.get(access.reviewId)?.pendingDecisionCount ?? counts?.get(access.reviewId)?.needsDecision ?? 0,
                audience: new Set(audiences.get(access.reviewId) ?? []),
                requestRows: requestsById.get(access.reviewId) ?? [], verdictRows: verdictsById.get(access.reviewId) ?? [] }));
        }
    }
    return result;
}

function projectHumanRows(input: Readonly<{
    actorAccountId: string; access: ReviewAccessCapability; currentRoundOrdinal: number; pendingDecisionCount: number;
    audience: ReadonlySet<string>;
    requestRows: readonly Readonly<{ id: string; roundOrdinal: number; principal: unknown; required: boolean;
        eligibleAccounts: readonly Readonly<{ accountId: string }>[] }>[];
    verdictRows: readonly Readonly<{ accountId: string; roundOrdinal: number; verdict: string; content: unknown; revision: number; submittedAt: Date }>[];
}>): HumanRows {
    const { requestRows, verdictRows } = input;
    const currentRequests = requestRows.filter(row => row.roundOrdinal === input.currentRoundOrdinal);
    const requests = currentRequests.map(row => projectRequest(row, input.audience));
    const verdicts = verdictRows.map(row => ({ accountId: row.accountId, roundOrdinal: row.roundOrdinal,
        verdict: row.verdict as ReviewVerdictV1['verdict'], content: row.content === null ? undefined : StoredJsonContentEnvelopeSchema.parse(row.content),
        submittedAt: row.submittedAt.getTime(), revision: row.revision }));
    const canRead = true;
    const canDecide = input.access.level !== 'view';
    const needsYou = projectReviewNeedsYouV1({ reviewId: input.access.reviewId,
        roundOrdinal: input.currentRoundOrdinal, actorAccountId: input.actorAccountId, canRead, canDecide,
        pendingDecisionCount: input.pendingDecisionCount, requests: currentRequests.map(request => ({ roundOrdinal: request.roundOrdinal,
            eligibleAccountIds: request.eligibleAccounts.map(account => account.accountId) })),
        verdicts });
    return { requests, verdicts, needsYou };
}

/** Canonical admitted human-state reader. Access must already be resolved at request admission. */
export async function readAdmittedReviewHumanStateInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    access: ReviewAccessCapability;
    /** Already read by the composed detail owner in this admitted snapshot. */
    facts?: AdmittedReviewAttentionFact;
}>): Promise<ReviewHumanStateV1> {
    const rows = (await readHumanRowsInTx(tx, { actorAccountId: input.actorAccountId, reviews: [input.access],
        facts: input.facts === undefined ? undefined : new Map([[input.access.reviewId, input.facts]]) })).get(input.access.reviewId)!;
    return ReviewHumanStateV1Schema.parse({ reviewId: input.access.reviewId,
        roundOrdinal: rows.needsYou.roundOrdinal, requests: rows.requests, verdicts: rows.verdicts,
        needsYou: rows.needsYou });
}

/** Batch projection used by list and Inbox consumers; it performs no per-review access lookup. */
export async function readAdmittedReviewNeedsYouInTx(tx: Tx, input: HumanReadInput): Promise<ReadonlyMap<string, ReviewNeedsYouV1>> {
    return new Map([...(await readHumanRowsInTx(tx, input))].map(([reviewId, rows]) => [reviewId, rows.needsYou]));
}

export async function setAdmittedReviewersInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    access: ReviewAccessCapability;
    request: ReviewReviewersSetInputV1;
}>): Promise<ReviewHumanStateV1> {
    if (input.access.level === 'view') throw Object.assign(new Error('review_access_forbidden'), { code: 'review_access_forbidden' });
    const current = await tx.reviewMetadata.findUnique({ where: { artifactId: input.access.reviewId }, select: { currentRoundOrdinal: true } });
    if (!current || current.currentRoundOrdinal !== input.request.roundOrdinal) throw Object.assign(new Error('review_round_not_admitted'), { code: 'review_round_not_admitted' });
    await tx.reviewRequestedReviewer.deleteMany({ where: { reviewId: input.access.reviewId, roundOrdinal: input.request.roundOrdinal } });
    for (const reviewer of input.request.reviewers) {
        const eligibleAccounts = reviewer.principal.kind === 'account'
            ? [reviewer.principal.accountId]
            : reviewer.principal.kind === 'team'
                ? (await tx.teamMembership.findMany({ where: { teamId: reviewer.principal.teamId, status: 'active', account: { status: 'active' }, team: { archivedAt: null }, role: { in: ['owner', 'admin', 'member'] } }, select: { accountId: true } })).map(row => row.accountId)
                : (await tx.teamGroupMembership.findMany({ where: { teamGroupId: reviewer.principal.groupId, teamMembership: { status: 'active', account: { status: 'active' }, team: { archivedAt: null }, role: { in: ['owner', 'admin', 'member'] } } }, select: { teamMembership: { select: { accountId: true } } } })).map(row => row.teamMembership.accountId);
        await tx.reviewRequestedReviewer.create({ data: { reviewId: input.access.reviewId, roundOrdinal: input.request.roundOrdinal,
            principalKey: reviewer.principal.kind === 'account' ? `account:${reviewer.principal.accountId}` : reviewer.principal.kind === 'team' ? `team:${reviewer.principal.teamId}` : `group:${reviewer.principal.teamId}:${reviewer.principal.groupId}`,
            principal: reviewer.principal, required: reviewer.required, eligibleAccounts: { create: eligibleAccounts.map(accountId => ({ accountId })) } } });
    }
    return readAdmittedReviewHumanStateInTx(tx, { actorAccountId: input.actorAccountId, access: input.access });
}

export async function submitAdmittedReviewVerdictInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    access: ReviewAccessCapability;
    request: ReviewVerdictSubmitInputV1;
}>): Promise<ReviewHumanStateV1> {
    if (input.access.reviewId !== input.request.reviewId) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
    const metadata = await tx.reviewMetadata.findUnique({ where: { artifactId: input.request.reviewId }, select: { currentRoundOrdinal: true } });
    if (!metadata || metadata.currentRoundOrdinal !== input.request.roundOrdinal) throw Object.assign(new Error('review_round_not_admitted'), { code: 'review_round_not_admitted' });
    const requestRow = await tx.reviewRequestedReviewer.findFirst({ where: { reviewId: input.request.reviewId, roundOrdinal: input.request.roundOrdinal, eligibleAccounts: { some: { accountId: input.actorAccountId } } }, select: { id: true } });
    const requested = requestRow ? await tx.reviewRequestedReviewerAccount.findUnique({ where: { requestId_accountId: { requestId: requestRow.id, accountId: input.actorAccountId } } }) : null;
    if (!requested) throw Object.assign(new Error('review_reviewer_not_requested'), { code: 'review_reviewer_not_requested' });
    const previous = await tx.reviewVerdict.findUnique({ where: { reviewId_roundOrdinal_accountId: { reviewId: input.request.reviewId, roundOrdinal: input.request.roundOrdinal, accountId: input.actorAccountId } }, select: { revision: true } });
    const revision = previous?.revision ?? 0;
    if (input.request.expectedRevision !== undefined && input.request.expectedRevision !== revision) throw Object.assign(new Error('review_verdict_revision_mismatch'), { code: 'review_verdict_revision_mismatch' });
    const content = input.request.content;
    if (content && content.t !== input.access.encryptionMode) throw Object.assign(new Error('review_verdict_encryption_mode_mismatch'), { code: 'review_verdict_encryption_mode_mismatch' });
    if (content?.t === 'plain') {
        const opened = ReviewVerdictContentV1Schema.safeParse(content.v);
        if (!opened.success || opened.data.reviewId !== input.request.reviewId || opened.data.roundOrdinal !== input.request.roundOrdinal
            || opened.data.accountId !== input.actorAccountId || opened.data.revision !== revision + 1) {
            throw Object.assign(new Error('review_verdict_content_mismatch'), { code: 'review_verdict_content_mismatch' });
        }
    }
    if (previous && input.request.expectedRevision === undefined && content === undefined) {
        return readAdmittedReviewHumanStateInTx(tx, { actorAccountId: input.actorAccountId, access: input.access });
    }
    await tx.reviewVerdict.upsert({ where: { reviewId_roundOrdinal_accountId: { reviewId: input.request.reviewId, roundOrdinal: input.request.roundOrdinal, accountId: input.actorAccountId } },
        create: { reviewId: input.request.reviewId, roundOrdinal: input.request.roundOrdinal, accountId: input.actorAccountId, verdict: input.request.verdict, content: content ?? undefined, revision: revision + 1 },
        update: { verdict: input.request.verdict, content: content ?? undefined, revision: revision + 1 } });
    return readAdmittedReviewHumanStateInTx(tx, { actorAccountId: input.actorAccountId, access: input.access });
}
