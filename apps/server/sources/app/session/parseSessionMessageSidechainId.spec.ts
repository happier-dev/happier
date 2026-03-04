import { describe, expect, it } from "vitest";

import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";

describe("parseSessionMessageSidechainId", () => {
    it("returns {ok:true, sidechainId:null} for nullish inputs", () => {
        expect(parseSessionMessageSidechainId(undefined)).toEqual({ ok: true, sidechainId: null });
        expect(parseSessionMessageSidechainId(null)).toEqual({ ok: true, sidechainId: null });
    });

    it("trims string inputs", () => {
        expect(parseSessionMessageSidechainId(" sc-1 ")).toEqual({ ok: true, sidechainId: "sc-1" });
    });

    it("treats empty strings as invalid by default", () => {
        expect(parseSessionMessageSidechainId("")).toEqual({ ok: false });
        expect(parseSessionMessageSidechainId("   ")).toEqual({ ok: false });
    });

    it("can treat empty strings as null when configured", () => {
        expect(parseSessionMessageSidechainId("", { emptyString: "null" })).toEqual({ ok: true, sidechainId: null });
        expect(parseSessionMessageSidechainId("   ", { emptyString: "null" })).toEqual({ ok: true, sidechainId: null });
    });

    it("rejects non-string non-nullish values", () => {
        expect(parseSessionMessageSidechainId(123)).toEqual({ ok: false });
        expect(parseSessionMessageSidechainId({})).toEqual({ ok: false });
    });

    it("rejects sidechain ids longer than the max length", () => {
        const tooLong = "x".repeat(192);
        expect(parseSessionMessageSidechainId(tooLong)).toEqual({ ok: false });
    });
});

