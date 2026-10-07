import {
    buildReviewCommentTextSnapshotHashes,
    ReviewCommentSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
    reviewCommentTextSnapshotHasBidiControlsV1,
    reviewCommentTextSnapshotIsLikelyMinifiedV1,
    type ReviewCommentSnapshotContentV1,
    type ReviewCommentSnapshotV1,
    type ReviewCommentTextSnapshotLinesV1,
} from "@happier-dev/protocol";

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
}
