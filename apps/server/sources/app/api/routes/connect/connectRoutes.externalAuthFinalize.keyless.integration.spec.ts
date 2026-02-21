import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";

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

describe("connectRoutes (external auth finalize keyless) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-external-finalize-keyless-"));
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
        await rm(baseDir, { recursive: true, force: true });
    });

    it("POST /v1/auth/external/:provider/finalize-keyless provisions a keyless account and returns a token when enabled", async () => {
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE = "plain";

        const pendingKey = "oauth_pending_keylessA1";
        const proof = "proof_secret_1";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
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
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json).toMatchObject({ success: true });
        expect(typeof json.token).toBe("string");

        const accounts = await db.account.findMany({ select: { id: true, publicKey: true, encryptionMode: true } });
        expect(accounts.length).toBe(1);
        expect(accounts[0].publicKey).toBeNull();
        expect(accounts[0].encryptionMode).toBe("plain");

        const identities = await db.accountIdentity.findMany({
            where: { provider: "github", providerUserId: "123" },
            select: { accountId: true },
        });
        expect(identities.length).toBe(1);
        expect(identities[0].accountId).toBe(accounts[0].id);

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless returns 409 restore-required when the external identity is linked to a keyed account", async () => {
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        const keyedAccount = await db.account.create({
            data: { publicKey: "pk_hex_1", encryptionMode: "e2ee" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: keyedAccount.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                showOnProfile: false,
            },
        });

        const pendingKey = "oauth_pending_keylessB1";
        const proof = "proof_secret_2";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
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
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "restore-required" });

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/:provider/finalize-keyless returns 403 e2ee-required when server storagePolicy=required_e2ee", async () => {
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        const keylessAccount = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: keylessAccount.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                showOnProfile: false,
            },
        });

        const pendingKey = "oauth_pending_keylessC1";
        const proof = "proof_secret_3";
        const proofHash = createHash("sha256").update(proof, "utf8").digest("hex");

        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "",
            name: "The Octocat",
        };

        await db.repeatKey.create({
            data: {
                key: pendingKey,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    authMode: "keyless",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "profile"], JSON.stringify(githubProfile)),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending_keyless", pendingKey, "token"], "tok_3"),
                    ),
                    suggestedUsername: "octocat",
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
            method: "POST",
            url: "/v1/auth/external/github/finalize-keyless",
            headers: { "content-type": "application/json" },
            payload: { pending: pendingKey, proof },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "e2ee-required" });

        const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
        expect(pending).toBeNull();

        await app.close();
    });
});
