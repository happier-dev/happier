import { ReviewCommentDraftMessageV1Schema, ReviewCommentsV1Schema, type ReviewCommentsV1 } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';

export const ReviewCommentDraftSchema = ReviewCommentDraftMessageV1Schema;
export { ReviewCommentsV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';
export { buildReviewCommentsV1MetaPayload } from '@happier-dev/protocol/messages/structured/reviewCommentsInput';
export type { ReviewCommentsV1 };

export function parseReviewCommentsV1(payload: unknown): ReviewCommentsV1 | null {
    const parsed = ReviewCommentsV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}
