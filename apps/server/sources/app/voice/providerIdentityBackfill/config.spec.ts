import { describe, expect, it } from "vitest";

import { readVoiceProviderIdentityBackfillPolicy } from "./config";

describe("readVoiceProviderIdentityBackfillPolicy", () => {
    it("is disabled by default and uses bounded rollout defaults", () => {
        expect(readVoiceProviderIdentityBackfillPolicy({}, "postgres")).toEqual({
            enabled: false,
            batchSize: 100,
            timeBudgetMs: 5_000,
            batchDelayMs: 100,
            intervalMs: 60_000,
            lockTtlMs: 305_000,
        });
    });

    it("enables supported providers only through an explicit valid switch", () => {
        const env = { HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "true" };

        expect(readVoiceProviderIdentityBackfillPolicy(env, "postgres").enabled).toBe(true);
        expect(readVoiceProviderIdentityBackfillPolicy(env, "pglite").enabled).toBe(true);
        expect(readVoiceProviderIdentityBackfillPolicy(env, "sqlite").enabled).toBe(true);
        expect(readVoiceProviderIdentityBackfillPolicy(env, "mysql").enabled).toBe(false);
    });

    it("treats every MySQL worker setting as not applicable without parsing it", () => {
        expect(readVoiceProviderIdentityBackfillPolicy({
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "sometimes",
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: "unbounded",
        }, "mysql")).toEqual({
            enabled: false,
            batchSize: 100,
            timeBudgetMs: 5_000,
            batchDelayMs: 100,
            intervalMs: 60_000,
            lockTtlMs: 305_000,
        });
    });

    it("rejects malformed enablement and out-of-range budgets instead of silently widening work", () => {
        expect(() => readVoiceProviderIdentityBackfillPolicy({
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "sometimes",
        }, "postgres")).toThrow(/ENABLED/);

        expect(() => readVoiceProviderIdentityBackfillPolicy({
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: "1001",
        }, "postgres")).toThrow(/BATCH_SIZE/);

        expect(() => readVoiceProviderIdentityBackfillPolicy({
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: "0",
        }, "postgres")).toThrow(/TIME_BUDGET_MS/);
    });

    it("derives a lock lifetime beyond the maximum run budget", () => {
        expect(readVoiceProviderIdentityBackfillPolicy({
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "true",
            HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: "120000",
        }, "postgres").lockTtlMs).toBe(420_000);
    });
});
