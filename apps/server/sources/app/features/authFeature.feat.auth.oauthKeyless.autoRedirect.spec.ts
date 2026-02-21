import { describe, expect, it } from "vitest";

import { resolveAuthFeature } from "./authFeature";

describe("resolveAuthFeature (OAuth keyless auto-redirect)", () => {
    it("auto-selects the sole enabled keyless OAuth login method when anonymous signup is disabled", () => {
        const feature = resolveAuthFeature({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://example.test/v1/oauth/github/callback",
        } as NodeJS.ProcessEnv);

        expect(feature.capabilities?.auth?.ui?.autoRedirect?.enabled).toBe(true);
        expect(feature.capabilities?.auth?.ui?.autoRedirect?.providerId).toBe("github");
    });
});
