import { afterEach, describe, expect, it, vi } from "vitest";
import * as oidcClient from "openid-client";

import { createOidcOAuthProvider } from "./oidcOAuthProvider";

vi.mock("openid-client", () => ({
    allowInsecureRequests: () => {},
    discovery: vi.fn(async () => ({})),
    fetchUserInfo: vi.fn(async () => ({})),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe("oidcOAuthProvider", () => {
    it("uses configured scopes when building auth urls", () => {
        const provider = createOidcOAuthProvider({
            id: "okta",
            type: "oidc",
            displayName: "Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email offline_access",
            httpTimeoutSeconds: 30,
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        });

        expect(provider.resolveScope({ env: process.env, flow: "auth" })).toBe("openid profile email offline_access");
    });

    it("extracts login using the configured login claim with sensible fallback", () => {
        const provider = createOidcOAuthProvider({
            id: "okta",
            type: "oidc",
            displayName: "Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email",
            httpTimeoutSeconds: 30,
            claims: { login: "upn", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        });

        expect(provider.getLogin({ upn: "User@Corp.Example" })).toBe("User@Corp.Example");
        expect(provider.getLogin({ upn: "", preferred_username: "alice" })).toBe("alice");
        expect(provider.getLogin({ email: "alice@example.test" })).toBe("alice@example.test");
        expect(provider.getLogin({})).toBe(null);
    });

    it("preserves the original error as the cause when profile fetch fails", async () => {
        const provider = createOidcOAuthProvider({
            id: "okta",
            type: "oidc",
            displayName: "Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email",
            httpTimeoutSeconds: 30,
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        });

        const cause = new Error("fetchUserInfo exploded");
        (oidcClient.discovery as any).mockResolvedValue({} as any);
        (oidcClient.fetchUserInfo as any).mockRejectedValue(cause);

        const err = await provider
            .fetchProfile({ env: process.env, accessToken: "t", idTokenClaims: { sub: "user-1" } })
            .then(
                () => null,
                (e) => e,
            );

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("profile_fetch_failed");
        expect((err as any).cause).toBe(cause);
    });

    it("reports configured=false when required instance config is missing", () => {
        const provider = createOidcOAuthProvider({
            id: "okta",
            type: "oidc",
            displayName: "Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "",
            redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email",
            httpTimeoutSeconds: 30,
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        });

        expect(provider.isConfigured(process.env)).toBe(false);
        expect(provider.resolveStatus(process.env).configured).toBe(false);
    });
});
