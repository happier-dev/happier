import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE } from "@happier-dev/protocol";
import { voiceRoutes } from "./voiceRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp(): any {
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

// A non-subscribed RevenueCat payload (no active entitlements) so mints are
// granted from the monthly free-session quota.
function notSubscribedPayload() {
    return { subscriber: { entitlements: { active: {} } } };
}

function subscribedPayload() {
    return { subscriber: { entitlements: { active: { voice: { expires_date: null } } } } };
}

describe("voiceRoutes (free-session quota is cleanup-independent, sqlite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-voice-freequota-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_VOICE__ENABLED: "true",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "true",
                REVENUECAT_SECRET_KEY: "rc-secret",
                VOICE_FREE_SESSIONS_PER_MONTH: "1",
                VOICE_FREE_MINUTES_PER_MONTH: "1",
                VOICE_MAX_CONCURRENT_SESSIONS: "5",
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
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await db.voiceConversation.deleteMany().catch(() => {});
        await db.voiceSessionLease.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("counts a completed free session toward the monthly quota even after its lease is pruned", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-freequota" }, select: { id: true } });
        const providerConversationId = "conv_freequota_1";
        let bindingNonce = "";

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(notSubscribedPayload()), { status: 200 });
            }
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_free" }), { status: 200 });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(
                    JSON.stringify({
                        conversation_id: providerConversationId,
                        agent_id: "agent_dev",
                        metadata: { call_duration_secs: 10, start_time_unix_secs: Math.floor(Date.now() / 1000) },
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

        // 1) Consume the single monthly free session and complete it so a
        //    durable VoiceConversation row is written.
        const firstMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s1" },
        });
        expect(firstMint.statusCode).toBe(200);
        const firstMintJson = firstMint.json() as any;
        const leaseId = firstMintJson.leaseId as string;
        bindingNonce = firstMintJson.bindingNonce as string;

        const start = await app.inject({
            method: "POST",
            url: "/v1/voice/session/start",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(start.statusCode).toBe(200);

        const complete = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(complete.statusCode).toBe(200);
        expect(await db.voiceConversation.count({ where: { accountId: user.id } })).toBe(1);

        // 2) Simulate the 24h opportunistic cleanup / retention rule pruning the
        //    expired lease. The lease row is gone; only the conversation remains.
        await db.voiceSessionLease.deleteMany({ where: { accountId: user.id } });
        expect(await db.voiceSessionLease.count({ where: { accountId: user.id } })).toBe(0);

        // 3) A second mint in the same month must be blocked: the consumed free
        //    session is counted from the durable VoiceConversation, not the
        //    pruned lease. Before the fix this returned 200 (quota bypass).
        const secondMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "s2" },
        });
        expect(secondMint.statusCode).toBe(403);
        expect(secondMint.json()).toMatchObject({ allowed: false, reason: "quota_exceeded" });
    });

    it("does not charge a completed subscription grant to free quota after its lease is pruned", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-subscription-quota" }, select: { id: true } });
        const providerConversationId = "conv_subscription_quota_1";
        let bindingNonce = "";
        let subscribed = true;

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(subscribed ? subscribedPayload() : notSubscribedPayload()), {
                    status: 200,
                });
            }
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: subscribed ? "conv_token_subscription" : "conv_token_free" }), {
                    status: 200,
                });
            }
            if (u.includes(`/v1/convai/conversations/${providerConversationId}`)) {
                return new Response(
                    JSON.stringify({
                        conversation_id: providerConversationId,
                        agent_id: "agent_dev",
                        metadata: { call_duration_secs: 10, start_time_unix_secs: Math.floor(Date.now() / 1000) },
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

        const subscriptionMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "subscription-session" },
        });
        expect(subscriptionMint.statusCode).toBe(200);
        const subscriptionMintJson = subscriptionMint.json() as any;
        const leaseId = subscriptionMintJson.leaseId as string;
        bindingNonce = subscriptionMintJson.bindingNonce as string;

        const start = await app.inject({
            method: "POST",
            url: "/v1/voice/session/start",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(start.statusCode).toBe(200);

        const complete = await app.inject({
            method: "POST",
            url: "/v1/voice/session/complete",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { leaseId, providerConversationId },
        });
        expect(complete.statusCode).toBe(200);
        expect(
            await db.voiceConversation.findUnique({
                where: { leaseId },
                select: { grantedBy: true },
            }),
        ).toEqual({ grantedBy: "subscription" });

        await db.voiceSessionLease.deleteMany({ where: { accountId: user.id } });
        expect(await db.voiceSessionLease.count({ where: { accountId: user.id } })).toBe(0);

        subscribed = false;
        const freeMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "free-session" },
        });
        expect(freeMint.statusCode).toBe(200);
        expect(freeMint.json()).toMatchObject({ allowed: true, token: "conv_token_free" });
    });

    it("does not infer a pruned legacy conversation with unknown provenance as a free grant", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-legacy-quota" }, select: { id: true } });
        await db.voiceConversation.create({
            data: {
                accountId: user.id,
                providerId: "legacy_provider",
                providerConversationId: "legacy_unknown_1",
                durationSeconds: 60,
                grantedBy: null,
            },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(notSubscribedPayload()), { status: 200 });
            }
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_free_after_legacy" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const freeMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "free-after-legacy" },
        });
        expect(freeMint.statusCode).toBe(200);
        expect(freeMint.json()).toMatchObject({ allowed: true, token: "conv_token_free_after_legacy" });
    });

    it("charges completed free-session and free-minute usage to its mint period rather than its completion month", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-08-01T00:10:00.000Z"));

        const user = await db.account.create({ data: { publicKey: "pk-voice-cross-month-quota" }, select: { id: true } });
        await db.voiceConversation.create({
            data: {
                accountId: user.id,
                providerId: "legacy_provider",
                providerConversationId: "cross_month_free_1",
                durationSeconds: 60,
                grantedBy: "free",
                grantPeriodKey: "2026-07",
                createdAt: new Date("2026-08-01T00:01:00.000Z"),
            },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(notSubscribedPayload()), { status: 200 });
            }
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token_august_free" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const augustMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "august-free-session" },
        });
        expect(augustMint.statusCode).toBe(200);
        expect(augustMint.json()).toMatchObject({ allowed: true, token: "conv_token_august_free" });
    });

    it("uses an older writer's retained lease as exact free-grant provenance", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-legacy-free-quota" }, select: { id: true } });
        const now = new Date();
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: user.id,
                periodKey: now.toISOString().slice(0, 7),
                grantedBy: "free",
                elevenLabsAgentId: "agent_dev",
                expiresAt: new Date(now.getTime() + 60_000),
            },
            select: { id: true },
        });
        await db.voiceConversation.create({
            data: {
                accountId: user.id,
                leaseId: lease.id,
                providerId: "legacy_provider",
                providerConversationId: "legacy_free_1",
                durationSeconds: 60,
                grantedBy: null,
            },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(notSubscribedPayload()), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const freeMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "free-after-legacy-free" },
        });
        expect(freeMint.statusCode).toBe(403);
        expect(freeMint.json()).toMatchObject({ allowed: false, reason: "quota_exceeded" });
    });

    it("does not prune an older writer's only exact free-grant provenance before quota accounting", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));

        const user = await db.account.create({ data: { publicKey: "pk-voice-legacy-free-cleanup" }, select: { id: true } });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: user.id,
                periodKey: "2026-07",
                grantedBy: "free",
                elevenLabsAgentId: "agent_dev",
                createdAt: new Date("2026-07-27T10:00:00.000Z"),
                expiresAt: new Date("2026-07-27T10:01:00.000Z"),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: user.id,
                leaseId: lease.id,
                providerId: "legacy_provider",
                providerConversationId: "legacy_free_cleanup_1",
                durationSeconds: 60,
                grantedBy: null,
                createdAt: new Date("2026-07-27T10:01:00.000Z"),
            },
            select: { id: true },
        });

        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes("api.revenuecat.com")) {
                return new Response(JSON.stringify(notSubscribedPayload()), { status: 200 });
            }
            if (u.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "unexpected_quota_bypass_token" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${u}`);
        }) as any);

        const app = createTestApp();
        voiceRoutes(app as any);
        await app.ready();

        const freeMint = await app.inject({
            method: "POST",
            url: "/v1/voice/token",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { sessionId: "free-after-legacy-cleanup" },
        });

        expect(freeMint.statusCode).toBe(403);
        expect(freeMint.json()).toMatchObject({ allowed: false, reason: "quota_exceeded" });
        const retained = await db.voiceConversation.findUnique({
            where: { id: conversation.id },
            select: { grantedBy: true, leaseId: true },
        });
        expect(retained).toEqual({ grantedBy: "free", leaseId: null });
    });
});
