import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { connectRoutes } from "@/app/api/routes/connect/connectRoutes";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { decryptString } from "@/modules/encrypt";
import { createAppCloseTracker } from "@/app/api/testkit/appLifecycle";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { applyEnvValues } from "@/testkit/env";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function base64url(input: Buffer): string {
    return input.toString("base64url");
}

function signJwtRs256(params: {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    privateKeyPem: string;
}): string {
    const encodedHeader = base64url(Buffer.from(JSON.stringify(params.header), "utf8"));
    const encodedPayload = base64url(Buffer.from(JSON.stringify(params.payload), "utf8"));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    signer.end();
    const signature = signer.sign(params.privateKeyPem);
    return `${data}.${base64url(signature)}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function applyOidcOffboardingEnv(providersConfig: unknown, strict?: string): void {
    applyEnvValues({
        AUTH_SIGNUP_PROVIDERS: "okta",
        AUTH_REQUIRED_LOGIN_PROVIDERS: "okta",
        AUTH_OFFBOARDING_ENABLED: "true",
        AUTH_OFFBOARDING_INTERVAL_SECONDS: "60",
        AUTH_OFFBOARDING_STRICT: strict,
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
        AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify(providersConfig),
        HAPPIER_WEBAPP_URL: "https://app.example.test",
    });
}

describe("OIDC offboarding refresh (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    const authCodes = new Map<string, { nonce: string }>();
    let oidcServer: ReturnType<typeof createServer> | null = null;
    let oidcIssuer: string;
    let jwks: any;
    let privateKeyPem: string;
    const kid = "k1";
    let groupsForTokens: string[] = ["eng"];
    let refreshInvalidGrant = false;
    let refreshServerError = false;
    let refreshSubjectOverride: string | null = null;
    let omitRefreshIdToken = false;
    // Rotation mode: the issuer revokes the presented refresh token and only honours the one it last issued.
    let enforceRefreshTokenRotation = false;
    let currentRefreshToken = "rt_1";
    let rotationCounter = 1;
    // Transient UserInfo outage after an otherwise successful (possibly rotating) grant.
    let userInfoServerError = false;

    beforeAll(async () => {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const publicJwk = publicKey.export({ format: "jwk" }) as any;
        publicJwk.kid = kid;
        publicJwk.use = "sig";
        publicJwk.alg = "RS256";
        jwks = { keys: [publicJwk] };
        privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

        oidcServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? "/", oidcIssuer);

            if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
                res.setHeader("content-type", "application/json");
                res.end(
                    JSON.stringify({
                        issuer: oidcIssuer,
                        authorization_endpoint: `${oidcIssuer}/authorize`,
                        token_endpoint: `${oidcIssuer}/token`,
                        jwks_uri: `${oidcIssuer}/jwks`,
                        userinfo_endpoint: `${oidcIssuer}/userinfo`,
                        response_types_supported: ["code"],
                        code_challenge_methods_supported: ["S256"],
                        subject_types_supported: ["public"],
                        id_token_signing_alg_values_supported: ["RS256"],
                    }),
                );
                return;
            }

            if (req.method === "GET" && url.pathname === "/jwks") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(jwks));
                return;
            }

            if (req.method === "GET" && url.pathname === "/authorize") {
                const state = url.searchParams.get("state") ?? "";
                const redirectUri = url.searchParams.get("redirect_uri") ?? "";
                const nonce = url.searchParams.get("nonce") ?? "";
                const code = `code_${Math.random().toString(16).slice(2)}`;
                authCodes.set(code, { nonce });

                const redirect = new URL(redirectUri);
                redirect.searchParams.set("code", code);
                if (state) redirect.searchParams.set("state", state);
                res.statusCode = 302;
                res.setHeader("location", redirect.toString());
                res.end();
                return;
            }

            if (req.method === "POST" && url.pathname === "/token") {
                const body = await readBody(req);
                const params = new URLSearchParams(body);
                const grantType = params.get("grant_type") ?? "";

                if (grantType === "refresh_token" && refreshInvalidGrant) {
                    res.statusCode = 400;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ error: "invalid_grant" }));
                    return;
                }
                if (grantType === "refresh_token" && refreshServerError) {
                    res.statusCode = 500;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ error: "server_error" }));
                    return;
                }
                if (grantType === "refresh_token" && enforceRefreshTokenRotation) {
                    if ((params.get("refresh_token") ?? "") !== currentRefreshToken) {
                        res.statusCode = 400;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "invalid_grant" }));
                        return;
                    }
                    rotationCounter += 1;
                    currentRefreshToken = `rt_${rotationCounter}`;
                }

                let nonce = "";
                if (grantType === "authorization_code") {
                    const code = params.get("code") ?? "";
                    const record = authCodes.get(code);
                    if (!record) {
                        res.statusCode = 400;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "invalid_grant" }));
                        return;
                    }
                    nonce = record.nonce;
                }

                const subject =
                    grantType === "refresh_token" && typeof refreshSubjectOverride === "string" && refreshSubjectOverride.length > 0
                        ? refreshSubjectOverride
                        : "user_1";
                const idToken = signJwtRs256({
                    header: { typ: "JWT", alg: "RS256", kid },
                    payload: {
                        iss: oidcIssuer,
                        aud: "oidc_client",
                        sub: subject,
                        ...(nonce ? { nonce } : {}),
                        exp: Math.floor(Date.now() / 1000) + 600,
                        iat: Math.floor(Date.now() / 1000),
                        preferred_username: "acme_user",
                        email: "acme_user@example.test",
                        groups: groupsForTokens,
                    },
                    privateKeyPem,
                });

                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    access_token: grantType === "refresh_token" ? "at_2" : "at_1",
                    token_type: "Bearer",
                    expires_in: 600,
                    refresh_token: grantType === "refresh_token"
                        ? (enforceRefreshTokenRotation ? currentRefreshToken : "rt_2")
                        : "rt_1",
                    ...(grantType === "refresh_token" && omitRefreshIdToken ? {} : { id_token: idToken }),
                }));
                return;
            }

            if (req.method === "GET" && url.pathname === "/userinfo") {
                if (userInfoServerError) {
                    res.statusCode = 503;
                    res.end("unavailable");
                    return;
                }
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    sub: refreshSubjectOverride ?? "user_1",
                    preferred_username: "acme_user",
                    email: "acme_user@example.test",
                    groups: groupsForTokens,
                }));
                return;
            }

            res.statusCode = 404;
            res.end("not found");
        });

        await new Promise<void>((resolve) => {
            oidcServer!.listen(0, "127.0.0.1", () => resolve());
        });

        const address = oidcServer.address();
        if (!address || typeof address === "string") throw new Error("failed to bind oidc stub server");
        oidcIssuer = `http://127.0.0.1:${address.port}`;
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-offboarding-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        globalThis.fetch = originalFetch;
        authCodes.clear();
        groupsForTokens = ["eng"];
        refreshInvalidGrant = false;
        refreshServerError = false;
        refreshSubjectOverride = null;
        omitRefreshIdToken = false;
        enforceRefreshTokenRotation = false;
        currentRefreshToken = "rt_1";
        rotationCounter = 1;
        userInfoServerError = false;
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
        if (oidcServer) {
            await new Promise<void>((resolve) => oidcServer!.close(() => resolve()));
        }
    });

    async function authenticateAccount(seedByte: number): Promise<{
        app: ReturnType<typeof createTestApp>;
        accountId: string;
    }> {
        const seed = new Uint8Array(32).fill(seedByte);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const callback = new URL(authRes.headers.get("location")!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const callbackLocation = callbackRes.headers.location;
        expect(callbackLocation).toBeTruthy();
        const pending = new URL(callbackLocation!).searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);
        const account = await db.account.findFirst({
            where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) },
            select: { id: true },
        });
        expect(account).toBeTruthy();
        const initial = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(initial).toEqual({ ok: true });
        return { app, accountId: account!.id };
    }

    it("re-checks eligibility and recovers the same identity after restored membership and fresh authentication", async () => {
        applyOidcOffboardingEnv([
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                storeRefreshToken: true,
                scopes: "openid profile email offline_access",
                allow: { groupsAny: ["eng"] },
            },
        ]);

        const seed = new Uint8Array(32).fill(1);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) } });
        expect(account).toBeTruthy();

        const first = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(first.ok).toBe(true);

        // Simulate the user losing group membership, and force re-check.
        groupsForTokens = ["sales"];
        await db.accountIdentity.updateMany({
            where: { accountId: account!.id, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        const second = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(second).toEqual({ ok: false, statusCode: 403, error: "not-eligible" });
        await expect(enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        // A new successful proof replaces the old denial, without deleting or transferring the identity.
        const deniedIdentity = await db.accountIdentity.findFirstOrThrow({
            where: { accountId: account!.id, provider: "okta" },
            select: { id: true, providerUserId: true },
        });
        groupsForTokens = ["eng"];
        const recovered = await authenticateAccount(1);
        expect(recovered.accountId).toBe(account!.id);
        await expect(db.accountIdentity.findFirstOrThrow({
            where: { accountId: account!.id, provider: "okta" },
            select: { id: true, providerUserId: true, eligibilityStatus: true, eligibilityReason: true },
        })).resolves.toEqual({ ...deniedIdentity, eligibilityStatus: "eligible", eligibilityReason: null });
        await recovered.app.close();
        await app.close();
    });

    it("rejects an authoritatively ineligible identity before its next refresh while preserving transient unknown state", async () => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }]);
        const { app, accountId } = await authenticateAccount(17);
        const nextCheckAt = new Date(Date.now() + 60_000);

        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityStatus: "ineligible", eligibilityNextCheckAt: nextCheckAt },
        });
        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityStatus: "unknown", eligibilityNextCheckAt: nextCheckAt },
        });
        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: true });
        await app.close();
    });

    it("uses UserInfo to refresh current claims when the refresh grant omits an ID token", async () => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            fetchUserInfo: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }]);
        const { app, accountId } = await authenticateAccount(8);

        omitRefreshIdToken = true;
        groupsForTokens = ["sales"];
        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });
        await app.close();
    });

    it("fails closed in strict mode when a refresh grant provides no current claims", async () => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }], "true");
        const { app, accountId } = await authenticateAccount(9);

        omitRefreshIdToken = true;
        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });
        await expect(db.accountIdentity.findFirst({
            where: { accountId, provider: "okta" },
            select: { eligibilityStatus: true, eligibilityReason: true },
        })).resolves.toEqual({
            eligibilityStatus: "unknown",
            eligibilityReason: "eligibility-refresh-error",
        });
        await app.close();
    });

    it("preserves best-effort compatibility when a refresh grant provides no current claims", async () => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }]);
        const { app, accountId } = await authenticateAccount(10);

        omitRefreshIdToken = true;
        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: true });
        await expect(db.accountIdentity.findFirst({
            where: { accountId, provider: "okta" },
            select: { eligibilityStatus: true, eligibilityReason: true },
        })).resolves.toEqual({ eligibilityStatus: "eligible", eligibilityReason: null });
        await app.close();
    });

    it("persists a rotated refresh token when the grant carries no current claims", async () => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }]);
        // The issuer revokes the presented refresh token on every successful grant, as RFC 6749 §6 permits.
        enforceRefreshTokenRotation = true;
        const { app, accountId } = await authenticateAccount(11);

        // This refresh carries no ID token, so the claims-bearing write never runs — but the
        // issuer has still rotated, and the stored token must follow it.
        omitRefreshIdToken = true;
        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: true });

        const rotated = await db.accountIdentity.findFirst({
            where: { accountId, provider: "okta" },
            select: { token: true },
        });
        expect(decryptString(["user", accountId, "okta", "refresh_token"], new Uint8Array(rotated!.token!)))
            .toBe("rt_3");

        await db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });
        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: true });
        await expect(db.accountIdentity.findFirst({
            where: { accountId, provider: "okta" },
            select: { eligibilityStatus: true, eligibilityReason: true },
        })).resolves.toEqual({ eligibilityStatus: "eligible", eligibilityReason: null });
        await app.close();
    });

    it.each([
        { mode: "best-effort", strict: undefined, transientResult: { ok: true } },
        { mode: "strict", strict: "true", transientResult: { ok: false, statusCode: 403, error: "not-eligible" } },
    ] as const)("keeps a rotated refresh token when UserInfo fails after the grant ($mode)", async ({ strict, transientResult }) => {
        applyOidcOffboardingEnv([{
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            storeRefreshToken: true,
            fetchUserInfo: true,
            scopes: "openid profile email offline_access",
            allow: { groupsAny: ["eng"] },
        }], strict);
        enforceRefreshTokenRotation = true;
        const { app, accountId } = await authenticateAccount(strict ? 13 : 12);
        const storedToken = async () => {
            const row = await db.accountIdentity.findFirst({ where: { accountId, provider: "okta" }, select: { token: true } });
            return decryptString(["user", accountId, "okta", "refresh_token"], new Uint8Array(row!.token!));
        };
        const expireCheck = () => db.accountIdentity.updateMany({
            where: { accountId, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        // The grant succeeds and rotates (revoking the presented token); only the later UserInfo call fails.
        userInfoServerError = true;
        await expireCheck();
        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual(transientResult);
        expect(await storedToken()).toBe(currentRefreshToken);

        // Recovery: the retained replacement is still honoured by the issuer.
        userInfoServerError = false;
        await expireCheck();
        await expect(enforceLoginEligibility({ accountId, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: true });
        expect(await storedToken()).toBe(currentRefreshToken);
        await expect(db.accountIdentity.findFirst({
            where: { accountId, provider: "okta" },
            select: { eligibilityStatus: true, eligibilityReason: true },
        })).resolves.toEqual({ eligibilityStatus: "eligible", eligibilityReason: null });
        await app.close();
    });

    it("fails closed when refresh token grant returns invalid_grant and restrictions are configured", async () => {
        applyOidcOffboardingEnv([
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                storeRefreshToken: true,
                scopes: "openid profile email offline_access",
                allow: { groupsAny: ["eng"] },
            },
        ]);

        const seed = new Uint8Array(32).fill(2);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) } });
        expect(account).toBeTruthy();

        const first = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(first.ok).toBe(true);

        // Force re-check, but make refresh token grant fail with invalid_grant.
        refreshInvalidGrant = true;
        await db.accountIdentity.updateMany({
            where: { accountId: account!.id, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        const second = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(second).toEqual({ ok: false, statusCode: 403, error: "not-eligible" });
        await expect(enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        await app.close();
    });

    it("allows access when refresh token grant fails with a transient server error (non-strict mode)", async () => {
        applyOidcOffboardingEnv([
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                storeRefreshToken: true,
                scopes: "openid profile email offline_access",
                allow: { groupsAny: ["eng"] },
            },
        ]);

        const seed = new Uint8Array(32).fill(4);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) } });
        expect(account).toBeTruthy();

        const first = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(first.ok).toBe(true);

        refreshServerError = true;
        await db.accountIdentity.updateMany({
            where: { accountId: account!.id, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        const second = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(second).toEqual({ ok: true });

        await app.close();
    });

    it("fails closed when refresh token grant fails with a transient server error in strict mode", async () => {
        applyOidcOffboardingEnv(
            [
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                storeRefreshToken: true,
                scopes: "openid profile email offline_access",
                allow: { groupsAny: ["eng"] },
            },
            ],
            "true",
        );

        const seed = new Uint8Array(32).fill(5);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) } });
        expect(account).toBeTruthy();

        const first = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(first.ok).toBe(true);

        refreshServerError = true;
        await db.accountIdentity.updateMany({
            where: { accountId: account!.id, provider: "okta" },
            data: { eligibilityNextCheckAt: new Date(0) },
        });

        const second = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(second).toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        await app.close();
    });

    it("compares the refreshed subject with the exact opaque linked provider user id", async () => {
        applyOidcOffboardingEnv([
            {
                id: "okta",
                type: "oidc",
                displayName: "Acme Okta",
                issuer: oidcIssuer,
                clientId: "oidc_client",
                clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                storeRefreshToken: true,
                scopes: "openid profile email offline_access",
                allow: { groupsAny: ["eng"] },
            },
        ]);

        const seed = new Uint8Array(32).fill(7);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const callbackRes = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const challenge = randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/okta/finalize",
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: privacyKit.encodeHex(new Uint8Array(kp.publicKey)) } });
        expect(account).toBeTruthy();

        const first = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(first.ok).toBe(true);

        await db.accountIdentity.updateMany({
            where: { accountId: account!.id, provider: "okta" },
            data: {
                providerUserId: " user_1 ",
                eligibilityNextCheckAt: new Date(0),
            },
        });

        const second = await enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() });
        expect(second).toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        const identityAfterMismatch = await db.accountIdentity.findFirst({
            where: { accountId: account!.id, provider: "okta" },
            select: { eligibilityStatus: true },
        });
        expect(identityAfterMismatch).toEqual({ eligibilityStatus: "ineligible" });
        await expect(enforceLoginEligibility({ accountId: account!.id, env: process.env, now: new Date() }))
            .resolves.toEqual({ ok: false, statusCode: 403, error: "not-eligible" });

        await app.close();
    });
});
