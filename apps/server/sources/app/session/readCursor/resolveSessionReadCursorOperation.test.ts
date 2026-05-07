import { describe, expect, it } from "vitest";

import { resolveSessionReadCursorOperation } from "./resolveSessionReadCursorOperation";

describe("resolveSessionReadCursorOperation", () => {
    it("advances a null cursor to the requested cursor", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: null,
            operation: { kind: "advance", lastViewedSessionSeq: 4 },
        })).toEqual({
            nextLastViewedSessionSeq: 4,
            didChange: true,
            readState: "unread",
        });
    });

    it("clamps advance to the current session sequence", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 3,
            operation: { kind: "advance", lastViewedSessionSeq: 9 },
        })).toEqual({
            nextLastViewedSessionSeq: 8,
            didChange: true,
            readState: "read",
        });
    });

    it("clamps advance to zero for empty sessions", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 0,
            currentLastViewedSessionSeq: null,
            operation: { kind: "advance", lastViewedSessionSeq: 9 },
        })).toEqual({
            nextLastViewedSessionSeq: 0,
            didChange: true,
            readState: "empty",
        });
    });

    it("keeps the cursor when advance would regress", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 5,
            operation: { kind: "advance", lastViewedSessionSeq: 4 },
        })).toEqual({
            nextLastViewedSessionSeq: 5,
            didChange: false,
            readState: "unread",
        });
    });

    it("marks read by moving to the current session sequence", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 3,
            operation: { kind: "mark-read" },
        })).toEqual({
            nextLastViewedSessionSeq: 8,
            didChange: true,
            readState: "read",
        });
    });

    it("no-ops mark-read when the cursor is already current", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 8,
            operation: { kind: "mark-read" },
        })).toEqual({
            nextLastViewedSessionSeq: 8,
            didChange: false,
            readState: "read",
        });
    });

    it("marks unread by lowering a current cursor to one before the current sequence", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 8,
            operation: { kind: "mark-unread" },
        })).toEqual({
            nextLastViewedSessionSeq: 7,
            didChange: true,
            readState: "unread",
        });
    });

    it("keeps the cursor when mark-unread is already unread", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: 3,
            operation: { kind: "mark-unread" },
        })).toEqual({
            nextLastViewedSessionSeq: 3,
            didChange: false,
            readState: "unread",
        });
    });

    it("marks the first sequence unread by lowering to zero", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 1,
            currentLastViewedSessionSeq: 1,
            operation: { kind: "mark-unread" },
        })).toEqual({
            nextLastViewedSessionSeq: 0,
            didChange: true,
            readState: "unread",
        });
    });

    it("keeps empty sessions unchanged when marking unread", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 0,
            currentLastViewedSessionSeq: 0,
            operation: { kind: "mark-unread" },
        })).toEqual({
            nextLastViewedSessionSeq: 0,
            didChange: false,
            readState: "empty",
        });
    });

    it("preserves null when mark-unread is already unread through a missing cursor", () => {
        expect(resolveSessionReadCursorOperation({
            sessionSeq: 8,
            currentLastViewedSessionSeq: null,
            operation: { kind: "mark-unread" },
        })).toEqual({
            nextLastViewedSessionSeq: null,
            didChange: false,
            readState: "unread",
        });
    });
});
