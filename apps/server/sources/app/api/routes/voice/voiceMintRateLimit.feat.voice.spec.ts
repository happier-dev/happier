import { describe, expect, it } from "vitest";

import { resolveVoiceMintRouteRateLimit } from "./voiceMintRateLimit";

describe("voiceMintRateLimit", () => {
    describe("resolveVoiceMintRouteRateLimit", () => {
        it("returns one shared-handler configuration and a schema-compatible 429 error builder", () => {
            const config = resolveVoiceMintRouteRateLimit({});
            expect(config).not.toBe(false);
            if (config === false) throw new Error("expected a config");
            expect(config.max).toBe(10);
            expect(config).not.toHaveProperty("groupId");
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
