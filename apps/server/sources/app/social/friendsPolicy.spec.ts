import { describe, expect, it } from "vitest";

import { resolveFriendsPolicyFromEnv } from "./friendsPolicy";

describe("social/friendsPolicy", () => {
    it("defaults to enabled with username identity allowed", () => {
        const policy = resolveFriendsPolicyFromEnv({});
        expect(policy.enabled).toBe(true);
        expect(policy.allowUsername).toBe(true);
        expect(policy.requiredIdentityProviderId).toBeNull();
    });

    it("disables friends when canonical feature env is false-ish", () => {
        expect(resolveFriendsPolicyFromEnv({ HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0" }).enabled).toBe(false);
        expect(resolveFriendsPolicyFromEnv({ HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "false" }).enabled).toBe(false);
        expect(resolveFriendsPolicyFromEnv({ HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "off" }).enabled).toBe(false);
    });

    it("allows username identity when canonical allow-username env is on", () => {
        const policy = resolveFriendsPolicyFromEnv({ HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1" });
        expect(policy.allowUsername).toBe(true);
        expect(policy.requiredIdentityProviderId).toBeNull();
    });

    it("requires an identity provider when allow-username is explicitly disabled", () => {
        const policy = resolveFriendsPolicyFromEnv({ HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0" });
        expect(policy.allowUsername).toBe(false);
        expect(policy.requiredIdentityProviderId).toBe("github");
    });
});
