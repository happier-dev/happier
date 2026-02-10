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
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { initEncrypt } from "@/modules/encrypt";
import { enableAuthentication } from "../../utils/enableAuthentication";
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
    enableAuthentication(typed);
    return trackApp(typed);
}

function createAccountKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        secretKeyRaw: new Uint8Array(kp.secretKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

function decryptTokenEncrypted(params: { tokenEncryptedBase64: string; recipientSecretKey: Uint8Array }): string | null {
    const bundle = privacyKit.decodeBase64(params.tokenEncryptedBase64);
    const ephemeralPublicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
    const nonce = bundle.slice(tweetnacl.box.publicKeyLength, tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
    const ciphertext = bundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
    const opened = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, params.recipientSecretKey);
    if (!opened) {
        return null;
    }
    return new TextDecoder().decode(opened);
}

describe("authRoutes (account auth request) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-account-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            ACCOUNT_AUTH_REQUEST_TTL_SECONDS: "900",
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
        await initEncrypt();
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
        await db.accountAuthRequest.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("returns requested from /v1/auth/account/request and recreates an expired request", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested" });

        const publicKeyHex = privacyKit.encodeHex(publicKeyRaw);
        const row = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(row).toBeTruthy();

        await db.accountAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(expiredRes.statusCode).toBe(200);
        expect(expiredRes.json()).toEqual({ state: "requested" });

        const refreshed = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(refreshed).toBeTruthy();
        expect(refreshed!.id).not.toBe(row!.id);

        await app.close();
    });

    it("does not return authorized from /v1/auth/account/request when the request is expired (even if responded)", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });
        expect(approveRes.statusCode).toBe(200);
        expect(approveRes.json()).toEqual({ success: true });

        const publicKeyHex = privacyKit.encodeHex(publicKeyRaw);
        const row = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(row?.response).toBe("hello");

        await db.accountAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(expiredRes.statusCode).toBe(200);
        expect(expiredRes.json()).toEqual({ state: "requested" });

        const refreshed = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(refreshed).toBeTruthy();
        expect(refreshed!.response).toBeNull();

        await app.close();
    });

    it("rejects oversized publicKey payloads", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: "a".repeat(513) },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns authorized with encrypted token and no plaintext token from /v1/auth/account/request", async () => {
        const { secretKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        app.get("/_test/whoami", { preHandler: (app as any).authenticate }, async (request: any) => {
            return { userId: request.userId };
        });
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });
        expect(approveRes.statusCode).toBe(200);

        const authorizedRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(authorizedRes.statusCode).toBe(200);
        const json = authorizedRes.json() as any;
        expect(json.state).toBe("authorized");
        expect(json.token).toBeUndefined();
        expect(typeof json.tokenEncrypted).toBe("string");
        expect(typeof json.response).toBe("string");

        const decryptedToken = decryptTokenEncrypted({ tokenEncryptedBase64: json.tokenEncrypted, recipientSecretKey: secretKeyRaw });
        expect(decryptedToken).toBeTruthy();

        const whoamiRes = await app.inject({
            method: "GET",
            url: "/_test/whoami",
            headers: { authorization: `Bearer ${decryptedToken}` },
        });
        expect(whoamiRes.statusCode).toBe(200);
        expect(whoamiRes.json()).toEqual({ userId: account.id });

        await app.close();
    });
});
