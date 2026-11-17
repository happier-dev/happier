import type { ReviewCommentListRequestV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { ReviewCommentOperationError } from "./errors";
import { normalizeReviewCommentListFilters, matchesReviewCommentListFilters, compareReviewCommentListOrder, canonicalReviewCommentListFilters, type ReviewCommentCanonicalFilters, type ReviewCommentQueryRecordV1 } from '@happier-dev/protocol/reviews/comments/queries';
export { normalizeReviewCommentListFilters, matchesReviewCommentListFilters, compareReviewCommentListOrder, canonicalReviewCommentListFilters } from '@happier-dev/protocol/reviews/comments/queries';

type ReviewCommentListPosition = Readonly<{
    updatedAt: number;
    serverRevision: number;
    id: string;
}>;

type ReviewCommentCursorPayload = Readonly<{
    v: 1;
    filters: ReviewCommentCanonicalFilters;
    position: ReviewCommentListPosition;
}>;


export type ReviewCommentListResult<T = ReviewCommentV1> = Readonly<{
    items: readonly T[];
    cursor: string | null;
}>;


function encodeCursorPayload(payload: ReviewCommentCursorPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorPayload(cursor: string): ReviewCommentCursorPayload {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
            !parsed
            || typeof parsed !== "object"
            || parsed.v !== 1
            || !parsed.position
            || typeof parsed.position !== "object"
            || typeof parsed.position.updatedAt !== "number"
            || typeof parsed.position.serverRevision !== "number"
            || typeof parsed.position.id !== "string"
        ) {
            throw new Error("invalid cursor");
        }
        return parsed as ReviewCommentCursorPayload;
    } catch {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_filter",
            "Review comment cursor is invalid",
        );
    }
}

function assertCursorFiltersMatch(params: Readonly<{
    cursor: ReviewCommentCursorPayload;
    filters: ReviewCommentListRequestV1;
}>): void {
    const expected = JSON.stringify(params.cursor.filters);
    const actual = JSON.stringify(canonicalReviewCommentListFilters(params.filters));
    if (expected !== actual) {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_filter",
            "Review comment cursor does not match the active filters",
        );
    }
}

function commentPosition(comment: ReviewCommentListPosition): ReviewCommentListPosition {
    return {
        updatedAt: comment.updatedAt,
        serverRevision: comment.serverRevision,
        id: comment.id,
    };
}

function comparePositionToComment(left: ReviewCommentQueryRecordV1, right: ReviewCommentListPosition): number {
    return compareReviewCommentListOrder(left, {
        ...left,
        id: right.id,
        updatedAt: right.updatedAt,
        serverRevision: right.serverRevision,
    });
}

export function readReviewCommentListCursorPosition(filters: ReviewCommentListRequestV1): ReviewCommentListPosition | null {
    const normalized = normalizeReviewCommentListFilters(filters);
    const cursor = normalized.cursor ? decodeCursorPayload(normalized.cursor) : null;
    if (cursor) assertCursorFiltersMatch({ cursor, filters: normalized });
    return cursor?.position ?? null;
}

export function pageReviewCommentListCandidates<T extends ReviewCommentListPosition>(
    candidates: readonly T[],
    filters: ReviewCommentListRequestV1,
): ReviewCommentListResult<T> {
    const normalized = normalizeReviewCommentListFilters(filters);
    const page = candidates.slice(0, normalized.limit);
    const hasMore = candidates.length > normalized.limit;
    const last = page[page.length - 1];

    return {
        items: page,
        cursor: hasMore && last
            ? encodeCursorPayload({
                v: 1,
                filters: canonicalReviewCommentListFilters(normalized),
                position: commentPosition(last),
            })
            : null,
    };
}

export function applyReviewCommentListQuery<T extends ReviewCommentQueryRecordV1>(
    comments: readonly T[],
    filters: ReviewCommentListRequestV1,
): ReviewCommentListResult<T> {
    const normalized = normalizeReviewCommentListFilters(filters);
    const position = readReviewCommentListCursorPosition(normalized);
    const candidates = comments
        .filter((comment) => matchesReviewCommentListFilters(comment, normalized))
        .sort(compareReviewCommentListOrder)
        .filter((comment) => !position || comparePositionToComment(comment, position) > 0);
    return pageReviewCommentListCandidates(candidates, normalized);
}
