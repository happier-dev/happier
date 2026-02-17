import { describe, expect, it } from "vitest";

import { resolveFriendsFeature } from "./friendsFeature";

describe("resolveFriendsFeature", () => {
    it("defaults to friends enabled when username identity is allowed", () => {
        const feature = resolveFriendsFeature({} as NodeJS.ProcessEnv);
        expect(feature.features?.social?.friends?.enabled).toBe(true);
    });

    it("treats friends as disabled when username identity is disabled and the required identity provider is not registered", () => {
        const feature = resolveFriendsFeature({
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: "custom",
        } as unknown as NodeJS.ProcessEnv);
        expect(feature.features?.social?.friends?.enabled).toBe(false);
    });
});
