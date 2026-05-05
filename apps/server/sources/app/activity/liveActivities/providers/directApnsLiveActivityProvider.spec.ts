import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type {
    ApnsLiveActivityHttp2Request,
    ApnsLiveActivityHttp2Response,
} from "./apnsLiveActivityHttp2Sender";
import {
    createDirectApnsLiveActivityTargetFixture,
    createDirectApnsProviderConfig,
    createRemoteUpdateRequest,
    createRemoteUpdateRequestNearContentStateBudget,
    createUrgentRemoteUpdateRequest,
} from "./directApnsLiveActivityProvider.testkit";

type SendApnsRequest = (
    params: ApnsLiveActivityHttp2Request,
) => Promise<ApnsLiveActivityHttp2Response>;

function getLiveActivityTargetDelegate() {
    return (db as unknown as {
        accountLiveActivityTarget?: {
            deleteMany: () => Promise<unknown>;
        };
    }).accountLiveActivityTarget;
}

async function loadProviderModule() {
    return import("./directApnsLiveActivityProvider").catch(() => null);
}

describe("directApnsLiveActivityProvider", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-live-activity-apns-provider-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        vi.restoreAllMocks();
        await getLiveActivityTargetDelegate()?.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("marks a target ended after APNs reports an unregistered ActivityKit token", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_1" } });
        const session = await db.session.create({
            data: {
                id: "session-1",
                tag: "session-1",
                accountId: account.id,
                metadata: "{}",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
            },
        });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: session.id,
            suffix: "1",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });

        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => ({
            status: 410,
            reason: "Unregistered",
            apnsId: "apns-1",
        }));

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest(session.id),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });

        expect(result.status).toBe("failed");
        expect(result.classification.action).toBe("permanent_drop_target");
        expect(sendApnsRequest).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: "https://api.sandbox.push.apple.com",
            deviceToken: "activity-token-1",
            headers: expect.objectContaining({
                "apns-id": expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
                ),
                "apns-push-type": "liveactivity",
                "apns-topic": "dev.happier.custom.push-type.liveactivity",
                "apns-priority": "5",
            }),
            payload: expect.objectContaining({
                aps: expect.objectContaining({
                    timestamp: 1_777_809_600,
                }),
            }),
        }));

        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeInstanceOf(Date);
        expect(updated.lastFailureCode).toBe("Unregistered");
        expect(updated.failureCount).toBe(1);
    });

    it("classifies configured environment mismatches before sending to APNs", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_2" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-2",
            suffix: "2",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const sendApnsRequest = vi.fn<SendApnsRequest>();

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-2"),
            config: createDirectApnsProviderConfig({ environment: "production" }),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });

        expect(result.status).toBe("failed");
        expect(result.classification.reason).toBe("apns_environment_mismatch");
        expect(sendApnsRequest).not.toHaveBeenCalled();

        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeNull();
        expect(updated.lastFailureCode).toBe("apns_environment_mismatch");
    });

    it("uses the production APNs endpoint and rotates JWTs for separate sends without dropping requests", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_3" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-3",
            suffix: "3",
            environment: "production",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => ({
            status: 200,
            apnsId: "accepted",
        }));
        const config = createDirectApnsProviderConfig({ environment: "production" });

        await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-3"),
            config,
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });
        await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-3"),
            config,
            now: new Date("2026-05-03T12:50:00.000Z"),
            sendApnsRequest,
        });

        const calls = sendApnsRequest.mock.calls.map(([request]) => request);
        expect(calls).toHaveLength(2);
        expect(calls.every((request) => request.endpoint === "https://api.push.apple.com")).toBe(true);
        expect(calls[0]?.headers.authorization).not.toBe(calls[1]?.headers.authorization);
        expect(JSON.stringify(calls.map((request) => ({
            authorization: request.headers.authorization,
            payload: request.payload,
        })))).not.toContain("activity-token-3");
        expect(JSON.stringify(calls.map((request) => ({
            authorization: request.headers.authorization,
            payload: request.payload,
        })))).not.toContain(config.privateKeyPem);
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.lastPayloadHash).toBe(createRemoteUpdateRequest("session-3").snapshotFingerprint);
        expect(updated.failureCount).toBe(0);
    });

    it("includes an APNs alert only for urgent sanitized interruptive updates", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_4" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-4",
            suffix: "4",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => ({
            status: 200,
            apnsId: "accepted",
        }));

        await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createUrgentRemoteUpdateRequest("session-4"),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });

        const sent = sendApnsRequest.mock.calls[0]?.[0];
        expect(sent?.headers["apns-priority"]).toBe("10");
        expect(sent?.payload).toMatchObject({
            aps: {
                alert: {
                    title: "Approval needed",
                    body: "Open Happier to review the request.",
                    sound: "default",
                },
            },
        });
    });

    it("marks BadDeviceToken failures as ended target invalidations", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_5" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-5",
            suffix: "5",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-5"),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest: vi.fn(async () => ({
                status: 400,
                reason: "BadDeviceToken",
                apnsId: "apns-bad-device",
            })),
        });

        expect(result.classification).toEqual({
            action: "permanent_drop_target",
            reason: "BadDeviceToken",
        });
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeInstanceOf(Date);
        expect(updated.lastFailureCode).toBe("BadDeviceToken");
    });

    it("rejects APNs payloads that exceed the ActivityKit budget after APNs wrapping", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_payload_budget" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-budget",
            suffix: "budget",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const request = createRemoteUpdateRequestNearContentStateBudget("session-budget");
        const config = createDirectApnsProviderConfig();
        const apnsPayload = mod.buildDirectApnsLiveActivityHttp2Request({
            target: {
                activityId: target.activityId,
                bundleId: target.bundleId!,
            },
            request,
            config,
            now: new Date("2026-05-03T12:00:00.000Z"),
            deviceToken: "activity-token-budget",
        }).payload;
        expect(Buffer.byteLength(JSON.stringify(apnsPayload), "utf8"))
            .toBeGreaterThan(LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES);
        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => ({ status: 200 }));

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request,
            config,
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });

        expect(result).toMatchObject({
            targetId: target.id,
            status: "failed",
            classification: {
                action: "permanent_fix_payload",
                reason: "PayloadTooLarge",
            },
        });
        expect(sendApnsRequest).not.toHaveBeenCalled();
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.lastFailureCode).toBe("PayloadTooLarge");
        expect(updated.failureCount).toBe(1);
    });

    it("records transient APNs transport errors instead of throwing from the provider", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_transport_error" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-transport",
            suffix: "transport",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transport"),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest: vi.fn<SendApnsRequest>(async () => {
                throw new Error("socket hang up");
            }),
        });

        expect(result).toMatchObject({
            targetId: target.id,
            status: "failed",
            classification: {
                action: "transient_retry",
                reason: "apns_transport_error",
            },
        });
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeNull();
        expect(updated.lastFailureCode).toBe("apns_transport_error");
        expect(JSON.stringify(updated.diagnostics)).not.toContain("activity-token-transport");
    });

    it("retires a target after the configured transient APNs failure budget", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: "2",
        });
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_transient_budget" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-transient-budget",
            suffix: "transient-budget",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => {
            throw new Error("socket hang up");
        });

        await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transient-budget"),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });
        await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transient-budget"),
            config: createDirectApnsProviderConfig(),
            now: new Date("2026-05-03T12:00:01.000Z"),
            sendApnsRequest,
        });

        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.failureCount).toBe(2);
        expect(updated.lastFailureCode).toBe("apns_transport_error");
        expect(updated.endedAt).toEqual(new Date("2026-05-03T12:00:01.000Z"));
    });

    it("records invalid APNs token-auth credentials without sending to APNs", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const account = await db.account.create({ data: { publicKey: "pk_live_activity_apns_invalid_key" } });
        const target = await createDirectApnsLiveActivityTargetFixture({
            accountId: account.id,
            sessionId: "session-invalid-key",
            suffix: "invalid-key",
            encryptLiveActivityTargetSecret: mod.encryptLiveActivityTargetSecret,
        });
        const malformedPrivateKey = "-----BEGIN PRIVATE KEY-----\nnot-a-p8-key\n-----END PRIVATE KEY-----";
        const sendApnsRequest = vi.fn<SendApnsRequest>(async () => ({ status: 200 }));

        const result = await mod.sendDirectApnsLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-invalid-key"),
            config: createDirectApnsProviderConfig({ privateKeyPem: malformedPrivateKey }),
            now: new Date("2026-05-03T12:00:00.000Z"),
            sendApnsRequest,
        });

        expect(result).toMatchObject({
            targetId: target.id,
            status: "failed",
            classification: {
                action: "operator_config",
                reason: "apns_provider_token_invalid",
            },
        });
        expect(sendApnsRequest).not.toHaveBeenCalled();
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeNull();
        expect(updated.lastFailureCode).toBe("apns_provider_token_invalid");
        expect(JSON.stringify(updated.diagnostics)).not.toContain("activity-token-invalid-key");
        expect(JSON.stringify(updated.diagnostics)).not.toContain(malformedPrivateKey);
    });
});
