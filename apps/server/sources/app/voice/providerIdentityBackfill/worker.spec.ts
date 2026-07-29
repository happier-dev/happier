import { describe, expect, it } from "vitest";

import { assertVoiceProviderIdentityBackfillMonitorSuccess } from "./worker";

describe("assertVoiceProviderIdentityBackfillMonitorSuccess", () => {
    it("turns a handled backfill failure into a bounded monitor failure", () => {
        expect(() => assertVoiceProviderIdentityBackfillMonitorSuccess({
            status: "failed",
            reason: "collision",
        })).toThrow("voice_provider_identity_backfill_failed:collision");
    });

    it("does not fail the monitor for successful, disabled, or contended passes", () => {
        expect(() => assertVoiceProviderIdentityBackfillMonitorSuccess({
            status: "disabled",
        })).not.toThrow();
        expect(() => assertVoiceProviderIdentityBackfillMonitorSuccess({
            status: "locked",
        })).not.toThrow();
        expect(() => assertVoiceProviderIdentityBackfillMonitorSuccess({
            status: "completed",
            result: {
                stopReason: "zero",
                batches: 1,
                conversationsProcessed: 0,
                leasesProcessed: 0,
                remainingConversations: 0,
                remainingLeases: 0,
            },
        })).not.toThrow();
    });
});
