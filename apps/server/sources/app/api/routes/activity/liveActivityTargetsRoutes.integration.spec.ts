import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

async function loadRoutesModule() {
    return import("./liveActivityTargetsRoutes").catch(() => null);
}

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function getLiveActivityTargetDelegate() {
    return (db as unknown as {
        accountLiveActivityTarget?: {
            deleteMany: () => Promise<unknown>;
            count: () => Promise<number>;
        };
    }).accountLiveActivityTarget;
}

function redactBytes(value: Uint8Array | Buffer | null): string {
    if (!value) return "";
    return Buffer.from(value).toString("utf8");
}

function createP8PrivateKey(): string {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

async function createTestApp() {
    const routes = await loadRoutesModule();
    expect(routes).not.toBeNull();
    if (!routes) throw new Error("liveActivityTargetsRoutes module is missing");

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    enableAuthentication(typed);
    routes.liveActivityTargetsRoutes(typed);
    return trackApp(typed);
}

type RouteErrorResponse = Readonly<{
    code?: string;
    error?: unknown;
}>;

type LiveActivityTargetResponse = Readonly<{
    target: Record<string, unknown>;
}>;

type LiveActivityTargetsResponse = Readonly<{
    targets: readonly Record<string, unknown>[];
}>;

function responseJson<T>(response: { json: () => unknown }): T {
    return response.json() as T;
}

async function createAccountToken(publicKey: string) {
    const account = await db.account.create({ data: { publicKey } });
    const token = await auth.createToken(account.id);
    const session = await db.session.create({
        data: {
            id: `${publicKey}-session`,
            tag: `${publicKey}-session`,
            accountId: account.id,
            metadata: "{}",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
        },
    });
    return { account, token, session };
}

describe("liveActivityTargetsRoutes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-live-activity-target-routes-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await getLiveActivityTargetDelegate()?.deleteMany();
        await db.accountPushToken.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("stores direct APNs ActivityKit targets separately from Expo push tokens and redacts secrets", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: createP8PrivateKey(),
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        });
        const app = await createTestApp();
        const { token, session } = await createAccountToken("pk_live_activity_routes_1");

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "direct_apns",
                bundleId: "dev.happier.custom",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawToken: "raw-activitykit-token",
            },
        });

        expect(post.statusCode).toBe(200);
        expect(await db.accountPushToken.count()).toBe(0);
        expect(await getLiveActivityTargetDelegate()?.count()).toBe(1);
        expect(JSON.stringify(post.json())).not.toContain("raw-activitykit-token");

        const get = await app.inject({
            method: "GET",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(get.statusCode).toBe(200);
        expect(JSON.stringify(get.json())).not.toContain("raw-activitykit-token");
        expect(responseJson<LiveActivityTargetsResponse>(get).targets[0]).toMatchObject({
            transportMode: "direct_apns",
            tokenKind: "activitykit_update_token",
            hasRawToken: true,
        });
    });

    it("rejects Expo push tokens on the direct APNs target path", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "direct_apns",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: createP8PrivateKey(),
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        });
        const app = await createTestApp();
        const { token, session } = await createAccountToken("pk_live_activity_routes_2");

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "direct_apns",
                bundleId: "dev.happier.custom",
                environment: "sandbox",
                tokenKind: "expo_push_token",
                rawToken: "ExponentPushToken[abc]",
            },
        });

        expect(post.statusCode).toBe(400);
        expect(responseJson<RouteErrorResponse>(post).code).toBe("live_activity_invalid_target_kind");
        expect(await getLiveActivityTargetDelegate()?.count()).toBe(0);
    });

    it("rejects direct APNs target registration when direct APNs is not the resolved server mode", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "local_only",
            HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "TEAMID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: "KEYID1234",
            HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: createP8PrivateKey(),
            HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "dev.happier.custom",
            HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: "sandbox",
        });
        const app = await createTestApp();
        const { token, session } = await createAccountToken("pk_live_activity_routes_mode");

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "direct_apns",
                bundleId: "dev.happier.custom",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawToken: "raw-activitykit-token",
            },
        });

        expect(post.statusCode).toBe(409);
        expect(responseJson<RouteErrorResponse>(post).code).toBe("live_activity_transport_unavailable");
        expect(await getLiveActivityTargetDelegate()?.count()).toBe(0);
    });

    it("rejects background wake target registration when background wake is not the resolved server mode", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "local_only",
            HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: "1",
        });
        const app = await createTestApp();
        const { account, token, session } = await createAccountToken("pk_live_activity_routes_bg_mode");
        await db.accountPushToken.create({
            data: {
                accountId: account.id,
                token: "ExponentPushToken[background-wake]",
            },
        });

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "background_wake_best_effort",
                tokenKind: "expo_push_token",
                expoPushToken: "ExponentPushToken[background-wake]",
            },
        });

        expect(post.statusCode).toBe(409);
        expect(responseJson<RouteErrorResponse>(post).code).toBe("live_activity_transport_unavailable");
        expect(await getLiveActivityTargetDelegate()?.count()).toBe(0);
    });

    it("stores hosted relay ActivityKit update tokens encrypted on the selected server", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
        });
        const app = await createTestApp();
        const { token, session } = await createAccountToken("pk_live_activity_routes_hosted_token");

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawToken: "hosted-relay-activitykit-token",
            },
        });

        expect(post.statusCode).toBe(200);
        expect(JSON.stringify(post.json())).not.toContain("hosted-relay-activitykit-token");
        const stored = await db.accountLiveActivityTarget.findFirstOrThrow({
            where: { sessionId: session.id, transportMode: "hosted_happier_relay" },
        });
        expect(stored.rawTokenEncrypted).toBeTruthy();
        expect(stored).not.toHaveProperty("hostedRelayTargetId");
        expect(stored).not.toHaveProperty("hostedRelayCapabilityEncrypted");
        expect(redactBytes(stored.rawTokenEncrypted)).not.toContain("hosted-relay-activitykit-token");
        const responseTarget = responseJson<LiveActivityTargetResponse>(post).target;
        expect(responseTarget).toMatchObject({
            transportMode: "hosted_happier_relay",
            tokenKind: "activitykit_update_token",
            hasRawToken: true,
        });
        expect(responseTarget).not.toHaveProperty("hostedRelayTargetId");
        expect(responseTarget).not.toHaveProperty("hasHostedRelayCapability");
    });

    it("rejects opaque hosted relay capability fields instead of accepting unused future contracts", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: "1",
            HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: "hosted_happier_relay",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: "1",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: "https://relay.happier.dev",
            HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "relay-access-key",
        });
        const app = await createTestApp();
        const { token, session } = await createAccountToken("pk_live_activity_routes_3");

        const post = await app.inject({
            method: "POST",
            url: "/v1/live-activity-targets",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: session.id,
                activityInstanceKey: `server-1:HappierFocusLiveActivity:${session.id}`,
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawToken: "hosted-relay-activitykit-token",
                hostedRelayTargetId: "relay-target-1",
                hostedRelayCapability: "relay-capability-secret",
            },
        });

        expect(post.statusCode).toBe(400);
        expect(responseJson<RouteErrorResponse>(post).code).toBe("live_activity_target_invalid");
    });
});
