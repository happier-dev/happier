import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

async function loadHostedRelayProviderModule() {
    return import("./hostedRelayLiveActivityProvider").catch(() => null);
}

async function loadDirectApnsProviderModule() {
    return import("./directApnsLiveActivityProvider").catch(() => null);
}

function getLiveActivityTargetDelegate() {
    return (db as unknown as {
        accountLiveActivityTarget?: {
            deleteMany: () => Promise<unknown>;
        };
    }).accountLiveActivityTarget;
}

function createRemoteUpdateRequest(sessionId: string) {
    const now = 1_800_000_000_000;
    return {
        v: 1,
        requestId: "hosted-provider-req-1",
        createdAt: now,
        transportMode: "hosted_happier_relay",
        activityKey: {
            serverId: "server-1",
            sessionId,
            activityName: "HappierFocusLiveActivity",
        },
        snapshotFingerprint: "fp-hosted-provider-1",
        event: "update",
        contentState: {
            version: 1,
            generatedAt: now,
            staleAt: now + 30_000,
            sessionId,
            title: "Working",
            subtitle: null,
            previewText: null,
            statusText: "Thinking",
            attentionState: "thinking",
            defaultTarget: "happier://inbox",
            sessionTarget: `happier://session/server-1/${sessionId}`,
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
    } as const;
}

describe("hostedRelayLiveActivityProvider", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-live-activity-hosted-relay-provider-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        vi.restoreAllMocks();
        await getLiveActivityTargetDelegate()?.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("requires a hosted relay access key before dispatching", async () => {
        const hosted = await loadHostedRelayProviderModule();
        const direct = await loadDirectApnsProviderModule();
        expect(hosted).not.toBeNull();
        expect(direct).not.toBeNull();
        if (!hosted || !direct) return;

        const account = await db.account.create({ data: { publicKey: "pk_hosted_relay_provider_access_key" } });
        const target = await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-1",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-1",
                activityId: "activity-1",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-hosted-provider-access-key",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: direct.encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityId: "activity-1",
                    field: "rawToken",
                    value: "hosted-provider-activitykit-token",
                }),
            },
        });
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            success: true,
            status: "sent",
            classification: { action: "success" },
        }), { status: 200, headers: { "content-type": "application/json" } }));

        const result = await hosted.sendHostedRelayLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-1"),
            config: {
                baseUrl: "https://relay.happier.dev",
                accessKey: null,
            },
            now: new Date(1_800_000_000_000),
            fetchImpl,
        });

        expect(result).toMatchObject({
            targetId: target.id,
            status: "failed",
            code: "hosted_relay_access_key_missing",
            classification: {
                action: "operator_config",
                reason: "hosted_relay_access_key_missing",
            },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.lastFailureCode).toBe("hosted_relay_access_key_missing");
        expect(JSON.stringify(updated.diagnostics)).not.toContain("hosted-provider-activitykit-token");
    });

    it("records transient relay transport errors without leaking target tokens", async () => {
        const hosted = await loadHostedRelayProviderModule();
        const direct = await loadDirectApnsProviderModule();
        expect(hosted).not.toBeNull();
        expect(direct).not.toBeNull();
        if (!hosted || !direct) return;

        const account = await db.account.create({ data: { publicKey: "pk_hosted_relay_provider_transport" } });
        const target = await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-transport",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-transport",
                activityId: "activity-transport",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-hosted-provider-transport",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: direct.encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-transport",
                    activityId: "activity-transport",
                    field: "rawToken",
                    value: "hosted-provider-transport-token",
                }),
            },
        });

        const result = await hosted.sendHostedRelayLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transport"),
            config: {
                baseUrl: "https://relay.happier.dev",
                accessKey: "relay-access-key",
            },
            now: new Date(1_800_000_000_000),
            fetchImpl: vi.fn<typeof fetch>(async () => {
                throw new Error("network unavailable");
            }),
        });

        expect(result).toMatchObject({
            targetId: target.id,
            status: "failed",
            code: "hosted_relay_transport_error",
            classification: {
                action: "transient_retry",
                reason: "hosted_relay_transport_error",
            },
        });
        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.endedAt).toBeNull();
        expect(updated.lastFailureCode).toBe("hosted_relay_transport_error");
        expect(JSON.stringify(updated.diagnostics)).not.toContain("hosted-provider-transport-token");
        expect(JSON.stringify(updated.diagnostics)).not.toContain("relay-access-key");
    });

    it("retires a target after the configured transient hosted relay failure budget", async () => {
        harness.resetEnv({
            HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: "2",
        });
        const hosted = await loadHostedRelayProviderModule();
        const direct = await loadDirectApnsProviderModule();
        expect(hosted).not.toBeNull();
        expect(direct).not.toBeNull();
        if (!hosted || !direct) return;

        const account = await db.account.create({ data: { publicKey: "pk_hosted_relay_provider_transient_budget" } });
        const target = await db.accountLiveActivityTarget.create({
            data: {
                accountId: account.id,
                deviceId: "device-1",
                serverId: "server-1",
                sessionId: "session-transient-budget",
                activityInstanceKey: "server-1:HappierFocusLiveActivity:session-transient-budget",
                activityId: "activity-transient-budget",
                activityName: "HappierFocusLiveActivity",
                targetIdentityHash: "target-hash-hosted-provider-transient-budget",
                transportMode: "hosted_happier_relay",
                bundleId: "dev.happier.app",
                environment: "sandbox",
                tokenKind: "activitykit_update_token",
                rawTokenEncrypted: direct.encryptLiveActivityTargetSecret({
                    accountId: account.id,
                    serverId: "server-1",
                    sessionId: "session-transient-budget",
                    activityId: "activity-transient-budget",
                    field: "rawToken",
                    value: "hosted-provider-transient-budget-token",
                }),
            },
        });
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            throw new Error("network unavailable");
        });

        await hosted.sendHostedRelayLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transient-budget"),
            config: {
                baseUrl: "https://relay.happier.dev",
                accessKey: "relay-access-key",
            },
            now: new Date(1_800_000_000_000),
            fetchImpl,
        });
        await hosted.sendHostedRelayLiveActivityUpdate({
            target,
            request: createRemoteUpdateRequest("session-transient-budget"),
            config: {
                baseUrl: "https://relay.happier.dev",
                accessKey: "relay-access-key",
            },
            now: new Date(1_800_000_001_000),
            fetchImpl,
        });

        const updated = await db.accountLiveActivityTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(updated.failureCount).toBe(2);
        expect(updated.lastFailureCode).toBe("hosted_relay_transport_error");
        expect(updated.endedAt).toEqual(new Date(1_800_000_001_000));
    });
});
