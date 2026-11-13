import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The GitHub endpoints and avatar host are faked through the global fetch stub below.
vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));
import { createHash } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { authPendingSchema } from "./oauthExternal/oauthExternalSchemas";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const DIRECTORY_PROOF = "directory-proof-secret";
const DIRECTORY_PROOF_HASH = createHash("sha256").update(DIRECTORY_PROOF, "utf8").digest("hex");
const SERVING_ENDPOINT_URL = "https://accounts.example.test";
const CANONICAL_SERVER_URL = "https://accounts.internal.example.test";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    typed.get(
        "/_test/account-directory-admission",
        {
            config: { allowAccountDirectoryToken: true },
            preHandler: typed.authenticate,
        },
        async () => ({ ok: true }),
    );
    typed.get(
        "/_test/full-account-only",
        { preHandler: typed.authenticate },
        async () => ({ ok: true }),
    );
    return trackApp(typed);
}

function scheduleProviderDisableAfterFinalizeHandlerStarts(app: any): void {
    app.addHook("preHandler", (request: { url: string }, _reply: unknown, done: () => void) => {
        if (request.url.includes("/v1/auth/external/github/finalize")) {
            process.env.AUTH_SIGNUP_PROVIDERS = "github";
            setImmediate(() => {
                process.env.AUTH_SIGNUP_PROVIDERS = "gitlab";
            });
        }
        done();
    });
}

function applyDirectoryOAuthEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "self",
        HAPPIER_SERVER_IDENTITY_ID: "srv_directory_oauth_test",
        HAPPIER_CANONICAL_SERVER_URL: CANONICAL_SERVER_URL,
        HAPPIER_PUBLIC_SERVER_URL: SERVING_ENDPOINT_URL,
        GITHUB_CLIENT_ID: "gh_client",
        GITHUB_CLIENT_SECRET: "gh_secret",
        GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        HAPPIER_WEBAPP_URL: "https://app.example.test",
        AUTH_SIGNUP_PROVIDERS: "github",
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        ...overrides,
    });
}

