import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { createExternalAuthorizeAttempt } from "./oauthExternal/createExternalAuthorizeUrl";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { startOidcStubServer, type OidcStubServer } from "../../testkit/oidcStub";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate(
        "authenticate",
        async (request: any, reply: any) => {
            const userId =
                request.headers["x-test-user-id"];
            if (
                typeof userId !== "string"
                || !userId
            ) {
                return reply.code(401).send({
                    error: "Unauthorized",
                });
            }
            request.userId = userId;
        },
    );
    return trackApp(typed);
}

describe("connectRoutes (OIDC callback) external auth flow (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    let oidcStub: OidcStubServer;
    let oidcIssuer: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-auth-",
            initAuth: true,
            initEncrypt: true,
        });
        oidcStub = await startOidcStubServer();
        oidcIssuer = oidcStub.issuer;
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        globalThis.fetch = originalFetch;
        oidcStub.reset();
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
        await oidcStub.close();
    });

    it("returns OIDC sign-in to the desktop attempt that opened the authorization URL", async () => {
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                id: "okta", type: "oidc", displayName: "Acme Okta",
                issuer: oidcIssuer, clientId: "oidc_client", clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
            }]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const query = new URLSearchParams({
            publicKey: privacyKit.encodeBase64(keyPair.publicKey), desktopCallbackScheme: "happier-dev",
        });
        const app = createTestApp();
        connectRoutes(app);
        await app.ready();
        const start = await app.inject(`/v1/auth/external/okta/params?${query}`);
        expect(start.statusCode, start.body).toBe(200);
        const authorize = await fetch(start.json().url, { redirect: "manual" });
        const callback = new URL(authorize.headers.get("location")!);
        const response = await app.inject(`${callback.pathname}${callback.search}`);
        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        expect(redirect.protocol).toBe("happier-dev:");
        expect(redirect.host + redirect.pathname).toBe("oauth/okta");
        expect(redirect.searchParams.get("pending")).toBeTruthy();
        expect(start.json().desktopAttemptId).toBeTruthy();
        expect(redirect.searchParams.get("desktopAttemptId")).toBe(start.json().desktopAttemptId);
    });

    it("returns sanitized OIDC test diagnostics even when eligibility denies sign-in, without Account writes", async () => {
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                id: "okta", type: "oidc", displayName: "Acme Okta",
                issuer: oidcIssuer, clientId: "oidc_client", clientSecret: "oidc_secret",
                redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                allow: { emailDomains: ["example.test"], groupsAny: ["eng"] },
            }]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const runtime = await resolveOAuthRuntimeById(process.env, "okta", { kind: "home" }, "identity_connection_test");
        expect(runtime).not.toBeNull();
        const attempt = await createExternalAuthorizeAttempt({
            flow: "connect", env: process.env, providerId: "okta",
            provider: runtime!.provider, reference: runtime!.reference,
            userId: "initiating-admin", purpose: "identity_connection_test",
            webAppOAuthReturnUrl: "https://app.example.test/settings/authentication",
        });
        expect(attempt).not.toBeNull();
        const authorize = await fetch(attempt!.url, { redirect: "manual" });
        expect(authorize.status).toBe(302);
        const callback = new URL(authorize.headers.get("location")!);
        const app = createTestApp();
        connectRoutes(app);
        await app.ready();
        const response = await app.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        expect(redirect.searchParams.get("error")).toBeNull();
        const resultHandle = redirect.searchParams.get("resultHandle");
        expect(resultHandle).toBeTruthy();
        const stored = await db.repeatKey.findUnique({ where: { key: `oauth_identity_connection_test_result_${resultHandle}` } });
        expect(JSON.parse(stored!.value).diagnostics).toEqual({
            subjectPresent: true, loginAvailable: true, emailAvailable: true, emailVerified: false,
            groups: { state: "complete", count: 1 },
            eligibility: { status: "ineligible", rules: [
                { kind: "email_domains", matched: false }, { kind: "groups_any", matched: true },
            ] },
            mappedGroups: [],
        });
        expect(stored!.value).not.toContain("acme_user");
        expect(stored!.value).not.toContain("at_1");
        expect(await db.account.count()).toBe(0);
        expect(await db.accountIdentity.count()).toBe(0);
    });

    it.each([
        ["callback", "rotation"],
        ["finalize", "rotation"],
        ["callback", "removal"],
        ["finalize", "removal"],
    ] as const)("consumes a stale deployment OAuth %s after %s before network or Account mutations", async (phase, change) => {
        const config = {
            id: "okta",
            type: "oidc",
            displayName: "Acme Okta",
            issuer: oidcIssuer,
            clientId: "oidc_client",
            clientSecret: "oidc_secret",
            redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
        };
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([config]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const kp = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));
        const app = createTestApp();
        connectRoutes(app);
        await app.ready();
        const params = await app.inject({
            method: "GET",
            url: `/v1/auth/external/okta/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(params.statusCode, params.body).toBe(200);
        const authorize = await fetch(params.json().url, { redirect: "manual" });
        expect(authorize.status).toBe(302);
        const callback = new URL(authorize.headers.get("location")!);

        const changeConfiguration = () => {
            process.env.AUTH_PROVIDERS_CONFIG_JSON = JSON.stringify(change === "removal"
                ? []
                : [{ ...config, clientSecret: "rotated_secret" }]);
        };
        const network = vi.fn(originalFetch);
        if (phase === "callback") {
            changeConfiguration();
            globalThis.fetch = network;
        }
        const response = await app.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        if (phase === "callback") {
            expect(redirect.searchParams.get("error")).toBe("auth_provider_configuration_changed");
        } else {
            const pending = redirect.searchParams.get("pending");
            expect(pending, response.headers.location).toBeTruthy();
            changeConfiguration();
            globalThis.fetch = network;
            const challenge = new Uint8Array(32).fill(9);
            const finalized = await app.inject({
                method: "POST",
                url: "/v1/auth/external/okta/finalize",
                payload: {
                    pending,
                    publicKey,
                    challenge: privacyKit.encodeBase64(challenge),
                    signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(challenge, kp.secretKey))),
                    username: "oidcuser",
                },
            });
            expect(finalized.statusCode, finalized.body).toBe(409);
            expect(finalized.json()).toEqual({ error: "auth_provider_configuration_changed" });
        }
        expect(network).not.toHaveBeenCalled();
        expect(await db.repeatKey.count()).toBe(0);
        expect(await db.account.count()).toBe(0);
        expect(await db.accountIdentity.count()).toBe(0);
    });

    it("creates a pending auth record for an OIDC provider and redirects without creating an account", async () => {
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: oidcIssuer,
                    clientId: "oidc_client",
                    clientSecret: "oidc_secret",
                    redirectUrl: "https://api.example.test/v1/oauth/okta/callback",
                },
            ]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });

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
        expect(paramsUrl.origin).toBe(oidcIssuer);
        expect(paramsUrl.pathname).toBe("/authorize");

        const authRes = await fetch(paramsUrl.toString(), { redirect: "manual" });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get("location");
        expect(location).toBeTruthy();

        const callback = new URL(location!);
        const res = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/okta");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("uses the generic OIDC callback to bind first-key step-up proof to the exact existing identity", async () => {
        harness.resetEnv({
            AUTH_SIGNUP_PROVIDERS: "okta",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "okta",
                    type: "oidc",
                    displayName: "Acme Okta",
                    issuer: oidcIssuer,
                    clientId: "oidc_client",
                    clientSecret: "oidc_secret",
                    redirectUrl:
                        "https://api.example.test/v1/oauth/okta/callback",
                },
            ]),
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "okta",
                providerUserId: "user_1",
                profile: {},
            },
        });
        const proofHash = "d".repeat(64);
        const requestDigest =
            `aemrb1_${"A".repeat(43)}`;
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url:
                "/v1/auth/external/okta/params"
                + "?mode=keyless"
                + `&proofHash=${proofHash}`
                + "&purpose=account_encryption_first_key"
                + `&requestDigest=${
                    encodeURIComponent(requestDigest)
                }`,
            headers: {
                "x-test-user-id": account.id,
            },
        });
        expect(
            paramsRes.statusCode,
            paramsRes.body,
        ).toBe(200);
        const paramsUrl = new URL(
            (paramsRes.json() as { url: string }).url,
        );
        const authRes = await fetch(
            paramsUrl.toString(),
            { redirect: "manual" },
        );
        expect(authRes.status).toBe(302);
        const callback = new URL(
            authRes.headers.get("location")!,
        );

        const response = await app.inject({
            method: "GET",
            url: `${callback.pathname}${callback.search}`,
        });
        expect(
            response.statusCode,
            response.body,
        ).toBe(302);
        const redirect = new URL(
            response.headers.location as string,
        );
        expect(redirect.searchParams.get("purpose"))
            .toBe("account_encryption_first_key");
        const pending =
            redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();
        const row = await db.repeatKey.findUnique({
            where: { key: pending! },
        });
        expect(JSON.parse(row!.value)).toEqual({
            v: 3,
            flow: "auth",
            purpose:
                "account_encryption_first_key",
            provider: "okta",
            securityBinding: {
                provider: {
                    id: "okta",
                    source: "deployment",
                    runtimeFingerprint: expect.any(String),
                    context: { kind: "home" },
                },
                connection: null,
                admission: null,
                purpose: "account_encryption_first_key",
            },
            userId: account.id,
            providerUserId: "user_1",
            proofHash,
            requestDigest,
        });

        await app.close();
    });
});
