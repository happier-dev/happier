import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { encryptLiveActivityTargetSecret } from "@/app/activity/liveActivities/providers/directApnsLiveActivityProvider";
import { createP8PrivateKey } from "@/app/activity/liveActivities/providers/directApnsLiveActivityProvider.testkit";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (_messages: unknown[]) => [{ status: "ok" }]));
const sendApnsLiveActivityHttp2RequestSpy = vi.hoisted(() => vi.fn(async () => ({
    status: 200,
    apnsId: "apns-route-direct",
})));

vi.mock("expo-server-sdk", () => {
    class Expo {
        static isExpoPushToken(token: unknown) {
            return typeof token === "string" && token.startsWith("ExponentPushToken[");
        }
        chunkPushNotifications(messages: unknown[]) {
            return [messages];
        }
        async sendPushNotificationsAsync(chunk: unknown[]) {
            return await sendPushNotificationsAsyncSpy(chunk);
        }
    }
    return { Expo };
});

vi.mock("@/app/activity/liveActivities/providers/apnsLiveActivityHttp2Sender", () => ({
    sendApnsLiveActivityHttp2Request: sendApnsLiveActivityHttp2RequestSpy,
}));

async function loadRoutesModule() {
    return import("./liveActivityRemoteUpdateRoutes").catch(() => null);
}

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function getLiveActivityTargetDelegate() {
    return (db as unknown as {
        accountLiveActivityTarget?: {
            deleteMany: () => Promise<unknown>;
        };
    }).accountLiveActivityTarget;
}

async function createTestApp() {
    const routes = await loadRoutesModule();
    expect(routes).not.toBeNull();
    if (!routes) throw new Error("liveActivityRemoteUpdateRoutes module is missing");

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    routes.liveActivityRemoteUpdateRoutes(typed);
    return trackApp(typed);
}

