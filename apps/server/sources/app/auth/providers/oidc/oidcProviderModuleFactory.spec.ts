import { describe, expect, it } from "vitest";

import type { AuthPolicy } from "@/app/auth/authPolicy";
import { createOidcProviderModule } from "@/app/auth/providers/oidc/oidcProviderModuleFactory";

describe("oidcProviderModuleFactory", () => {
    it("surfaces ui hints, restrictions, and offboarding source in resolveFeatures()", () => {
        const policy: AuthPolicy = {
            anonymousSignupEnabled: true,
            signupProviders: [],
            requiredLoginProviders: [],
            offboarding: { enabled: true, intervalSeconds: 3600, mode: "per-request-cache" },
        };

        const provider = createOidcProviderModule({
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: {
                usersAllowlist: ["alice"],
                emailDomains: ["example.com"],
                groupsAny: ["eng"],
                groupsAll: ["employees"],
            },
            fetchUserInfo: false,
            storeRefreshToken: true,
            ui: { buttonColor: "#111111", iconHint: "okta" },
        });

        const features = provider.auth.resolveFeatures({ env: {}, policy });

        expect(features.enabled).toBe(true);
        expect(features.configured).toBe(true);
        expect(features.ui?.displayName).toBe("Acme Okta");
        expect(features.ui?.iconHint).toBe("okta");
        expect(features.ui?.connectButtonColor).toBe("#111111");

        expect(features.restrictions.usersAllowlist).toBe(true);
        expect(features.restrictions.orgsAllowlist).toBe(true);
        expect(features.restrictions.orgMatch).toBe("all");

        expect(features.offboarding.enabled).toBe(true);
        expect(features.offboarding.intervalSeconds).toBe(3600);
        expect(features.offboarding.mode).toBe("per-request-cache");
        expect(features.offboarding.source).toBe("oidc_refresh_token");
    });
});

