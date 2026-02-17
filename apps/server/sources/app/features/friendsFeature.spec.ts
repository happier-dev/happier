import { describe, expect, it } from "vitest";

import { resolveFriendsFeature } from "./friendsFeature";

describe("resolveFriendsFeature", () => {
    it("defaults to friends enabled when username identity is allowed", () => {
        const feature = resolveFriendsFeature({} as NodeJS.ProcessEnv);
        expect(feature.social.friends.enabled).toBe(true);
    });

    it("hard-disables friends when build policy denies the feature", () => {
        const feature = resolveFriendsFeature({
            HAPPIER_BUILD_FEATURES_DENY: "social.friends",
        } as NodeJS.ProcessEnv);

        expect(feature.social.friends.enabled).toBe(false);
    });
});

