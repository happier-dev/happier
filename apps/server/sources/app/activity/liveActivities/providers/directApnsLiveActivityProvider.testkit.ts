import { generateKeyPairSync } from "node:crypto";

import {
    LiveActivityRemoteUpdateRequestV1Schema,
    type LiveActivityRemoteUpdateRequestV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";

export function createP8PrivateKey(): string {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function createDirectApnsProviderConfig(overrides: Partial<{
    environment: "sandbox" | "production";
    teamId: string;
    keyId: string;
    privateKeyPem: string;
    bundleIds: string[];
    allowedActivityNames: string[];
}> = {}) {
    return {
        environment: "sandbox" as const,
        teamId: "TEAMID1234",
        keyId: "KEYID1234",
        privateKeyPem: createP8PrivateKey(),
        bundleIds: ["dev.happier.custom"],
        allowedActivityNames: ["HappierFocusLiveActivity"],
        ...overrides,
    };
}

export function createRemoteUpdateRequest(sessionId: string): LiveActivityRemoteUpdateRequestV1 {
    const now = 1_800_000_000_000;
    return {
        v: 1,
        requestId: "req-1",
        createdAt: now,
        transportMode: "direct_apns",
        activityKey: {
            serverId: "server-1",
            sessionId,
            activityName: "HappierFocusLiveActivity",
        },
        snapshotFingerprint: "fp-1",
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
    };
}

export function createUrgentRemoteUpdateRequest(sessionId: string): LiveActivityRemoteUpdateRequestV1 {
    const base = createRemoteUpdateRequest(sessionId);
    const contentState = base.contentState;
    if (!contentState) {
        throw new Error("Expected Live Activity request fixture to include content state");
    }
    return LiveActivityRemoteUpdateRequestV1Schema.parse({
        ...base,
        interruptiveAlert: {
            title: "Approval needed",
            body: "Open Happier to review the request.",
            sound: "default",
        },
        contentState: {
            ...contentState,
            attentionState: "permission_required",
            statusText: "Permission required",
        },
    });
}

export function createRemoteUpdateRequestNearContentStateBudget(sessionId: string): LiveActivityRemoteUpdateRequestV1 {
    const base = createRemoteUpdateRequest(sessionId);
    for (let statusTextLength = 4_096; statusTextLength >= 1; statusTextLength -= 1) {
        const candidate = {
            ...base,
            contentState: {
                ...base.contentState,
                statusText: "x".repeat(statusTextLength),
            },
        };
        const parsed = LiveActivityRemoteUpdateRequestV1Schema.safeParse(candidate);
        if (parsed.success) return parsed.data;
    }
    throw new Error("Unable to build a near-budget Live Activity request fixture");
}

export type EncryptLiveActivityTargetSecret = (params: Readonly<{
    accountId: string;
    serverId: string;
    sessionId: string;
    activityId: string;
    field: "rawToken";
    value: string;
}>) => Uint8Array<ArrayBuffer>;

export async function createDirectApnsLiveActivityTargetFixture(params: Readonly<{
    accountId: string;
    sessionId: string;
    suffix: string;
    environment?: "sandbox" | "production";
    bundleId?: string;
    activityToken?: string;
    encryptLiveActivityTargetSecret: EncryptLiveActivityTargetSecret;
}>) {
    const environment = params.environment ?? "sandbox";
    const bundleId = params.bundleId ?? "dev.happier.custom";
    const activityId = `activity-${params.suffix}`;
    const activityToken = params.activityToken ?? `activity-token-${params.suffix}`;

    return db.accountLiveActivityTarget.create({
        data: {
            accountId: params.accountId,
            deviceId: "device-1",
            serverId: "server-1",
            sessionId: params.sessionId,
            activityInstanceKey: `server-1:HappierFocusLiveActivity:${params.sessionId}`,
            activityId,
            activityName: "HappierFocusLiveActivity",
            targetIdentityHash: `target-hash-${params.suffix}`,
            transportMode: "direct_apns",
            bundleId,
            environment,
            tokenKind: "activitykit_update_token",
            rawTokenEncrypted: params.encryptLiveActivityTargetSecret({
                accountId: params.accountId,
                serverId: "server-1",
                sessionId: params.sessionId,
                activityId,
                field: "rawToken",
                value: activityToken,
            }),
        },
    });
}
