import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "./enableAuthentication";
import { encryptString } from "@/modules/encrypt";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("enableAuthentication (auth policy) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-decorator-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    const createAuthenticatedApp = async () => {
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();
        return app;
    };

    const withAuthenticatedApp = async (run: (app: any) => Promise<void>) => {
        const app = await createAuthenticatedApp();
        try {
            await run(app);
        } finally {
            await app.close().catch(() => {});
        }
    };

    const withStubbedFetch = async (fetchImpl: typeof fetch, run: () => Promise<void>) => {
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", fetchImpl as any);
        try {
            await run();
        } finally {
            globalThis.fetch = originalFetch;
        }
    };

    afterEach(async () => {
        harness.resetEnv();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("blocks authenticated requests when GitHub is required but the account is not linked", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: "provider-required", provider: "github" });
        });
    });

    it("allows authenticated requests when GitHub is required and the account is linked", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
        });
    });

    it("blocks authenticated requests when GitHub allowlist does not include the linked user", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_USERS: "bob",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: "not-eligible" });
        });
    });

    it("allows authenticated requests when GitHub allowlist matches the linked user case-insensitively", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_USERS: "OctoCat",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
        });
    });

    it("blocks authenticated requests when GitHub org allowlist is configured and the user is not a member (github_app)", async () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_OFFBOARDING_ENABLED: "1",
            AUTH_OFFBOARDING_INTERVAL_SECONDS: "60",
            AUTH_GITHUB_APP_ID: "1",
            AUTH_GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
            AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: "acme=123",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                eligibilityNextCheckAt: new Date(0),
            },
        });
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
                const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
                if (href.includes("/app/installations/123/access_tokens")) {
                    return new Response(JSON.stringify({ token: "inst_tok", expires_at: new Date(Date.now() + 60_000).toISOString() }), {
                        status: 201,
                        headers: { "content-type": "application/json" },
                    });
                }
                if (href.includes("/orgs/acme/members/octocat")) {
                    return new Response(JSON.stringify({ message: "Not Found" }), {
                        status: 404,
                        headers: { "content-type": "application/json" },
                    });
                }
                throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(403);
                    expect(res.json()).toEqual({ error: "not-eligible" });
                });
            },
        );
    });

    it("allows authenticated requests when GitHub org allowlist is configured and the user is a member (oauth_user_token)", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "oauth_user_token",
            AUTH_OFFBOARDING_ENABLED: "1",
            AUTH_OFFBOARDING_INTERVAL_SECONDS: "60",
            GITHUB_STORE_ACCESS_TOKEN: "1",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                token: encryptString(["user", account.id, "github", "token"], "user_tok") as any,
                eligibilityNextCheckAt: new Date(0),
            },
        });
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
                const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
                if (href.includes("/orgs/acme/members/octocat")) {
                    const authHeader = (init as any)?.headers?.Authorization ?? (init as any)?.headers?.authorization ?? "";
                    if (!String(authHeader).includes("Bearer user_tok")) {
                        return new Response(JSON.stringify({ message: "Unauthorized" }), {
                            status: 401,
                            headers: { "content-type": "application/json" },
                        });
                    }
                    return new Response(null, { status: 204 });
                }
                throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(200);
                    expect(res.json()).toEqual({ ok: true });
                });
            },
        );
    });

    it("allows authenticated requests when GitHub org allowlist is configured and the user is a member (oauth_user_token via AccountIdentity.token)", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "oauth_user_token",
            AUTH_OFFBOARDING_ENABLED: "1",
            AUTH_OFFBOARDING_INTERVAL_SECONDS: "60",
            GITHUB_STORE_ACCESS_TOKEN: "1",
        });

        const account = await db.account.create({ data: { publicKey: "pk_1_id_tok" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat", avatar_url: "x", name: null } as any,
                token: encryptString(["user", account.id, "github", "token"], "user_tok") as any,
                eligibilityNextCheckAt: new Date(0),
            },
        });
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
                const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
                if (href.includes("/orgs/acme/members/octocat")) {
                    const authHeader = (init as any)?.headers?.Authorization ?? (init as any)?.headers?.authorization ?? "";
                    if (!String(authHeader).includes("Bearer user_tok")) {
                        return new Response(JSON.stringify({ message: "Unauthorized" }), {
                            status: 401,
                            headers: { "content-type": "application/json" },
                        });
                    }
                    return new Response(null, { status: 204 });
                }
                throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(200);
                    expect(res.json()).toEqual({ ok: true });
                });
            },
        );
    });
});
