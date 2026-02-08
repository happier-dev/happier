import { describe, expect, it } from "vitest";

import { AuthErrorCodeSchema } from "@happier-dev/protocol";

describe("protocol (AuthErrorCodeSchema)", () => {
    it("accepts provider-agnostic oauth error codes", () => {
        expect(AuthErrorCodeSchema.safeParse("oauth_not_configured").success).toBe(true);
    });

    it("rejects GitHub-shaped error codes", () => {
        expect(AuthErrorCodeSchema.safeParse("invalid_github_response").success).toBe(false);
    });
});

