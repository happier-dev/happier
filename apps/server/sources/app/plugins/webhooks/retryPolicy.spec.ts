import { describe, expect, it } from "vitest";

import { resolvePluginWebhookRetryDelayMsV1 } from "./retryPolicy";

describe("plugin webhook retry policy", () => {
    it("uses bounded equal-jitter windows that advance monotonically by execution attempt", () => {
        expect(resolvePluginWebhookRetryDelayMsV1({ attempt: 1, random: () => 0 })).toBe(2_500);
        expect(resolvePluginWebhookRetryDelayMsV1({ attempt: 1, random: () => 0.999999 })).toBeLessThanOrEqual(5_000);
        expect(resolvePluginWebhookRetryDelayMsV1({ attempt: 2, random: () => 0 })).toBe(5_000);
        expect(resolvePluginWebhookRetryDelayMsV1({ attempt: 12, random: () => 0.999999 })).toBeLessThanOrEqual(10_800_000);
    });

    it("rejects invalid attempt and randomness inputs instead of scheduling outside policy", () => {
        expect(() => resolvePluginWebhookRetryDelayMsV1({ attempt: 0, random: () => 0 })).toThrow(TypeError);
        expect(() => resolvePluginWebhookRetryDelayMsV1({ attempt: 1, random: () => 1 })).toThrow(TypeError);
    });
});
