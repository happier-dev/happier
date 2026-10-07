import { describe, expect, it } from "vitest";

import {
    buildReviewCommentTextSnapshotHashes,
    validateReviewCommentSnapshot,
} from "./snapshots";

describe("review comment snapshot validation", () => {
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

    it("accepts complete valid snapshots above the former line and byte cutoffs", () => {
        const longLine = "x".repeat(5 * 1024 * 1024 + 1);
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
        })).not.toThrow();
    });

    it("accepts explicitly incomplete retained snapshots without imposing a capture cutoff", () => {
        const uncappedLine = "x".repeat(4001);
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
        })).not.toThrow();
    });
});
