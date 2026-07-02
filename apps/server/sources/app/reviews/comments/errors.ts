import type { ReviewCommentOperationErrorCodeV1 } from "@happier-dev/protocol";

export class ReviewCommentOperationError extends Error {
    constructor(
        readonly code: ReviewCommentOperationErrorCodeV1,
        message: string,
    ) {
        super(message);
        this.name = "ReviewCommentOperationError";
    }
}
