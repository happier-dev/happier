import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const sendApnsRequest = vi.fn();

vi.mock("@/app/activity/liveActivities/providers/apnsLiveActivityHttp2Sender", () => ({
    sendApnsLiveActivityHttp2Request: sendApnsRequest,
}));

async function loadRoutesModule() {
    return import("./liveActivityHostedRelayRoutes").catch(() => null);
}

const { trackApp, closeTrackedApps } = createAppCloseTracker();

async function createTestApp() {
    const routes = await loadRoutesModule();
    expect(routes).not.toBeNull();
    if (!routes) throw new Error("liveActivityHostedRelayRoutes module is missing");

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    routes.liveActivityHostedRelayRoutes(typed);
    return trackApp(typed);
}

function resetHostedRelayEnv(extra: NodeJS.ProcessEnv = {}) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED", "1");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS", "relay-access-key");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS", "999999999999");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID", "TEAMID1234");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID", "KEYID1234");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY", privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS", "dev.happier.app");
    vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT", "sandbox");
    for (const [key, value] of Object.entries(extra)) {
        vi.stubEnv(key, value);
    }
}

function createUpdate(extra: Record<string, unknown> = {}) {
    const now = 1_800_000_000_000;
    return {
        v: 1,
        requestId: "relay-update-1",
        createdAt: now,
        transportMode: "hosted_happier_relay",
        activityKey: {
            serverId: "server-1",
            sessionId: "session-1",
            activityName: "HappierFocusLiveActivity",
        },
        snapshotFingerprint: "fp-relay-1",
        event: "update",
        contentState: {
            version: 1,
            generatedAt: now,
            staleAt: now + 30_000,
            sessionId: "session-1",
            title: "Working",
            subtitle: null,
            previewText: null,
            statusText: "Thinking",
            attentionState: "thinking",
            defaultTarget: "happier://inbox",
            sessionTarget: "happier://session/server-1/session-1",
            overflowCount: 0,
            totalAttentionCount: 1,
            allowActionButtons: false,
            labels: {
                title: "Happier",
                openLabel: "Open",
                inboxLabel: "Inbox",
                attentionLabel: "Attention",
            },
        },
        ...extra,
    };
}

function createRelayPayload(extra: Record<string, unknown> = {}) {
    const requestId = typeof extra.requestId === "string" ? extra.requestId : "relay-request-1";
    const createdAt = typeof extra.createdAt === "number" ? extra.createdAt : 1_800_000_000_000;
    const update = extra.update ?? createUpdate({ requestId, createdAt });
    return {
        v: 1,
        requestId,
        createdAt,
        bundleId: "dev.happier.app",
        environment: "sandbox",
        activityName: "HappierFocusLiveActivity",
        activityId: "activity-1",
        activityKitUpdateToken: "activitykit-update-token",
        update,
        ...extra,
    };
}

