import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { initEncrypt } from "@/modules/encrypt";
import { auth } from "@/app/auth/auth";
import { voiceRoutes } from "./voiceRoutes";
import { createAppCloseTracker } from "../testkit/appLifecycle";

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

describe("voiceRoutes (integration, sqlite)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-voice-routes-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            VOICE_ENABLED: "true",
            VOICE_REQUIRE_SUBSCRIPTION: "false",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "60",
            ELEVENLABS_API_KEY: "elevenlabs-key",
            ELEVENLABS_AGENT_ID: "agent_dev",
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
        await db.voiceConversation.deleteMany().catch(() => {});
        await db.voiceSessionLease.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("mints a voice token, persists a lease, and does not persist a VoiceConversation until completion", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u1" }, select: { id: true } });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_1" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s1" },
        });
        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.allowed).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(typeof json.leaseId).toBe("string");

        const lease = await db.voiceSessionLease.findUnique({ where: { id: json.leaseId }, select: { accountId: true, sessionId: true } });
        expect(lease).toEqual({ accountId: user.id, sessionId: "s1" });

        const conversations = await db.voiceConversation.count();
        expect(conversations).toBe(0);
    });

    it("enforces max concurrent sessions and deletes the losing lease", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u2" }, select: { id: true } });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_any" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const [r1, r2] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/voice/token", headers: { "content-type": "application/json", "x-test-user-id": user.id }, payload: { sessionId: "s1" } }),
            app.inject({ method: "POST", url: "/v1/voice/token", headers: { "content-type": "application/json", "x-test-user-id": user.id }, payload: { sessionId: "s2" } }),
        ]);

        const codes = [r1.statusCode, r2.statusCode].sort();
        expect(codes).toEqual([200, 429]);

        const leases = await db.voiceSessionLease.count();
        expect(leases).toBe(1);
    });

    it("completes a voice session and persists VoiceConversation linked to the lease", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u3" }, select: { id: true } });
        const providerConversationId = "conv_123";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_2" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                const startTime = Math.floor(Date.now() / 1000);
                return new Response(JSON.stringify({
                    agent_id: "agent_dev",
                    metadata: { call_duration_secs: 12, start_time_unix_secs: startTime },
                }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const tokenRes = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s1" },
        });
        expect(tokenRes.statusCode).toBe(200);
        const leaseId = (tokenRes.json() as any).leaseId as string;

        const completeRes = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json()).toEqual({ ok: true, durationSeconds: 12 });

        const row = await db.voiceConversation.findUnique({
            where: {
                providerId_providerConversationId: { providerId: "elevenlabs_agents", providerConversationId },
            },
            select: { accountId: true, leaseId: true, durationSeconds: true },
        });
        expect(row).toEqual({ accountId: user.id, leaseId, durationSeconds: 12 });
    });

    it("allows a new token immediately after completion when max concurrent sessions is 1", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u4" }, select: { id: true } });
        const providerConversationId = "conv_456";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_reuse" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                const startTime = Math.floor(Date.now() / 1000);
                return new Response(JSON.stringify({
                    agent_id: "agent_dev",
                    metadata: { call_duration_secs: 5, start_time_unix_secs: startTime },
                }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const firstTokenRes = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s1" },
        });
        expect(firstTokenRes.statusCode).toBe(200);
        const firstLeaseId = (firstTokenRes.json() as any).leaseId as string;

        const completeRes = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId: firstLeaseId, providerConversationId },
        });
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json()).toEqual({ ok: true, durationSeconds: 5 });

        const secondTokenRes = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s2" },
        });
        expect(secondTokenRes.statusCode).toBe(200);
        expect((secondTokenRes.json() as any).allowed).toBe(true);
    });

    it("fails closed when completing a lease that is not owned by the caller", async () => {
        const u1 = await db.account.create({ data: { publicKey: "pk-voice-owner" }, select: { id: true } });
        const u2 = await db.account.create({ data: { publicKey: "pk-voice-not-owner" }, select: { id: true } });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_3" }), { status: 200 });
            }
            if (u.includes("/v1/convai/conversations/")) {
                return new Response(JSON.stringify({ metadata: { call_duration_secs: 1, start_time_unix_secs: Math.floor(Date.now() / 1000) } }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const tokenRes = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": u1.id },
            payload: { sessionId: "s1" },
        });
        expect(tokenRes.statusCode).toBe(200);
        const leaseId = (tokenRes.json() as any).leaseId as string;

        const completeRes = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": u2.id },
            payload: { leaseId, providerConversationId: "conv_wrong_user" },
        });
        expect(completeRes.statusCode).toBe(404);
        expect(completeRes.json()).toEqual({ ok: false, reason: "not_found" });

        expect(await db.voiceConversation.count()).toBe(0);
    });

    it("fails closed when provider conversation metadata does not match the lease binding", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-binding-u1" }, select: { id: true } });
        const providerConversationId = "conv_binding_mismatch";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_binding" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(
                    JSON.stringify({
                        agent_id: "agent_other",
                        metadata: { call_duration_secs: 4, start_time_unix_secs: Math.floor(Date.now() / 1000) },
                    }),
                    { status: 200 },
                );
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const tokenRes = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s-bind" },
        });
        expect(tokenRes.statusCode).toBe(200);
        const leaseId = (tokenRes.json() as any).leaseId as string;

        const completeRes = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(completeRes.statusCode).toBe(404);
        expect(completeRes.json()).toEqual({ ok: false, reason: "not_found" });

        expect(await db.voiceConversation.count()).toBe(0);
    });
});
