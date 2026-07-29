import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import { voiceRoutes } from "./voiceRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

// The mint endpoints key the rate limit by verified user id with an IP
// fallback. The unverifiable test bearer token falls back to the request IP,
// which `app.inject` keeps constant — so both endpoints are keyed identically
// for the single simulated caller. This isolates the question under test: do
// /v1/voice/token and /v1/voice/lease/mint share ONE budget or two?
async function createTestApp(userId: string): Promise<any> {
    const app = Fastify();
    await app.register(fastifyRateLimit, resolveApiRateLimitPluginOptions(process.env));
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, _reply: any) => {
        request.userId = userId;
    });

    voiceRoutes(typed as any);
    await app.ready();
    return trackApp(typed);
}

describe("voiceRoutes (cross-endpoint rate limit, sqlite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-voice-rl-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_VOICE__ENABLED: "true",
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "false",
                VOICE_MAX_CONCURRENT_SESSIONS: "100",
                VOICE_MAX_SESSION_SECONDS: "60",
                ELEVENLABS_API_KEY: "elevenlabs-key",
                ELEVENLABS_AGENT_ID: "agent_dev",
                HAPPIER_API_RATE_LIMITS_ENABLED: "true",
                // Tight per-user budget so the bucket exhausts within the test.
                HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "2",
                HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "1 minute",
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

    function stubMintFetch() {
        vi.stubGlobal("fetch", vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("/v1/convai/conversation/token")) {
                return new Response(JSON.stringify({ token: "conv_token" }), { status: 200 });
            }
            throw new Error(`unexpected fetch url: ${String(url)}`);
        }) as any);
    }

    async function mint(app: any, url: "/v1/voice/token" | "/v1/voice/lease/mint", userId: string) {
        return app.inject({
            method: "POST",
            url,
            headers: { "content-type": "application/json", authorization: "Bearer tkn", "x-test-user-id": userId },
            payload: {},
        });
    }

    // A throttled mint returns 429 with the route's `{ allowed:false, reason }`
    // contract (served by the shared lease-chokepoint throttle, and by the
    // per-route plugin via its errorResponseBuilder).
    function expectThrottled(res: { statusCode: number; json: () => unknown }) {
        expect(res.statusCode).toBe(429);
        expect(res.json()).toMatchObject({ allowed: false, reason: "too_many_sessions" });
    }

    it("shares one rate-limit budget across /v1/voice/token and /v1/voice/lease/mint for a single user", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-voice-rl" }, select: { id: true } });
        stubMintFetch();
        const app = await createTestApp(user.id);

        // Exhaust the shared budget (max=2) on the canonical mint endpoint.
        expect((await mint(app, "/v1/voice/token", user.id)).statusCode).toBe(200);
        expect((await mint(app, "/v1/voice/token", user.id)).statusCode).toBe(200);
        expectThrottled(await mint(app, "/v1/voice/token", user.id));

        // The alias mints the SAME resource (a voice lease + token). With a
        // shared per-user budget the alias must ALSO be throttled for this user.
        // If it still minted (200) the budget would be per-endpoint and the user
        // could mint 2x the intended tokens by alternating endpoints.
        expectThrottled(await mint(app, "/v1/voice/lease/mint", user.id));
    });
});
