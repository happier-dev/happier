import { describe, expect, it } from "vitest";

import { resolveAuthPolicyFromEnv } from "./authPolicy";

describe("resolveAuthPolicyFromEnv (offboarding enabled default)", () => {
    it("defaults offboarding disabled when no provider restrictions exist", () => {
        const policy = resolveAuthPolicyFromEnv({} as any);
        expect(policy.offboarding.enabled).toBe(false);
    });

    it("defaults offboarding enabled when GitHub org restrictions are configured", () => {
        const policy = resolveAuthPolicyFromEnv({
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
        } as any);
        expect(policy.offboarding.enabled).toBe(true);
    });

    it("defaults offboarding enabled when an OIDC provider has allowlists configured", () => {
        const policy = resolveAuthPolicyFromEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "corp",
                    type: "oidc",
                    displayName: "Corp SSO",
                    issuer: "https://example.com",
                    clientId: "client",
                    clientSecret: "secret",
                    redirectUrl: "https://app.example.com/oauth/callback",
                    scopes: "openid profile email",
                    allow: { groupsAny: ["devs"] },
                    storeRefreshToken: true,
                },
            ]),
        } as any);
        expect(policy.offboarding.enabled).toBe(true);
    });

    it("allows AUTH_OFFBOARDING_ENABLED to override the default", () => {
        const policy = resolveAuthPolicyFromEnv({
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_OFFBOARDING_ENABLED: "false",
        } as any);
        expect(policy.offboarding.enabled).toBe(false);
    });
});

