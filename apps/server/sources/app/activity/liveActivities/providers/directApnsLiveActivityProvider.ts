import { createHash, createSign, randomUUID } from "node:crypto";

import {
    classifyLiveActivityApnsDeliveryResponse,
    deriveLiveActivityApnsDeliveryFields,
    LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES,
    type LiveActivityApnsDeliveryClassification,
    type LiveActivityApnsTemplate,
    type LiveActivityRemoteUpdateRequestV1,
} from "@happier-dev/protocol";
import type { AccountLiveActivityTarget } from "@prisma/client";

import { decryptString, encryptString } from "@/modules/encrypt";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { recordLiveActivityTargetFailure } from "../recordLiveActivityTargetFailure";
import type { LiveActivityDirectApnsConfig } from "../resolveLiveActivityRemoteTransport";
import {
    sendApnsLiveActivityHttp2Request,
    type ApnsLiveActivityHttp2Request,
    type ApnsLiveActivityHttp2Response,
} from "./apnsLiveActivityHttp2Sender";

export type CreateApnsLiveActivityJwtParams = Readonly<{
    teamId: string;
    keyId: string;
    privateKeyPem: string;
    issuedAtEpochSeconds: number;
}>;

export type EncryptLiveActivityTargetSecretParams = Readonly<{
    accountId: string;
    serverId: string;
    sessionId: string;
    activityId: string;
    field: string;
    value: string;
}>;

export type SendDirectApnsLiveActivityUpdateParams = Readonly<{
    target: AccountLiveActivityTarget;
    request: LiveActivityRemoteUpdateRequestV1;
    config: Omit<LiveActivityDirectApnsConfig, "configured" | "diagnostics">;
    now: Date;
    sendApnsRequest?: (params: ApnsLiveActivityHttp2Request) => Promise<ApnsLiveActivityHttp2Response>;
}>;

export type BuildDirectApnsLiveActivityHttp2RequestParams = Readonly<{
    target: Readonly<{
        activityId: string;
        bundleId: string;
    }>;
    request: LiveActivityRemoteUpdateRequestV1;
    config: Readonly<{
        environment: LiveActivityDirectApnsConfig["environment"];
        teamId: string | null;
        keyId: string | null;
        privateKeyPem: string | null;
    }>;
    now: Date;
    deviceToken: string;
}>;

export type DirectApnsLiveActivityDeliveryResult = Readonly<{
    targetId: string;
    status: "sent" | "failed";
    classification: LiveActivityApnsDeliveryClassification;
    apnsId?: string;
}>;

const APNS_SANDBOX_ENDPOINT = "https://api.sandbox.push.apple.com";
const APNS_PRODUCTION_ENDPOINT = "https://api.push.apple.com";
const APNS_PROVIDER_JWT_ROTATION_SECONDS = 50 * 60;

const apnsProviderJwtCache = new Map<string, Readonly<{
    issuedAtEpochSeconds: number;
    token: string;
}>>();

function base64UrlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function secretPath(params: Omit<EncryptLiveActivityTargetSecretParams, "value">): string[] {
    return [
        "liveActivityTarget",
        params.accountId,
        params.serverId,
        params.sessionId,
        params.activityId,
        params.field,
    ];
}

export function createApnsLiveActivityJwt(params: CreateApnsLiveActivityJwtParams): string {
    const header = base64UrlJson({ alg: "ES256", kid: params.keyId });
    const payload = base64UrlJson({ iss: params.teamId, iat: params.issuedAtEpochSeconds });
    const signingInput = `${header}.${payload}`;
    const signature = createSign("SHA256")
        .update(signingInput)
        .sign({ key: params.privateKeyPem, dsaEncoding: "ieee-p1363" })
        .toString("base64url");
    return `${signingInput}.${signature}`;
}

export function encryptLiveActivityTargetSecret(
    params: EncryptLiveActivityTargetSecretParams,
): Uint8Array<ArrayBuffer> {
    return encryptString(secretPath(params), params.value);
}

export function decryptLiveActivityTargetSecret(
    target: AccountLiveActivityTarget,
    field: string,
): string | null {
    if (!target.rawTokenEncrypted) return null;
    const bytes = new Uint8Array(target.rawTokenEncrypted) as Uint8Array<ArrayBuffer>;
    return decryptString(secretPath({
        accountId: target.accountId,
        serverId: target.serverId,
        sessionId: target.sessionId,
        activityId: target.activityId,
        field,
    }), bytes);
}

