import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/auth/providers/providerModules", () => ({
    resolveProviderModules: () => [
        {
            oauth: {
                id: "GitHub",
                resolveStatus: () => ({ enabled: true, configured: true }),
                isConfigured: () => true,
                resolveRedirectUrl: () => "https://server.example.test/v1/oauth/github/callback",
                resolveScope: () => "openid",
                resolveAuthorizeUrl: async () => "https://provider.example.test/authorize",
                exchangeCodeForAccessToken: async () => ({ accessToken: "t" }),
                fetchProfile: async () => ({ login: "alice" }),
                getLogin: () => "alice",
                getProviderUserId: () => "alice",
            },
        },
    ],
}));

import { findOAuthProviderById } from "./registry";

describe("oauth/providers registry", () => {
    it("finds providers case-insensitively", () => {
        const provider = findOAuthProviderById({}, "github");
        expect(provider?.id).toBe("GitHub");
    });
});

