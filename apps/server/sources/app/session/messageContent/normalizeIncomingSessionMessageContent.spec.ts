import { describe, expect, it } from "vitest";

import { normalizeIncomingSessionMessageContent } from "./normalizeIncomingSessionMessageContent";

describe("normalizeIncomingSessionMessageContent", () => {
    it("wraps legacy ciphertext strings as encrypted content", () => {
        expect(normalizeIncomingSessionMessageContent("aGVsbG8=")).toEqual({ t: "encrypted", c: "aGVsbG8=" });
    });

    it("accepts encrypted envelope objects", () => {
        expect(normalizeIncomingSessionMessageContent({ t: "encrypted", c: "abc" })).toEqual({ t: "encrypted", c: "abc" });
    });

    it("accepts plain envelope objects", () => {
        expect(normalizeIncomingSessionMessageContent({ t: "plain", v: { type: "user", text: "hi" } })).toEqual({
            t: "plain",
            v: { type: "user", text: "hi" },
        });
    });

    it("returns null for invalid inputs", () => {
        expect(normalizeIncomingSessionMessageContent(null)).toBeNull();
        expect(normalizeIncomingSessionMessageContent({})).toBeNull();
        expect(normalizeIncomingSessionMessageContent({ t: "plain" })).toBeNull();
        expect(normalizeIncomingSessionMessageContent({ t: "encrypted", c: 123 })).toBeNull();
    });
});

