import { describe, expect, it } from "vitest";

import {
    buildReviewCommentTextSnapshotHashes,
    REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES,
    REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES,
    validateReviewCommentSnapshot,
} from "./snapshots";

describe("review comment snapshot validation", () => {
    it("uses the ratified 5 MiB text snapshot cap", () => {
        expect(REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it("accepts text snapshots only when hashes and bidi/minified metadata match the captured text", () => {
        const hashes = buildReviewCommentTextSnapshotHashes({
            selectedLines: ["if (value == null) return null;"],
            beforeContext: ["function read(value?: User) {"],
            afterContext: ["return value.name;", "}"],
        });

        expect(() => validateReviewCommentSnapshot({
            kind: "text",
            selectedLines: ["if (value == null) return null;"],
            beforeContext: ["function read(value?: User) {"],
            afterContext: ["return value.name;", "}"],
            selectedLinesHash: hashes.selectedLinesHash,
            contextWindowHash: hashes.contextWindowHash,
            capturedAt: 1,
            fileLength: 4,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        })).not.toThrow();
    });

    it("rejects forged hash and bidi metadata", () => {
        expect(() => validateReviewCommentSnapshot({
            kind: "text",
            selectedLines: ["const hidden = \"\u202Etxt\";"],
            beforeContext: [],
            afterContext: [],
            selectedLinesHash: "sha256:wrong",
            contextWindowHash: "sha256:wrong",
            capturedAt: 1,
            fileLength: 1,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        })).toThrow(/hash|bidi/i);
    });

    it("requires explicit truncation metadata for line and file caps", () => {
        const longLine = "x".repeat(5000);
        const hashes = buildReviewCommentTextSnapshotHashes({
            selectedLines: [longLine],
            beforeContext: [],
            afterContext: [],
        });

        expect(() => validateReviewCommentSnapshot({
            kind: "text",
            selectedLines: [longLine],
            beforeContext: [],
            afterContext: [],
            selectedLinesHash: hashes.selectedLinesHash,
            contextWindowHash: hashes.contextWindowHash,
            capturedAt: 1,
            fileLength: 1,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: true,
        })).toThrow(/truncated/i);
    });

    it("rejects text snapshots that still carry uncapped line content", () => {
        const uncappedLine = "x".repeat(REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES + 1);
        const hashes = buildReviewCommentTextSnapshotHashes({
            selectedLines: [uncappedLine],
            beforeContext: [],
            afterContext: [],
        });

        expect(() => validateReviewCommentSnapshot({
            kind: "text",
            selectedLines: [uncappedLine],
            beforeContext: [],
            afterContext: [],
            selectedLinesHash: hashes.selectedLinesHash,
            contextWindowHash: hashes.contextWindowHash,
            capturedAt: 1,
            fileLength: 1,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: true,
            truncationReason: "line_too_long",
            hasBidiControls: false,
            likelyMinified: true,
        })).toThrow(/line cap/i);
    });
});
