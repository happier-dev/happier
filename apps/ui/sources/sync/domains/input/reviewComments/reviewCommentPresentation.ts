import type { ReviewCommentDraft } from './reviewCommentTypes';
import {
    formatReviewCommentDraftAnchorLabel,
    getReviewCommentDraftAnchorPrimaryLine,
} from './anchors/reviewCommentDraftAnchor';

export function getReviewCommentAnchorLine(draft: ReviewCommentDraft): number | null {
    return getReviewCommentDraftAnchorPrimaryLine(draft.anchor);
}

export function formatReviewCommentAnchorLabel(draft: ReviewCommentDraft): string {
    return formatReviewCommentDraftAnchorLabel(draft.anchor);
}
