import type { ReviewCommentV1} from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import { groupReviewFindingSourcesV1 } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';

import type { ReviewFindingThreadEntry } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { REVIEW_SEVERITY_RANK } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { t } from '@/text';

/** One reviewer of a review: one run, its latest findings and the durable comment of each. */
export type ReviewMember = Readonly<{
    runId: string;
    backendId: string;
    reviewerLabel: string;
    findings: readonly ReviewFinding[];
    commentByFindingId: ReadonlyMap<string, ReviewCommentV1>;
    originalByFindingId: Readonly<Record<string, ReviewFinding>>;
    threadsByFindingId: Readonly<Record<string, readonly ReviewFindingThreadEntry[]>>;
}>;

/** Where a merged row came from: one reviewer's own finding and its comment. */
export type ReviewFindingSource = Readonly<{
    member: ReviewMember;
    finding: ReviewFinding;
    comment: ReviewCommentV1 | null;
}>;

/**
 * One row of a review's findings. A finding two reviewers both reported (the same
 * `ReviewComment.findingIdentity`) is one row with both as its sources; everything else is a row of
 * its own reviewer.
 */
export type ReviewFindingRowModel = Readonly<{
    /** Stable within the review: the finding id for one reviewer, run-qualified for several. */
    rowId: string;
    /** The row's face: the most severe source's latest version; first source wins ties. */
    finding: ReviewFinding;
    sources: readonly ReviewFindingSource[];
}>;

/**
 * Merges the reviewers' findings into one list (lab R1), keyed on ORC's semantic finding identity.
 * A finding whose comment hasn't materialized has no identity and stays its reviewer's own row.
 * With one reviewer every row keeps its finding id, so a single review reads exactly as before.
 */
export function mergeReviewFindings(members: readonly ReviewMember[]): readonly ReviewFindingRowModel[] {
    const qualified = members.length > 1;
    return groupReviewFindingSourcesV1(members.flatMap(member => member.findings.map(finding => ({
        member, runId: member.runId, finding, comment: member.commentByFindingId.get(finding.id) ?? null,
    })))).map(sources => {
        const first = sources[0]!;
        const finding = sources.reduce((selected, source) => REVIEW_SEVERITY_RANK[source.finding.severity] < REVIEW_SEVERITY_RANK[selected.severity]
            ? source.finding : selected, first.finding);
        return { rowId: qualified ? `${first.runId}:${first.finding.id}` : first.finding.id, finding, sources };
    });
}

/** Most severe first (the most severe of a merged row's sources); report order within a severity. */
export function sortReviewFindingRows(rows: readonly ReviewFindingRowModel[]): readonly ReviewFindingRowModel[] {
    const rank = (row: ReviewFindingRowModel) => Math.min(...row.sources.map((source) => REVIEW_SEVERITY_RANK[source.finding.severity] ?? 9));
    return rows
        .map((row, index) => ({ row, index, rank: rank(row) }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ row }) => row);
}

/** Names a set of reviewers in a row or a chip: the reviewer, "Both", or "3 reviewers". */
export function formatReviewerSet(labels: readonly string[]): string {
    if (labels.length === 1) return labels[0]!;
    if (labels.length === 2) return t('runPage.review.both');
    return t('runPage.review.reviewerCount', { count: labels.length });
}
