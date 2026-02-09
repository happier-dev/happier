import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

function createSignInRequest() {
    const seed = new Uint8Array(32).fill(7);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

function createTerminalKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        secretKeyRaw: new Uint8Array(kp.secretKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function sha256Base64Url(bytes: Uint8Array): string {
    const digest = createHash("sha256").update(Buffer.from(bytes)).digest();
    return digest.toString("base64url");
}

describe("authRoutes (terminal auth request) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-terminal-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            TERMINAL_AUTH_REQUEST_TTL_SECONDS: "900",
            TERMINAL_AUTH_CLAIM_RETRY_WINDOW_SECONDS: "60",
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
        await db.terminalAuthRequest.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("returns 410 expired from /v1/auth/request when the request exceeded TTL and deletes it", async () => {
        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested" });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(expiredRes.statusCode).toBe(410);
        expect(expiredRes.json()).toEqual({ error: "expired" });

        const remaining = await db.terminalAuthRequest.findUnique({ where: { id: row!.id } });
        expect(remaining).toBeNull();

        await app.close();
    });

    it("returns not_found from /v1/auth/request/status when the request exceeded TTL and deletes it", async () => {
        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "not_found", supportsV2: false });

        const remaining = await db.terminalAuthRequest.findUnique({ where: { id: row!.id } });
        expect(remaining).toBeNull();

        await app.close();
    });

    it("clamps TERMINAL_AUTH_REQUEST_TTL_SECONDS to a minimum safe value", async () => {
        process.env.TERMINAL_AUTH_REQUEST_TTL_SECONDS = "1";

        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        // If TTL were truly 1s, this would be expired. With clamping (>= 60s), it should remain valid.
        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 2_000) },
        });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "pending", supportsV2: true });

        await app.close();
    });

    it("clamps TERMINAL_AUTH_REQUEST_TTL_SECONDS to a maximum safe value", async () => {
        process.env.TERMINAL_AUTH_REQUEST_TTL_SECONDS = "999999";

        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        // If TTL were truly huge, this would not be expired. With clamping (<= 3600s), it should expire.
        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 3_601_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(expiredRes.statusCode).toBe(410);
        expect(expiredRes.json()).toEqual({ error: "expired" });

        await app.close();
    });

    it("allows claiming an authorized request with the correct claim secret and returns token + response", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;
        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(10);

        const { publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested" });

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });
        expect(approveRes.statusCode).toBe(200);
        expect(approveRes.json()).toEqual({ success: true });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "authorized", supportsV2: true });

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(claimRes.statusCode).toBe(200);
        const claimJson = claimRes.json() as any;
        expect(claimJson).toEqual({
            state: "authorized",
            token: expect.any(String),
            response: "hello",
        });
        expect(claimJson.token.length).toBeGreaterThan(10);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row?.claimedAt).toBeTruthy();

        await app.close();
    });

    it("returns consumed when the claim write loses a race after eligibility checks", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const { publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });
        expect(approveRes.statusCode).toBe(200);

        const updateManySpy = vi.spyOn(db.terminalAuthRequest, "updateMany").mockResolvedValueOnce({ count: 0 } as any);
        try {
            const claimRes = await app.inject({
                method: "POST",
                url: "/v1/auth/request/claim",
                payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
            });
            expect(claimRes.statusCode).toBe(410);
            expect(claimRes.json()).toEqual({ error: "consumed" });
        } finally {
            updateManySpy.mockRestore();
        }

        await app.close();
    });

    it("rejects setting claimSecretHash on an existing request that was created without one", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const { publicKeyBase64 } = createTerminalKeypair();
        const first = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ state: "requested" });

        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretHash = sha256Base64Url(claimSecret);
        const takeoverAttempt = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(takeoverAttempt.statusCode).toBe(409);
        expect(takeoverAttempt.json()).toEqual({ error: "claim_mismatch" });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row?.claimSecretHash ?? null).toBeNull();

        await app.close();
    });

    it("rejects oversized publicKey inputs without 500s", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const tooLarge = "A".repeat(10_000);
        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: tooLarge, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(401);
        expect(createRes.json()).toEqual({ error: "Invalid public key" });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(tooLarge)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "not_found", supportsV2: false });

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: tooLarge, claimSecret: tooLarge },
        });
        expect(claimRes.statusCode).toBe(400);

        await app.close();
    });

    it("returns 401 from /v1/auth when base64 decoding fails (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: "not-base64!!",
                challenge: "not-base64!!",
                signature: "not-base64!!",
            },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns 401 from /v1/auth/response when base64 decoding fails (no 500)", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: "not-base64!!", response: "hello" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns 401 from /v1/auth/request/claim when the claim secret is wrong", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const { publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);

        await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });

        const wrongSecret = encodeBase64Url(new Uint8Array(randomBytes(32)));
        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: wrongSecret },
        });
        expect(claimRes.statusCode).toBe(401);
        expect(claimRes.json()).toEqual({ error: "unauthorized" });

        await app.close();
    });

    it("returns 410 consumed from /v1/auth/request/claim after the retry window elapses", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const { publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);

        await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { claimedAt: new Date(Date.now() - 61_000) },
        });

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(claimRes.statusCode).toBe(410);
        expect(claimRes.json()).toEqual({ error: "consumed" });

        const remaining = await db.terminalAuthRequest.findUnique({ where: { id: row!.id } });
        expect(remaining).toBeNull();

        await app.close();
    });

    it("returns 401 from /v1/auth/request when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: "not-base64!!", supportsV2: true },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns not_found from /v1/auth/request/status when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/auth/request/status?publicKey=not-base64!!",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "not_found", supportsV2: false });

        await app.close();
    });

    it("returns 410 expired from /v1/auth/request/claim when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: "not-base64!!", claimSecret: encodeBase64Url(new Uint8Array(randomBytes(32))) },
        });
        expect(res.statusCode).toBe(410);
        expect(res.json()).toEqual({ error: "expired" });

        await app.close();
    });

    it("keeps legacy behavior without claimSecretHash (token + response via /v1/auth/request) while enforcing TTL", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const { publicKeyBase64 } = createTerminalKeypair();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested" });

        const createdRow = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(createdRow?.claimSecretHash ?? null).toBeNull();

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: publicKeyBase64, response: "hello" },
        });
        expect(approveRes.statusCode).toBe(200);

        const approvedRow = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(approvedRow?.claimSecretHash ?? null).toBeNull();

        const authorizedRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(authorizedRes.statusCode).toBe(200);
        expect(authorizedRes.json()).toEqual({
            state: "authorized",
            token: expect.any(String),
            response: "hello",
        });

        await app.close();
    });
});
