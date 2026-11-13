import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { encryptString } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { resolveEffectiveHomeAuthMethods } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "@/app/teams/invitations/token";

vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false, trustProxy: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createAuthBody(seedByte = 7) {
    const seed = new Uint8Array(32).fill(seedByte);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        secretSeed: seed,
        publicKeyHex: privacyKit.encodeHex(new Uint8Array(kp.publicKey)),
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

describe("authRoutes (auth policy) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-policy-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.teamInvitation.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.homeGovernancePolicy.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns 403 signup-disabled when anonymous signup is disabled and the account does not exist", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        const { body } = createAuthBody();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "signup-disabled" });
        await expect(db.account.count()).resolves.toBe(0);

        await app.close();
    });

    it("uses the exact Team invitation to atomically provision a key Account and membership on a closed Home", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: {
                    v: 1,
                    enabledMethodIds: ["key_challenge"],
                    admission: "invitation_only",
                },
            },
        });
        const owner = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const team = await db.team.create({
            data: {
                name: "Key invitation Team",
                admissionMode: "invite_only",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
        });
        const invitationToken = mintTeamInvitationToken();
        await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash: Buffer.from(digestTeamInvitationToken(invitationToken)),
                role: "member",
                historyAccess: "from_membership",
                createdByAccountId: owner.id,
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const { body, publicKeyHex } = createAuthBody(31);
        const app = createTestApp();
        authRoutes(app);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                ...body,
                admission: { kind: "team_invitation", token: invitationToken },
            },
        });

        expect(response.statusCode, response.body).toBe(200);
        const account = await db.account.findUniqueOrThrow({
            where: { publicKey: publicKeyHex },
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toMatchObject({ role: "member" });
        await app.close();
    });

    it("returns 403 signup-disabled when key challenge provisioning is denied for public requests", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "key_challenge",
        });

        const { body } = createAuthBody();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            headers: { "x-forwarded-for": "203.0.113.10" },
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "signup-disabled" });

        const accounts = await db.account.findMany({ select: { id: true } });
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("returns 404 when key-challenge login is disabled", async () => {
        // With key-challenge disabled, the server must still have at least one other
        // viable login method configured to avoid a hard lockout.
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "github",
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
        });

        const { body } = createAuthBody();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(404);

        await app.close();
    });

    it("rejects a direct key-challenge login when persisted Home policy disables the method", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
            },
        });
        const { body, publicKeyHex } = createAuthBody();
        await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "e2ee" } });

        const app = createTestApp();
        authRoutes(app);
        await app.ready();

        const response = await app.inject({ method: "POST", url: "/v1/auth", payload: body });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toEqual({ error: "method_not_available" });
        await app.close();
    });

    it("refuses startup when persisted Home policy disables every configured authentication method", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                revision: 1,
                teamCreationPolicy: "managed_only",
                authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
            },
        });
        const effective = await resolveEffectiveHomeAuthMethods({ env: process.env });
        expect(effective.status).toBe("ready");
        if (effective.status !== "ready") throw new Error("Expected readable Home policy");
        expect(effective.decisions.every((method) => method.actions.every((action) => !action.enabled))).toBe(true);

        const app = createTestApp();
        authRoutes(app);
        // Do not let the assertion printer inspect a resolved Fastify instance:
        // its address getter requires a listening socket.
        const startupError = await app.ready().then(() => null, (error: unknown) => error);
        expect(startupError).toBeInstanceOf(Error);
        expect((startupError as Error).message).toMatch(/no login methods/i);
    });

    it("fails fast when key-challenge login is disabled and no other login methods are available", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        });

        const app = createTestApp();
        authRoutes(app);
        const startupError = await app.ready().then(() => null, (error: unknown) => error);
        expect(startupError).toBeInstanceOf(Error);
        expect((startupError as Error).message).toMatch(/no login methods/i);
        await app.close();
    });

    it("does not fail fast when key-challenge login is disabled and a keyless OAuth login method is configured", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            GITHUB_CLIENT_ID: "id",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://example.com/oauth/github/callback",
        });

        const app = createTestApp();
        authRoutes(app);
        await app.ready();
        await app.close();
    });

    it("returns 403 provider-required when a required identity provider is missing", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
        });

        const { body, publicKeyHex } = createAuthBody();
        await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "provider-required", provider: "github" });

        await app.close();
    });

    it("issues a token when GitHub is required for login and the account has a linked github identity", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
        });

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(json.token.length).toBeGreaterThan(10);

        await app.close();
    });

    it("creates new accounts with encryptionMode=plain when plaintext storage is optional and defaultAccountMode=plain", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const { body, publicKeyHex } = createAuthBody();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });
        expect(res.statusCode).toBe(200);

        const stored = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("plain");

        await app.close();
    });

    it("returns 403 not-eligible when GitHub is required and the GitHub allowlist does not include the user", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_USERS: "bob",
        });

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 403 not-eligible (not 500) when GitHub allowlist is configured but providerLogin is null", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_USERS: "bob",
        });

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: null,
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 403 not-eligible when GitHub org allowlist is configured and the user is not a member (github_app)", async () => {
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

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
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

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
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
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 200 when GitHub org allowlist is configured and the user is a member (oauth_user_token)", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "oauth_user_token",
            GITHUB_STORE_ACCESS_TOKEN: "1",
        });

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
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

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
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
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");

        await app.close();
    });

    it("returns 200 when GitHub org allowlist is configured and the user is a member (oauth_user_token via AccountIdentity.token)", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "oauth_user_token",
            GITHUB_STORE_ACCESS_TOKEN: "1",
        });

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex, encryptionMode: "plain" } });
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

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
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
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");

        await app.close();
    });

    it("creates a plain Home account while signup is open, refuses new anonymous signups after closure and app recreation, and keeps the persisted credential valid", async () => {
        // Loopback bootstrap posture: the fixed Personal Home storage policy with anonymous signup still open.
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "plaintext_only",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const bootstrap = createAuthBody();

        const firstApp = createTestApp();
        authRoutes(firstApp as any);
        await firstApp.ready();

        const signupRes = await firstApp.inject({
            method: "POST",
            url: "/v1/auth",
            payload: bootstrap.body,
        });
        expect(signupRes.statusCode).toBe(200);
        const signupJson = signupRes.json() as { success?: boolean; token?: string };
        expect(signupJson.success).toBe(true);
        expect(typeof signupJson.token).toBe("string");
        await firstApp.close();

        const stored = await db.account.findUnique({
            where: { publicKey: bootstrap.publicKeyHex },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("plain");

        // Signup closure through the canonical env owner, then recreate the real
        // app against the same durable harness database (no data reset between apps).
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "plaintext_only",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const restartedApp = createTestApp();
        authRoutes(restartedApp as any);
        await restartedApp.ready();

        const freshSignup = createAuthBody(9);
        const refusedRes = await restartedApp.inject({
            method: "POST",
            url: "/v1/auth",
            payload: freshSignup.body,
        });
        expect(refusedRes.statusCode).toBe(403);
        expect(refusedRes.json()).toEqual({ error: "signup-disabled" });

        // The pre-restart identity still logs in under closed signup, no duplicate
        // account is created, and its signup-time token still authenticates.
        const loginRes = await restartedApp.inject({
            method: "POST",
            url: "/v1/auth",
            payload: bootstrap.body,
        });
        expect(loginRes.statusCode).toBe(200);
        expect((loginRes.json() as { success?: boolean }).success).toBe(true);

        const accounts = await db.account.findMany({ select: { publicKey: true } });
        expect(accounts.map((account) => account.publicKey)).toEqual([bootstrap.publicKeyHex]);

        const pingRes = await restartedApp.inject({
            method: "GET",
            url: "/v1/auth/ping",
            headers: { authorization: `Bearer ${signupJson.token}` },
        });
        expect(pingRes.statusCode).toBe(200);
        expect(pingRes.json()).toEqual({ ok: true });

        await restartedApp.close();
    });
});
