import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE } from "@happier-dev/protocol";
import { voiceRoutes } from "./voiceRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { deriveVoiceProviderConversationKey } from "./voiceProviderConversationIdentity";

const { trackApp, closeTrackedApps } = createAppCloseTracker();


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

async function mintVoiceLease(app: any, userId: string, sessionId: string): Promise<string> {
    return (await mintVoiceLeaseWithBindingNonce(app, userId, sessionId)).leaseId;
}

async function mintVoiceLeaseWithBindingNonce(
    app: any,
    userId: string,
    sessionId: string,
): Promise<{ leaseId: string; bindingNonce: string }> {
    const res = await app.inject({
        method: "POST",
        url: "/v1/voice/token",
        headers: { "content-type": "application/json", "x-test-user-id": userId },
        payload: { sessionId },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as any;
    expect(typeof json.bindingNonce).toBe("string");
    return { leaseId: json.leaseId as string, bindingNonce: json.bindingNonce as string };
}

function providerConversationDetails(params: {
    conversationId: string;
    bindingNonce: string;
    durationSeconds: number;
    startTimeUnixSecs?: number;
    agentId?: string;
}) {
    return {
        conversation_id: params.conversationId,
        agent_id: params.agentId ?? "agent_dev",
        metadata: {
            call_duration_secs: params.durationSeconds,
            start_time_unix_secs: params.startTimeUnixSecs ?? Math.floor(Date.now() / 1000),
        },
        conversation_initiation_client_data: {
            dynamic_variables: {
                [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: params.bindingNonce,
            },
        },
    };
}

async function bindVoiceSession(app: any, userId: string, leaseId: string, providerConversationId: string) {
    return app.inject({
        method: "POST",
        url: "/v1/voice/session/start",
        headers: { "content-type": "application/json", "x-test-user-id": userId },
        payload: { leaseId, providerConversationId },
    });
}

async function completeVoiceSession(app: any, userId: string, leaseId: string, providerConversationId: string) {
    return app.inject({
        method: "POST",
        url: "/v1/voice/session/complete",
        headers: { "content-type": "application/json", "x-test-user-id": userId },
        payload: { leaseId, providerConversationId },
    });
}

describe("voiceRoutes (integration, sqlite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-voice-routes-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_VOICE__ENABLED: "true",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "false",
                VOICE_MAX_CONCURRENT_SESSIONS: "1",
                VOICE_MAX_SESSION_SECONDS: "60",
                ELEVENLABS_API_KEY: "elevenlabs-key",
                ELEVENLABS_AGENT_ID: "agent_dev",
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
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

        expect(typeof json.bindingNonce).toBe("string");
        expect(json.bindingNonce.length).toBeGreaterThan(20);

        const lease = await db.voiceSessionLease.findUnique({
            where: { id: json.leaseId },
            select: { accountId: true, sessionId: true, providerBindingNonce: true },
        });
        expect(lease).toEqual({ accountId: user.id, sessionId: "s1", providerBindingNonce: json.bindingNonce });

        const conversations = await db.voiceConversation.count();
        expect(conversations).toBe(0);
    });

    it("respects ELEVENLABS_API_BASE_URL when minting a conversation token", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-baseurl-u1" }, select: { id: true } });

        harness.resetEnv({ ELEVENLABS_API_BASE_URL: "http://elevenlabs.example.test/" });
        const expected = "http://elevenlabs.example.test/v1/convai/conversation/token?agent_id=agent_dev";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            expect(String(url)).toBe(expected);
            return new Response(JSON.stringify({ token: "conv_token_baseurl" }), { status: 200 });
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "baseurl-s1" },
        });
        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.allowed).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(typeof json.leaseId).toBe("string");
    });

    it("mints a voice token via the account-scoped alias route without a sessionId", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-alias-u1" }, select: { id: true } });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_alias" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/voice/lease/mint",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.allowed).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(typeof json.leaseId).toBe("string");

        const lease = await db.voiceSessionLease.findUnique({
            where: { id: json.leaseId },
            select: { accountId: true, sessionId: true },
        });
        expect(lease).toEqual({ accountId: user.id, sessionId: null });
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

    it("admits at most VOICE_MAX_CONCURRENT_SESSIONS under a concurrent mint burst (TOCTOU-safe)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-toctou" }, select: { id: true } });
        const maxConcurrent = 3;
        const burst = 8;
        // Raise the per-user mint budget above the burst so this test isolates
        // the concurrency winners check (not the shared mint throttle).
        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: String(maxConcurrent), HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_burst" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const results = await Promise.all(
            Array.from({ length: burst }, (_, i) =>
                app.inject({
                    method: "POST",
                    url: "/v1/voice/token",
                    headers: { "content-type": "application/json", "x-test-user-id": user.id },
                    payload: { sessionId: `s${i}` },
                }),
            ),
        );

        const succeeded = results.filter((r) => r.statusCode === 200).length;
        const throttled = results.filter((r) => r.statusCode === 429).length;
        // No over-admission: even under a concurrent burst the winners check must
        // never grant more than the configured concurrency.
        expect(succeeded).toBeLessThanOrEqual(maxConcurrent);
        expect(succeeded + throttled).toBe(burst);

        // Persisted leases must match the granted sessions exactly (losers are
        // rolled back inside the transaction).
        const leases = await db.voiceSessionLease.count({ where: { accountId: user.id } });
        expect(leases).toBe(succeeded);
    });

    it("does not over-grant the daily minute cap under a concurrent mint burst (FIND-019)", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-minute-race" }, select: { id: true } });
        const maxMinutesPerDay = 2;
        const maxSessionSeconds = 60;
        const burst = 8;
        // Isolate the daily minute cap from the concurrency and mint-throttle gates: raise both well
        // above the burst. With a 60s pending-lease charge and a 120s/day cap, at most 2 mints may be
        // granted. If the minute check ran outside the lock, all 8 would observe the same 0s budget
        // and over-grant.
        harness.resetEnv({
            VOICE_MAX_CONCURRENT_SESSIONS: String(burst),
            VOICE_MAX_SESSION_SECONDS: String(maxSessionSeconds),
            VOICE_MAX_MINUTES_PER_DAY: String(maxMinutesPerDay),
            HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100",
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_minute_race" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const results = await Promise.all(
            Array.from({ length: burst }, (_, i) =>
                app.inject({
                    method: "POST",
                    url: "/v1/voice/token",
                    headers: { "content-type": "application/json", "x-test-user-id": user.id },
                    payload: { sessionId: `m${i}` },
                }),
            ),
        );

        const succeeded = results.filter((r) => r.statusCode === 200).length;
        const denied = results.filter((r) => r.statusCode === 403).length;
        // At most maxMinutesPerDay sessions (each charged at maxSessionSeconds) fit in the daily cap.
        expect(succeeded).toBeLessThanOrEqual(maxMinutesPerDay);
        expect(succeeded).toBeGreaterThanOrEqual(1);
        expect(succeeded + denied).toBe(burst);
        // Quota denials must report quota_exceeded, not a generic throttle.
        for (const r of results.filter((res) => res.statusCode === 403)) {
            expect((r.json() as any).reason).toBe("quota_exceeded");
        }
        // Persisted leases must match the granted sessions exactly (over-budget losers rolled back).
        const leases = await db.voiceSessionLease.count({ where: { accountId: user.id } });
        expect(leases).toBe(succeeded);
    });

    it("completes a voice session and persists VoiceConversation linked to the lease", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u3" }, select: { id: true } });
        const providerConversationId = "conv_123";
        let bindingNonce = "";
        let providerDurationSeconds = 12;
        let providerFetchUnavailable = false;

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_2" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                if (providerFetchUnavailable) throw new Error("provider unavailable after durable completion");
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: providerDurationSeconds,
                })), { status: 200 });
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
        const tokenJson = tokenRes.json() as any;
        const leaseId = tokenJson.leaseId as string;
        bindingNonce = tokenJson.bindingNonce as string;
        const startRes = await bindVoiceSession(app, user.id, leaseId, providerConversationId);
        expect(startRes.statusCode).toBe(200);
        expect(await db.voiceSessionLease.findUnique({
            where: { id: leaseId },
            select: { providerId: true, providerConversationId: true },
        })).toEqual({ providerId: null, providerConversationId: null });

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
                providerId_providerConversationKey: {
                    providerId: "elevenlabs_agents",
                    providerConversationKey: deriveVoiceProviderConversationKey({
                        providerId: "elevenlabs_agents",
                        providerConversationId,
                    }),
                },
            },
            select: { accountId: true, leaseId: true, durationSeconds: true },
        });
        expect(row).toEqual({ accountId: user.id, leaseId, durationSeconds: 12 });

        providerDurationSeconds = 13;
        const repeatedCompleteRes = await completeVoiceSession(app, user.id, leaseId, providerConversationId);
        expect(repeatedCompleteRes.statusCode).toBe(200);
        expect(repeatedCompleteRes.json()).toEqual({ ok: true, durationSeconds: 12 });
        expect(await db.voiceConversation.count()).toBe(1);

        providerFetchUnavailable = true;
        const retryWhileProviderUnavailable = await completeVoiceSession(app, user.id, leaseId, providerConversationId);
        expect(retryWhileProviderUnavailable.statusCode).toBe(200);
        expect(retryWhileProviderUnavailable.json()).toEqual({ ok: true, durationSeconds: 12 });
    });

    it("completes securely when the start binding request was lost but the provider echoes the lease nonce", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-unbound-complete" }, select: { id: true } });
        const providerConversationId = "conv_unbound_complete";
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_unbound" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 7,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const minted = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-unbound");
        const leaseId = minted.leaseId;
        bindingNonce = minted.bindingNonce;
        const completeRes = await completeVoiceSession(app, user.id, leaseId, providerConversationId);

        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json()).toEqual({ ok: true, durationSeconds: 7 });
        expect(await db.voiceConversation.count()).toBe(1);
    });

    it("persists a nonce-verified completion after lease expiry when provider timing is inside the allowed window", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-expired-complete" }, select: { id: true } });
        const providerConversationId = "conv_expired_complete";
        let bindingNonce = "";
        const providerStartedAt = Math.floor((Date.now() - 2_000) / 1_000);

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_expired_complete" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 1,
                    startTimeUnixSecs: providerStartedAt,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const minted = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-expired-complete");
        bindingNonce = minted.bindingNonce;
        await db.voiceSessionLease.update({
            where: { id: minted.leaseId },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });

        const completed = await completeVoiceSession(app, user.id, minted.leaseId, providerConversationId);
        expect(completed.statusCode).toBe(200);
        expect(completed.json()).toEqual({ ok: true, durationSeconds: 1 });
        expect(await db.voiceConversation.count()).toBe(1);
    });

    it("upgrades a matching legacy completed conversation with its digest during idempotent completion", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-legacy-idempotent" }, select: { id: true } });
        const providerConversationId = "conv_legacy_idempotent";
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_legacy_idempotent" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 6,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const minted = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-legacy-idempotent");
        bindingNonce = minted.bindingNonce;
        const legacyConversation = await db.voiceConversation.create({
            data: {
                accountId: user.id,
                leaseId: minted.leaseId,
                providerId: "elevenlabs_agents",
                providerConversationId,
                providerConversationKey: null,
                durationSeconds: 6,
            },
            select: { id: true },
        });

        const completed = await completeVoiceSession(app, user.id, minted.leaseId, providerConversationId);
        expect(completed.statusCode).toBe(200);
        expect(await db.voiceConversation.findUnique({
            where: { id: legacyConversation.id },
            select: { providerConversationKey: true },
        })).toEqual({
            providerConversationKey: deriveVoiceProviderConversationKey({
                providerId: "elevenlabs_agents",
                providerConversationId,
            }),
        });
    });

    it("overwrites a stale same-lease advisory binding after nonce-verified completion", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-stale-advisory" }, select: { id: true } });
        const providerConversationId = "conv_authoritative";
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_stale_advisory" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 13,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const minted = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-stale-advisory");
        bindingNonce = minted.bindingNonce;
        await db.voiceSessionLease.update({
            where: { id: minted.leaseId },
            data: {
                providerId: "elevenlabs_agents",
                providerConversationId: "conv_stale_wrong",
            },
        });

        const completeRes = await completeVoiceSession(app, user.id, minted.leaseId, providerConversationId);
        expect(completeRes.statusCode).toBe(200);
        expect(await db.voiceSessionLease.findUnique({
            where: { id: minted.leaseId },
            select: { providerId: true, providerConversationId: true },
        })).toEqual({ providerId: "elevenlabs_agents", providerConversationId });
    });

    it("rolls back all lease changes when a verified conversation is already owned by another lease", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk-voice-rollback-owner" }, select: { id: true } });
        const contender = await db.account.create({ data: { publicKey: "pk-voice-rollback-contender" }, select: { id: true } });
        const providerConversationId = "conv_rollback_conflict";

        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: "2", HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_rollback_conflict" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const ownerMint = await mintVoiceLeaseWithBindingNonce(app, owner.id, "s-rollback-owner");
        const contenderMint = await mintVoiceLeaseWithBindingNonce(app, contender.id, "s-rollback-contender");
        await db.voiceSessionLease.update({
            where: { id: ownerMint.leaseId },
            data: { providerId: "elevenlabs_agents", providerConversationId },
        });
        await db.voiceConversation.create({
            data: {
                accountId: owner.id,
                leaseId: ownerMint.leaseId,
                providerId: "elevenlabs_agents",
                providerConversationId,
                durationSeconds: 4,
            },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce: contenderMint.bindingNonce,
                    durationSeconds: 9,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const beforeLeases = await db.voiceSessionLease.findMany({
            orderBy: { id: "asc" },
            select: { id: true, providerId: true, providerConversationId: true },
        });
        const beforeConversations = await db.voiceConversation.findMany({
            orderBy: { id: "asc" },
            select: { id: true, accountId: true, leaseId: true, providerId: true, providerConversationId: true, durationSeconds: true },
        });

        const completeRes = await completeVoiceSession(app, contender.id, contenderMint.leaseId, providerConversationId);
        expect(completeRes.statusCode).toBe(404);
        expect(await db.voiceSessionLease.findMany({
            orderBy: { id: "asc" },
            select: { id: true, providerId: true, providerConversationId: true },
        })).toEqual(beforeLeases);
        expect(await db.voiceConversation.findMany({
            orderBy: { id: "asc" },
            select: { id: true, accountId: true, leaseId: true, providerId: true, providerConversationId: true, durationSeconds: true },
        })).toEqual(beforeConversations);
    });

    it("fails closed before mutation when a digest-key hit has a different exact identifier", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk-voice-collision-owner" }, select: { id: true } });
        const contender = await db.account.create({ data: { publicKey: "pk-voice-collision-contender" }, select: { id: true } });
        const requestedConversationId = "conv_collision_requested";
        const collisionKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: requestedConversationId,
        });

        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: "2", HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_collision" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const ownerMint = await mintVoiceLeaseWithBindingNonce(app, owner.id, "s-collision-owner");
        const contenderMint = await mintVoiceLeaseWithBindingNonce(app, contender.id, "s-collision-contender");
        await db.voiceConversation.create({
            data: {
                accountId: owner.id,
                leaseId: ownerMint.leaseId,
                providerId: "elevenlabs_agents",
                providerConversationId: "conv_collision_stored_other_raw_value",
                providerConversationKey: collisionKey,
                durationSeconds: 1,
            },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (String(url).includes(`/v1/convai/conversations/${requestedConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: requestedConversationId,
                    bindingNonce: contenderMint.bindingNonce,
                    durationSeconds: 2,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);

        const before = await db.voiceSessionLease.findUnique({
            where: { id: contenderMint.leaseId },
            select: { providerId: true, providerConversationId: true, providerConversationKey: true },
        });
        const completed = await completeVoiceSession(app, contender.id, contenderMint.leaseId, requestedConversationId);
        expect(completed.statusCode).toBe(503);
        expect(await db.voiceSessionLease.findUnique({
            where: { id: contenderMint.leaseId },
            select: { providerId: true, providerConversationId: true, providerConversationKey: true },
        })).toEqual(before);
    });

    it("accepts exactly one concurrent owner and leaves the losing lease unpoisoned", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-concurrent-completion" }, select: { id: true } });
        const providerConversationId = "conv_concurrent_completion";
        const completionNonces: string[] = [];

        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: "2", HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_concurrent_completion" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                const bindingNonce = completionNonces.shift();
                if (!bindingNonce) throw new Error("missing completion nonce");
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 3,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const first = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-concurrent-completion-1");
        const second = await mintVoiceLeaseWithBindingNonce(app, user.id, "s-concurrent-completion-2");
        completionNonces.push(first.bindingNonce, second.bindingNonce);

        const attempts = await Promise.all([
            completeVoiceSession(app, user.id, first.leaseId, providerConversationId),
            completeVoiceSession(app, user.id, second.leaseId, providerConversationId),
        ]);
        expect(attempts.map((attempt) => attempt.statusCode).sort()).toEqual([200, 404]);
        expect(await db.voiceConversation.count()).toBe(1);

        const winnerIndex = attempts.findIndex((attempt) => attempt.statusCode === 200);
        const loserLeaseId = winnerIndex === 0 ? second.leaseId : first.leaseId;
        expect(await db.voiceSessionLease.findUnique({
            where: { id: loserLeaseId },
            select: { providerId: true, providerConversationId: true, providerConversationKey: true },
        })).toEqual({ providerId: null, providerConversationId: null, providerConversationKey: null });
    });

    it("rejects completion when the provider conversation is bound to another account's lease", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk-voice-binding-owner" }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: "pk-voice-binding-other" }, select: { id: true } });
        const providerConversationId = "conv_cross_account_binding";
        let ownerBindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_cross_account" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce: ownerBindingNonce,
                    durationSeconds: 9,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const ownerMint = await mintVoiceLeaseWithBindingNonce(app, owner.id, "s-owner");
        const ownerLeaseId = ownerMint.leaseId;
        ownerBindingNonce = ownerMint.bindingNonce;
        const otherLeaseId = await mintVoiceLease(app, other.id, "s-other");
        const bindRes = await bindVoiceSession(app, owner.id, ownerLeaseId, providerConversationId);
        expect(bindRes.statusCode).toBe(200);

        const stolenCompleteRes = await completeVoiceSession(app, other.id, otherLeaseId, providerConversationId);
        expect(stolenCompleteRes.statusCode).toBe(404);
        expect(stolenCompleteRes.json()).toEqual({ ok: false, reason: "not_found" });

        const rightfulCompleteRes = await completeVoiceSession(app, owner.id, ownerLeaseId, providerConversationId);
        expect(rightfulCompleteRes.statusCode).toBe(200);
        expect(rightfulCompleteRes.json()).toEqual({ ok: true, durationSeconds: 9 });
    });

    it("rejects attacker-first provider conversation binding and lets the nonce-owning lease complete", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk-voice-attacker-owner" }, select: { id: true } });
        const attacker = await db.account.create({ data: { publicKey: "pk-voice-attacker" }, select: { id: true } });
        const providerConversationId = "conv_attacker_first";
        let ownerBindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_attacker_first" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce: ownerBindingNonce,
                    durationSeconds: 11,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: "2", HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });
        const ownerMint = await mintVoiceLeaseWithBindingNonce(app, owner.id, "s-owner-attacker-first");
        const attackerMint = await mintVoiceLeaseWithBindingNonce(app, attacker.id, "s-attacker-first");
        ownerBindingNonce = ownerMint.bindingNonce;

        const attackerStart = await bindVoiceSession(app, attacker.id, attackerMint.leaseId, providerConversationId);
        expect(attackerStart.statusCode).toBe(200);

        const attackerComplete = await completeVoiceSession(app, attacker.id, attackerMint.leaseId, providerConversationId);
        expect(attackerComplete.statusCode).toBe(404);

        const ownerComplete = await completeVoiceSession(app, owner.id, ownerMint.leaseId, providerConversationId);
        expect(ownerComplete.statusCode).toBe(200);
        expect(ownerComplete.json()).toEqual({ ok: true, durationSeconds: 11 });

        const row = await db.voiceConversation.findUnique({
            where: {
                providerId_providerConversationKey: {
                    providerId: "elevenlabs_agents",
                    providerConversationKey: deriveVoiceProviderConversationKey({
                        providerId: "elevenlabs_agents",
                        providerConversationId,
                    }),
                },
            },
            select: { accountId: true, leaseId: true },
        });
        expect(row).toEqual({ accountId: owner.id, leaseId: ownerMint.leaseId });
    });

    it("allows concurrent start associations and leaves ownership to nonce-verified completion", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-concurrent-binding" }, select: { id: true } });
        const providerConversationId = "conv_concurrent_binding";

        harness.resetEnv({ VOICE_MAX_CONCURRENT_SESSIONS: "2", HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "100" });
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_concurrent_binding" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const firstLeaseId = await mintVoiceLease(app, user.id, "s-concurrent-1");
        const secondLeaseId = await mintVoiceLease(app, user.id, "s-concurrent-2");
        const results = await Promise.all([
            bindVoiceSession(app, user.id, firstLeaseId, providerConversationId),
            bindVoiceSession(app, user.id, secondLeaseId, providerConversationId),
        ]);

        expect(results.map((result) => result.statusCode).sort()).toEqual([200, 200]);
    });

    it("rejects blank, invalid-Unicode, or oversized opaque ids at the voice lifecycle boundary", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-lifecycle-validation" }, select: { id: true } });
        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const blankStart = await bindVoiceSession(app, user.id, "lease_validation", "   ");
        expect(blankStart.statusCode).toBe(400);

        const oversizedProviderConversationId = "c".repeat(513);
        const oversizedStart = await bindVoiceSession(app, user.id, "lease_validation", oversizedProviderConversationId);
        expect(oversizedStart.statusCode).toBe(400);

        const invalidUnicodeStart = await bindVoiceSession(app, user.id, "lease_validation", "conv_\ud800");
        expect(invalidUnicodeStart.statusCode).toBe(400);

        const blankComplete = await completeVoiceSession(app, user.id, "lease_validation", "   ");
        expect(blankComplete.statusCode).toBe(400);

        const oversizedComplete = await completeVoiceSession(app, user.id, "lease_validation", oversizedProviderConversationId);
        expect(oversizedComplete.statusCode).toBe(400);

        const oversizedSession = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "🙂".repeat(513) },
        });
        expect(oversizedSession.statusCode).toBe(400);

        const blankSession = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "   " },
        });
        expect(blankSession.statusCode).toBe(400);

        const invalidUnicodeSession = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "session_\udfff" },
        });
        expect(invalidUnicodeSession.statusCode).toBe(400);
    });

    it("preserves max-length multibyte session and provider identifiers with a digest identity", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-max-opaque-identifiers" }, select: { id: true } });
        const sessionId = "🙂".repeat(512);
        const providerConversationId = ` ${"界".repeat(510)} `;
        let bindingNonce = "";

        expect([...sessionId]).toHaveLength(512);
        expect([...providerConversationId]).toHaveLength(512);
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_max_opaque" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${encodeURIComponent(providerConversationId)}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 8,
                })), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const minted = await mintVoiceLeaseWithBindingNonce(app, user.id, sessionId);
        bindingNonce = minted.bindingNonce;
        expect(await db.voiceSessionLease.findUnique({
            where: { id: minted.leaseId },
            select: { sessionId: true },
        })).toEqual({ sessionId });

        const completed = await completeVoiceSession(app, user.id, minted.leaseId, providerConversationId);
        expect(completed.statusCode).toBe(200);
        expect(await db.voiceConversation.findUnique({
            where: { leaseId: minted.leaseId },
            select: { providerConversationId: true, providerConversationKey: true },
        })).toEqual({
            providerConversationId,
            providerConversationKey: deriveVoiceProviderConversationKey({
                providerId: "elevenlabs_agents",
                providerConversationId,
            }),
        });
    });

    it("allows a new token immediately after completion when max concurrent sessions is 1", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-u4" }, select: { id: true } });
        const providerConversationId = "conv_456";
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_reuse" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: providerConversationId,
                    bindingNonce,
                    durationSeconds: 5,
                })), { status: 200 });
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
        const firstTokenJson = firstTokenRes.json() as any;
        const firstLeaseId = firstTokenJson.leaseId as string;
        bindingNonce = firstTokenJson.bindingNonce as string;
        const startRes = await bindVoiceSession(app, user.id, firstLeaseId, providerConversationId);
        expect(startRes.statusCode).toBe(200);

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
                return new Response(JSON.stringify(providerConversationDetails({
                    conversationId: "conv_wrong_user",
                    bindingNonce: "nonce-wrong-user",
                    durationSeconds: 1,
                })), { status: 200 });
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
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_binding" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(
                    JSON.stringify({
                        conversation_id: providerConversationId,
                        agent_id: "agent_other",
                        metadata: { call_duration_secs: 4, start_time_unix_secs: Math.floor(Date.now() / 1000) },
                        conversation_initiation_client_data: {
                            dynamic_variables: {
                                [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: bindingNonce,
                            },
                        },
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
        const tokenJson = tokenRes.json() as any;
        const leaseId = tokenJson.leaseId as string;
        bindingNonce = tokenJson.bindingNonce as string;
        const startRes = await bindVoiceSession(app, user.id, leaseId, providerConversationId);
        expect(startRes.statusCode).toBe(200);

        const completeRes = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(completeRes.statusCode).toBe(404);
        expect(completeRes.json()).toEqual({ ok: false, reason: "not_found" });

        expect(await db.voiceConversation.count()).toBe(0);
        expect(await db.voiceSessionLease.findUnique({
            where: { id: leaseId },
            select: { providerId: true, providerConversationId: true, providerConversationKey: true },
        })).toEqual({ providerId: null, providerConversationId: null, providerConversationKey: null });
    });
});
