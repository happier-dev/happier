import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { encryptString } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false, trustProxy: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return trackApp(typed);
}

function createAuthBody(seedByte = 7) {
    const seed = new Uint8Array(32).fill(seedByte);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        publicKeyHex: privacyKit.encodeHex(new Uint8Array(kp.publicKey)),
        signingKeyPair: kp,
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

function applyGithubExternalAuthFinalizeEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        AUTH_SIGNUP_PROVIDERS: "github",
        ...overrides,
    });
}

const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9e8AAAAASUVORK5CYII=",
    "base64",
);

describe("connectRoutes (external auth finalize) (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-external-finalize-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        globalThis.fetch = originalFetch;
        await db.userFeedItem.deleteMany();
        await db.userRelationship.deleteMany();
        await db.repeatKey.deleteMany();
        await db.uploadedFile.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    it("POST /v1/auth/external/:provider/finalize returns 404 unsupported-provider for unknown providers", async () => {
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/unknown/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending: "p",
                publicKey: "k",
                challenge: "c",
                signature: "s",
            },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "unsupported-provider" });

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending deletes valid oauth_pending records (idempotent)", async () => {
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_deleteAA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                    suggestedUsername: null,
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteAA1",
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });

        const row = await db.repeatKey.findUnique({ where: { key: "oauth_pending_deleteAA1" } });
        expect(row).toBeNull();

        // Second delete should still succeed.
        const res2 = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteAA1",
        });
        expect(res2.statusCode).toBe(200);

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending does not delete non-oauth_pending keys", async () => {
        await db.repeatKey.create({
            data: {
                key: "not_oauth_pending_delete_1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/not_oauth_pending_delete_1",
        });

        expect(res.statusCode).toBe(200);
        const row = await db.repeatKey.findUnique({ where: { key: "not_oauth_pending_delete_1" } });
        expect(row).not.toBeNull();

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending does not delete oauth_pending records for other providers", async () => {
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_deleteOtherProviderA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "google",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteOtherProviderA1",
        });

        expect(res.statusCode).toBe(200);
        const row = await db.repeatKey.findUnique({ where: { key: "oauth_pending_deleteOtherProviderA1" } });
        expect(row).not.toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/github/finalize creates an account and returns a token", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody();

        const pending = "oauth_pending_pendingCreateA1";
        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_1"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(json.token.length).toBeGreaterThan(10);

        const account = await db.account.findFirst({ where: { publicKey: publicKeyHex } });
        expect(account).toBeTruthy();
        expect(account?.username).toBe("octocat");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account!.id, provider: "github" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe(String(githubProfile.id));
        expect(identity?.providerLogin).toBe("octocat");

        await app.close();
    });

    it("rejects a different signed content key for an existing keyed account without mutating it", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const {
            body,
            publicKeyHex,
            signingKeyPair,
        } = createAuthBody(61);
        const originalContentKey = tweetnacl.box.keyPair();
        const replacementContentKey = tweetnacl.box.keyPair();
        const originalBinding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(originalContentKey.publicKey),
        ]);
        const originalSignature = tweetnacl.sign.detached(
            originalBinding,
            signingKeyPair.secretKey,
        );
        const replacementBinding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(replacementContentKey.publicKey),
        ]);
        const replacementSignature = tweetnacl.sign.detached(
            replacementBinding,
            signingKeyPair.secretKey,
        );
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                username: "existing-oauth-user",
                contentPublicKey: new Uint8Array(originalContentKey.publicKey),
                contentPublicKeySig: new Uint8Array(originalSignature),
            },
            select: { id: true, updatedAt: true },
        });

        const pending = "oauth_pending_contentKeyMismatchA1";
        const githubProfile = {
            id: 6123,
            login: "oauth-mismatch",
            avatar_url: "https://avatars.example.test/content-key-mismatch.png",
            name: "Content Key Mismatch",
        };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex],
                            "tok_content_key_mismatch",
                        ),
                    ),
                    suggestedUsername: "oauth-mismatch",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
                contentPublicKey: privacyKit.encodeBase64(
                    new Uint8Array(replacementContentKey.publicKey),
                ),
                contentPublicKeySig: privacyKit.encodeBase64(
                    new Uint8Array(replacementSignature),
                ),
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: "content_public_key_mismatch",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                username: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            username: "existing-oauth-user",
            contentPublicKey: new Uint8Array(originalContentKey.publicKey),
            contentPublicKeySig: new Uint8Array(originalSignature),
            updatedAt: account.updatedAt,
        });
        await expect(db.accountIdentity.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);

        await app.close();
    });

    it("rejects a raced OAuth Account winner with a different content key and does not delete it", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const {
            body,
            publicKeyHex,
            signingKeyPair,
        } = createAuthBody(62);
        const winnerContentKey = tweetnacl.box.keyPair();
        const requestedContentKey = tweetnacl.box.keyPair();
        const winnerSignature = tweetnacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(winnerContentKey.publicKey),
            ]),
            signingKeyPair.secretKey,
        );
        const requestedSignature = tweetnacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(requestedContentKey.publicKey),
            ]),
            signingKeyPair.secretKey,
        );
        const pending = "oauth_pending_contentKeyRaceA1";
        const githubProfile = {
            id: 6223,
            login: "oauth-race",
            avatar_url: "https://avatars.example.test/content-key-race.png",
            name: "Content Key Race",
        };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex],
                            "tok_content_key_race",
                        ),
                    ),
                    suggestedUsername: "oauth-race",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        // Test-only scheduling wrapper around the real Prisma boundary.
        const accountDelegate = db.account as any;
        const originalFindUnique = accountDelegate.findUnique;
        let racedAccount:
            | Readonly<{ id: string; updatedAt: Date }>
            | undefined;
        let injectedRaceWinner = false;
        accountDelegate.findUnique = async (args: any) => {
            const result = await originalFindUnique.call(
                accountDelegate,
                args,
            );
            if (
                !injectedRaceWinner
                && args?.where?.publicKey === publicKeyHex
                && result === null
            ) {
                injectedRaceWinner = true;
                racedAccount = await db.account.create({
                    data: {
                        publicKey: publicKeyHex,
                        username: "race-winner",
                        contentPublicKey:
                            new Uint8Array(winnerContentKey.publicKey),
                        contentPublicKeySig:
                            new Uint8Array(winnerSignature),
                    },
                    select: { id: true, updatedAt: true },
                });
            }
            return result;
        };

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();
        let response;
        try {
            response = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: {
                    pending,
                    ...body,
                    contentPublicKey: privacyKit.encodeBase64(
                        new Uint8Array(requestedContentKey.publicKey),
                    ),
                    contentPublicKeySig: privacyKit.encodeBase64(
                        new Uint8Array(requestedSignature),
                    ),
                },
            });
        } finally {
            accountDelegate.findUnique = originalFindUnique;
        }

        expect(response!.statusCode).toBe(409);
        expect(response!.json()).toEqual({
            error: "content_public_key_mismatch",
        });
        expect(racedAccount).toBeDefined();
        await expect(db.account.findUniqueOrThrow({
            where: { id: racedAccount!.id },
            select: {
                username: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            username: "race-winner",
            contentPublicKey:
                new Uint8Array(winnerContentKey.publicKey),
            contentPublicKeySig:
                new Uint8Array(winnerSignature),
            updatedAt: racedAccount!.updatedAt,
        });

        await app.close();
    });

    it("POST /v1/auth/external/github/finalize returns 403 forbidden when keyed provisioning is denied for public requests", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "github",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
        });

        const { body, publicKeyHex } = createAuthBody();

        const pending = "oauth_pending_publicBlockedA1";
        const githubProfile = {
            id: 223,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_public"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "forbidden" });
        expect(await db.account.findFirst({ where: { publicKey: publicKeyHex } })).toBeNull();

        await app.close();
    });

    it("returns 400 username-required when pending indicates username is required and no username is provided", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(9);

        const pending = "oauth_pending_usernameRequiredA1";
        const githubProfile = {
            id: 124,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_2"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: true,
                    usernameReason: "login_taken",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "username-required" });

        const accounts = await db.account.findMany({ where: { publicKey: publicKeyHex } });
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("creates an account when username is provided for a username-required pending", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(10);

        const pending = "oauth_pending_usernameRequiredA2";
        const githubProfile = {
            id: 125,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_3"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: true,
                    usernameReason: "login_taken",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                username: "octocat_2",
                ...body,
            },
        });

        expect(res.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: publicKeyHex } });
        expect(account?.username).toBe("octocat_2");
        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account!.id, provider: "github" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe(String(githubProfile.id));
        expect(identity?.providerLogin).toBe("octocat");

        await app.close();
    });

    it("returns 409 provider-already-linked when an identity is linked to another account", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(7);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(8);

        const githubProfile = {
            id: 777,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        // First finalize connects GitHub identity to pk1.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingAuthA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingAuthA1", pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingAuthA1", pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingAuthA1", ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        // Second finalize attempts to connect same GitHub identity to pk2.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingAuthA2",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingAuthA2", pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingAuthA2", pk2], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingAuthA2", ...body2 },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "provider-already-linked", provider: "github" });

        const stillOne = await db.accountIdentity.findMany({
            where: { provider: "github", providerUserId: String(githubProfile.id) },
            select: { accountId: true },
        });
        expect(stillOne.length).toBe(1);

        await app.close();
    });

    it("resets the account and migrates social relationships when reset=true and the provider identity is already linked", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(21);
        const {
            body: body2,
            publicKeyHex: pk2,
            signingKeyPair: resetSigningKeyPair,
        } = createAuthBody(22);
        const resetContentKey = tweetnacl.box.keyPair();
        const resetContentKeySignature = tweetnacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(resetContentKey.publicKey),
            ]),
            resetSigningKeyPair.secretKey,
        );

        const githubProfile = {
            id: 888,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        // First finalize links identity to pk1 (username should become "octocat").
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingResetA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingResetA1", pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingResetA1", pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingResetA1", ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true, username: true } });
        expect(oldAccount?.username).toBe("octocat");

        // Add some social data to be migrated.
        const friend = await db.account.create({ data: { publicKey: "pk_friend_reset", username: "friend1" } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: oldAccount!.id, toUserId: friend.id, status: "friend" },
                { fromUserId: friend.id, toUserId: oldAccount!.id, status: "friend" },
            ],
        });
        await db.userFeedItem.create({
            data: {
                userId: oldAccount!.id,
                counter: BigInt(1),
                body: { t: "friend_accepted", v: 1 },
            } as any,
        });
        await db.account.update({
            where: { id: oldAccount!.id },
            data: { feedSeq: BigInt(1) },
        });

        // Second finalize uses a new device key and requests a reset.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingResetA2",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingResetA2", pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingResetA2", pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending: "oauth_pending_pendingResetA2",
                reset: true,
                ...body2,
                contentPublicKey: privacyKit.encodeBase64(
                    new Uint8Array(resetContentKey.publicKey),
                ),
                contentPublicKeySig: privacyKit.encodeBase64(
                    new Uint8Array(resetContentKeySignature),
                ),
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expect.objectContaining({ success: true, token: expect.any(String) }));

        const newAccount = await db.account.findFirst({
            where: { publicKey: pk2 },
            select: {
                id: true,
                username: true,
                feedSeq: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        expect(newAccount?.username).toBe("octocat");
        expect(newAccount?.feedSeq?.toString()).toBe("1");
        expect(newAccount?.contentPublicKey).toEqual(
            new Uint8Array(resetContentKey.publicKey),
        );
        expect(newAccount?.contentPublicKeySig).toEqual(
            new Uint8Array(resetContentKeySignature),
        );

        // Social relationships moved to the new account.
        const rels = await db.userRelationship.findMany({
            where: {
                OR: [{ fromUserId: newAccount!.id }, { toUserId: newAccount!.id }],
            },
            select: { fromUserId: true, toUserId: true },
        });
        expect(rels.length).toBeGreaterThan(0);
        const oldRels = await db.userRelationship.findMany({
            where: {
                OR: [{ fromUserId: oldAccount!.id }, { toUserId: oldAccount!.id }],
            },
            select: { fromUserId: true },
        });
        expect(oldRels.length).toBe(0);

        const feedMoved = await db.userFeedItem.findMany({
            where: { userId: newAccount!.id },
            select: { id: true },
        });
        expect(feedMoved.length).toBeGreaterThan(0);

        await app.close();
    });

    it("does not migrate social data when provider reset disableAccount fails (restores old identity, keeps pending)", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(31);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(32);

        const githubProfile = {
            id: 889,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const pending1 = "oauth_pending_disableFailResetA1";
        await db.repeatKey.create({
            data: {
                key: pending1,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending1, pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending1, pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: pending1, ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true, username: true } });
        expect(oldAccount?.username).toBe("octocat");
        const oldIdentityBefore = await db.accountIdentity.findMany({
            where: { accountId: oldAccount!.id, provider: "github" },
            select: { id: true },
        });
        expect(oldIdentityBefore.length).toBe(1);

        // Add social data to ensure it does not migrate.
        const friend = await db.account.create({ data: { publicKey: "pk_friend_disable_reset", username: "friend1" } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: oldAccount!.id, toUserId: friend.id, status: "friend" },
                { fromUserId: friend.id, toUserId: oldAccount!.id, status: "friend" },
            ],
        });
        await db.userFeedItem.create({
            data: {
                userId: oldAccount!.id,
                counter: BigInt(1),
                body: { t: "friend_accepted", v: 1 },
            } as any,
        });
        await db.account.update({
            where: { id: oldAccount!.id },
            data: { feedSeq: BigInt(1) },
        });

        const pending2 = "oauth_pending_disableFailResetA2";
        await db.repeatKey.create({
            data: {
                key: pending2,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending2, pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending2, pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const originalUpsert = db.repeatKey.upsert.bind(db.repeatKey);
        const upsertSpy = vi.spyOn(db.repeatKey, "upsert").mockImplementation((async (args: any) => {
            const key = args?.where?.key;
            if (typeof key === "string" && key.startsWith("auth_disabled_")) {
                throw new Error("disable failed");
            }
            return await originalUpsert(args);
        }) as any);
        try {
            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending: pending2, reset: true, ...body2 },
            });

            expect(res.statusCode).toBe(500);
            expect(upsertSpy).toHaveBeenCalled();

            const newAccount = await db.account.findFirst({ where: { publicKey: pk2 }, select: { id: true } });
            expect(newAccount).toBeNull();

            const oldAccountAfter = await db.account.findUnique({
                where: { id: oldAccount!.id },
                select: { username: true },
            });
            expect(oldAccountAfter?.username).toBe("octocat");

            const oldIdentityAfter = await db.accountIdentity.findMany({
                where: { accountId: oldAccount!.id, provider: "github" },
                select: { id: true },
            });
            expect(oldIdentityAfter.length).toBe(1);

            const relsForOld = await db.userRelationship.findMany({
                where: { OR: [{ fromUserId: oldAccount!.id }, { toUserId: oldAccount!.id }] },
                select: { fromUserId: true, toUserId: true },
            });
            expect(relsForOld.length).toBeGreaterThan(0);

            const feedForOld = await db.userFeedItem.findMany({ where: { userId: oldAccount!.id }, select: { id: true } });
            expect(feedForOld.length).toBeGreaterThan(0);

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending2 } });
            expect(stillPending).toBeTruthy();
        } finally {
            upsertSpy.mockRestore();
        }

        await app.close();
    });

    it("deletes the newly created account when identity detach fails during provider reset", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(41);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(42);

        const githubProfile = {
            id: 890,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const pending1 = "oauth_pending_detachFailResetA1";
        await db.repeatKey.create({
            data: {
                key: pending1,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending1, pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending1, pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: pending1, ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true } });
        expect(oldAccount).toBeTruthy();

        const pending2 = "oauth_pending_detachFailResetA2";
        await db.repeatKey.create({
            data: {
                key: pending2,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending2, pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending2, pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const deleteSpy = vi.spyOn(db.accountIdentity, "delete").mockImplementationOnce((async () => {
            throw new Error("detach failed");
        }) as any);
        try {
            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending: pending2, reset: true, ...body2 },
            });

            expect(res.statusCode).toBe(500);
            expect(deleteSpy).toHaveBeenCalled();

            const newAccount = await db.account.findFirst({ where: { publicKey: pk2 }, select: { id: true } });
            expect(newAccount).toBeNull();

            const oldIdentity = await db.accountIdentity.findMany({
                where: { accountId: oldAccount!.id, provider: "github" },
                select: { id: true },
            });
            expect(oldIdentity.length).toBe(1);

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending2 } });
            expect(stillPending).toBeTruthy();
        } finally {
            deleteSpy.mockRestore();
        }

        await app.close();
    });

    it("cleans up newly created account when GitHub connect fails, leaving the pending key for retry", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(11);

        const pending = "oauth_pending_connectFailureA1";
        const githubProfile = {
            id: 999,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo-fail.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_9"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.resetModules();
        vi.doMock("@/app/auth/providers/identity", async () => {
            const actual = await vi.importActual<typeof import("@/app/auth/providers/identity")>(
                "@/app/auth/providers/identity",
            );
            return {
                ...actual,
                connectExternalIdentity: vi.fn(async () => {
                    throw new Error("connect failed");
                }),
            };
        });

        let app: ReturnType<typeof createTestApp> | null = null;
        try {
            const { connectRoutes: connectRoutesMocked } = await import("./connectRoutes");

            app = createTestApp();
            connectRoutesMocked(app as any);
            await app.ready();

            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending, ...body },
            });
            expect(res.statusCode).toBe(500);

            const account = await db.account.findFirst({ where: { publicKey: publicKeyHex }, select: { id: true } });
            expect(account).toBeNull();

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending } });
            expect(stillPending).toBeTruthy();
        } finally {
            if (app) {
                await app.close();
            }
            vi.doUnmock("@/app/auth/providers/identity");
            vi.resetModules();
        }
    });
});
