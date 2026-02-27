import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

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

function createPhoneEphemeralKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

describe("authRoutes (pairing auth) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-pairing-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: "1",
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
        await (db as any).authPairingSession?.deleteMany?.().catch(() => {});
        await db.accountAuthRequest.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("requires auth for /v1/auth/pairing/start", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            payload: { secretHash: "xxxxxxxx" },
        });
        expect(res.statusCode).toBe(401);

        await app.close();
    });

    it("creates a pairing session, allows phone request, and exposes status to the owning account", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret = "secret-hash-123";
        const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash },
        });
        expect(startRes.statusCode).toBe(200);
        const startJson = startRes.json() as any;
        expect(typeof startJson.pairId).toBe("string");
        expect(typeof startJson.expiresAt).toBe("string");

        const pairId = String(startJson.pairId);
        const { publicKeyBase64 } = createPhoneEphemeralKeypair();

        const invalidKeyRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: "not-base64!!", deviceLabel: "iPhone" },
        });
        expect(invalidKeyRes.statusCode).toBe(401);
        expect(invalidKeyRes.json()).toEqual({ error: "Invalid public key" });

        const badRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret: "wrong", publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(badRes.statusCode).toBe(404);

        const tooLongSecretRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret: "x".repeat(1_000), publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(tooLongSecretRes.statusCode).toBe(400);

        const requestRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(requestRes.statusCode).toBe(200);
        expect(requestRes.json()).toEqual({ state: "requested", confirmCode: expect.any(String) });

        const tooLongDeviceLabelRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: publicKeyBase64, deviceLabel: "x".repeat(1_000) },
        });
        expect(tooLongDeviceLabelRes.statusCode).toBe(400);

        const otherKey = createPhoneEphemeralKeypair();
        const secondRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: otherKey.publicKeyBase64, deviceLabel: "Other iPhone" },
        });
        expect(secondRes.statusCode).toBe(401);
        expect(secondRes.json()).toEqual({ error: "already_requested" });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({
            state: "requested",
            pairId,
            expiresAt: expect.any(String),
            requestedPublicKey: publicKeyBase64,
            requestedDeviceLabel: "iPhone",
            confirmCode: expect.any(String),
        });

        await app.close();
    });

    it("invalidates previous pairing sessions for the same account on start", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret1 = "secret-1";
        const secretHash1 = createHash("sha256").update(secret1, "utf8").digest("base64url");
        const start1 = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash: secretHash1 },
        });
        expect(start1.statusCode).toBe(200);
        const pairId1 = String((start1.json() as any).pairId);

        const secret2 = "secret-2";
        const secretHash2 = createHash("sha256").update(secret2, "utf8").digest("base64url");
        const start2 = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash: secretHash2 },
        });
        expect(start2.statusCode).toBe(200);
        const pairId2 = String((start2.json() as any).pairId);
        expect(pairId2).not.toBe(pairId1);

        const oldStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId1)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(oldStatus.statusCode).toBe(404);

        const nextStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId2)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(nextStatus.statusCode).toBe(200);
        expect(nextStatus.json()).toEqual({ state: "pending", pairId: pairId2, expiresAt: expect.any(String) });

        await app.close();
    });

    it("best-effort cleans up expired pairing sessions on start", async () => {
        const accountA = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-a` },
            select: { id: true },
        });
        const token = await auth.createToken(accountA.id);

        const accountB = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-b` },
            select: { id: true },
        });

        await db.authPairingSession.create({
            data: {
                accountId: accountB.id,
                secretHash: "expired-secret-hash",
                requestedPublicKey: null,
                expiresAt: new Date(Date.now() - 60_000),
            },
        });

        expect(await db.authPairingSession.count({ where: { accountId: accountB.id } })).toBe(1);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret = "cleanup-secret";
        const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash },
        });
        expect(startRes.statusCode).toBe(200);

        expect(await db.authPairingSession.count({ where: { accountId: accountB.id } })).toBe(0);

        await app.close();
    });
});
