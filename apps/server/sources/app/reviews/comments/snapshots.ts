import {
    buildReviewCommentTextSnapshotHashes,
    REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES_V1,
    REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1,
    ReviewCommentSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
    reviewCommentTextSnapshotHasBidiControlsV1,
    reviewCommentTextSnapshotIsLikelyMinifiedV1,
    reviewCommentTextSnapshotUtf8BytesV1,
    type ReviewCommentSnapshotContentV1,
    type ReviewCommentSnapshotV1,
    type ReviewCommentTextSnapshotLinesV1,
} from "@happier-dev/protocol";

export const REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES = REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES_V1;
export const REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES = REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1;

export type ReviewCommentTextSnapshotLines = ReviewCommentTextSnapshotLinesV1;

export { buildReviewCommentTextSnapshotHashes };

function resolvePlainReviewCommentSnapshot(snapshotContent: ReviewCommentSnapshotContentV1): ReviewCommentSnapshotV1 | null {
    const envelope = StoredJsonContentEnvelopeSchema.safeParse(snapshotContent);
    if (envelope.success) {
        if (envelope.data.t === "encrypted") return null;
        return ReviewCommentSnapshotV1Schema.parse(envelope.data.v);
    }
    return ReviewCommentSnapshotV1Schema.parse(snapshotContent);
}

export function validateReviewCommentSnapshot(snapshotContent: ReviewCommentSnapshotContentV1): void {
    const snapshot = resolvePlainReviewCommentSnapshot(snapshotContent);
    if (snapshot === null) return;
    if (snapshot.kind !== "text") {
        if (snapshot.kind === "too_large" && snapshot.sizeBytes <= snapshot.capBytes) {
            throw new Error("review comment snapshot too_large metadata must exceed the capture cap");
        }
        return;
    }

    const allLines = [
        ...snapshot.beforeContext,
        ...snapshot.selectedLines,
        ...snapshot.afterContext,
    ];
    const hashes = buildReviewCommentTextSnapshotHashes(snapshot);
    const selectedBytes = reviewCommentTextSnapshotUtf8BytesV1(snapshot.selectedLines.join("\n"));
    const contextBytes = reviewCommentTextSnapshotUtf8BytesV1(allLines.join("\n"));
    const longestLineBytes = Math.max(0, ...allLines.map(reviewCommentTextSnapshotUtf8BytesV1));
    const actualHasBidiControls = reviewCommentTextSnapshotHasBidiControlsV1(allLines);
    const actualLikelyMinified = reviewCommentTextSnapshotIsLikelyMinifiedV1(allLines);

    if (snapshot.selectedLinesHash !== hashes.selectedLinesHash) {
        throw new Error("review comment snapshot selectedLinesHash does not match captured lines");
    }
    if (snapshot.contextWindowHash !== hashes.contextWindowHash) {
        throw new Error("review comment snapshot contextWindowHash does not match captured context");
    }
    if (snapshot.hasBidiControls !== actualHasBidiControls) {
        throw new Error("review comment snapshot bidi metadata does not match captured text");
    }
    if (snapshot.likelyMinified !== actualLikelyMinified) {
        throw new Error("review comment snapshot minified metadata does not match captured text");
    }

    const exceedsSizeCap = selectedBytes > REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES
        || contextBytes > REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES;
    const exceedsLineCap = longestLineBytes > REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES;

    if ((exceedsSizeCap || exceedsLineCap) && !snapshot.truncated) {
        throw new Error("review comment snapshot must be marked truncated when captured text exceeds caps");
    }
    if (exceedsSizeCap && snapshot.truncationReason !== "file_too_large" && snapshot.truncationReason !== "context_cap") {
        throw new Error("review comment snapshot truncationReason must describe the exceeded size cap");
    }
    if (exceedsLineCap && snapshot.truncationReason !== "line_too_long") {
        throw new Error("review comment snapshot truncationReason must describe the exceeded line cap");
    }
    if (exceedsLineCap) {
        throw new Error("review comment snapshot line cap still exceeded after truncation");
    }
}