describe("liveActivityHostedRelayRoutes (integration)", () => {
    afterEach(async () => {
        await closeTrackedApps();
        vi.unstubAllEnvs();
        sendApnsRequest.mockReset();
    });

    it("derives APNs liveactivity headers and coalesces duplicate relay requests", async () => {
        resetHostedRelayEnv();
        sendApnsRequest.mockResolvedValue({ status: 200, apnsId: "apns-relay-1" });
        const app = await createTestApp();

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload(),
        });
        const duplicate = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload(),
        });

        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({
            success: true,
            status: "sent",
            classification: { action: "success" },
            apnsId: "apns-relay-1",
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toMatchObject({
            success: true,
            status: "coalesced",
            duplicate: true,
        });
        expect(sendApnsRequest).toHaveBeenCalledTimes(1);
        const apnsRequest = sendApnsRequest.mock.calls[0]?.[0];
        expect(apnsRequest).toMatchObject({
            deviceToken: "activitykit-update-token",
            headers: {
                "apns-push-type": "liveactivity",
                "apns-topic": "dev.happier.app.push-type.liveactivity",
            },
        });
        expect(apnsRequest.headers).not.toHaveProperty("apns-header-from-caller");
        expect(JSON.stringify(first.json())).not.toContain("activitykit-update-token");
    });

    it("rejects duplicate relay request ids when the replayed envelope changes", async () => {
        resetHostedRelayEnv();
        sendApnsRequest.mockResolvedValue({ status: 200, apnsId: "apns-relay-replay" });
        const app = await createTestApp();
        const firstPayload = createRelayPayload({ requestId: "relay-request-replay-conflict" });
        const changedPayload = createRelayPayload({
            requestId: "relay-request-replay-conflict",
            update: createUpdate({
                requestId: "relay-request-replay-conflict",
                snapshotFingerprint: "fp-relay-conflicting-replay",
            }),
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: firstPayload,
        });
        const replay = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: changedPayload,
        });

        expect(first.statusCode).toBe(200);
        expect(replay.statusCode).toBe(409);
        expect(replay.json()).toMatchObject({
            success: false,
            status: "failed",
            code: "live_activity_hosted_relay_replay_conflict",
        });
        expect(JSON.stringify(replay.json())).not.toContain("activitykit-update-token");
        expect(sendApnsRequest).toHaveBeenCalledTimes(1);
    });

    it("requires exact relay access-key matches across configured keys", async () => {
        resetHostedRelayEnv({
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: "primary-key,relay-access-key,secondary-key",
        });
        sendApnsRequest.mockResolvedValue({ status: 200, apnsId: "apns-relay-key" });
        const app = await createTestApp();

        const partial = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access" },
            payload: createRelayPayload({ requestId: "relay-key-partial" }),
        });
        const secondKey = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer secondary-key" },
            payload: createRelayPayload({ requestId: "relay-key-secondary" }),
        });

        expect(partial.statusCode).toBe(401);
        expect((partial.json() as any).code).toBe("live_activity_hosted_relay_unauthorized");
        expect(secondKey.statusCode).toBe(200);
        expect(secondKey.json()).toMatchObject({
            success: true,
            status: "sent",
            apnsId: "apns-relay-key",
        });
        expect(sendApnsRequest).toHaveBeenCalledTimes(1);
    });

    it("rejects caller-supplied APNs headers before APNs send", async () => {
        resetHostedRelayEnv();
        const app = await createTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({
                apnsHeaders: {
                    "apns-push-type": "alert",
                    "apns-topic": "com.attacker.app",
                },
            }),
        });

        expect(response.statusCode).toBe(400);
        expect((response.json() as any).code).toBe("live_activity_hosted_relay_invalid");
        expect(sendApnsRequest).not.toHaveBeenCalled();
    });

    it("rejects relay envelopes whose request identity does not match the inner update", async () => {
        resetHostedRelayEnv();
        const app = await createTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({
                requestId: "outer-request",
                createdAt: 1_800_000_000_000,
                update: createUpdate({
                    requestId: "inner-request",
                    createdAt: 1_799_999_000_000,
                }),
            }),
        });

        expect(response.statusCode).toBe(400);
        expect((response.json() as any).code).toBe("live_activity_hosted_relay_invalid");
        expect(sendApnsRequest).not.toHaveBeenCalled();
    });

    it("rejects unallowlisted bundles and stale relay requests before APNs send", async () => {
        resetHostedRelayEnv({
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: "60000",
        });
        const app = await createTestApp();

        const badBundle = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({ bundleId: "com.attacker.app", createdAt: Date.now() }),
        });
        const stale = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({ requestId: "relay-request-stale", createdAt: 1 }),
        });

        expect(badBundle.statusCode).toBe(403);
        expect((badBundle.json() as any).code).toBe("live_activity_hosted_relay_bundle_not_allowed");
        expect(stale.statusCode).toBe(409);
        expect((stale.json() as any).code).toBe("live_activity_hosted_relay_stale");
        expect(sendApnsRequest).not.toHaveBeenCalled();
    });

    it("returns a sanitized transient failure when APNs transport throws", async () => {
        resetHostedRelayEnv();
        sendApnsRequest.mockRejectedValueOnce(new Error("apns connection reset"));
        const app = await createTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({
                requestId: "relay-request-apns-transport",
                activityKitUpdateToken: "activitykit-transport-error-token",
            }),
        });

        expect(response.statusCode).toBe(502);
        expect(response.json()).toMatchObject({
            success: false,
            status: "failed",
            classification: {
                action: "transient_retry",
                reason: "apns_transport_error",
            },
            code: "live_activity_hosted_relay_apns_transport_error",
        });
        expect(JSON.stringify(response.json())).not.toContain("activitykit-transport-error-token");
        expect(sendApnsRequest).toHaveBeenCalledTimes(1);
    });

    it("returns a sanitized APNs configuration failure for malformed hosted-relay private keys", async () => {
        resetHostedRelayEnv({
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-p8-key\n-----END PRIVATE KEY-----",
        });
        const app = await createTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-hosted-relay",
            headers: { authorization: "Bearer relay-access-key" },
            payload: createRelayPayload({
                requestId: "relay-request-invalid-key",
                activityKitUpdateToken: "activitykit-invalid-key-token",
            }),
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            code: "live_activity_hosted_relay_apns_unavailable",
            diagnostics: expect.arrayContaining(["apns_private_key_must_be_p8_token_key"]),
        });
        expect(JSON.stringify(response.json())).not.toContain("activitykit-invalid-key-token");
        expect(sendApnsRequest).not.toHaveBeenCalled();
    });
});
