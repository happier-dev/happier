import { describe, expect, it } from "vitest";

import { resolveVoiceMintRateLimit, resolveVoiceMintRouteRateLimit } from "./voiceMintRateLimit";

describe("voiceMintRateLimit", () => {
    describe("resolveVoiceMintRateLimit", () => {
        it("resolves the catalog default budget (10 per minute)", () => {
            const limit = resolveVoiceMintRateLimit({});
            expect(limit).toEqual({ max: 10, windowMs: 60_000 });
        });

        it("reflects env overrides for max and window", () => {
            const limit = resolveVoiceMintRateLimit({
                HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "5",
                HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "30 seconds",
            });
            expect(limit).toEqual({ max: 5, windowMs: 30_000 });
        });

        it("parses assorted window units", () => {
            expect(resolveVoiceMintRateLimit({ HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "2 minutes" })?.windowMs).toBe(120_000);
            expect(resolveVoiceMintRateLimit({ HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "1 hour" })?.windowMs).toBe(3_600_000);
            expect(resolveVoiceMintRateLimit({ HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "500 ms" })?.windowMs).toBe(500);
        });

        it("falls back to one minute for an unparseable window", () => {
            expect(resolveVoiceMintRateLimit({ HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "garbage" })?.windowMs).toBe(60_000);
        });

        it("returns null when rate limiting is disabled (max <= 0 or limits off)", () => {
            expect(resolveVoiceMintRateLimit({ HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "0" })).toBeNull();
            expect(resolveVoiceMintRateLimit({ HAPPIER_API_RATE_LIMITS_ENABLED: "false" })).toBeNull();
        });
    });

    describe("resolveVoiceMintRouteRateLimit", () => {
        it("attaches the shared groupId and a schema-compatible 429 error builder", () => {
            const config = resolveVoiceMintRouteRateLimit({});
            expect(config).not.toBe(false);
            if (config === false) throw new Error("expected a config");
            expect(config.max).toBe(10);
            expect(config.groupId).toBe("voice.mint");
            expect(config.errorResponseBuilder()).toEqual({
                statusCode: 429,
                allowed: false,
                reason: "too_many_sessions",
            });
        });

        it("is false when rate limiting is disabled", () => {
            expect(resolveVoiceMintRouteRateLimit({ HAPPIER_API_RATE_LIMITS_ENABLED: "false" })).toBe(false);
        });
    });
});