function resolveEndpoint(environment: string): string {
    return environment === "production" ? APNS_PRODUCTION_ENDPOINT : APNS_SANDBOX_ENDPOINT;
}

function resolveTemplate(request: LiveActivityRemoteUpdateRequestV1): LiveActivityApnsTemplate {
    if (request.event !== "update") return "quietFocus";
    const attentionState = request.contentState.attentionState;
    return attentionState === "permission_required" || attentionState === "action_required"
        ? "urgentAttention"
        : "quietFocus";
}

function unixSeconds(ms: number): number {
    return Math.floor(ms / 1000);
}

function buildApnsPayload(
    request: LiveActivityRemoteUpdateRequestV1,
    params: { allowsAlert: boolean; timestampEpochSeconds: number },
): unknown {
    const aps: Record<string, unknown> = {
        timestamp: params.timestampEpochSeconds,
        event: request.event,
    };
    if (request.contentState) {
        aps["content-state"] = request.contentState;
        aps["stale-date"] = unixSeconds(request.contentState.staleAt);
    }
    if (request.event === "end" && typeof request.dismissalAt === "number") {
        aps["dismissal-date"] = unixSeconds(request.dismissalAt);
    }
    if (request.event === "update" && params.allowsAlert && request.interruptiveAlert) {
        aps.alert = request.interruptiveAlert;
    }
    return { aps };
}

function apnsProviderJwtCacheKey(params: Omit<CreateApnsLiveActivityJwtParams, "issuedAtEpochSeconds">): string {
    return [
        params.teamId,
        params.keyId,
        createHash("sha256").update(params.privateKeyPem).digest("hex"),
    ].join("\0");
}

function resolveCachedApnsLiveActivityJwt(params: CreateApnsLiveActivityJwtParams): string {
    const cacheKey = apnsProviderJwtCacheKey(params);
    const cached = apnsProviderJwtCache.get(cacheKey);
    if (
        cached &&
        params.issuedAtEpochSeconds >= cached.issuedAtEpochSeconds &&
        params.issuedAtEpochSeconds - cached.issuedAtEpochSeconds < APNS_PROVIDER_JWT_ROTATION_SECONDS
    ) {
        return cached.token;
    }

    const token = createApnsLiveActivityJwt(params);
    apnsProviderJwtCache.set(cacheKey, {
        issuedAtEpochSeconds: params.issuedAtEpochSeconds,
        token,
    });
    return token;
}

function countJsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function recordFailure(
    targetId: string,
    now: Date,
    code: string,
    classification: LiveActivityApnsDeliveryClassification,
): Promise<void> {
    await recordLiveActivityTargetFailure({
        targetId,
        now,
        code,
        classification,
        diagnostics: { classification },
    });
}

async function recordSuccess(targetId: string, now: Date, hash: string): Promise<void> {
    await db.accountLiveActivityTarget.update({
        where: { id: targetId },
        data: {
            lastPushedAt: now,
            lastPayloadHash: hash,
            failureCount: 0,
            lastFailureCode: null,
            diagnostics: getActivePrismaRuntime().DbNull,
        },
    });
}

function buildConfigFailure(reason: string): LiveActivityApnsDeliveryClassification {
    return { action: "operator_config", reason };
}

function buildPayloadFailure(reason: string): LiveActivityApnsDeliveryClassification {
    return { action: "permanent_fix_payload", reason };
}

function buildTransientFailure(reason: string): LiveActivityApnsDeliveryClassification {
    return { action: "transient_retry", reason };
}

function isAllowed(value: string | null, allowlist: readonly string[]): value is string {
    return typeof value === "string" && allowlist.includes(value);
}

