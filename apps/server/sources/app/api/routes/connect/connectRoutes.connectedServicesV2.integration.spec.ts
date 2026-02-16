import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { initEncrypt } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import tweetnacl from "tweetnacl";
import { openBoxBundle } from "@happier-dev/protocol";

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
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return trackApp(typed);
}

describe("connectRoutes (connected services v2) sealed credential endpoints (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-connected-services-v2-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await initEncrypt();
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await db.$disconnect();
        process.env = envBackup;
        await rm(baseDir, { recursive: true, force: true });
    });

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
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("does not register v2 connected service routes when HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED=0", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = "0";
        const user = await db.account.create({ data: { publicKey: "pk-csv2-disabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(404);
        const body = res.json() as any;
        expect(body?.error).not.toBe("connect_credential_not_found");
    });

    it("stores and returns sealed ciphertext for a connected service profile", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u1" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
            metadata: expect.objectContaining({ kind: "oauth", providerEmail: "user@example.com" }),
        });
    });

    it("rejects sealed ciphertext longer than CONNECTED_SERVICE_CREDENTIAL_MAX_LEN", async () => {
        process.env.CONNECTED_SERVICE_CREDENTIAL_MAX_LEN = "4";
        const user = await db.account.create({ data: { publicKey: "pk-csv2-max-len" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "12345" },
                metadata: { kind: "oauth" },
            },
        });

        expect(register.statusCode).toBe(413);
        expect(register.json()).toEqual({ error: "connect_credential_invalid" });
    });

    it("supports v1 register-sealed and credential shims (default profile)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-v1-shims" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register-sealed",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com" },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v1/connect/anthropic/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
            metadata: expect.objectContaining({ kind: "oauth", providerEmail: "user@example.com" }),
        });
    });

    it("proxies OAuth token exchange and returns an encrypted bundle (openai-codex)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-oauth-proxy" }, select: { id: true } });

        const keyPair = tweetnacl.box.keyPair();
        const publicKeyB64Url = Buffer.from(keyPair.publicKey).toString("base64url");

        vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
            expect(String(url)).toContain("auth.openai.com/oauth/token");
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id_token: "id_token_1",
                    access_token: "access_token_1",
                    refresh_token: "refresh_token_1",
                    expires_in: 3600,
                }),
                text: async () => "",
            } as any;
        }));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/exchange",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                publicKey: publicKeyB64Url,
                code: "code_1",
                verifier: "verifier_1",
                redirectUri: "http://localhost:1455/auth/callback",
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(typeof body?.bundle).toBe("string");
        expect(body?.access_token).toBeUndefined();
        expect(body?.refresh_token).toBeUndefined();
        expect(body?.id_token).toBeUndefined();

        const bundleBytes = new Uint8Array(Buffer.from(body.bundle, "base64url"));
        const opened = openBoxBundle({ bundle: bundleBytes, recipientSecretKeyOrSeed: keyPair.secretKey });
        expect(opened).not.toBeNull();
        const openedJson = JSON.parse(Buffer.from(opened!).toString("utf8"));
        expect(openedJson).toEqual(
            expect.objectContaining({
                accessToken: "access_token_1",
                refreshToken: "refresh_token_1",
                idToken: "id_token_1",
            }),
        );
    });

    it("lists connected service profiles without returning plaintext secrets", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u2" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const list = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: { "x-test-user-id": user.id },
        });
        expect(list.statusCode).toBe(200);
        const json = list.json() as any;
        expect(Array.isArray(json.profiles)).toBe(true);
        expect(json.profiles).toEqual([
            expect.objectContaining({
                profileId: "work",
                status: "connected",
                providerEmail: "user@example.com",
            }),
        ]);
        expect(JSON.stringify(json)).not.toContain("c2VhbGVk");
    });

    it("treats legacy v1 vendor tokens as unsupported for v2 credential reads", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u3" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const legacyRegister = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "legacy-token" },
        });
        expect(legacyRegister.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(409);
        expect(getOne.json()).toEqual({ error: "connect_credential_unsupported_format" });
    });

    it("acquires a refresh lease and prevents concurrent refresh", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u4" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const leaseA = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m1", leaseMs: 10_000 },
        });
        expect(leaseA.statusCode).toBe(200);
        expect(leaseA.json()).toEqual(expect.objectContaining({ acquired: true, leaseUntil: expect.any(Number) }));

        const leaseB = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/refresh-lease",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { machineId: "m2", leaseMs: 10_000 },
        });
        expect(leaseB.statusCode).toBe(200);
        expect(leaseB.json()).toEqual(expect.objectContaining({ acquired: false, leaseUntil: expect.any(Number) }));
    });

    it("deletes a connected service credential for a profile", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-csv2-u5" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });

        const del = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(del.statusCode).toBe(200);
        expect(del.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);

        const list = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: { "x-test-user-id": user.id },
        });
        expect(list.statusCode).toBe(200);
        expect((list.json() as any).profiles).toEqual([]);
    });
});
