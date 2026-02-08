import { describe, expect, it } from "vitest";

import { resolveFriendsPolicyFromEnv } from "./friendsPolicy";

describe("social/friendsPolicy", () => {
    it("defaults to enabled with a required identity provider when username is disabled", () => {
        const policy = resolveFriendsPolicyFromEnv({});
        expect(policy.enabled).toBe(true);
        expect(policy.allowUsername).toBe(false);
        expect(policy.requiredIdentityProviderId).toBe("github");
    });

    it("disables friends when FRIENDS_ENABLED is false-ish", () => {
        expect(resolveFriendsPolicyFromEnv({ FRIENDS_ENABLED: "0" }).enabled).toBe(false);
        expect(resolveFriendsPolicyFromEnv({ FRIENDS_ENABLED: "false" }).enabled).toBe(false);
        expect(resolveFriendsPolicyFromEnv({ FRIENDS_ENABLED: "off" }).enabled).toBe(false);
    });

    it("allows username identity when FRIENDS_ALLOW_USERNAME is on", () => {
        const policy = resolveFriendsPolicyFromEnv({ FRIENDS_ALLOW_USERNAME: "1" });
        expect(policy.allowUsername).toBe(true);
        expect(policy.requiredIdentityProviderId).toBeNull();
    });
});