export function buildDirectApnsLiveActivityHttp2Request(
    params: BuildDirectApnsLiveActivityHttp2RequestParams,
): ApnsLiveActivityHttp2Request {
    const nowEpochSeconds = Math.floor(params.now.getTime() / 1000);
    const fields = deriveLiveActivityApnsDeliveryFields({
        bundleId: params.target.bundleId,
        activityId: params.target.activityId,
        event: params.request.event,
        template: resolveTemplate(params.request),
        nowEpochSeconds,
        quietHoursActive: false,
        alertRequested: params.request.event === "update" && Boolean(params.request.interruptiveAlert),
    });
    const jwt = resolveCachedApnsLiveActivityJwt({
        teamId: params.config.teamId ?? "",
        keyId: params.config.keyId ?? "",
        privateKeyPem: params.config.privateKeyPem ?? "",
        issuedAtEpochSeconds: nowEpochSeconds,
    });
    const payload = buildApnsPayload(params.request, {
        allowsAlert: fields.allowsAlert,
        timestampEpochSeconds: nowEpochSeconds,
    });

    return {
        endpoint: resolveEndpoint(params.config.environment),
        deviceToken: params.deviceToken,
        headers: {
            authorization: `bearer ${jwt}`,
            "apns-id": randomUUID(),
            "apns-push-type": fields.pushType,
            "apns-topic": fields.topic,
            "apns-priority": String(fields.priority),
            "apns-expiration": String(fields.expiration),
            "apns-collapse-id": fields.collapseId,
        },
        payload,
    };
}

export async function sendDirectApnsLiveActivityUpdate(
    params: SendDirectApnsLiveActivityUpdateParams,
): Promise<DirectApnsLiveActivityDeliveryResult> {
    const target = params.target;
    if (target.environment !== params.config.environment) {
        const classification = buildConfigFailure("apns_environment_mismatch");
        await recordFailure(target.id, params.now, "apns_environment_mismatch", classification);
        return { targetId: target.id, status: "failed", classification };
    }
    if (!isAllowed(target.bundleId, params.config.bundleIds)) {
        const classification = buildConfigFailure("apns_bundle_id_not_allowed");
        await recordFailure(target.id, params.now, "apns_bundle_id_not_allowed", classification);
        return { targetId: target.id, status: "failed", classification };
    }
    if (
        params.config.allowedActivityNames.length > 0 &&
        !params.config.allowedActivityNames.includes(target.activityName)
    ) {
        const classification = buildConfigFailure("apns_activity_name_not_allowed");
        await recordFailure(target.id, params.now, "apns_activity_name_not_allowed", classification);
        return { targetId: target.id, status: "failed", classification };
    }

    const deviceToken = decryptLiveActivityTargetSecret(target, "rawToken");
    if (!deviceToken) {
        const classification = buildConfigFailure("activitykit_update_token_missing");
        await recordFailure(target.id, params.now, "activitykit_update_token_missing", classification);
        return { targetId: target.id, status: "failed", classification };
    }

    let apnsRequest: ApnsLiveActivityHttp2Request;
    try {
        apnsRequest = buildDirectApnsLiveActivityHttp2Request({
            target: {
                activityId: target.activityId,
                bundleId: target.bundleId,
            },
            request: params.request,
            config: params.config,
            now: params.now,
            deviceToken,
        });
    } catch {
        const classification = buildConfigFailure("apns_provider_token_invalid");
        await recordFailure(target.id, params.now, "apns_provider_token_invalid", classification);
        return { targetId: target.id, status: "failed", classification };
    }
    if (countJsonBytes(apnsRequest.payload) > LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) {
        const classification = buildPayloadFailure("PayloadTooLarge");
        await recordFailure(target.id, params.now, "PayloadTooLarge", classification);
        return { targetId: target.id, status: "failed", classification };
    }

    let apnsResponse: ApnsLiveActivityHttp2Response;
    try {
        apnsResponse = await (params.sendApnsRequest ?? sendApnsLiveActivityHttp2Request)(apnsRequest);
    } catch {
        const classification = buildTransientFailure("apns_transport_error");
        await recordFailure(target.id, params.now, "apns_transport_error", classification);
        return { targetId: target.id, status: "failed", classification };
    }
    const classification = classifyLiveActivityApnsDeliveryResponse(apnsResponse);
    if (classification.action === "success") {
        await recordSuccess(target.id, params.now, params.request.snapshotFingerprint);
        return {
            targetId: target.id,
            status: "sent",
            classification,
            apnsId: apnsResponse.apnsId,
        };
    }

    const failureCode = classification.reason ?? `apns_status_${apnsResponse.status}`;
    await recordFailure(target.id, params.now, failureCode, classification);
    return {
        targetId: target.id,
        status: "failed",
        classification,
        apnsId: apnsResponse.apnsId,
    };
}
