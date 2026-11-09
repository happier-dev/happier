import { describe, expect, it } from "vitest";

import {
    resolveToolEnvelopeMeta,
    resolveToolEnvelopeMetaV2,
    ToolHappierMetaV2Schema,
    ToolHappierMetaV3Schema,
} from "./meta.js";
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
    it("accepts current qualified provenance without losing loose tool metadata", () => {
        const meta = {
            v: 3,
            protocol: "native",
            agent: { pluginId: "example.agent", localId: "fixture" },
            rawToolName: "execute",
            canonicalToolName: "Bash",
            sessionMode: "local_control",
        };

        const parsed = BashInputV2Schema.safeParse({ command: "echo hi", _happier: meta });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data._happier).toEqual(meta);
        expect(resolveToolEnvelopeMeta({ _happier: meta })).toEqual(meta);
        expect(resolveToolEnvelopeMeta({ _happier: meta, _happy: makeMeta("historical-provider", "old") })).toEqual(meta);
        expect(ToolHappierMetaV2Schema.safeParse(meta).success).toBe(false);
        expect(resolveToolEnvelopeMetaV2({ _happier: meta })).toBeNull();
    });

    it("keeps qualified identity closed while metadata adjuncts remain open", () => {
        const meta = {
            v: 3,
            protocol: "acp",
            agent: { pluginId: "example.agent", localId: "fixture", authority: "invented" },
            rawToolName: "execute",
            canonicalToolName: "Bash",
        };
        expect(ToolHappierMetaV3Schema.safeParse(meta).success).toBe(false);
        expect(resolveToolEnvelopeMeta({ _happier: meta })).toBeNull();
    });

    it("normalizes released native provenance without inventing a qualified identity", () => {
        const legacy = { ...makeMeta("unqualified-provider", "execute"), sessionMode: "local_control" };
        expect(resolveToolEnvelopeMeta({ _happy: legacy })).toEqual({ ...legacy, protocol: "native" });
        expect(resolveToolEnvelopeMeta({ _happier: { ...legacy, protocol: "acp" } })).toEqual({
            ...legacy,
            protocol: "acp",
        });
        expect(resolveToolEnvelopeMeta({ _happy: legacy })).not.toHaveProperty("agent");
    });

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