function createPayload(extra: Record<string, unknown> = {}) {
    const now = 1_800_000_000_000;
    return {
        v: 1,
        requestId: "req-route-1",
        createdAt: now,
        transportMode: "hosted_happier_relay",
        activityKey: {
            serverId: "server-1",
            sessionId: "session-1",
            activityName: "HappierFocusLiveActivity",
        },
        snapshotFingerprint: "fp-route-1",
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

describe("liveActivityRemoteUpdateRoutes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-live-activity-update-routes-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        sendPushNotificationsAsyncSpy.mockReset();
        sendPushNotificationsAsyncSpy.mockResolvedValue([{ status: "ok" }]);
        sendApnsLiveActivityHttp2RequestSpy.mockReset();
        sendApnsLiveActivityHttp2RequestSpy.mockResolvedValue({
            status: 200,
            apnsId: "apns-route-direct",
        });
        await getLiveActivityTargetDelegate()?.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("rejects caller-supplied APNs transport fields before any relay/provider send", async () => {
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route" } });
        const token = await auth.createToken(account.id);

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({
                "apns-topic": "com.attacker.app",
                apnsHeaders: {
                    "apns-push-type": "alert",
                },
            }),
        });

        expect(response.statusCode).toBe(400);
        expect((response.json() as any).code).toBe("live_activity_remote_update_invalid");
    });

    it("blocks direct APNs dispatch when direct APNs is not the resolved server mode", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "local_only",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        });
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_mode" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-mode",
                transportMode: "direct_apns",
                bundleId: "dev.happier.custom",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
            },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "direct_apns" }),
        });

        expect(response.statusCode).toBe(200);
        expect((response.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "failed",
                code: "live_activity_transport_unavailable",
            }),
        ]);
    });

    it("blocks background wake dispatch when background wake is not the resolved server mode", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "local_only",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "1",
        });
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_bg_mode" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-bg-mode",
                transportMode: "background_wake_best_effort",
                tokenKind: "expo_push_token",
                expoPushToken: "not-an-expo-token",
            },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "background_wake_best_effort" }),
        });

        expect(response.statusCode).toBe(200);
        expect((response.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "failed",
                code: "live_activity_transport_unavailable",
            }),
        ]);
    });

    it("decrypts selected-server hosted relay tokens only for outbound relay dispatch", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
        });
        const fetchMock = vi.fn<(_input: unknown, _init?: { body?: unknown; headers?: unknown }) => Promise<Response>>(async () => new Response(JSON.stringify({
            success: true,
            status: "sent",
            classification: { action: "success" },
            apnsId: "apns-hosted-1",
            tokenFingerprint: "activitykit:abc123",
        }), { status: 200, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_hosted" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-hosted",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityId: "activity-1",
                    field: "rawToken",
                    value: "hosted-relay-activitykit-token",
                }),
            },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "hosted_happier_relay" }),
        });

        expect(response.statusCode).toBe(200);
        expect((response.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "sent",
                tokenFingerprint: "activitykit:abc123",
            }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const outboundCall = fetchMock.mock.calls[0];
        if (!outboundCall) throw new Error("Expected hosted relay fetch call");
        const outboundInit = outboundCall[1];
        if (!outboundInit) throw new Error("Expected hosted relay fetch init");
        const outboundBody = JSON.parse(String(outboundInit.body));
        expect(outboundBody.activityKitUpdateToken).toBe("hosted-relay-activitykit-token");
        expect(outboundBody.update.requestId).toBe("req-route-1");
        expect(outboundInit.headers).toMatchObject({
            authorization: "Bearer relay-access-key",
        });
        const updated = await db.accountLiveActivityTarget.findFirstOrThrow({
            where: { accountId: account.id, transportMode: "hosted_happier_relay" },
        });
        expect(updated.lastPushedAt).toBeTruthy();
        expect(JSON.stringify(updated.diagnostics)).not.toContain("hosted-relay-activitykit-token");
        expect(JSON.stringify(response.json())).not.toContain("hosted-relay-activitykit-token");
    });

    it("coalesces duplicate selected-server hosted relay updates before outbound relay dispatch", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: "30000",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
        });
        const fetchMock = vi.fn<(_input: unknown, _init?: { body?: unknown; headers?: unknown }) => Promise<Response>>(async () => new Response(JSON.stringify({
            success: true,
            status: "sent",
            classification: { action: "success" },
            apnsId: "apns-hosted-dedupe",
            tokenFingerprint: "activitykit:dedupe",
        }), { status: 200, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_hosted_dedupe" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-hosted-dedupe",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityId: "activity-1",
                    field: "rawToken",
                    value: "hosted-relay-activitykit-token",
                }),
            },
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "hosted_happier_relay" }),
        });
        const duplicate = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "hosted_happier_relay" }),
        });

        expect(first.statusCode).toBe(200);
        expect(duplicate.statusCode).toBe(200);
        expect((first.json() as any).deliveries).toEqual([
            expect.objectContaining({ status: "sent" }),
        ]);
        expect((duplicate.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "coalesced",
                duplicate: true,
                reason: "duplicate_payload",
            }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const updated = await db.accountLiveActivityTarget.findFirstOrThrow({
            where: { accountId: account.id, transportMode: "hosted_happier_relay" },
        });
        expect(updated.lastPayloadHash).toBe("fp-route-1");
        expect(updated.lastPushedAt).toBeTruthy();
    });

    it("coalesces duplicate selected-server direct APNs updates before outbound APNs dispatch", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: "30000",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: createP8PrivateKey(),
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        });
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_direct_dedupe" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-direct-dedupe",
                transportMode: "direct_apns",
                bundleId: "dev.happier.custom",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityId: "activity-1",
                    field: "rawToken",
                    value: "direct-apns-activitykit-token",
                }),
            },
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "direct_apns" }),
        });
        const duplicate = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "direct_apns" }),
        });

        expect(first.statusCode).toBe(200);
        expect(duplicate.statusCode).toBe(200);
        expect((first.json() as any).deliveries).toEqual([
            expect.objectContaining({ status: "sent" }),
        ]);
        expect((duplicate.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "coalesced",
                duplicate: true,
                reason: "duplicate_payload",
            }),
        ]);
        expect(sendApnsLiveActivityHttp2RequestSpy).toHaveBeenCalledTimes(1);
        const updated = await db.accountLiveActivityTarget.findFirstOrThrow({
            where: { accountId: account.id, transportMode: "direct_apns" },
        });
        expect(updated.lastPayloadHash).toBe("fp-route-1");
        expect(updated.lastPushedAt).toBeTruthy();
    });

    it("persists background wake fingerprints and coalesces duplicate selected-server updates", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "background_wake_best_effort",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: "30000",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "1",
        });
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_bg_dedupe" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-bg-dedupe",
                transportMode: "background_wake_best_effort",
                tokenKind: "expo_push_token",
                expoPushToken: "ExponentPushToken[wake]",
            },
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "background_wake_best_effort" }),
        });
        const duplicate = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "background_wake_best_effort" }),
        });

        expect(first.statusCode).toBe(200);
        expect(duplicate.statusCode).toBe(200);
        expect((first.json() as any).deliveries).toEqual([
            expect.objectContaining({ status: "sent_best_effort" }),
        ]);
        expect((duplicate.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "coalesced",
                duplicate: true,
                reason: "duplicate_payload",
            }),
        ]);
        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
        const updated = await db.accountLiveActivityTarget.findFirstOrThrow({
            where: { accountId: account.id, transportMode: "background_wake_best_effort" },
        });
        expect(updated.lastPayloadHash).toBe("fp-route-1");
        expect(updated.lastPushedAt).toBeTruthy();
        expect(updated.failureCount).toBe(0);
        expect(updated.lastFailureCode).toBeNull();
    });

    it("throttles non-identical background wake updates inside the configured per-target interval", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "background_wake_best_effort",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: "60000",
        });
        const app = await createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_live_activity_update_route_bg_throttle" } });
        const token = await auth.createToken(account.id);
        await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-route-bg-throttle",
                transportMode: "background_wake_best_effort",
                tokenKind: "expo_push_token",
                expoPushToken: "ExponentPushToken[wake]",
            },
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({ transportMode: "background_wake_best_effort" }),
        });
        const throttled = await app.inject({
            method: "POST",
            url: "/v1/live-activity-remote-updates",
            headers: { authorization: `Bearer ${token}` },
            payload: createPayload({
                requestId: "req-route-2",
                transportMode: "background_wake_best_effort",
                snapshotFingerprint: "fp-route-2",
            }),
        });

        expect(first.statusCode).toBe(200);
        expect(throttled.statusCode).toBe(200);
        expect((first.json() as any).deliveries).toEqual([
            expect.objectContaining({ status: "sent_best_effort" }),
        ]);
        expect((throttled.json() as any).deliveries).toEqual([
            expect.objectContaining({
                status: "throttled",
                throttled: true,
                reason: "background_wake_min_interval",
            }),
        ]);
        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    });
});
