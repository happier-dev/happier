import { describe, expect, it } from "vitest";
import type { StoredHomeSettings } from "@/app/home/settings/startupHomeEnv";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAuthProviderInstancesFromEnv } from "./oidcProviderConfig";

describe("oidcProviderConfig", () => {
    it("parses AUTH_PROVIDERS_CONFIG_JSON and normalizes provider ids", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "Okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: "https://example.okta.com/oauth2/default",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.errors).toEqual([]);
        expect(res.instances.map((i) => i.id)).toEqual(["okta"]);
        expect(res.instances[0]?.type).toBe("oidc");
    });

    it("applies OIDC defaults and validates scopes include openid", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: "https://issuer.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
                    scopes: "profile email", // invalid (missing openid)
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.instances).toEqual([]);
        expect(res.errors.join("\n")).toMatch(/openid/i);
    });

    it("parses allowlists, claim mapping, ui hints, and refresh/userinfo toggles", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: "https://issuer.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
                    scopes: "openid profile email offline_access",
                    httpTimeoutSeconds: 7,
                    claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: {
                        usersAllowlist: ["Alice", "bob"],
                        emailDomains: ["Example.COM", "@corp.example.test"],
                        groupsAny: ["Eng", "SRE"],
                        groupsAll: ["employees"],
                    },
                    fetchUserInfo: true,
                    storeRefreshToken: true,
                    ui: { buttonColor: "#123456", iconHint: "okta" },
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.errors).toEqual([]);
        expect(res.instances.length).toBe(1);
        const instance: any = res.instances[0];
        expect(instance.scopes).toContain("openid");
        expect(instance.fetchUserInfo).toBe(true);
        expect(instance.storeRefreshToken).toBe(true);
        expect(instance.claims?.login).toBe("preferred_username");
        expect(instance.allow?.usersAllowlist).toEqual(["alice", "bob"]);
        expect(instance.allow?.emailDomains).toEqual(["example.com", "corp.example.test"]);
        expect(instance.allow?.groupsAny).toEqual(["eng", "sre"]);
        expect(instance.allow?.groupsAll).toEqual(["employees"]);
        expect(instance.ui?.buttonColor).toBe("#123456");
        expect(instance.ui?.iconHint).toBe("okta");
        expect(instance.httpTimeoutSeconds).toBe(7);
        expect(instance.clientAuthenticationMethod).toBe("client_secret_post");
    });

    it("accepts only supported confidential-client authentication methods", async () => {
        const provider = {
            id: "corp",
            type: "oidc",
            displayName: "Corp OIDC",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/corp/callback",
        };

        const basic = resolveAuthProviderInstancesFromEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{ ...provider, clientAuthenticationMethod: "client_secret_basic" }]),
        });
        expect(basic.errors).toEqual([]);
        expect(basic.instances[0]?.clientAuthenticationMethod).toBe("client_secret_basic");

        const unsupported = resolveAuthProviderInstancesFromEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{ ...provider, clientAuthenticationMethod: "private_key_jwt" }]),
        });
        expect(unsupported.instances).toEqual([]);
        expect(unsupported.errors.join("\n")).toMatch(/clientAuthenticationMethod/);
    });

    it("reports an error for duplicate provider ids", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Okta",
                    issuer: "https://issuer.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
                },
                {
                    id: "OKTA",
                    type: "oidc",
                    displayName: "Okta2",
                    issuer: "https://issuer2.example.test",
                    clientId: "cid2",
                    clientSecret: "secret2",
                    redirectUrl: "https://server.example.test/v1/oauth/okta/callback",
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.instances).toEqual([]);
        expect(res.errors.length).toBeGreaterThan(0);
        expect(res.errors.join("\n")).toMatch(/duplicate/i);
    });


    it("rejects non-loopback http issuers (security hardening)", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "corp",
                    type: "oidc",
                    displayName: "Corp OIDC",
                    issuer: "http://issuer.corp.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/corp/callback",
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.instances).toEqual([]);
        expect(res.errors.join("\n")).toMatch(/issuer/i);
        expect(res.errors.join("\n")).toMatch(/https/i);
    });

    it("keeps valid provider instances when an unrelated entry is invalid", async () => {
        const env: NodeJS.ProcessEnv = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "broken",
                    type: "oidc",
                    displayName: "Broken",
                    issuer: "not-a-url",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/broken/callback",
                },
                {
                    id: "valid",
                    type: "oidc",
                    displayName: "Valid",
                    issuer: "https://issuer.example.test",
                    clientId: "cid",
                    clientSecret: "secret",
                    redirectUrl: "https://server.example.test/v1/oauth/valid/callback",
                },
            ]),
        };

        const res = resolveAuthProviderInstancesFromEnv(env);
        expect(res.instances.map((instance) => instance.id)).toEqual(["valid"]);
        expect(res.errors.join("\n")).toMatch(/broken/);
    });

    it("rejects malformed allowlist fields without dropping unrelated valid providers", async () => {
        const provider = (id: string, allow: unknown) => ({
            id,
            type: "oidc",
            displayName: id,
            issuer: `https://${id}.example.test`,
            clientId: "cid",
            clientSecret: "secret",
            redirectUrl: `https://server.example.test/v1/oauth/${id}/callback`,
            allow,
        });
        const res = resolveAuthProviderInstancesFromEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                provider("scalar-list", { groupsAny: "admins" }),
                provider("mixed-list", { usersAllowlist: ["alice", 7] }),
                provider("valid", { groupsAny: ["admins"] }),
            ]),
        });

        expect(res.instances.map((instance) => instance.id)).toEqual(["valid"]);
        expect(res.errors).toEqual(expect.arrayContaining([
            expect.stringMatching(/allow\.groupsAny for scalar-list/),
            expect.stringMatching(/allow\.usersAllowlist for mixed-list/),
        ]));
    });

    it("rejects a malformed whole document without producing provider instances", async () => {
        const res = resolveAuthProviderInstancesFromEnv({
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify({ id: "not-an-array" }),
        });

        expect(res.instances).toEqual([]);
        expect(res.errors.join("\n")).toMatch(/JSON array/);
    });

    it("does not fall back to JSON when the preferred config path is unreadable", async () => {
        const dir = await mkdtemp(join(tmpdir(), "happier-oidc-missing-config-"));
        try {
            const res = resolveAuthProviderInstancesFromEnv({
                AUTH_PROVIDERS_CONFIG_PATH: join(dir, "missing.json"),
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                    {
                        id: "fallback",
                        type: "oidc",
                        displayName: "Fallback",
                        issuer: "https://issuer.example.test",
                        clientId: "cid",
                        clientSecret: "secret",
                        redirectUrl: "https://server.example.test/v1/oauth/fallback/callback",
                    },
                ]),
            });

            expect(res.instances).toEqual([]);
            expect(res.errors.join("\n")).toMatch(/cannot read file/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    describe("clientSecretEnv", () => {
        const baseProvider = {
            id: "acme",
            type: "oidc",
            displayName: "Acme OIDC",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            redirectUrl: "https://server.example.test/v1/oauth/acme/callback",
        };

        it("reads the client secret from the named environment variable", async () => {
            const env: NodeJS.ProcessEnv = {
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{ ...baseProvider, clientSecretEnv: " ACME_OIDC_SECRET " }]),
                ACME_OIDC_SECRET: " secret-from-env ",
            };

            const res = resolveAuthProviderInstancesFromEnv(env);
            expect(res.errors).toEqual([]);
            expect(res.instances.map((i) => i.clientSecret)).toEqual([" secret-from-env "]);
        });

        it("prefers a literal clientSecret over clientSecretEnv", async () => {
            const env: NodeJS.ProcessEnv = {
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                    { ...baseProvider, clientSecret: "literal-secret", clientSecretEnv: "ACME_OIDC_SECRET" },
                ]),
                ACME_OIDC_SECRET: "secret-from-env",
            };

            const res = resolveAuthProviderInstancesFromEnv(env);
            expect(res.errors).toEqual([]);
            expect(res.instances.map((i) => i.clientSecret)).toEqual(["literal-secret"]);
        });

        it.each(["json", "path"])("refuses deployment-secret references in Home-authored %s configuration after restart", async (source) => {
            const { loadStartupHomeEnv, applyStartupHomeEnvToProcess } = await import("@/app/home/settings/startupHomeEnv");
            const dir = await mkdtemp(join(tmpdir(), "happier-home-oidc-secret-"));
            const config = JSON.stringify([{ ...baseProvider, clientSecretEnv: "DEPLOYMENT_SECRET" }]);
            const configPath = join(dir, "providers.json");
            try {
                await writeFile(configPath, config, "utf8");
                const stored: StoredHomeSettings = source === "json"
                    ? { values: {}, secrets: { AUTH_PROVIDERS_CONFIG_JSON: config } }
                    : { values: { AUTH_PROVIDERS_CONFIG_PATH: configPath }, secrets: {} };
                const startup = await loadStartupHomeEnv({
                    env: { DEPLOYMENT_SECRET: "bootstrap-private-value" },
                    readStored: async () => stored,
                    log: () => {},
                });
                const processEnv = { ...startup.deploymentEnv };
                applyStartupHomeEnvToProcess(startup, processEnv);

                for (const env of [startup.env, { ...processEnv }]) {
                    const result = resolveAuthProviderInstancesFromEnv(env);
                    expect(result.instances).toEqual([]);
                    expect(result.errors).toEqual([expect.stringMatching(/clientSecretEnv.*deployment/i)]);
                    expect(result.errors.join("\n")).not.toContain("bootstrap-private-value");
                }

                if (source === "json") {
                    const literal = JSON.stringify([{ ...baseProvider, clientSecret: "home-owned-secret" }]);
                    const literalStartup = await loadStartupHomeEnv({
                        env: {},
                        readStored: async () => ({ values: {}, secrets: { AUTH_PROVIDERS_CONFIG_JSON: literal } }),
                        log: () => {},
                    });
                    expect(resolveAuthProviderInstancesFromEnv(literalStartup.env).instances[0]?.clientSecret).toBe("home-owned-secret");
                }
            } finally {
                await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: {} }), log: () => {} });
                await rm(dir, { recursive: true, force: true });
            }
        });

        it.each(["", null])("rejects an invalid literal %j without falling back to the environment", async (clientSecret) => {
            const res = resolveAuthProviderInstancesFromEnv({
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                    { ...baseProvider, clientSecret, clientSecretEnv: "ACME_OIDC_SECRET" },
                ]),
                ACME_OIDC_SECRET: "secret-from-env",
            });

            expect(res.instances).toEqual([]);
            expect(res.errors).toEqual([expect.stringContaining("clientSecret for acme")]);
            expect(res.errors.join("\n")).not.toContain("secret-from-env");
        });

        it.each([
            ["unset", undefined],
            ["empty", ""],
            ["whitespace-only", "  "],
        ])("rejects the provider config when the named variable is %s", async (_label, value) => {
            const env: NodeJS.ProcessEnv = {
                AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{ ...baseProvider, clientSecretEnv: "ACME_OIDC_SECRET" }]),
            };
            if (value !== undefined) env.ACME_OIDC_SECRET = value;

            const res = resolveAuthProviderInstancesFromEnv(env);
            expect(res.instances).toEqual([]);
            expect(res.errors.join("\n")).toMatch(/clientSecretEnv for acme/);
            expect(res.errors.join("\n")).toMatch(/ACME_OIDC_SECRET/);
        });
    });

    it("resolves environment secrets from AUTH_PROVIDERS_CONFIG_PATH (preferred over JSON)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "happier-oidc-config-"));
        try {
            const path = join(dir, "providers.json");
            await writeFile(
                path,
                JSON.stringify([
                    {
                        id: "Acme",
                        type: "oidc",
                        displayName: "Acme OIDC",
                        issuer: "https://issuer.example.test",
                        clientId: "cid",
                        clientSecretEnv: "ACME_OIDC_SECRET",
                        redirectUrl: "https://server.example.test/v1/oauth/acme/callback",
                    },
                ]),
                "utf8",
            );

            const env: NodeJS.ProcessEnv = {
                AUTH_PROVIDERS_CONFIG_PATH: path,
                AUTH_PROVIDERS_CONFIG_JSON: "[]",
                ACME_OIDC_SECRET: "secret-from-file-config",
            };

            const res = resolveAuthProviderInstancesFromEnv(env);
            expect(res.errors).toEqual([]);
            expect(res.instances.map((i) => i.id)).toEqual(["acme"]);
            expect(res.instances.map((i) => i.clientSecret)).toEqual(["secret-from-file-config"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
