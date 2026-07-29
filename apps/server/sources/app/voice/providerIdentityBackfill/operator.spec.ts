import { describe, expect, it } from "vitest";

import {
    parseVoiceProviderIdentityBackfillOperatorArgs,
    resolveVoiceProviderIdentityBackfillOperatorProvider,
} from "./operator";

describe("parseVoiceProviderIdentityBackfillOperatorArgs", () => {
    it("parses run and verify modes with bounded numeric options", () => {
        expect(parseVoiceProviderIdentityBackfillOperatorArgs([
            "run",
            "--batch-size=25",
            "--time-budget-ms=10000",
            "--batch-delay-ms=50",
        ])).toEqual({
            mode: "run",
            batchSize: 25,
            timeBudgetMs: 10_000,
            batchDelayMs: 50,
            stabilityMs: 5_000,
        });
        expect(parseVoiceProviderIdentityBackfillOperatorArgs([
            "verify",
            "--stability-ms=30000",
        ])).toMatchObject({ mode: "verify", stabilityMs: 30_000 });
    });

    it("rejects unknown modes, flags, and unsafe numeric values", () => {
        expect(() => parseVoiceProviderIdentityBackfillOperatorArgs(["maybe"])).toThrow(/run or verify/);
        expect(() => parseVoiceProviderIdentityBackfillOperatorArgs(["run", "--unknown=1"])).toThrow(/unknown/i);
        expect(() => parseVoiceProviderIdentityBackfillOperatorArgs(["run", "--batch-size=1001"])).toThrow(/batch-size/);
        expect(() => parseVoiceProviderIdentityBackfillOperatorArgs(["verify", "--stability-ms=-1"])).toThrow(/stability-ms/);
        expect(() => parseVoiceProviderIdentityBackfillOperatorArgs(["verify", "--stability-ms=0"])).toThrow(/stability-ms/);
    });
});

describe("resolveVoiceProviderIdentityBackfillOperatorProvider", () => {
    it("accepts canonical providers and the postgresql alias", () => {
        expect(resolveVoiceProviderIdentityBackfillOperatorProvider({ HAPPIER_DB_PROVIDER: "postgresql" }, "sqlite"))
            .toBe("postgres");
        expect(resolveVoiceProviderIdentityBackfillOperatorProvider({ HAPPY_DB_PROVIDER: "pglite" }, "sqlite"))
            .toBe("pglite");
    });

    it("rejects an explicit unknown provider instead of silently targeting the fallback", () => {
        expect(() => resolveVoiceProviderIdentityBackfillOperatorProvider({
            HAPPIER_DB_PROVIDER: "postgress",
        }, "postgres")).toThrow(/Unsupported.*postgress/);
    });
});