function stubGithubProviderNetwork(profile: unknown = { id: 123, login: "octocat" }): void {
    globalThis.fetch = (async (url: any) => {
        if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
            return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
        }
        if (typeof url === "string" && url.includes("https://api.github.com/user")) {
            return { ok: true, json: async () => profile } as any;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as any;
}

async function seedLinkedAccount(params: { providerUserId: string; encryptionMode?: string }) {
    const account = await db.account.create({
        data: {
            publicKey: null,
            encryptionMode: params.encryptionMode ?? "plain",
        },
        select: { id: true },
    });
    await db.accountIdentity.create({
        data: {
            accountId: account.id,
            provider: "github",
            providerUserId: params.providerUserId,
            providerLogin: "octocat",
        },
    });
    return account;
}

async function requestDirectoryParams(
    app: any,
    query: Record<string, string | undefined>,
) {
    const search = new URLSearchParams();
    const withDefaults = query.purpose === "account_directory" && query.canonicalServerUrl === undefined
        ? { canonicalServerUrl: CANONICAL_SERVER_URL, ...query }
        : query;
    for (const [key, value] of Object.entries(withDefaults)) {
        if (value !== undefined) search.set(key, value);
    }
    return await app.inject({
        method: "GET",
        url: `/v1/auth/external/github/params?${search.toString()}`,
    });
}

async function runCallback(app: any, authorizeUrl: string) {
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    return await app.inject({
        method: "GET",
        url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
    });
}

describe("connectRoutes (Account Directory OAuth purpose)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oauth-account-directory-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        globalThis.fetch = originalFetch;
        await db.repeatKey.deleteMany();
        await db.simpleCache.deleteMany({ where: { key: "server_identity_id" } }).catch(() => undefined);
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    it("params binds the directory purpose and the serving-owner endpoint into the signed state", async () => {
        applyDirectoryOAuthEnv(harness);
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsJson = paramsRes.json() as {
            url: string;
            purpose: string;
            credentialTarget: string;
            endpointUrl: string;
            endpointServerIdentityId: string;
            canonicalServerUrl: string;
        };
        expect(paramsJson.purpose).toBe("account_directory");
        expect(paramsJson.credentialTarget).toBe("account_directory");
        expect(paramsJson.endpointUrl).toBe(SERVING_ENDPOINT_URL);
        expect(paramsJson.endpointServerIdentityId).toBe(serverIdentityId);
        expect(paramsJson.canonicalServerUrl).toBe(CANONICAL_SERVER_URL);

        const verifiedState = await auth.verifyOauthStateToken(
            new URL(paramsJson.url).searchParams.get("state")!,
        );
        expect(verifiedState).not.toBeNull();
        expect(verifiedState!.flow).toBe("auth");
        expect(verifiedState!.purpose).toBe("account_directory");
        expect(verifiedState!.userId).toBeNull();
        expect(verifiedState!.publicKey).toBeNull();
        expect(verifiedState!.proofHash).toBe(DIRECTORY_PROOF_HASH);
        expect(verifiedState!.endpointUrl).toBe(SERVING_ENDPOINT_URL);
        expect(verifiedState!.endpointServerIdentityId).toBe(serverIdentityId);
        expect(verifiedState!.canonicalServerUrl).toBe(CANONICAL_SERVER_URL);

        await app.close();
    });

    it("params fails closed when the directory endpoint is not the serving Account Service", async () => {
        applyDirectoryOAuthEnv(harness);
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const foreignUrl = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: "https://evil.example.test",
            endpointServerIdentityId: serverIdentityId,
        });
        expect(foreignUrl.statusCode).toBe(400);
        expect(foreignUrl.json()).toEqual({ error: "invalid-account-directory-target" });

        const foreignIdentity = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: "srv_not_the_serving_owner",
        });
        expect(foreignIdentity.statusCode).toBe(400);
        expect(foreignIdentity.json()).toEqual({ error: "invalid-account-directory-target" });

        applyDirectoryOAuthEnv(harness, {
            HAPPIER_PUBLIC_SERVER_URL: undefined,
        });
        const noCanonicalUrl = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(noCanonicalUrl.statusCode).toBe(400);

        await app.close();
    });

    it("params fails closed for unknown, contradictory, or unbound directory purpose requests", async () => {
        applyDirectoryOAuthEnv(harness);
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const unknownPurpose = await requestDirectoryParams(app, {
            purpose: "home_login",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(unknownPurpose.statusCode).toBeGreaterThanOrEqual(400);

        const keyedDirectory = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
            publicKey: "dG90YWxseW5vdG9uZQ==",
        });
        expect(keyedDirectory.statusCode).toBeGreaterThanOrEqual(400);

        const unboundDirectory = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(unboundDirectory.statusCode).toBeGreaterThanOrEqual(400);

        const missingEndpoint = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
        });
        expect(missingEndpoint.statusCode).toBeGreaterThanOrEqual(400);

        await app.close();
    });

    it("oauth state serialization fails closed for forged purpose bindings", async () => {
        applyDirectoryOAuthEnv(harness);
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);

        await expect(auth.createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid-1",
            purpose: "home_login" as unknown as "account_directory",
        })).rejects.toThrow();

        await expect(auth.createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid-1",
            purpose: "account_directory",
            userId: "someone",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        })).rejects.toThrow();

        await expect(auth.createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid-1",
            purpose: "account_directory",
            publicKey: "aa",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        })).rejects.toThrow();

        await expect(auth.createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid-1",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        })).rejects.toThrow();

        await expect(auth.createOauthStateToken({
            flow: "connect",
            provider: "github",
            sid: "sid-1",
            userId: "someone",
            purpose: "account_directory",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        })).rejects.toThrow();

        const state = await auth.createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid-1",
            proofHash: DIRECTORY_PROOF_HASH,
            purpose: "account_directory",
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
            canonicalServerUrl: CANONICAL_SERVER_URL,
        });
        const verified = await auth.verifyOauthStateToken(state);
        expect(verified).toMatchObject({
            flow: "auth",
            provider: "github",
            purpose: "account_directory",
            userId: null,
            publicKey: null,
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
            canonicalServerUrl: CANONICAL_SERVER_URL,
        });
    });

    it("completes the directory corridor through callback and finalize-keyless with exactly the restricted provenance", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork();
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const account = await seedLinkedAccount({ providerUserId: "123" });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);

        const callbackRes = await runCallback(app, (paramsRes.json() as { url: string }).url);
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location!);
        expect(redirect.searchParams.get("purpose")).toBe("account_directory");
        expect(redirect.searchParams.get("credentialTarget")).toBe("account_directory");
        expect(redirect.searchParams.get("endpointUrl")).toBe(SERVING_ENDPOINT_URL);
        expect(redirect.searchParams.get("endpointServerIdentityId")).toBe(serverIdentityId);
        const pendingKey = redirect.searchParams.get("pending");
        expect(pendingKey).toMatch(/^oauth_pending_/);

        const stored = await db.repeatKey.findUnique({ where: { key: pendingKey! } });
        expect(stored).not.toBeNull();
        const parsedPending = authPendingSchema.safeParse(JSON.parse(stored!.value));
        expect(parsedPending.success).toBe(true);
        if (parsedPending.success) {
            expect(parsedPending.data).toMatchObject({
                v: 2,
                purpose: "account_directory",
                proofHash: DIRECTORY_PROOF_HASH,
                canonicalServerUrl: CANONICAL_SERVER_URL,
            });
        }

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof: DIRECTORY_PROOF },
        });
        expect(finalizeRes.statusCode).toBe(200);
        const { token } = finalizeRes.json() as { token: string };

        const verified = await auth.verifyToken(token);
        expect(verified).not.toBeNull();
        expect(verified!.userId).toBe(account.id);
        expect(verified!.authTokenKind).toBe("account_directory");
        expect(verified!.authority).toBe("present_user");

        const [directoryAdmission, fullOnlyAdmission] = await Promise.all([
            app.inject({
                method: "GET",
                url: "/_test/account-directory-admission",
                headers: { authorization: `Bearer ${token}` },
            }),
            app.inject({
                method: "GET",
                url: "/_test/full-account-only",
                headers: { authorization: `Bearer ${token}` },
            }),
        ]);
        expect(directoryAdmission.statusCode).toBe(200);
        expect(fullOnlyAdmission.statusCode).toBe(403);

        expect(await db.repeatKey.findUnique({ where: { key: pendingKey! } })).toBeNull();
        const identities = await db.accountIdentity.findMany({ where: { accountId: account.id } });
        expect(identities.length).toBe(1);
        expect(await db.accountHomeDirectoryEntry.findUnique({
            where: { accountId_homeServerIdentityId: { accountId: account.id, homeServerIdentityId: serverIdentityId } },
        })).toMatchObject({ accountId: account.id, homeServerIdentityId: serverIdentityId });
        expect(await db.accountDirectoryLink.findUnique({
            where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: serverIdentityId, issuerSubjectId: account.id } },
        })).toMatchObject({ accountId: account.id, issuerSubjectId: account.id });

        await app.close();
    });

    it.each([
        ["public endpoint", { HAPPIER_PUBLIC_SERVER_URL: "https://changed.example.test" }],
        ["canonical audience", { HAPPIER_CANONICAL_SERVER_URL: "https://changed.internal.example.test" }],
        ["server identity", { HAPPIER_SERVER_IDENTITY_ID: "srv_changed_after_callback" }],
    ] as const)("rejects keyless finalization after the current %s changes", async (_label, changedEnv) => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork();
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        await seedLinkedAccount({ providerUserId: "123" });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        Object.assign(process.env, changedEnv);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending, proof: DIRECTORY_PROOF },
        });

        expect(finalizeRes.statusCode).toBe(400);
        expect(finalizeRes.json()).toEqual({ error: "invalid-pending" });
        expect(await db.repeatKey.findUnique({
            where: { key: pending! },
        })).toBeNull();

        await app.close();
    });

    it("atomically consumes one linked keyless Directory continuation across concurrent finalization", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork();
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const account = await seedLinkedAccount({ providerUserId: "123" });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        const responses = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize-keyless",
                headers: { "content-type": "application/json" },
                payload: { pending, proof: DIRECTORY_PROOF },
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize-keyless",
                headers: { "content-type": "application/json" },
                payload: { pending, proof: DIRECTORY_PROOF },
            }),
        ]);
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode !== 200);

        expect(responses.map((response) => response.statusCode).sort(), JSON.stringify(responses.map((response) => response.json()))).toEqual([
            200,
            400,
        ]);
        expect(loser?.json()).toEqual({ error: "invalid-pending" });
        expect(winner?.json()).toMatchObject({ success: true });
        expect(await auth.verifyToken(
            (winner?.json() as { token: string }).token,
        )).toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
            authority: "present_user",
        });

        await app.close();
    });

    it("keeps an unlinked Directory keyless continuation keyless and requests a fresh keyed sign-in", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({
            id: 987,
            login: "unlinked-directory-user",
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);

        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location!);
        expect(redirect.searchParams.get("mode")).toBe("keyless");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                proof: DIRECTORY_PROOF,
            },
        });
        expect(finalizeRes.statusCode).toBe(403);
        expect(finalizeRes.json()).toEqual({
            error: "keyed-authentication-required",
        });
        expect(await db.repeatKey.findUnique({
            where: { key: pending! },
        })).toBeNull();

        await app.close();
    });

    it("creates a first-time keyed Directory account and bootstraps its same-service Home through the canonical OAuth route", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({
            id: 789,
            login: "directory-keyed-user",
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(29),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);
        const authorizeUrl = (paramsRes.json() as { url: string }).url;
        const state = new URL(authorizeUrl).searchParams.get("state");
        expect(state).toBeTruthy();
        expect(await auth.verifyOauthStateToken(state!)).toMatchObject({
            flow: "auth",
            provider: "github",
            purpose: "account_directory",
            publicKey: privacyKit.encodeHex(
                new Uint8Array(keyPair.publicKey),
            ),
            proofHash: null,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });

        const callbackRes = await runCallback(app, authorizeUrl);
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location!);
        expect(redirect.searchParams.get("mode")).toBe("keyed");
        expect(redirect.searchParams.get("purpose")).toBe("account_directory");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        const stored = await db.repeatKey.findUnique({
            where: { key: pending! },
        });
        const parsedStored = authPendingSchema.safeParse(
            JSON.parse(stored!.value),
        );
        if (!parsedStored.success) throw parsedStored.error;
        expect(JSON.parse(stored!.value)).toMatchObject({
            v: 2,
            flow: "auth",
            authMode: "keyed",
            purpose: "account_directory",
            publicKeyHex: privacyKit.encodeHex(
                new Uint8Array(keyPair.publicKey),
            ),
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });

        const challenge = new Uint8Array(32).fill(31);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(challenge),
                signature: privacyKit.encodeBase64(
                    new Uint8Array(
                        tweetnacl.sign.detached(
                            challenge,
                            keyPair.secretKey,
                        ),
                    ),
                ),
            },
        });
        expect(finalizeRes.statusCode).toBe(200);
        const verified = await auth.verifyToken(
            (finalizeRes.json() as { token: string }).token,
        );
        expect(verified).toMatchObject({
            authTokenKind: "account_directory",
            authority: "present_user",
        });
        const account = await db.account.findUnique({
            where: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(keyPair.publicKey),
                ),
            },
            select: {
                id: true,
                encryptionMode: true,
                preferredHomeServerIdentityId: true,
            },
        });
        expect(account).toMatchObject({
            id: verified!.userId,
            encryptionMode: "e2ee",
            preferredHomeServerIdentityId: serverIdentityId,
        });
        await expect(db.accountHomeDirectoryEntry.findMany({
            where: { accountId: verified!.userId },
            select: {
                homeServerIdentityId: true,
                canonicalServerUrl: true,
            },
        })).resolves.toEqual([{
            homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: CANONICAL_SERVER_URL,
        }]);
        await expect(db.accountDirectoryLink.findMany({
            where: { accountId: verified!.userId },
            select: {
                issuerServerIdentityId: true,
                issuerSubjectId: true,
            },
        })).resolves.toEqual([{
            issuerServerIdentityId: serverIdentityId,
            issuerSubjectId: verified!.userId,
        }]);

        await app.close();
    });

    it("rejects keyed finalization after the current Directory target changes", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({ id: 791, login: "directory-keyed-stale-target" });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(37),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        process.env.HAPPIER_PUBLIC_SERVER_URL = "https://changed.example.test";
        const challenge = new Uint8Array(32).fill(39);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(challenge),
                signature: privacyKit.encodeBase64(
                    new Uint8Array(
                        tweetnacl.sign.detached(challenge, keyPair.secretKey),
                    ),
                ),
            },
        });

        expect(finalizeRes.statusCode).toBe(400);
        expect(finalizeRes.json()).toEqual({ error: "invalid-pending" });
        expect(await db.repeatKey.findUnique({
            where: { key: pending! },
        })).toBeNull();

        await app.close();
    });

    it("rejects keyless Directory finalization after the provider is disabled in current server policy", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork();
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        await seedLinkedAccount({ providerUserId: "123" });

        const app = createTestApp();
        connectRoutes(app as any);
        scheduleProviderDisableAfterFinalizeHandlerStarts(app);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyless",
            proofHash: DIRECTORY_PROOF_HASH,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending, proof: DIRECTORY_PROOF },
        });

        expect(finalizeRes.statusCode).toBe(403);
        expect(finalizeRes.json()).toEqual({
            error: "signup-provider-disabled",
        });
        expect((finalizeRes.json() as { token?: unknown }).token)
            .toBeUndefined();
        // No authority is consumed by a rejected policy decision.
        expect(await db.repeatKey.findUnique({
            where: { key: pending! },
        })).not.toBeNull();

        await app.close();
    });

    it("rejects keyed Directory finalization after the provider is disabled in current server policy", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({
            id: 793,
            login: "directory-keyed-disabled-provider",
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(41),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );

        const app = createTestApp();
        connectRoutes(app as any);
        scheduleProviderDisableAfterFinalizeHandlerStarts(app);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        expect(paramsRes.statusCode).toBe(200);
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        const challenge = new Uint8Array(32).fill(43);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                publicKey,
                challenge: privacyKit.encodeBase64(challenge),
                signature: privacyKit.encodeBase64(
                    new Uint8Array(
                        tweetnacl.sign.detached(challenge, keyPair.secretKey),
                    ),
                ),
            },
        });

        expect(finalizeRes.statusCode).toBe(403);
        expect(finalizeRes.json()).toEqual({
            error: "signup-provider-disabled",
        });
        expect((finalizeRes.json() as { token?: unknown }).token)
            .toBeUndefined();
        expect(await db.repeatKey.findUnique({
            where: { key: pending! },
        })).not.toBeNull();
        expect(await db.account.findUnique({
            where: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(keyPair.publicKey),
                ),
            },
            select: { id: true },
        })).toBeNull();

        await app.close();
    });

    it("atomically consumes one first-time keyed Directory continuation across concurrent finalization", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({
            id: 790,
            login: "directory-keyed-concurrent-user",
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(33),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);
        const challenge = new Uint8Array(32).fill(35);
        const payload = {
            pending,
            publicKey,
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(
                new Uint8Array(
                    tweetnacl.sign.detached(challenge, keyPair.secretKey),
                ),
            ),
        };

        const responses = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
        ]);
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode !== 200);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([
            200,
            400,
        ]);
        expect(loser?.json()).toEqual({ error: "invalid-pending" });
        expect(await auth.verifyToken(
            (winner?.json() as { token: string }).token,
        )).toMatchObject({
            authTokenKind: "account_directory",
            authority: "present_user",
        });

        await app.close();
    });

    it("writes no fresh Account state when exact pending custody is lost during identity preparation", async () => {
        applyDirectoryOAuthEnv(harness);
        const avatarUrl = "https://avatars.example.test/pending-race.png";
        stubGithubProviderNetwork({
            id: 791,
            login: "directory-keyed-lost-pending-user",
            avatar_url: avatarUrl,
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(36));
        const publicKey = privacyKit.encodeBase64(new Uint8Array(keyPair.publicKey));
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(keyPair.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(app, (paramsRes.json() as { url: string }).url);
        const pending = new URL(callbackRes.headers.location!).searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        globalThis.fetch = (async (url: unknown) => {
            if (url === avatarUrl) {
                await db.repeatKey.deleteMany({ where: { key: pending! } });
                return { ok: false } as Response;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as typeof fetch;

        const challenge = new Uint8Array(32).fill(37);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                publicKey,
                username: "directory-lost-pending",
                challenge: privacyKit.encodeBase64(challenge),
                signature: privacyKit.encodeBase64(new Uint8Array(
                    tweetnacl.sign.detached(challenge, keyPair.secretKey),
                )),
            },
        });

        expect(finalizeRes.statusCode).toBe(400);
        expect(finalizeRes.json()).toEqual({ error: "invalid-pending" });
        expect(await db.account.findUnique({ where: { publicKey: publicKeyHex } })).toBeNull();
        expect(await db.accountIdentity.count({ where: { provider: "github", providerUserId: "791" } })).toBe(0);
        expect(await db.accountHomeDirectoryEntry.count()).toBe(0);
        expect(await db.accountDirectoryLink.count()).toBe(0);

        await app.close();
    });

    it("writes no existing Account or identity state when exact pending custody is lost during identity preparation", async () => {
        applyDirectoryOAuthEnv(harness);
        const avatarUrl = "https://avatars.example.test/existing-pending-race.png";
        stubGithubProviderNetwork({
            id: 792,
            login: "directory-existing-lost-pending-user",
            avatar_url: avatarUrl,
        });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(38));
        const publicKey = privacyKit.encodeBase64(new Uint8Array(keyPair.publicKey));
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(keyPair.publicKey));
        const account = await db.account.create({
            data: { publicKey: publicKeyHex, encryptionMode: "plain" },
            select: { id: true, username: true, updatedAt: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(app, (paramsRes.json() as { url: string }).url);
        const pending = new URL(callbackRes.headers.location!).searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);

        globalThis.fetch = (async (url: unknown) => {
            if (url === avatarUrl) {
                await db.repeatKey.deleteMany({ where: { key: pending! } });
                return { ok: false } as Response;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as typeof fetch;

        const challenge = new Uint8Array(32).fill(39);
        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                publicKey,
                username: "directory-existing-lost-pending",
                challenge: privacyKit.encodeBase64(challenge),
                signature: privacyKit.encodeBase64(new Uint8Array(
                    tweetnacl.sign.detached(challenge, keyPair.secretKey),
                )),
            },
        });

        expect(finalizeRes.statusCode).toBe(400);
        expect(finalizeRes.json()).toEqual({ error: "invalid-pending" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { username: true, updatedAt: true },
        })).resolves.toEqual({ username: account.username, updatedAt: account.updatedAt });
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);

        await app.close();
    });

    it("atomically consumes one same-account keyed Directory continuation across concurrent reauthentication", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({ id: 791, login: "directory-keyed-reauth" });
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(37),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );
        const publicKeyHex = privacyKit.encodeHex(
            new Uint8Array(keyPair.publicKey),
        );
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "791",
                providerLogin: "directory-keyed-reauth",
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);
        const challenge = new Uint8Array(32).fill(39);
        const payload = {
            pending,
            publicKey,
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(
                new Uint8Array(
                    tweetnacl.sign.detached(challenge, keyPair.secretKey),
                ),
            ),
        };

        const responses = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
        ]);
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode !== 200);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([
            200,
            400,
        ]);
        expect(loser?.json()).toEqual({ error: "invalid-pending" });
        expect(await auth.verifyToken(
            (winner?.json() as { token: string }).token,
        )).toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
            authority: "present_user",
        });
        expect(await db.accountHomeDirectoryEntry.findMany({ where: { accountId: account.id } })).toEqual([
            expect.objectContaining({ homeServerIdentityId: serverIdentityId }),
        ]);
        expect(await db.accountDirectoryLink.findMany({ where: { accountId: account.id } })).toEqual([
            expect.objectContaining({ issuerServerIdentityId: serverIdentityId, issuerSubjectId: account.id }),
        ]);
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
            preferredHomeServerIdentityId: serverIdentityId,
        });

        await app.close();
    });

    it("atomically consumes one linked keyed Directory continuation across concurrent finalization", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork();
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const account = await seedLinkedAccount({ providerUserId: "123" });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(
            new Uint8Array(32).fill(41),
        );
        const publicKey = privacyKit.encodeBase64(
            new Uint8Array(keyPair.publicKey),
        );

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await requestDirectoryParams(app, {
            purpose: "account_directory",
            mode: "keyed",
            publicKey,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: serverIdentityId,
        });
        const callbackRes = await runCallback(
            app,
            (paramsRes.json() as { url: string }).url,
        );
        const pending = new URL(callbackRes.headers.location!)
            .searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);
        const challenge = new Uint8Array(32).fill(43);
        const payload = {
            pending,
            publicKey,
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(
                new Uint8Array(
                    tweetnacl.sign.detached(challenge, keyPair.secretKey),
                ),
            ),
        };

        const responses = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload,
            }),
        ]);
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode !== 200);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([
            200,
            400,
        ]);
        expect(loser?.json()).toEqual({ error: "invalid-pending" });
        expect(winner?.json()).toMatchObject({ success: true });
        expect(await auth.verifyToken(
            (winner?.json() as { token: string }).token,
        )).toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
            authority: "present_user",
        });

        await app.close();
    });

    it("finalize fails closed on a forged directory continuation shape", async () => {
        applyDirectoryOAuthEnv(harness);
        await seedLinkedAccount({ providerUserId: "123" });

        const sharedPending = {
            v: 2 as const,
            flow: "auth" as const,
            provider: "github",
            proofHash: DIRECTORY_PROOF_HASH,
            profileEnc: "eA==",
            accessTokenEnc: "eA==",
        };
        expect(authPendingSchema.safeParse({
            ...sharedPending,
            endpointUrl: SERVING_ENDPOINT_URL,
            endpointServerIdentityId: "srv_accounts_1",
        }).success).toBe(false);
        expect(authPendingSchema.safeParse({
            ...sharedPending,
            purpose: "account_directory",
        }).success).toBe(false);

        const pendingKey = "oauth_pending_forgeddir1";
        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    v: 2,
                    flow: "auth",
                    purpose: "account_directory",
                    provider: "github",
                    endpointUrl: SERVING_ENDPOINT_URL,
                    endpointServerIdentityId: "srv_accounts_1",
                    proofHash: DIRECTORY_PROOF_HASH,
                    userId: "attacker-account",
                    profileEnc: "eA==",
                    accessTokenEnc: "eA==",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof: DIRECTORY_PROOF },
        });
        expect(finalizeRes.statusCode).toBe(400);
        expect(finalizeRes.json()).toEqual({ error: "invalid-pending" });
        expect(await db.repeatKey.findUnique({ where: { key: pendingKey } })).toBeNull();

        await app.close();
    });

    it("default keyless flow still mints a full account credential with no purpose", async () => {
        applyDirectoryOAuthEnv(harness);
        stubGithubProviderNetwork({ id: 456, login: "linked-cat" });
        const account = await seedLinkedAccount({ providerUserId: "456" });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?mode=keyless&proofHash=${DIRECTORY_PROOF_HASH}`,
        });
        expect(paramsRes.statusCode).toBe(200);

        const callbackRes = await runCallback(app, (paramsRes.json() as { url: string }).url);
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location!);
        expect(redirect.searchParams.get("purpose")).toBeNull();
        expect(redirect.searchParams.get("endpointUrl")).toBeNull();
        const pendingKey = redirect.searchParams.get("pending");
        expect(pendingKey).toBeTruthy();

        const finalizeRes = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof: DIRECTORY_PROOF },
        });
        expect(finalizeRes.statusCode).toBe(200);

        const verified = await auth.verifyToken((finalizeRes.json() as { token: string }).token);
        expect(verified).not.toBeNull();
        expect(verified!.userId).toBe(account.id);
        expect(verified!.authTokenKind).toBe("account");
        expect(verified!.authority).toBe("present_user");

        await app.close();
    });
});
