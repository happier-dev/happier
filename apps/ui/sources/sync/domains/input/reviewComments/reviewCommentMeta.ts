import { ReviewCommentDraftMessageV1Schema, ReviewCommentsV1Schema, type ReviewCommentsV1 } from '@happier-dev/protocol';

export const ReviewCommentDraftSchema = ReviewCommentDraftMessageV1Schema;
export { ReviewCommentsV1Schema, buildReviewCommentsV1MetaPayload } from '@happier-dev/protocol';
export type { ReviewCommentsV1 };

export function parseReviewCommentsV1(payload: unknown): ReviewCommentsV1 | null {
    const parsed = ReviewCommentsV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}
