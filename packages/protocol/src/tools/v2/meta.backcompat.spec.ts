import { describe, expect, it } from "vitest";

import { resolveToolEnvelopeMetaV2 } from "./meta.js";
import { BashInputV2Schema } from "./schemas.js";

function makeMeta(provider: string, rawToolName: string) {
    return {
        v: 2 as const,
        protocol: "codex" as const,
        provider,
        rawToolName,
        canonicalToolName: "Bash",
    };
}

describe("tools v2 meta back-compat", () => {
    it("accepts legacy _happy meta", () => {
        const legacy = makeMeta("legacy-provider", "legacy_bash");
        const parsed = BashInputV2Schema.parse({
            command: "echo hi",
            _happy: legacy,
        });

        expect(parsed._happy).toEqual(legacy);
        expect(resolveToolEnvelopeMetaV2(parsed)).toEqual(legacy);
    });

    it("accepts canonical _happier meta", () => {
        const canonical = makeMeta("canonical-provider", "canonical_bash");
        const parsed = BashInputV2Schema.parse({
            command: "echo hi",
            _happier: canonical,
        });

        expect(parsed._happier).toEqual(canonical);
        expect(resolveToolEnvelopeMetaV2(parsed)).toEqual(canonical);
    });

    it("prefers _happier when both _happier and _happy are present", () => {
        const canonical = makeMeta("canonical-provider", "canonical_bash");
        const legacy = makeMeta("legacy-provider", "legacy_bash");
        const parsed = BashInputV2Schema.parse({
            command: "echo hi",
            _happier: canonical,
            _happy: legacy,
        });

        expect(resolveToolEnvelopeMetaV2(parsed)).toEqual(canonical);
    });
});
