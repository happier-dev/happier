import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { initEncrypt } from "@/modules/encrypt";
import { encryptString } from "@/modules/encrypt";
import { initFilesLocalFromEnv, loadFiles } from "@/storage/blob/files";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function runServerPrismaMigrateDeploySqlite(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}). ${out}`);
    }
}

function createTestApp() {
    const app = Fastify({ logger: false });
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
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9e8AAAAASUVORK5CYII=",
    "base64",
);

describe("connectRoutes (external auth finalize) (integration)", () => {
    const envBackup = { ...process.env };
    const originalFetch = globalThis.fetch;
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-external-finalize-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir,
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
        await initEncrypt();
        initFilesLocalFromEnv(process.env);
        await loadFiles();
    }, 120_000);

    const restoreEnv = (base: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) {
            if (!(key in base)) {
                delete (process.env as any)[key];
            }
        }
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string") {
                process.env[key] = value;
            }
        }
    };

    afterEach(async () => {
        await closeTrackedApps();
        restoreEnv(testEnvBase);
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
        await db.$disconnect();
        process.env = envBackup;
        globalThis.fetch = originalFetch;
        await rm(baseDir, { recursive: true, force: true });
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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

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

    it("returns 400 username-required when pending indicates username is required and no username is provided", async () => {
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

        process.env.HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED = "1";
        process.env.GITHUB_CLIENT_ID = "cid";
        process.env.GITHUB_CLIENT_SECRET = "secret";
        process.env.GITHUB_REDIRECT_URL = "https://server.example.test/v1/oauth/github/callback";

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(21);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(22);

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
            payload: { pending: "oauth_pending_pendingResetA2", reset: true, ...body2 },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expect.objectContaining({ success: true, token: expect.any(String) }));

        const newAccount = await db.account.findFirst({
            where: { publicKey: pk2 },
            select: { id: true, username: true, feedSeq: true },
        });
        expect(newAccount?.username).toBe("octocat");
        expect(newAccount?.feedSeq?.toString()).toBe("1");

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

        process.env.HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED = "1";
        process.env.GITHUB_CLIENT_ID = "cid";
        process.env.GITHUB_CLIENT_SECRET = "secret";
        process.env.GITHUB_REDIRECT_URL = "https://server.example.test/v1/oauth/github/callback";

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED = "1";
        process.env.GITHUB_CLIENT_ID = "cid";
        process.env.GITHUB_CLIENT_SECRET = "secret";
        process.env.GITHUB_REDIRECT_URL = "https://server.example.test/v1/oauth/github/callback";

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
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";

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
