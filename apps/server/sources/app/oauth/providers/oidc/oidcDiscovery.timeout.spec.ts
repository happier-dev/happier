import { describe, expect, it, vi } from "vitest";

vi.mock("openid-client", async () => {
    const actual = await vi.importActual<any>("openid-client");
    return {
        ...actual,
        discovery: vi.fn(async () => ({ mocked: true })),
    };
});

describe("oidcDiscovery", () => {
    it("passes instance.httpTimeoutSeconds to openid-client discovery options", async () => {
        vi.resetModules();
        const oidcClient = await import("openid-client");
        const { discoverOidcConfiguration } = await import("./oidcDiscovery");

        await discoverOidcConfiguration({
            id: "okta",
            type: "oidc",
            displayName: "Okta",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
            scopes: "openid profile email",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        } as any);

        const call = (oidcClient as any).discovery.mock.calls[0];
        expect(call).toBeTruthy();
        expect(call[4]).toMatchObject({ timeout: 5 });
    });

    it("throws a descriptive error when issuer is not a valid URL", async () => {
        vi.resetModules();
        const oidcClient = await import("openid-client");
        (oidcClient as any).discovery?.mockClear?.();
        const { discoverOidcConfiguration } = await import("./oidcDiscovery");

        await expect(
            discoverOidcConfiguration({
                id: "bad",
                type: "oidc",
                displayName: "Bad",
                issuer: "not a url",
                clientId: "cid-bad",
                clientSecret: "secret",
                redirectUrl: "https://server.example.test/v1/oauth/bad/callback",
                scopes: "openid",
                claims: { login: "sub", email: "email", groups: "groups" },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: false,
                storeRefreshToken: false,
                ui: { buttonColor: null, iconHint: null },
                httpTimeoutSeconds: 5,
            } as any),
        ).rejects.toThrow("Invalid OIDC issuer URL: not a url");

        expect((oidcClient as any).discovery).not.toHaveBeenCalled();
    });
});
